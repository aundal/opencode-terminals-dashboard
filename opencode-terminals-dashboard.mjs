import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import net from 'net';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import process from 'process';

const DASHBOARD_PORT = 31337;
const LEASE_PORT = 31338;
const HEARTBEAT_URL = `http://127.0.0.1:${DASHBOARD_PORT}/api/heartbeat`;
const RUNNING_DECAY_MS = 30000;
const STALE_SUBAGENT_PRUNE_MS = 30000;
const STALE_HEARTBEAT_PURGE_MS = 15000;
const CLOSED_SESSION_RETENTION_MS = 15000;
const COLD_CACHE_MS = 5 * 60 * 1000;

// Module-level global rate limiter shared across all plugin listeners
const globalSessionThrottles = new Map();
const globalSessionLastState = new Map();

// Debug log helper (writes to C:\Users\<User>\opencode-debug.log only if DEBUG=1 or DEBUG=true)
const debugLogFile = path.join(os.homedir(), 'opencode-debug.log');
function pluginLog(msg) {
  if (process.env.DEBUG !== '1' && process.env.DEBUG !== 'true' && !process.env.OPENCODE_DEBUG) return;
  const time = new Date().toLocaleTimeString();
  try {
    fs.appendFileSync(debugLogFile, `[${time}] ${msg}\n`);
  } catch(e) {}
}

// Short ID helper: Extract the last 6 characters for debug visibility
function shortId(id) {
  if (!id || typeof id !== 'string') return 'none';
  return id.length > 6 ? `...${id.slice(-6)}` : id;
}

// Strict Session ID validation: Must start with 'ses_' to prevent Message IDs (msg_...) from leaking
function isSessionId(str) {
  if (typeof str !== 'string' || !str) return false;
  if (str.startsWith('msg_') || str.startsWith('prt_') || str.startsWith('part_') || str.startsWith('msg')) return false;
  return str.startsWith('ses_');
}

function findSessionId(event, session, ctx) {
  if (event?.properties) {
    if (typeof event.properties.sessionID === 'string' && isSessionId(event.properties.sessionID)) return event.properties.sessionID;
    if (typeof event.properties.sessionId === 'string' && isSessionId(event.properties.sessionId)) return event.properties.sessionId;
    if (typeof event.properties.session_id === 'string' && isSessionId(event.properties.session_id)) return event.properties.session_id;
    if (typeof event.properties.info?.sessionID === 'string' && isSessionId(event.properties.info.sessionID)) return event.properties.info.sessionID;
    if (typeof event.properties.part?.sessionID === 'string' && isSessionId(event.properties.part.sessionID)) return event.properties.part.sessionID;
  }
  if (event) {
    if (typeof event.sessionId === 'string' && isSessionId(event.sessionId)) return event.sessionId;
    if (typeof event.session_id === 'string' && isSessionId(event.session_id)) return event.session_id;
    if (typeof event.sessionID === 'string' && isSessionId(event.sessionID)) return event.sessionID;
    if (typeof event.part?.sessionID === 'string' && isSessionId(event.part.sessionID)) return event.part.sessionID;
  }
  if (session) {
    if (typeof session === 'string' && isSessionId(session)) return session;
    if (typeof session.id === 'string' && isSessionId(session.id)) return session.id;
  }
  return null;
}

function findParentId(event, session) {
  let parentId = null;
  if (event?.properties) {
    if (typeof event.properties.parentID === 'string') parentId = event.properties.parentID;
    else if (typeof event.properties.parentId === 'string') parentId = event.properties.parentId;
    else if (typeof event.properties.parent_id === 'string') parentId = event.properties.parent_id;
    else if (typeof event.properties.parentSessionID === 'string') parentId = event.properties.parentSessionID;
    else if (typeof event.properties.parent_session_id === 'string') parentId = event.properties.parent_session_id;
    else if (typeof event.properties.info?.parentID === 'string') parentId = event.properties.info.parentID;
    else if (typeof event.properties.info?.parentId === 'string') parentId = event.properties.info.parentId;
    else if (typeof event.properties.session?.parentID === 'string') parentId = event.properties.session.parentID;
    else if (typeof event.properties.task?.parentID === 'string') parentId = event.properties.task.parentID;
    else if (typeof event.properties.task?.parentSessionID === 'string') parentId = event.properties.task.parentSessionID;
  }
  if (!parentId && event) {
    if (typeof event.parentID === 'string') parentId = event.parentID;
    else if (typeof event.parentId === 'string') parentId = event.parentId;
    else if (typeof event.parent_id === 'string') parentId = event.parent_id;
  }
  if (!parentId && session) {
    if (typeof session.parentID === 'string') parentId = session.parentID;
    else if (typeof session.parentId === 'string') parentId = session.parentId;
    else if (typeof session.info?.parentID === 'string') parentId = session.info.parentID;
  }

  if (parentId && isSessionId(parentId)) {
    return parentId;
  }
  return null;
}

function findRawSessionTitle(event, session) {
  if (event?.properties) {
    if (typeof event.properties.title === 'string' && event.properties.title) {
      return event.properties.title;
    }
    if (event.properties.info && typeof event.properties.info.title === 'string' && event.properties.info.title) {
      return event.properties.info.title;
    }
    if (event.properties.task && typeof event.properties.task.title === 'string' && event.properties.task.title) {
      return event.properties.task.title;
    }
    if (event.properties.task && typeof event.properties.task.description === 'string' && event.properties.task.description) {
      return event.properties.task.description;
    }
  }
  if (session && typeof session.title === 'string' && session.title) return session.title;
  if (event && typeof event.title === 'string' && event.title) return event.title;
  return null;
}

// Clean title: remove "(@general subagent)" or similar suffixes
function cleanTitle(rawTitle) {
  if (!rawTitle) return null;
  let t = rawTitle.trim();
  t = t.replace(/\s*\(@[^)]*subagent[^)]*\)/gi, '');
  t = t.replace(/\s*\(@subagent\)/gi, '');
  t = t.replace(/\s*\(@general\)/gi, '');
  return t.trim();
}

function tokenTotal(tokens) {
  const normalized = normalizeTokens(tokens);
  if (!normalized) return 0;
  return normalized.input + normalized.output + normalized.reasoning + normalized.cache.read + normalized.cache.write;
}

function normalizeTokens(tokens) {
  if (!tokens || typeof tokens !== 'object') return undefined;
  const cache = tokens.cache && typeof tokens.cache === 'object' ? tokens.cache : {};
  const normalized = {
    input: typeof tokens.input === 'number' && isFinite(tokens.input) ? tokens.input : 0,
    output: typeof tokens.output === 'number' && isFinite(tokens.output) ? tokens.output : 0,
    reasoning: typeof tokens.reasoning === 'number' && isFinite(tokens.reasoning) ? tokens.reasoning : 0,
    cache: {
      read: typeof cache.read === 'number' && isFinite(cache.read) ? cache.read : 0,
      write: typeof cache.write === 'number' && isFinite(cache.write) ? cache.write : 0,
    }
  };
  return tokenTotalWithoutGuard(normalized) > 0 ? normalized : normalized;
}

function tokenTotalWithoutGuard(tokens) {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write;
}

function tokenFingerprint(tokens) {
  const normalized = normalizeTokens(tokens);
  if (!normalized) return 'none';
  return [normalized.input, normalized.output, normalized.reasoning, normalized.cache.read, normalized.cache.write].join(':');
}

function preferSessionTokens(currentTokens, nextTokens) {
  if (!nextTokens || typeof nextTokens !== 'object') return currentTokens;
  if (!currentTokens || typeof currentTokens !== 'object') return nextTokens;
  return tokenTotal(nextTokens) >= tokenTotal(currentTokens) ? nextTokens : currentTokens;
}

function zeroTokensLike(tokens) {
  const normalized = normalizeTokens(tokens);
  if (!normalized) return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 }
  };
}

function subtractTokens(totalTokens, baseTokens) {
  const total = normalizeTokens(totalTokens);
  if (!total) return undefined;
  const base = normalizeTokens(baseTokens) || zeroTokensLike(total);
  return {
    input: Math.max(0, total.input - base.input),
    output: Math.max(0, total.output - base.output),
    reasoning: Math.max(0, total.reasoning - base.reasoning),
    cache: {
      read: Math.max(0, total.cache.read - base.cache.read),
      write: Math.max(0, total.cache.write - base.cache.write),
    }
  };
}

function addTokens(a, b) {
  const left = normalizeTokens(a);
  const right = normalizeTokens(b);
  if (!left && !right) return undefined;
  const lhs = left || zeroTokensLike(right);
  const rhs = right || zeroTokensLike(left);
  return {
    input: lhs.input + rhs.input,
    output: lhs.output + rhs.output,
    reasoning: lhs.reasoning + rhs.reasoning,
    cache: {
      read: lhs.cache.read + rhs.cache.read,
      write: lhs.cache.write + rhs.cache.write,
    }
  };
}

function findActiveSubAgent(sessionId, sessionMap) {
  let best = null;
  for (const session of sessionMap.values()) {
    if (session.parentId === sessionId && (session.status === 'running' || session.status === 'asking_parent')) {
      if (!best || (session.lastActivityTime || 0) > (best.lastActivityTime || 0)) best = session;
    }
  }
  return best;
}

function isInterruptedError(value) {
  if (!value) return false;
  const text = String(value).toLowerCase();
  return text.includes('abort') || text.includes('cancel') || text.includes('interrupt');
}

function findAgentName(event, session) {
  if (event?.properties) {
    if (typeof event.properties.agent === 'string' && event.properties.agent) return event.properties.agent;
    if (event.properties.info && typeof event.properties.info.agent === 'string' && event.properties.info.agent) return event.properties.info.agent;
    if (event.properties.task && typeof event.properties.task.agent === 'string' && event.properties.task.agent) return event.properties.task.agent;
  }
  if (session && typeof session.agent === 'string' && session.agent) return session.agent;
  if (event && typeof event.agent === 'string' && event.agent) return event.agent;
  return null;
}

function findModelName(event, session) {
  if (event?.properties) {
    if (typeof event.properties.model === 'string' && event.properties.model) return event.properties.model;
    if (typeof event.properties.modelID === 'string' && event.properties.modelID) return event.properties.modelID;
    if (event.properties.info && typeof event.properties.info.model === 'string' && event.properties.info.model) return event.properties.info.model;
    if (event.properties.info && typeof event.properties.info.modelID === 'string' && event.properties.info.modelID) return event.properties.info.modelID;
  }
  if (session && typeof session.model === 'string' && session.model) return session.model;
  if (event && typeof event.model === 'string' && event.model) return event.model;
  return null;
}

function formatModelName(rawModel) {
  if (!rawModel) return 'Claude Haiku 4.5';
  let m = rawModel.trim();
  if (m.includes('/')) m = m.split('/').pop();
  m = m.replace(/\(latest\)/gi, '').trim();
  
  if (m.toLowerCase().includes('claude')) {
    m = m.replace(/claude/i, 'Claude');
    m = m.replace(/haiku/i, 'Haiku');
    m = m.replace(/sonnet/i, 'Sonnet');
    m = m.replace(/opus/i, 'Opus');
  } else if (m.toLowerCase().includes('chatgpt')) {
    m = m.replace(/chatgpt/i, 'ChatGPT');
  } else if (m.toLowerCase().includes('gpt')) {
    m = m.replace(/gpt/i, 'GPT');
  } else if (m.toLowerCase().includes('deepseek')) {
    m = m.replace(/deepseek/i, 'DeepSeek');
  }
  return m;
}

function formatAgentName(rawAgent, isSubAgent) {
  if (rawAgent && rawAgent !== 'Main' && rawAgent !== 'SubAgent') {
    if (rawAgent.toLowerCase() === 'build') return 'Build';
    if (rawAgent.toLowerCase() === 'plan') return 'Plan';
    return rawAgent;
  }
  return isSubAgent ? 'General Task' : 'Build';
}

function isQuestionOrPermissionEvent(event) {
  if (!event) return false;
  try {
    const type = (event.type || event.event || event.name || '').toLowerCase();
    
    // Explicit question or permission event types ONLY
    if (
      type === 'question.ask' || type === 'question.asked' || type === 'question.created' ||
      type === 'permission.ask' || type === 'permission.asked' || type === 'permission.request' ||
      type === 'permission.created'
    ) {
      return true;
    }

    const props = event.properties || {};
    if (props.question?.options || props.questions || props.info?.question?.options) {
      return true;
    }
  } catch(e) {}
  return false;
}

// ====================================================================
// SECTION 1: OpenCode Plugin Client Engine
// ====================================================================
function setupPlugin(ctx) {
  const sessions = new Map();
  const knownParents = new Map();
  let rootSessionId = null;
  let activeTopLevelSessionId = null;
  let heartbeatTimer = null;
  let disposed = false;

  function completedMessageKey(info) {
    if (info && typeof info.id === 'string' && info.id) return info.id;
    return null;
  }

  // ---- Dashboard server auto-management: start if missing, lease while alive ----
  let leaseSocket = null;
  let serverEnsureInFlight = false;

  function connectLease() {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: '127.0.0.1', port: LEASE_PORT });
      sock.once('connect', () => resolve(sock));
      sock.once('error', (e) => { sock.destroy(); reject(e); });
    });
  }

  // Returns an executable that can run this .mjs file as a script.
  // In opencode the plugin runs inside the Bun runtime, where process.execPath
  // points at opencode.exe/bun.exe - NOT a script runner for our imports.
  function getServerRuntime() {
    const exe = (process.execPath || '').toLowerCase();
    const base = path.basename(exe);
    if (base.includes('node')) return process.execPath;
    if (base.includes('bun')) return process.execPath;
    return 'node'; // opencode.exe etc -> resolve node from PATH
  }

  function spawnServer() {
    try {
      const child = spawn(getServerRuntime(), [fileURLToPath(import.meta.url)], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.unref();
      pluginLog('SPAWN Dashboard server process started with ' + getServerRuntime());
    } catch (e) { pluginLog('SPAWN-FAIL ' + (e && e.message)); }
  }

  async function ensureServer() {
    if (disposed) return;
    if (serverEnsureInFlight) return;
    serverEnsureInFlight = true;
    try {
      if (leaseSocket && !leaseSocket.destroyed) return;

      // 1. Try to lease an already-running server
      let sock = await connectLease().catch(() => null);
      if (disposed) {
        if (sock && !sock.destroyed) sock.destroy();
        return;
      }
      if (sock) {
        leaseSocket = sock;
        attachLeaseHandlers();
        // Server was already up (or just restarted) -> push all known sessions immediately
        sendAllReports(true).catch(() => {});
        return;
      }

      // 2. HTTP port already serving (e.g. manually started old server) -> do not spawn a second
      try {
        const up = await fetch(`http://127.0.0.1:${DASHBOARD_PORT}/`, { method: 'GET', signal: AbortSignal.timeout(500) });
        if (up.ok) return;
      } catch (e) {}

      // 3. No server at all -> spawn it, then poll for the lease port (up to 5s)
      spawnServer();
      let polled = null;
      for (let i = 0; i < 50 && !polled; i++) {
        await new Promise(r => setTimeout(r, 100));
        polled = await connectLease().catch(() => null);
      }
      if (disposed) {
        if (polled && !polled.destroyed) polled.destroy();
        return;
      }
      if (polled) {
        leaseSocket = polled;
        attachLeaseHandlers();
        // Freshly spawned server -> push all known sessions immediately
        sendAllReports(true).catch(() => {});
      }
    } finally {
      serverEnsureInFlight = false;
    }
  }

  function attachLeaseHandlers() {
    const sock = leaseSocket;
    if (!sock) return;
    sock.on('error', () => { try { sock.destroy(); } catch (e) {} });
    sock.on('close', () => {
      if (leaseSocket === sock) leaseSocket = null;
      if (disposed) return;
      // Self-heal: server died while this terminal is still alive -> respawn
      setTimeout(() => ensureServer().catch(() => {}), 2000);
    });
  }

  async function sendReportForSession(s, now, force = false) {
    if (!s || !s.sessionId) return;

    const lastTime = globalSessionThrottles.get(s.sessionId) || 0;
    const lastState = globalSessionLastState.get(s.sessionId) || {};

    const statusChanged = s.status !== lastState.status;
    const titleChanged = s.title !== lastState.title;
    const tokensChanged = tokenFingerprint(s.tokens) !== lastState.tokens;
    const timeElapsed = now - lastTime;

    // RULE 1: Module-level hard rate limit — Never send more than 1 report per 1000ms for the same session across all instances
    if (!force && !statusChanged && !tokensChanged && timeElapsed < 1000) {
      return;
    }

    // RULE 2: Heartbeat interval — If < 5 seconds elapsed, only send if status or title actually changed
    if (!force && !statusChanged && !titleChanged && !tokensChanged && timeElapsed < 5000) {
      return;
    }

    globalSessionThrottles.set(s.sessionId, now);
    globalSessionLastState.set(s.sessionId, { status: s.status, title: s.title, tokens: tokenFingerprint(s.tokens) });

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (process.env.DASHBOARD_TOKEN) headers['Authorization'] = 'Bearer ' + process.env.DASHBOARD_TOKEN;
      await fetch(HEARTBEAT_URL, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
          sessionId: s.sessionId,
          parentId: s.parentId,
          remove: s.remove === true,
          status: s.status,
          alarmEligible: s.alarmEligible === true,
          title: s.title,
          agent: s.agent,
          model: s.model,
          cost: s.cost,
          tokens: s.tokens,
          error: s.error,
          retryInfo: s.retryInfo,
          msgCount: s.msgCount,
          compactionCount: s.compactionCount,
          todos: s.todos,
          observedUsage: true,
          timestamp: now
        })
      });
    } catch (e) {}
  }

  async function closeSessionLocally(id, now) {
    const old = sessions.get(id);
    if (!old) return;
    old.status = 'closed';
    old.remove = true;
    old.waitingForUser = false;
    old.lastActivityTime = now;
    await sendReportForSession(old, now, true);
    knownParents.delete(id);
    sessions.delete(id);
  }

  async function sendAllReports(force = false) {
    const now = Date.now();
    for (const [id, s] of sessions.entries()) {
      const inactiveMs = now - s.lastActivityTime;

      // Quiet sub-agents can decay; top-level sessions should trust explicit OpenCode idle events.
      if (s.parentId && s.status === 'running' && inactiveMs > RUNNING_DECAY_MS) {
        s.status = s.waitingForUser ? 'user_response' : 'waiting';
      }

      // Quiet sub-agents should fade out of reporting instead of bouncing CLOSED -> RUNNING.
      if (s.parentId && !s.waitingForUser && s.status !== 'asking_parent' && inactiveMs > STALE_SUBAGENT_PRUNE_MS) {
        sessions.delete(id);
        continue;
      }

      await sendReportForSession(s, now, force);

      // Delete closed session from plugin map so heartbeats stop
      if (s.status === 'closed') {
        sessions.delete(id);
      }
    }
  }

  const eventHandler = async (arg1, arg2) => {
    let event = arg1 && arg1.event ? arg1.event : arg1;
    let session = arg1 && arg1.session ? arg1.session : arg2;

    let foundId = findSessionId(event, session, ctx);
    
    // Fallback to rootSessionId if event doesn't carry explicit session ID (e.g. question/permission events).
    // If sub-agents are active, anonymous prompts belong to the parent/sub-agent handoff and should not alarm the user.
    if (!foundId && rootSessionId) {
      if (isQuestionOrPermissionEvent(event)) {
        const activeSubAgent = findActiveSubAgent(rootSessionId, sessions);
        if (activeSubAgent) {
          const now = Date.now();
          activeSubAgent.status = 'asking_parent';
          activeSubAgent.waitingForUser = false;
          activeSubAgent.alarmEligible = false;
          activeSubAgent.lastActivityTime = now;
          await sendReportForSession(activeSubAgent, now, true);
          return;
        }
      }
      foundId = rootSessionId;
    }
    if (!foundId) return;

    let explicitParentId = findParentId(event, session);
    if (explicitParentId) {
      knownParents.set(foundId, explicitParentId);
    }

    if (!rootSessionId) {
      if (!explicitParentId) {
        rootSessionId = foundId;
      }
    }

    let effectiveParentId = explicitParentId || knownParents.get(foundId) || null;
    if (effectiveParentId === foundId) {
      knownParents.delete(foundId);
      effectiveParentId = null;
    }

    const isSubAgent = !!effectiveParentId;

    const rawTitle = findRawSessionTitle(event, session);
    const foundTitle = cleanTitle(rawTitle);
    const foundAgent = findAgentName(event, session);
    const foundModel = findModelName(event, session);

    const type = (event?.type || event?.event || event?.name || '').toLowerCase();
    const rawStatus = event?.properties?.status || event?.properties?.info?.status || session?.status || '';
    const coreStatus = (typeof rawStatus === 'string' ? rawStatus : (rawStatus && typeof rawStatus.type === 'string' ? rawStatus.type : '')).toLowerCase();

    const now = Date.now();
    let s = sessions.get(foundId);

    const isUserPrompt = isQuestionOrPermissionEvent(event);
    const isInterrupt = type.includes('interrupt') || type.includes('cancel') || type.includes('abort') || coreStatus === 'interrupted' || coreStatus === 'canceled' || coreStatus === 'aborted';

    // DIRECT OPENCODE CORE STATE MAPPING
    let status = s ? s.status : 'waiting';

    if (type === 'session.deleted' || type === 'session.closed' || type.includes('delete') || type.includes('close') || type.includes('end')) {
      status = 'closed';
      if (s) s.waitingForUser = false;
    } else if (isInterrupt) {
      status = 'interrupted';
      if (s) s.waitingForUser = false;
    } else if (coreStatus === 'retry' || type.includes('retry')) {
      status = 'retrying';
      if (s) s.waitingForUser = false;
    } else if (isUserPrompt || type.startsWith('permission') || type.startsWith('question')) {
      status = isSubAgent ? 'asking_parent' : 'user_response';
      if (s) s.waitingForUser = !isSubAgent;
    } else if (coreStatus === 'busy' || type.includes('busy') || type.includes('tool') || type.includes('execut') || type.includes('running') || type.includes('delta')) {
      status = 'running';
      if (s) s.waitingForUser = false;
      if (s) s.error = null;
    } else if (coreStatus === 'idle' || type === 'session.idle' || type === 'idle') {
      status = (s && (s.status === 'interrupted' || isInterruptedError(s.error))) ? 'interrupted' : 'waiting';
      if (s) s.waitingForUser = false;
    } else if (type.includes('error') || type.includes('fail') || type.includes('exception')) {
      status = 'failed';
      if (s) s.waitingForUser = false;
    } else if (s && s.waitingForUser) {
      status = 'user_response';
    }

    const isSessionCreate = type === 'session.created' || type === 'session.create';

    if (isSessionCreate && !isSubAgent && activeTopLevelSessionId && activeTopLevelSessionId !== foundId) {
      for (const [id, oldSession] of Array.from(sessions.entries())) {
        if (id === activeTopLevelSessionId || oldSession.parentId === activeTopLevelSessionId) {
          await closeSessionLocally(id, now);
        }
      }
    }
    if (!isSubAgent && status !== 'closed') {
      activeTopLevelSessionId = foundId;
      rootSessionId = foundId;
    }

    if (!s) {
      s = {
        sessionId: foundId,
        parentId: effectiveParentId,
        title: foundTitle || (effectiveParentId ? 'Sub-Agent Task' : 'Active Terminal'),
        agent: formatAgentName(foundAgent, isSubAgent),
        model: formatModelName(foundModel),
        status: status,
        waitingForUser: isUserPrompt && !isSubAgent,
        alarmEligible: status === 'user_response' && isUserPrompt && !isSubAgent,
        baseCost: isSessionCreate ? 0 : undefined,
        rawCost: undefined,
        completedMessageIDs: new Set(),
        lastActivityTime: now
      };
      sessions.set(foundId, s);
    } else {
      s.parentId = effectiveParentId;
      if (foundTitle && foundTitle !== 'Active Terminal' && foundTitle !== 'Sub-Agent Task') {
        s.title = foundTitle;
      }
      if (foundAgent) s.agent = formatAgentName(foundAgent, isSubAgent);
      if (foundModel) s.model = formatModelName(foundModel);

      s.lastActivityTime = now;
      s.status = status;
      s.alarmEligible = status === 'user_response' && isUserPrompt && !isSubAgent;
    }

    // ================== Extended telemetry capture ==================
    const props = event?.properties || {};
    const info = props.info || {};
    const part = props.part || {};

    // 1. Cost: show usage observed in this dashboard session, not persisted totals.
    if (typeof info.cost === 'number') {
      s.rawCost = typeof s.rawCost === 'number' ? Math.max(s.rawCost, info.cost) : info.cost;
      if (typeof s.baseCost !== 'number') s.baseCost = isSessionCreate ? 0 : s.rawCost;
      s.cost = Math.max(0, s.rawCost - s.baseCost);
    }
    if (
      type === 'message.updated' &&
      info &&
      info.role === 'assistant' &&
      info.tokens &&
      typeof info.tokens === 'object' &&
      info.time &&
      typeof info.time.completed === 'number'
    ) {
      const messageKey = completedMessageKey(info);
      if (messageKey && !s.completedMessageIDs.has(messageKey)) {
        s.completedMessageIDs.add(messageKey);
        s.tokens = addTokens(s.tokens, info.tokens);
      }
    }

    // 2. Error: from session.error / message error
    const err = props.error || info.error || {};
    if (err && typeof err === 'object' && (err.message || err.name || (err.data && err.data.message))) {
      s.error = (err.data && err.data.message) || err.message || err.name;
    }

    // 3. Retry info: from session.status (type=retry) or RetryPart
    const st = props.status || props.info?.status || {};
    if (st && st.type === 'retry') {
      s.retryInfo = { attempt: st.attempt, next: st.next, message: st.message };
    } else if (part.type === 'retry' && part.error) {
      s.retryInfo = { attempt: part.attempt, message: (part.error && part.error.message) || '' };
    }

    // 4. Message count: new messages only
    if (type === 'message.updated') s.msgCount = (s.msgCount || 0) + 1;

    // 5. Compaction count: compaction parts / events
    if (part.type === 'compaction' || type.includes('compaction')) s.compactionCount = (s.compactionCount || 0) + 1;

    // 6. Todos: todo.updated events carry the full array
    if (type === 'todo.updated' && Array.isArray(props.todos)) s.todos = props.todos;

    // Send report immediately if status or title changed
    await sendReportForSession(s, now);

    if (status === 'closed') {
      knownParents.delete(foundId);
      sessions.delete(foundId);
      if (activeTopLevelSessionId === foundId) activeTopLevelSessionId = null;
      return;
    }

    if (!heartbeatTimer) {
      heartbeatTimer = setInterval(() => sendAllReports(), 2500);
    }
  };

  try {
    if (ctx?.events?.on) {
      ctx.events.on('event', (event, session) => eventHandler(event, session));
    } else if (ctx?.client?.on) {
      ctx.client.on('event', (arg) => eventHandler(arg));
    }
  } catch (e) {}

  ensureServer().catch(() => {});

  return {
    event: eventHandler,
    cleanup: () => {
      disposed = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (leaseSocket && !leaseSocket.destroyed) leaseSocket.destroy();
    }
  };
}

async function DashboardReporterPluginV1(ctx) {
  return setupPlugin(ctx);
}

DashboardReporterPluginV1.id = "agent-dashboard-reporter";
DashboardReporterPluginV1.setup = async (ctx) => {
  return setupPlugin(ctx);
};

export default DashboardReporterPluginV1;

// ====================================================================
// SECTION 2: Web Server & Real-Time Telemetry Engine
// ====================================================================
const activeSessions = new Map();
const serverLastLogs = new Map();
const subAgentMetricSnapshots = new Map();
const sessionTokenFileCache = new Map();
const DEBUG_SESSION_ROOT = path.join(os.homedir(), '.config', 'opencode', 'debug');

function subAgentMetricKey(parentId, sessionId) {
  return parentId + '\0' + sessionId;
}

function rememberSubAgentMetrics(parentId, sessionId, data) {
  if (!isSessionId(parentId) || !isSessionId(sessionId)) return;

  const key = subAgentMetricKey(parentId, sessionId);
  const current = subAgentMetricSnapshots.get(key) || { parentId, sessionId };
  subAgentMetricSnapshots.set(key, {
    parentId,
    sessionId,
    cost: (typeof data.cost === 'number' && isFinite(data.cost))
      ? Math.max(typeof current.cost === 'number' ? current.cost : 0, data.cost)
      : current.cost,
    tokens: data.tokens && typeof data.tokens === 'object'
      ? preferSessionTokens(current.tokens, data.tokens)
      : current.tokens,
    msgCount: (typeof data.msgCount === 'number')
      ? Math.max(current.msgCount || 0, data.msgCount)
      : (current.msgCount || 0)
  });
}

function forgetSubAgentMetricsForParent(parentId) {
  for (const [key, snapshot] of subAgentMetricSnapshots.entries()) {
    if (snapshot.parentId === parentId) subAgentMetricSnapshots.delete(key);
  }
}

function getSubAgentMetricTotals(parentId) {
  let costValue = 0;
  let tokensValue;
  let msgCount = 0;

  for (const snapshot of subAgentMetricSnapshots.values()) {
    if (snapshot.parentId !== parentId) continue;
    if (typeof snapshot.cost === 'number' && isFinite(snapshot.cost)) costValue += snapshot.cost;
    tokensValue = addTokens(tokensValue, snapshot.tokens);
    msgCount += snapshot.msgCount || 0;
  }

  return { costValue, tokensValue, msgCount };
}

function findDebugSessionDir(sessionId) {
  if (!isSessionId(sessionId)) return null;
  try {
    const entries = fs.readdirSync(DEBUG_SESSION_ROOT, { withFileTypes: true });
    const match = entries.find((entry) => entry.isDirectory() && entry.name.startsWith(sessionId + '('));
    return match ? path.join(DEBUG_SESSION_ROOT, match.name) : null;
  } catch {
    return null;
  }
}

function latestSessionJsonFile(sessionDir) {
  try {
    const files = fs.readdirSync(sessionDir)
      .map((name) => (/^(\d+)\.json$/.exec(name) ? { name, order: Number(/^(\d+)\.json$/.exec(name)[1]) } : null))
      .filter(Boolean)
      .sort((a, b) => b.order - a.order);
    return files.length ? path.join(sessionDir, files[0].name) : null;
  } catch {
    return null;
  }
}

function readPersistedSessionTokens(sessionId) {
  const sessionDir = findDebugSessionDir(sessionId);
  if (!sessionDir) return undefined;
  const jsonFile = latestSessionJsonFile(sessionDir);
  if (!jsonFile) return undefined;

  try {
    const stat = fs.statSync(jsonFile);
    const cacheKey = jsonFile;
    const cached = sessionTokenFileCache.get(cacheKey);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.tokens;

    const raw = fs.readFileSync(jsonFile, 'utf8');
    const data = JSON.parse(raw);
    const totals = Array.isArray(data)
      ? data.reduce((sum, message) => {
          const info = message && typeof message === 'object' ? message.info : null;
          if (!info || info.role !== 'assistant' || !info.tokens || !info.time || typeof info.time.completed !== 'number') return sum;
          return addTokens(sum, info.tokens);
        }, undefined)
      : undefined;

    sessionTokenFileCache.set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size, tokens: totals });
    return totals;
  } catch {
    return undefined;
  }
}

function log(tag, message) {
  const time = new Date().toLocaleTimeString();
  console.log(`[${time}] [${tag}] ${message}`);
}

function startServer() {
  log('INIT', `Starting Web Server on port ${DASHBOARD_PORT}...`);

  // ---- Write-protection: heartbeats require a bearer token (read endpoints stay open).
  //      If DASHBOARD_TOKEN is unset, the server stays open (backwards compatible).
  const TOKEN = process.env.DASHBOARD_TOKEN || null;
  function tokenMatches(req) {
    if (!TOKEN) return true;
    const auth = req.headers['authorization'] || '';
    const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const a = crypto.createHash('sha256').update(provided).digest();
    const b = crypto.createHash('sha256').update(TOKEN).digest();
    return crypto.timingSafeEqual(a, b);
  }

  // ---- Lease tracking: each opencode terminal holds one TCP lease. When the last
  //      lease drops, the dashboard server shuts itself down (no terminals = no dashboard).
  const leaseSockets = new Set();
  let shutdownTimer = null;
  const SHUTDOWN_GRACE_MS = 30000;

  const leaseServer = net.createServer((socket) => {
    leaseSockets.add(socket);
    socket.on('close', () => {
      leaseSockets.delete(socket);
      if (leaseSockets.size === 0) {
        if (!shutdownTimer) {
          shutdownTimer = setTimeout(() => {
            if (leaseSockets.size === 0) {
              log('SHUTDOWN', `No active terminals for ${SHUTDOWN_GRACE_MS / 1000}s, shutting down dashboard server.`);
              process.exit(0);
            }
          }, SHUTDOWN_GRACE_MS);
        }
      } else if (shutdownTimer) {
        clearTimeout(shutdownTimer);
        shutdownTimer = null;
      }
    });
  });

  leaseServer.listen(LEASE_PORT, '127.0.0.1', () => {
    log('INIT', `Lease listener active on port ${LEASE_PORT}`);
  });

  setInterval(() => {
    const now = Date.now();
    for (const [id, session] of activeSessions.entries()) {
      // Stale sessions should disappear quietly unless an explicit close event was received.
      if (session.status !== 'closed' && now - session.lastHeartbeat > STALE_HEARTBEAT_PURGE_MS) {
        log('PURGE', `Session heartbeat expired: ${shortId(id)} (${session.title})`);
        if (!session.parentId) forgetSubAgentMetricsForParent(id);
        activeSessions.delete(id);
        continue;
      }

      // Retain explicit closed sessions briefly before purging completely.
      if (session.status === 'closed' && session.closedAt && (now - session.closedAt > CLOSED_SESSION_RETENTION_MS)) {
        log('PURGE', `Closed session retention expired (${CLOSED_SESSION_RETENTION_MS / 1000}s): ${shortId(id)} (${session.title})`);
        if (!session.parentId) forgetSubAgentMetricsForParent(id);
        activeSessions.delete(id);
      }
    }
  }, 1000);

  function parseStatusInfo(statusStr) {
    switch (statusStr) {
      case 'running': return { type: 'running', label: 'Running', color: 'green' };
      case 'user_response': return { type: 'user_response', label: 'Waiting for User Response', color: 'yellow' };
      case 'asking_parent': return { type: 'asking_parent', label: 'ASKING PARENT', color: 'yellow' };
      case 'interrupted': return { type: 'interrupted', label: 'Waiting (Interrupted)', color: 'orange' };
      case 'retrying': return { type: 'retrying', label: 'Retrying', color: 'skyblue' };
      case 'failed': return { type: 'failed', label: 'Failed', color: 'red' };
      case 'closed': return { type: 'closed', label: 'Closed', color: 'gray' };
      case 'waiting': return { type: 'waiting', label: 'Waiting (Idle)', color: 'white' };
      default: return { type: 'unknown', label: 'UNKNOWN', color: 'white' };
    }
  }

  function formatCompactDuration(ms) {
    if (!ms || ms < 0) return '0:00';
    const totalSeconds = Math.floor(ms / 1000);
    const seconds = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const minutes = totalMinutes % 60;
    const hours = Math.floor(totalMinutes / 60);

    const secStr = String(seconds).padStart(2, '0');

    if (hours > 0) {
      const minStr = String(minutes).padStart(2, '0');
      return `${hours}:${minStr}:${secStr}`;
    }
    return `${minutes}:${secStr}`;
  }

  function formatCost(cost) {
    if (typeof cost !== 'number' || !isFinite(cost)) return null;
    return '$' + cost.toFixed(2);
  }

  function formatTokens(tokens) {
    const normalized = normalizeTokens(tokens);
    if (!normalized) return null;
    const fmt = (n) => {
      if (typeof n !== 'number' || !isFinite(n)) return null;
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
      return String(n);
    };
    const parts = [];
    const input = fmt(normalized.input);
    const cache = fmt(normalized.cache.read + normalized.cache.write);
    const output = fmt(normalized.output + normalized.reasoning);
    if (input !== null) parts.push(input + ' in');
    if (cache !== null && normalized.cache.read + normalized.cache.write > 0) parts.push(cache + ' cache');
    if (output !== null) parts.push(output + ' out');
    return parts.length ? parts.join(' / ') : null;
  }

  function applyFormattedMetrics(card) {
    card.cost = formatCost(card.costValue);
    card.tokens = formatTokens(card.tokensValue);
    card.subAgentCost = card.subAgentCostValue > 0 ? formatCost(card.subAgentCostValue) : null;
    card.subAgentTokens = tokenTotal(card.subAgentTokensValue) > 0 ? formatTokens(card.subAgentTokensValue) : null;
  }

  function buildCardData(id, s, now) {
    const displayStatus = s.status === 'user_response' && s.alarmEligible !== true ? 'waiting' : s.status;
    const visibleStatus = displayStatus === 'waiting' && isInterruptedError(s.error) ? 'interrupted' : displayStatus;
    const isWaitingState = visibleStatus === 'waiting' || visibleStatus === 'user_response' || visibleStatus === 'asking_parent' || visibleStatus === 'interrupted';
    const waitingTimeMs = isWaitingState ? (now - s.statusChangedAt) : 0;
    const endTime = s.closedAt ? s.closedAt : now;
    const runtimeMs = visibleStatus === 'running'
      ? Math.max(0, endTime - (s.runningSince || s.statusChangedAt || s.startTime))
      : Math.max(0, s.lastRuntimeMs || 0);
    const uptimeMs = Math.max(0, endTime - s.startTime);

    const card = {
      id: id,
      title: cleanTitle(s.title) || s.title,
      agent: s.agent || 'Build',
      model: s.model || 'Claude Haiku 4.5',
      parentId: s.parentId,
      status: parseStatusInfo(visibleStatus),
      alarmEligible: s.alarmEligible === true,
      startTime: s.startTime,
      totalUptime: formatCompactDuration(uptimeMs),
      runtime: formatCompactDuration(runtimeMs),
      waitingTime: isWaitingState ? formatCompactDuration(waitingTimeMs) : null,
      isCacheCold: isWaitingState && waitingTimeMs >= COLD_CACHE_MS,
      costValue: (typeof s.cost === 'number' && isFinite(s.cost)) ? s.cost : undefined,
      tokensValue: s.tokens,
      subAgentCostValue: 0,
      subAgentTokensValue: undefined,
      subAgentMsgCount: 0,
      cost: null,
      tokens: null,
      subAgentCost: null,
      subAgentTokens: null,
      error: s.error || null,
      retryInfo: s.retryInfo || null,
      msgCount: s.msgCount || 0,
      compactionCount: s.compactionCount || 0,
      todos: Array.isArray(s.todos) ? s.todos : [],
      subAgents: []
    };
    const persistedTokens = readPersistedSessionTokens(id);
    if (persistedTokens) card.tokensValue = persistedTokens;
    applyFormattedMetrics(card);
    return card;
  }

  function hasInProgressTodo(card) {
    return Array.isArray(card.todos) && card.todos.some(t => t && t.status === 'in_progress');
  }

  function getCards() {
    const now = Date.now();
    const sessionCardsMap = new Map();

    for (const [id, s] of activeSessions.entries()) {
      sessionCardsMap.set(id, buildCardData(id, s, now));
    }

    const rootCards = [];

    for (const [id, card] of sessionCardsMap.entries()) {
      if (card.parentId && sessionCardsMap.has(card.parentId)) {
        const parentCard = sessionCardsMap.get(card.parentId);
        parentCard.subAgents.push(card);
      } else {
        rootCards.push(card);
      }
    }

    // Parent cards include their direct sub-agent usage and stay running while active work is tracked.
    for (const card of rootCards) {
      let hasActiveSubAgent = false;
      const subAgentTotals = getSubAgentMetricTotals(card.id);
      if (subAgentTotals.costValue > 0 || tokenTotal(subAgentTotals.tokensValue) > 0 || subAgentTotals.msgCount > 0) {
        card.subAgentCostValue = subAgentTotals.costValue;
        card.subAgentTokensValue = subAgentTotals.tokensValue;
        card.subAgentMsgCount = subAgentTotals.msgCount;
        if (typeof card.costValue === 'number' && isFinite(card.costValue)) card.costValue += subAgentTotals.costValue;
        else if (subAgentTotals.costValue > 0) card.costValue = subAgentTotals.costValue;
        card.tokensValue = addTokens(card.tokensValue, subAgentTotals.tokensValue);
        card.msgCount = (card.msgCount || 0) + subAgentTotals.msgCount;
        applyFormattedMetrics(card);
      }
      if (card.subAgents && card.subAgents.length > 0) {
        hasActiveSubAgent = card.subAgents.some(sub => sub.status.type === 'running' || sub.status.type === 'asking_parent' || hasInProgressTodo(sub));
      }
      if (hasActiveSubAgent && card.status.type !== 'closed' && card.status.type !== 'interrupted') {
        card.status = parseStatusInfo('running');
        card.waitingTime = null;
        card.isCacheCold = false;
      }
    }

    rootCards.sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
    for (const card of rootCards) {
      if (card.subAgents.length > 0) {
        card.subAgents.sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
      }
    }

    return rootCards;
  }

  function generateDashboardHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>OpenCode Terminal Dashboard</title>
  <script>
    window.openStates = window.openStates || {};
    window.lastStatuses = window.lastStatuses || {};

    window.dashboardLabels = {};
    try { window.dashboardLabels = JSON.parse(localStorage.getItem('dashboardLabels') || '{}'); } catch(e) {}

    var labelColors = ['blue', 'green', 'red', 'yellow', 'orange', 'purple', 'pink', 'cyan', 'gray', 'white'];
    function labelData(id) {
      var value = window.dashboardLabels[id];
      if (!value) return null;
      if (typeof value !== 'object') return null;
      return { text: value.text || '', color: value.color || 'blue' };
    }
    function existingLabels() {
      var seen = {};
      var labels = [];
      Object.keys(window.dashboardLabels).forEach(function(id) {
        var data = labelData(id);
        if (!data || !data.text || seen[data.text]) return;
        seen[data.text] = true;
        labels.push(data);
      });
      labels.sort(function(a, b) { return a.text.localeCompare(b.text); });
      return labels;
    }
    function getLabel(id) {
      var data = labelData(id);
      return data && data.text ? data.text : null;
    }
    function getLabelColor(id) {
      var data = labelData(id);
      return data && data.color ? data.color : 'blue';
    }
    function setLabel(id, label) {
      if (label) window.dashboardLabels[id] = { text: label, color: getLabelColor(id) }; else delete window.dashboardLabels[id];
      try { localStorage.setItem('dashboardLabels', JSON.stringify(window.dashboardLabels)); } catch(e) {}
    }
    function setLabelColor(id, color) {
      var text = getLabel(id);
      if (!text || labelColors.indexOf(color) === -1) return;
      window.dashboardLabels[id] = { text: text, color: color };
      try { localStorage.setItem('dashboardLabels', JSON.stringify(window.dashboardLabels)); } catch(e) {}
    }
    function setExistingLabel(id, data) {
      if (!data || !data.text) return;
      window.dashboardLabels[id] = { text: data.text, color: data.color || 'blue' };
      try { localStorage.setItem('dashboardLabels', JSON.stringify(window.dashboardLabels)); } catch(e) {}
    }

    function addExistingLabelsSubmenu(menu, id, labels) {
      if (!labels.length) return;
      var wrap = document.createElement('div');
      wrap.className = 'context-submenu-wrap';
      var trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'context-submenu-trigger';
      trigger.textContent = 'Labels';
      var submenu = document.createElement('div');
      submenu.className = 'context-submenu';
      labels.forEach(function(data) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'label-pick label-' + data.color;
        btn.textContent = data.text;
        btn.onclick = function(e) { e.stopPropagation(); setExistingLabel(id, data); refresh(); closeMenu(); };
        submenu.appendChild(btn);
      });
      wrap.appendChild(trigger);
      wrap.appendChild(submenu);
      menu.appendChild(wrap);
    }

    function labelBadge(id) {
      var l = getLabel(id);
      return l ? '<span class="session-label label-' + esc(getLabelColor(id)) + '">' + esc(l) + '</span>' : '';
    }

    function closeMenu() {
      if (window._labelMenu) { window._labelMenu.remove(); window._labelMenu = null; }
    }

    function showLabelMenu(x, y, id) {
      closeMenu();
      var menu = document.createElement('div');
      menu.className = 'context-menu';
      var setBtn = document.createElement('button');
      setBtn.textContent = 'Set label...';
      setBtn.onclick = function() {
        var v = prompt('Label for session:', getLabel(id) || '');
        if (v !== null) { setLabel(id, v.trim()); refresh(); }
        closeMenu();
      };
      var clearBtn = document.createElement('button');
      clearBtn.textContent = 'Remove label';
      clearBtn.onclick = function() { setLabel(id, null); refresh(); closeMenu(); };
      menu.appendChild(setBtn);
      var labels = existingLabels();
      addExistingLabelsSubmenu(menu, id, labels);
      if (getLabel(id)) {
        var colorTitle = document.createElement('div');
        colorTitle.className = 'context-menu-title';
        colorTitle.textContent = 'Set label color';
        menu.appendChild(colorTitle);
        var colorGrid = document.createElement('div');
        colorGrid.className = 'label-color-grid';
        labelColors.forEach(function(color) {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'label-color-choice label-' + color;
          btn.title = color.charAt(0).toUpperCase() + color.slice(1);
          btn.onclick = function(e) { e.stopPropagation(); setLabelColor(id, color); refresh(); };
          colorGrid.appendChild(btn);
        });
        menu.appendChild(colorGrid);
      }
      menu.appendChild(clearBtn);
      menu.style.left = x + 'px';
      menu.style.top = y + 'px';
      document.body.appendChild(menu);
      window._labelMenu = menu;
      setTimeout(function() { document.addEventListener('click', closeMenu, { once: true }); }, 0);
    }

    document.addEventListener('contextmenu', function(e) {
      var el = e.target.closest ? e.target.closest('.card, .sub-card') : null;
      if (!el) return;
      var id = el.getAttribute('data-session-id');
      if (!id) return;
      e.preventDefault();
      showLabelMenu(e.clientX, e.clientY, id);
    });

    function shortId(id) {
      if (!id || typeof id !== 'string') return 'none';
      return id.length > 6 ? '...' + id.slice(-6) : id;
    }

    function esc(s) {
      return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function statusTitle(c) {
      if (c.error && (c.status.type === 'interrupted' || c.status.type === 'failed')) {
        return 'Error: ' + c.error;
      }
      if (c.status.type === 'retrying' && c.retryInfo) {
        var r = c.retryInfo;
        var t = 'Retry';
        if (typeof r.attempt === 'number') t += ' ' + r.attempt + (typeof r.next === 'number' ? '/' + r.next : '');
        if (r.message) t += ': ' + r.message;
        return t;
      }
      return '';
    }

    function metaLine(c, extended, compact) {
      var line1 = [];
      if (!compact) {
        line1.push('<span class="label">Uptime:</span> <span class="value timer-value">' + c.totalUptime + '</span>');
        line1.push('<span class="divider">-</span> <span class="label">Runtime:</span> <span class="value timer-value">' + c.runtime + '</span>');
        if (c.waitingTime) line1.push('<span class="divider">-</span> <span class="label">Idle:</span> <span class="value timer-value highlight-waiting">' + c.waitingTime + '</span>' + (c.isCacheCold ? ' <span class="cold-cache" title="Cache cold">&#10052;</span>' : ''));
      }

      var line2 = [];
      var line3 = [];
      function pushMetric(html) {
        if (line2.length) line2.push('<span class="divider">-</span> ' + html);
        else line2.push(html);
      }
      if (extended && c.msgCount > 0) pushMetric('<span class="label">Msgs:</span> <span class="value">' + c.msgCount + ' (' + (c.subAgentMsgCount || 0) + ')' + '</span>');
      if (extended && c.cost) pushMetric('<span class="label">Cost:</span> <span class="value">' + esc(c.cost) + '</span>');
      if (extended && c.compactionCount > 0) pushMetric('<span class="label">Compactions:</span> <span class="value">' + c.compactionCount + '</span>');
      if (extended && c.tokens) line3.push('<span class="label">Tokens:</span> <span class="value" title="In = tokens sent to the model (prompt, context, tools) / Out = tokens generated by the model (response, reasoning)">' + esc(c.tokens) + '</span>');

      var html = '<div>' + line1.join('') + '</div>';
      if (line2.length) html += '<div>' + line2.join('') + '</div>';
      if (line3.length) html += '<div>' + line3.join('') + '</div>';
      return html;
    }

    function todoIcon(status) {
      if (status === 'completed') return '&#9745;';
      if (status === 'in_progress') return '&#9680;';
      if (status === 'cancelled') return '&#10005;';
      return '&#9633;';
    }

    function todoColor(status) {
      if (status === 'completed') return '#22c55e';
      if (status === 'in_progress') return '#eab308';
      if (status === 'cancelled') return '#64748b';
      return '#94a3b8';
    }

    function todosHTML(c) {
      if (!c.todos || c.todos.length === 0) return '';
      var done = c.todos.filter(function(t) { return t.status === 'completed'; }).length;
      var autoFoldTodos = localStorage.getItem('dashboardAutoFoldTodos') !== 'no';
      var isOpen = autoFoldTodos ? window.openStates['todo-' + c.id] === true : true;
      var openAttr = isOpen ? ' open' : '';
      var items = c.todos.map(function(t) {
        return '<div class="todo-row" style="color:' + todoColor(t.status) + '">' +
          '<span class="todo-icon">' + todoIcon(t.status) + '</span> ' +
          '<span class="todo-text">' + esc(t.content) + '</span>' +
          (t.priority ? '<span class="todo-priority">' + esc(t.priority) + '</span>' : '') +
        '</div>';
      }).join('');
      return '<div class="todos-container">' +
        '<details data-card-id="todo-' + c.id + '" class="todos-details"' + openAttr + '>' +
          '<summary class="todos-summary">' +
            '<span class="chevron">&#9654;</span> TODOS (' + done + '/' + c.todos.length + '):' +
          '</summary>' +
          '<div class="todos-list">' + items + '</div>' +
        '</details>' +
      '</div>';
    }

    function beep(freq, dur) {
      try {
        if (!window.audioCtx) window.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        var ctx = window.audioCtx;
        if (ctx.state === 'suspended') ctx.resume();
        var lowFreq = Math.max(180, freq * 0.75);
        var half = dur / 2;

        function playTone(startAt, toneFreq, toneDur) {
          var o = ctx.createOscillator();
          var g = ctx.createGain();
          o.connect(g);
          g.connect(ctx.destination);
          o.type = 'sine';
          o.frequency.value = toneFreq;
          g.gain.setValueAtTime(0.3, startAt);
          g.gain.exponentialRampToValueAtTime(0.0001, startAt + toneDur);
          o.start(startAt);
          o.stop(startAt + toneDur);
        }

        playTone(ctx.currentTime, lowFreq, half);
        playTone(ctx.currentTime + half, freq, half);
      } catch(e) {}
    }

    function checkAlarms(cards, jobsDone, errors, users) {
      if (!jobsDone && !errors && !users) { window.lastStatuses = {}; return; }
      var now = {};
      cards.forEach(function(c) { now[c.id] = { status: c.status.type, alarmEligible: c.alarmEligible === true }; });
      Object.keys(now).forEach(function(id) {
        var prev = window.lastStatuses[id];
        if (prev && prev.status !== now[id].status) {
          if (now[id].status === 'failed' && errors) beep(880, 1.0);
          else if (now[id].status === 'user_response' && now[id].alarmEligible && users) beep(660, 0.6);
          else if (now[id].status === 'closed' && jobsDone) beep(520, 0.6);
        }
      });
      window.lastStatuses = now;
    }

    function renderSubAgent(sub, mode, grouping) {
      var extended = mode === 'extended';
      var compact = mode === 'compact';
      var badgeTitle = statusTitle(sub);
      var showLabelBadge = grouping !== 'label';
      return '<div class="sub-card status-' + sub.status.color + '" data-session-id="' + sub.id + '">' +
        '<div class="card-header">' +
          '<div class="sub-session-title">&#129302; ' + esc(sub.title) + (showLabelBadge ? labelBadge(sub.id) : '') + '</div>' +
          '<div class="subtitle-row">' +
            '<span class="sub-session-subtitle">' + esc(sub.agent) + ' (' + esc(sub.model) + ')</span>' +
            '<span class="badge badge-' + sub.status.color + '"' + (badgeTitle ? ' title="' + esc(badgeTitle) + '"' : '') + '>' + sub.status.label + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="card-body">' +
          '<div class="time-compact">' + metaLine(sub, extended, compact) + '</div>' +
        '</div>' +
        todosHTML(sub) +
      '</div>';
    }

    function cardHTML(c, mode, grouping) {
      var compact = mode === 'compact';
      var autoFoldAgents = localStorage.getItem('dashboardAutoFoldAgents') !== 'no';
      var isOpen = autoFoldAgents ? window.openStates[c.id] === true : true;
      var openAttr = isOpen ? ' open' : '';
      var badgeTitle = statusTitle(c);
      var showLabelBadge = grouping !== 'label';

      var subAgentsHTML = (c.subAgents && c.subAgents.length > 0)
        ? '<div class="sub-agents-container">' +
            '<details data-card-id="' + c.id + '" class="sub-agents-details"' + openAttr + '>' +
              '<summary class="sub-agents-summary">' +
                '<span class="chevron">&#9654;</span> ACTIVE SUB-AGENTS (' + c.subAgents.length + '):' +
              '</summary>' +
              '<div class="sub-agents-list">' +
                c.subAgents.map(function(sub) { return renderSubAgent(sub, mode, grouping); }).join('') +
              '</div>' +
            '</details>' +
          '</div>'
        : '';

      return '<div class="card status-' + c.status.color + '" data-session-id="' + c.id + '">' +
        '<div class="card-header">' +
          '<div class="session-title">' + esc(c.title) + (showLabelBadge ? labelBadge(c.id) : '') + '</div>' +
          '<div class="subtitle-row">' +
            '<span class="session-subtitle">' + esc(c.agent) + ' (' + esc(c.model) + ')</span>' +
            '<span class="badge badge-' + c.status.color + '"' + (badgeTitle ? ' title="' + esc(badgeTitle) + '"' : '') + '>' + c.status.label + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="card-body">' +
          '<div class="time-compact">' + metaLine(c, mode === 'extended', compact) + '</div>' +
        '</div>' +
        todosHTML(c) +
        subAgentsHTML +
        (compact ? '' : '<div class="card-footer">Session ID: ' + esc(c.id) + '</div>') +
      '</div>';
    }

    function statusGroup(c) {
      var type = c.status && c.status.type;
      if (type === 'failed' || type === 'interrupted' || type === 'retrying') return 'Error';
      if (type === 'user_response' || type === 'asking_parent') return 'User Request';
      if (type === 'running') return 'Running';
      if (type === 'waiting') return 'Waiting';
      if (type === 'closed') return 'Closed';
      return 'Unknown';
    }

    function groupColor(label, cards) {
      if (label === 'Error') return 'red';
      if (label === 'User Request') return 'yellow';
      if (label === 'Running') return 'green';
      if (label === 'Waiting') return 'white';
      if (label === 'Closed') return 'gray';
      if (label === 'Unknown' || label === 'Unlabeled') return 'white';
      for (var i = 0; cards && i < cards.length; i++) {
        var data = labelData(cards[i].id);
        if (data && data.text === label && data.color) return data.color;
      }
      return cards && cards[0] && cards[0].status && cards[0].status.color ? cards[0].status.color : 'white';
    }

    function groupedHTML(cards, mode, grouping) {
      if (grouping === 'none') return cards.map(function(c) { return cardHTML(c, mode, grouping); }).join('');

      var groups = [];
      if (grouping === 'label') {
        var hasLabels = cards.some(function(c) { return !!getLabel(c.id); });
        if (!hasLabels) return cards.map(function(c) { return cardHTML(c, mode, 'none'); }).join('');
        var labelMap = {};
        cards.forEach(function(c) {
          var key = getLabel(c.id) || 'Unlabeled';
          if (!labelMap[key]) labelMap[key] = [];
          labelMap[key].push(c);
        });
        Object.keys(labelMap).sort(function(a, b) {
          if (a === 'Unlabeled') return 1;
          if (b === 'Unlabeled') return -1;
          return a.localeCompare(b);
        }).forEach(function(label) { groups.push({ label: label, labelGroup: true, color: groupColor(label, labelMap[label]), cards: labelMap[label] }); });
      } else if (grouping === 'status') {
        ['Error', 'User Request', 'Running', 'Waiting', 'Closed', 'Unknown'].forEach(function(label) {
          var items = cards.filter(function(c) { return statusGroup(c) === label; });
          if (items.length) groups.push({ label: label, color: groupColor(label, items), cards: items });
        });
      }

      return groups.map(function(group) {
        var groupKey = 'group-' + grouping + '-' + group.label;
        var isOpen = window.openStates[groupKey] !== false;
        return '<section class="group-box group-' + esc(group.color) + '">' +
          '<button type="button" class="group-header' + (group.labelGroup ? ' label-group' : '') + '" data-group-key="' + esc(groupKey) + '">' +
            '<span class="chevron">' + (isOpen ? '&#9660;' : '&#9654;') + '</span> ' + esc(group.label) + ' (' + group.cards.length + ')' +
          '</button>' +
          '<div class="group-body' + (isOpen ? '' : ' collapsed') + '">' +
            '<div class="group-cards grid">' + group.cards.map(function(c) { return cardHTML(c, mode, grouping); }).join('') + '</div>' +
          '</div>' +
        '</section>';
      }).join('');
    }

    function render(cards) {
      var container = document.getElementById('grid');
      var mode = localStorage.getItem('dashboardInfoMode') || 'standard';
      var grouping = localStorage.getItem('dashboardGrouping') || 'none';
      var q = document.getElementById('filterInput').value.trim().toLowerCase();

      checkAlarms(cards,
        localStorage.getItem('dashboardAlarmJobsDone') === 'yes',
        localStorage.getItem('dashboardAlarmErrors') === 'yes',
        localStorage.getItem('dashboardAlarmUsers') === 'yes');

      // Preserve open/closed state of accordion elements across 1-second auto-refreshes
      document.querySelectorAll('.sub-agents-details[data-card-id], .todos-details[data-card-id]').forEach(function(el) {
        var cardId = el.getAttribute('data-card-id');
        if (cardId) {
          window.openStates[cardId] = el.open;
        }
      });

      if (q) {
        cards = cards.filter(function(c) {
          var hay = (c.title + ' ' + c.agent + ' ' + c.status.label).toLowerCase();
          return hay.indexOf(q) !== -1;
        });
      }

      if (!cards || cards.length === 0) {
        container.className = 'grid';
        container.innerHTML = '<div class="offline-box">' +
          '<div class="offline-title">No open OpenCode terminals detected.</div>' +
          '<div class="offline-tip">Open a terminal window and run opencode to see live session status.</div>' +
        '</div>';
        return;
      }

      var html = groupedHTML(cards, mode, grouping);
      container.className = grouping === 'none' || html.indexOf('group-box') === -1 ? 'grid' : 'grouped-grid';
      container.innerHTML = html;
    }

    function loadSettings() {
      if (!localStorage.getItem('dashboardInfoMode')) localStorage.setItem('dashboardInfoMode', 'standard');
      if (!localStorage.getItem('dashboardGrouping')) localStorage.setItem('dashboardGrouping', 'none');
      [['dashboardAlarmJobsDone', 'no'], ['dashboardAlarmErrors', 'no'], ['dashboardAlarmUsers', 'no'], ['dashboardAutoFoldTodos', 'yes'], ['dashboardAutoFoldAgents', 'yes']].forEach(function(pair) {
        if (!localStorage.getItem(pair[0])) localStorage.setItem(pair[0], pair[1]);
      });

      function updateMenuState() {
        document.querySelectorAll('[data-setting][data-value]').forEach(function(btn) {
          var setting = btn.getAttribute('data-setting');
          var value = btn.getAttribute('data-value');
          btn.classList.toggle('active', localStorage.getItem(setting) === value);
        });
        document.querySelectorAll('[data-toggle]').forEach(function(btn) {
          var key = btn.getAttribute('data-toggle');
          var on = localStorage.getItem(key) === 'yes';
          btn.classList.toggle('active', on);
          btn.textContent = on ? 'ON' : 'OFF';
        });
      }

      document.querySelectorAll('[data-setting][data-value]').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.preventDefault();
          e.stopPropagation();
          localStorage.setItem(btn.getAttribute('data-setting'), btn.getAttribute('data-value'));
          updateMenuState();
          refresh();
        });
      });
      document.querySelectorAll('[data-toggle]').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.preventDefault();
          e.stopPropagation();
          var key = btn.getAttribute('data-toggle');
          localStorage.setItem(key, localStorage.getItem(key) === 'yes' ? 'no' : 'yes');
          updateMenuState();
          refresh();
        });
      });

      var settingsMenu = document.getElementById('settingsMenu');
      var settingsWrap = document.getElementById('settingsWrap');
      var settingsButton = document.getElementById('settingsButton');
      var settingsCloseTimer = null;
      function openSettings() {
        if (settingsCloseTimer) clearTimeout(settingsCloseTimer);
        settingsMenu.classList.add('open');
      }
      function closeSettings() { settingsMenu.classList.remove('open'); }
      function scheduleCloseSettings() { settingsCloseTimer = setTimeout(closeSettings, 100); }
      settingsButton.addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); openSettings(); });
      settingsWrap.addEventListener('mouseenter', openSettings);
      settingsWrap.addEventListener('mouseleave', scheduleCloseSettings);
      document.getElementById('grid').addEventListener('click', function(e) {
        var header = e.target.closest ? e.target.closest('.group-header[data-group-key]') : null;
        if (!header) return;
        var key = header.getAttribute('data-group-key');
        window.openStates[key] = window.openStates[key] === false;
        refresh();
      });
      updateMenuState();
      document.getElementById('filterInput').addEventListener('input', refresh);
    }

    async function refresh() {
      try {
        const res = await fetch('/api/data');
        const cards = await res.json();
        render(cards);
      } catch(e) {}
    }

    setInterval(refresh, 1000);
    window.onload = function() { loadSettings(); refresh(); };
  </script>
  <style>
    body { background-color: #0f172a; color: #f8fafc; font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 24px; }
    h1 { margin-top: 0; font-size: 1.5rem; color: #94a3b8; margin-bottom: 20px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, 360px); gap: 20px; align-items: start; }
    .card { width: 360px; box-sizing: border-box; background: #1e293b; border-radius: 8px; border-left: 6px solid #64748b; padding: 16px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.3); display: flex; flex-direction: column; transition: all 0.3s ease; }
    .card.status-white { border-left-color: #f3f4f6; }
    .card.status-green { border-left-color: #22c55e; }
    .card.status-red { border-left-color: #ef4444; }
    .card.status-yellow { border-left-color: #eab308; }
    .card.status-orange { border-left-color: #f97316; }
    .card.status-skyblue { border-left-color: #38bdf8; }
    .card.status-gray { border-left-color: #64748b; opacity: 0.65; }
    
    .card-header { display: flex; flex-direction: column; margin-bottom: 10px; gap: 4px; }
    .session-title { font-weight: bold; font-size: 1.1rem; line-height: 1.2; word-break: break-word; }
    .subtitle-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 2px; }
    .session-subtitle { font-size: 0.85rem; color: #94a3b8; font-weight: 500; }
    .badge { font-size: 0.75rem; padding: 4px 8px; border-radius: 4px; font-weight: 600; text-transform: uppercase; white-space: nowrap; }
    .badge-white { background: #ffffff; color: #0f172a; }
    .badge-green { background: #22c55e; color: #052e16; }
    .badge-red { background: #ef4444; color: #450a0a; }
    .badge-yellow { background: #eab308; color: #422006; }
    .badge-orange { background: #f97316; color: #431407; }
    .badge-skyblue { background: #38bdf8; color: #082f49; }
    .badge-gray { background: #64748b; color: #f8fafc; }
    
    .time-compact { font-size: 0.8rem; color: #cbd5e1; margin-bottom: 6px; }
    .time-compact .label { color: #94a3b8; }
    .time-compact .value { font-weight: 600; color: #f8fafc; }
    .time-compact .timer-value { display: inline-block; min-width: 5.36ch; text-align: right; font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; font-variant-numeric: tabular-nums; }
    .time-compact .divider { margin: 0 6px; color: #475569; }
    .time-compact .highlight-waiting { color: #fde047; font-weight: 600; }
    .time-compact .cold-cache { color: #7dd3fc; font-size: 0.9rem; vertical-align: middle; }
    .time-compact > div + div { margin-top: 2px; }
    .session-label { display: inline-block; margin-left: 8px; font-size: 0.7rem; font-weight: 600; color: #0f172a; background: #7dd3fc; border-radius: 4px; padding: 1px 6px; vertical-align: middle; }
    .label-blue { background: #38bdf8 !important; color: #082f49 !important; }
    .label-green { background: #22c55e !important; color: #052e16 !important; }
    .label-red { background: #ef4444 !important; color: #450a0a !important; }
    .label-yellow { background: #eab308 !important; color: #422006 !important; }
    .label-orange { background: #f97316 !important; color: #431407 !important; }
    .label-purple { background: #a855f7 !important; color: #2e1065 !important; }
    .label-pink { background: #ec4899 !important; color: #500724 !important; }
    .label-cyan { background: #06b6d4 !important; color: #083344 !important; }
    .label-gray { background: #64748b !important; color: #f8fafc !important; }
    .label-white { background: #f3f4f6 !important; color: #0f172a !important; }
    .context-menu { position: fixed; background: #1e293b; border: 1px solid #334155; border-radius: 6px; box-shadow: 0 8px 16px rgba(0, 0, 0, 0.4); padding: 4px; z-index: 1000; min-width: 140px; }
    .context-menu button { display: block; width: 100%; text-align: left; background: none; border: none; color: #f8fafc; padding: 6px 10px; font-size: 0.8rem; font-family: system-ui, -apple-system, sans-serif; cursor: pointer; border-radius: 4px; }
    .context-menu button:hover { background: #334155; }
    .context-menu-title { color: #94a3b8; font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; padding: 6px 8px 3px; }
    .context-submenu-wrap { position: relative; }
    .context-submenu-trigger::after { content: '›'; float: right; }
    .context-submenu { display: none; position: absolute; left: 100%; top: 0; min-width: 150px; background: #1e293b; border: 1px solid #334155; border-radius: 6px; box-shadow: 0 8px 16px rgba(0, 0, 0, 0.4); padding: 4px; }
    .context-submenu-wrap:hover .context-submenu { display: block; }
    .label-color-grid { display: grid; grid-template-columns: repeat(5, 20px); gap: 5px; padding: 4px 8px 8px; }
    .context-menu .label-color-choice { width: 20px; height: 20px; padding: 0; border: 1px solid #0f172a; border-radius: 50%; }
    .context-menu .label-color-choice:hover { outline: 2px solid #f8fafc; background: inherit; }

    .controls { display: flex; gap: 10px; margin-bottom: 20px; align-items: center; flex-wrap: nowrap; position: relative; }
    .controls input {
      background: #1e293b; color: #f8fafc; border: 1px solid #334155; border-radius: 6px;
      padding: 8px 12px; font-size: 0.85rem; font-family: system-ui, -apple-system, sans-serif;
    }
    .controls input { flex: 1; min-width: 180px; }
    .controls input::placeholder { color: #64748b; }
    .settings-wrap { position: relative; flex: 0 0 auto; }
    .settings-button { width: 38px; height: 38px; border-radius: 6px; border: 1px solid #334155; background: #1e293b; color: #cbd5e1; font-size: 1.1rem; cursor: pointer; }
    .settings-button:hover { border-color: #475569; color: #f8fafc; }
    .settings-menu { display: none; position: absolute; right: 0; top: 44px; z-index: 1000; min-width: 260px; background: #111827; border: 1px solid #334155; border-radius: 8px; box-shadow: 0 12px 28px rgba(0,0,0,0.45); padding: 12px; }
    .settings-menu.open { display: block; }
    .settings-section + .settings-section { margin-top: 12px; padding-top: 12px; border-top: 1px solid #334155; }
    .settings-heading { color: #94a3b8; font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 7px; }
    .settings-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 6px; }
    .settings-options { display: flex; gap: 6px; flex-wrap: wrap; }
    .settings-option, .settings-toggle { border: 1px solid #334155; background: #0f172a; color: #cbd5e1; border-radius: 6px; padding: 5px 8px; font-size: 0.78rem; font-family: system-ui, -apple-system, sans-serif; cursor: pointer; }
    .settings-option:hover, .settings-toggle:hover { border-color: #475569; color: #f8fafc; }
    .settings-option.active, .settings-toggle.active { background: #38bdf8; border-color: #38bdf8; color: #082f49; font-weight: 700; }
    .settings-row-label { color: #cbd5e1; font-size: 0.82rem; }
    .grouped-grid { display: flex; flex-direction: column; gap: 18px; }
    .group-box { position: relative; border: 1px solid #334155; border-left: 4px solid #f3f4f6; border-radius: 10px; padding: 22px 16px 16px; background: #172033; }
    .group-header { position: absolute; top: -14px; left: 16px; display: inline-flex; align-items: center; gap: 6px; margin: 0; background: #f3f4f6; color: #0f172a; border: 1px solid #334155; border-radius: 6px; padding: 4px 10px; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; white-space: nowrap; cursor: pointer; }
    .group-header.label-group { font-size: calc(0.72rem + 2px); }
    .group-body.collapsed { display: none; }
    .group-white { border-left-color: #f3f4f6; }
    .group-white .group-header { background: #f3f4f6; color: #0f172a; }
    .group-green { border-left-color: #22c55e; }
    .group-green .group-header { background: #22c55e; color: #052e16; }
    .group-red { border-left-color: #ef4444; }
    .group-red .group-header { background: #ef4444; color: #450a0a; }
    .group-yellow { border-left-color: #eab308; }
    .group-yellow .group-header { background: #eab308; color: #422006; }
    .group-orange { border-left-color: #f97316; }
    .group-orange .group-header { background: #f97316; color: #431407; }
    .group-skyblue { border-left-color: #38bdf8; }
    .group-skyblue .group-header { background: #38bdf8; color: #082f49; }
    .group-gray { border-left-color: #64748b; }
    .group-gray .group-header { background: #64748b; color: #f8fafc; }
    .group-blue { border-left-color: #38bdf8; }
    .group-blue .group-header { background: #38bdf8; color: #082f49; }
    .group-purple { border-left-color: #a855f7; }
    .group-purple .group-header { background: #a855f7; color: #2e1065; }
    .group-pink { border-left-color: #ec4899; }
    .group-pink .group-header { background: #ec4899; color: #500724; }
    .group-cyan { border-left-color: #06b6d4; }
    .group-cyan .group-header { background: #06b6d4; color: #083344; }
    .group-cards { margin-left: 8px; }

    .card-footer { margin-top: auto; padding-top: 10px; font-size: 0.7rem; color: #64748b; border-top: 1px solid #334155; }
    
    /* Sub-Agent Nested Styles & Collapsible Accordion */
    .sub-agents-container { margin-top: 12px; padding-top: 12px; border-top: 1px dashed #334155; }
    .sub-agents-details { width: 100%; }
    .sub-agents-summary { 
      font-size: 0.8rem; 
      font-weight: 600; 
      color: #94a3b8; 
      margin-bottom: 8px; 
      text-transform: uppercase; 
      letter-spacing: 0.05em; 
      cursor: pointer; 
      user-select: none;
      list-style: none;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .sub-agents-summary::-webkit-details-marker { display: none; }
    .sub-agents-summary:hover { color: #f8fafc; }
    .chevron { display: inline-block; font-size: 0.7rem; transition: transform 0.2s ease; color: #64748b; }
    .sub-agents-details[open] .chevron { transform: rotate(90deg); }
    .sub-agents-details:not([open]) .chevron { transform: rotate(0deg); }
    .sub-agents-list { margin-top: 8px; }

    /* Todos accordion */
    .todos-container { margin-top: 10px; padding-top: 10px; border-top: 1px dashed #334155; }
    .todos-details { width: 100%; }
    .todos-summary {
      font-size: 0.8rem;
      font-weight: 600;
      color: #94a3b8;
      margin-bottom: 8px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      cursor: pointer;
      user-select: none;
      list-style: none;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .todos-summary::-webkit-details-marker { display: none; }
    .todos-summary:hover { color: #f8fafc; }
    .todos-details[open] .chevron { transform: rotate(90deg); }
    .todos-details:not([open]) .chevron { transform: rotate(0deg); }
    .todos-list { margin-top: 6px; display: flex; flex-direction: column; gap: 4px; }
    .todo-row { display: flex; align-items: center; gap: 8px; font-size: 0.82rem; padding: 3px 4px; }
    .todo-icon { flex-shrink: 0; }
    .todo-text { flex: 1; word-break: break-word; }
    .todo-priority { font-size: 0.7rem; text-transform: uppercase; color: #64748b; flex-shrink: 0; }

    .sub-card { background: #0f172a; border-radius: 6px; border-left: 4px solid #64748b; padding: 10px 12px; margin-bottom: 8px; box-shadow: inset 0 2px 4px rgba(0,0,0,0.2); transition: all 0.3s ease; }
    .sub-card.status-white { border-left-color: #f3f4f6; }
    .sub-card.status-green { border-left-color: #22c55e; }
    .sub-card.status-red { border-left-color: #ef4444; }
    .sub-card.status-yellow { border-left-color: #eab308; }
    .sub-card.status-orange { border-left-color: #f97316; }
    .sub-card.status-skyblue { border-left-color: #38bdf8; }
    .sub-card.status-gray { border-left-color: #64748b; opacity: 0.65; }
    .sub-session-title { font-weight: 600; font-size: 0.95rem; line-height: 1.2; color: #e2e8f0; word-break: break-word; }
    .sub-session-subtitle { font-size: 0.8rem; color: #64748b; font-weight: 500; }

    .offline-box { background: #1e293b; padding: 24px; border-radius: 8px; text-align: center; width: 100%; grid-column: 1 / -1; }
    .offline-title { color: #f8fafc; font-weight: bold; font-size: 1.1rem; margin-bottom: 8px; }
    .offline-tip { color: #94a3b8; font-size: 0.9rem; }
    @media (max-width: 430px) {
      .grid { grid-template-columns: 1fr; }
      .card { width: 100%; }
    }
  </style>
</head>
<body>
  <h1>OpenCode Active Terminals Dashboard</h1>
  <div class="controls">
    <input id="filterInput" type="text" placeholder="Filter: title, agent, status..." />
    <div id="settingsWrap" class="settings-wrap">
      <button id="settingsButton" class="settings-button" type="button" title="Dashboard settings">&#9881;</button>
      <div id="settingsMenu" class="settings-menu">
        <div class="settings-section">
          <div class="settings-heading">View</div>
          <div class="settings-options">
            <button class="settings-option" type="button" data-setting="dashboardInfoMode" data-value="compact">Compact</button>
            <button class="settings-option" type="button" data-setting="dashboardInfoMode" data-value="standard">Normal</button>
            <button class="settings-option" type="button" data-setting="dashboardInfoMode" data-value="extended">Extended</button>
          </div>
        </div>
        <div class="settings-section">
          <div class="settings-heading">Grouping</div>
          <div class="settings-options">
            <button class="settings-option" type="button" data-setting="dashboardGrouping" data-value="status">Status</button>
            <button class="settings-option" type="button" data-setting="dashboardGrouping" data-value="label">Label</button>
            <button class="settings-option" type="button" data-setting="dashboardGrouping" data-value="none">None</button>
          </div>
        </div>
        <div class="settings-section">
          <div class="settings-heading">Alarms</div>
          <div class="settings-row"><span class="settings-row-label">Jobs</span><button class="settings-toggle" type="button" data-toggle="dashboardAlarmJobsDone">OFF</button></div>
          <div class="settings-row"><span class="settings-row-label">User request</span><button class="settings-toggle" type="button" data-toggle="dashboardAlarmUsers">OFF</button></div>
          <div class="settings-row"><span class="settings-row-label">Errors</span><button class="settings-toggle" type="button" data-toggle="dashboardAlarmErrors">OFF</button></div>
        </div>
        <div class="settings-section">
          <div class="settings-heading">Auto Folding</div>
          <div class="settings-row"><span class="settings-row-label">TODOS</span><button class="settings-toggle" type="button" data-toggle="dashboardAutoFoldTodos">ON</button></div>
          <div class="settings-row"><span class="settings-row-label">AGENTS</span><button class="settings-toggle" type="button" data-toggle="dashboardAutoFoldAgents">ON</button></div>
        </div>
      </div>
    </div>
  </div>
  <div id="content">
    <div id="grid" class="grid">Listening for active terminal heartbeats...</div>
  </div>
</body>
</html>`;
  }

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/heartbeat') {
      if (!tokenMatches(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
        return;
      }
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);

          if (data.sessionId && isSessionId(data.sessionId)) {
            const now = Date.now();
            const reportTimestamp = typeof data.timestamp === 'number' && isFinite(data.timestamp) ? data.timestamp : now;
            const existing = activeSessions.get(data.sessionId);

            if (existing && typeof existing.lastReportTimestamp === 'number' && reportTimestamp < existing.lastReportTimestamp) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));
              return;
            }

            const lastLog = serverLastLogs.get(data.sessionId) || { time: 0, status: '', title: '' };

            const statusChanged = data.status !== lastLog.status;
            const titleChanged = data.title !== lastLog.title;
            const logTimeElapsed = now - lastLog.time;

            // Console log ONLY when status/title changes or every 10 seconds
            if (statusChanged || titleChanged || logTimeElapsed >= 10000) {
              log('HEARTBEAT-IN', `[${data.agent || 'Main'}] session=${shortId(data.sessionId)} status=${data.status} title="${data.title}" parent=${data.parentId ? shortId(data.parentId) : 'none'}`);
              serverLastLogs.set(data.sessionId, { time: now, status: data.status, title: data.title });
            }

            if (data.parentId && isSessionId(data.parentId)) {
              rememberSubAgentMetrics(data.parentId, data.sessionId, data);
            }

            if (data.status === 'closed') {
              log('CLOSE', `Terminal closed signal received: ${shortId(data.sessionId)}`);
              if (data.remove === true) {
                if (!data.parentId || !isSessionId(data.parentId)) forgetSubAgentMetricsForParent(data.sessionId);
                activeSessions.delete(data.sessionId);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
                return;
              }
              if (existing) {
                const wasRunning = existing.status === 'running';
                const runningSince = existing.runningSince || existing.statusChangedAt || existing.startTime || now;
                if (wasRunning) {
                  existing.lastRuntimeMs = Math.max(0, now - runningSince);
                }
                existing.status = 'closed';
                existing.runningSince = null;
                existing.lastHeartbeat = now;
                existing.lastReportTimestamp = reportTimestamp;
                existing.statusChangedAt = now;
                if (!existing.closedAt) existing.closedAt = now;
              } else {
                activeSessions.set(data.sessionId, {
                  title: cleanTitle(data.title) || 'Closed Terminal',
                  agent: data.agent || 'Build',
                  model: data.model || 'Claude Haiku 4.5',
                  parentId: (data.parentId && isSessionId(data.parentId)) ? data.parentId : null,
                  status: 'closed',
                  startTime: now,
                  statusChangedAt: now,
                  closedAt: now,
                  lastHeartbeat: now,
                  lastReportTimestamp: reportTimestamp,
                  runningSince: null,
                  lastRuntimeMs: 0,
                  cost: data.cost,
                  tokens: data.tokens,
                  error: data.error,
                  retryInfo: data.retryInfo,
                  msgCount: data.msgCount || 0,
                  compactionCount: data.compactionCount || 0,
                  todos: data.todos
                });
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));
              return;
            }

            if (data.parentId && isSessionId(data.parentId) && !activeSessions.has(data.parentId)) {
              activeSessions.set(data.parentId, {
                title: 'Active Main Terminal',
                agent: 'Build',
                model: 'Claude Haiku 4.5',
                parentId: null,
                status: 'running',
                startTime: now,
                statusChangedAt: now,
                lastHeartbeat: now,
                lastReportTimestamp: reportTimestamp,
                runningSince: now,
                lastRuntimeMs: 0
              });
              log('PARENT-AUTO', `Created parent placeholder: ${shortId(data.parentId)}`);
            }

            const validParentId = (data.parentId && isSessionId(data.parentId)) ? data.parentId : null;
            const isNew = !activeSessions.has(data.sessionId);
            const current = activeSessions.get(data.sessionId);
            
            let rawTitle = cleanTitle(data.title) || (validParentId ? 'Sub-Agent Task' : 'Active Terminal');
            if (current && current.title && current.title !== 'Active Terminal' && current.title !== 'Sub-Agent Task' && (rawTitle === 'Active Terminal' || rawTitle === 'Sub-Agent Task')) {
              rawTitle = current.title;
            }

            const incomingStatus = data.status === 'user_response' && data.alarmEligible !== true ? 'waiting' : data.status;
            const incomingError = Object.prototype.hasOwnProperty.call(data, 'error') ? data.error : (current ? current.error : undefined);
            const normalizedStatus = incomingStatus === 'waiting' && isInterruptedError(incomingError) ? 'interrupted' : incomingStatus;
            const prevStatus = current ? current.status : null;
            const isStatusChanged = prevStatus !== normalizedStatus;
            const statusChangedAt = isStatusChanged ? now : (current ? current.statusChangedAt : now);
            const runningSince = (() => {
              if (normalizedStatus === 'running') {
                if (prevStatus === 'running' && current && current.runningSince) return current.runningSince;
                return now;
              }
              return null;
            })();
            const lastRuntimeMs = (() => {
              if (!current) return 0;
              if (prevStatus === 'running' && normalizedStatus !== 'running') {
                const startedAt = current.runningSince || current.statusChangedAt || current.startTime || now;
                return Math.max(0, now - startedAt);
              }
              return current.lastRuntimeMs || 0;
            })();

            const costState = (() => {
              if (typeof data.cost !== 'number' || !isFinite(data.cost)) {
                return {
                  cost: current ? current.cost : undefined,
                  rawCost: current ? current.rawCost : undefined,
                  baseCost: current ? current.baseCost : undefined
                };
              }
              if (data.observedUsage === true) {
                return { cost: data.cost, rawCost: undefined, baseCost: undefined };
              }
              const rawCost = current && typeof current.rawCost === 'number' ? Math.max(current.rawCost, data.cost) : data.cost;
              const baseCost = current && typeof current.baseCost === 'number' ? current.baseCost : rawCost;
              return { cost: Math.max(0, rawCost - baseCost), rawCost: rawCost, baseCost: baseCost };
            })();

            const tokenState = {
              tokens: current ? current.tokens : undefined,
              rawTokens: current ? current.rawTokens : undefined,
              baseTokens: current ? current.baseTokens : undefined
            };

            const nextSession = {
              title: rawTitle,
              agent: data.agent || (current ? current.agent : 'Build'),
              model: data.model || (current ? current.model : 'Claude Haiku 4.5'),
              parentId: validParentId,
              status: normalizedStatus,
              alarmEligible: normalizedStatus === 'user_response' && data.alarmEligible === true,
              startTime: current ? current.startTime : now,
              statusChangedAt: statusChangedAt,
              closedAt: null,
              lastHeartbeat: now,
              lastReportTimestamp: reportTimestamp,
              runningSince: runningSince,
              lastRuntimeMs: lastRuntimeMs,
              cost: costState.cost,
              rawCost: costState.rawCost,
              baseCost: costState.baseCost,
              tokens: tokenState.tokens,
              rawTokens: tokenState.rawTokens,
              baseTokens: tokenState.baseTokens,
              error: incomingError,
              retryInfo: data.retryInfo || (current ? current.retryInfo : undefined),
              msgCount: (typeof data.msgCount === 'number') ? data.msgCount : (current ? current.msgCount : 0),
              compactionCount: (typeof data.compactionCount === 'number') ? data.compactionCount : (current ? current.compactionCount : 0),
              todos: data.todos || (current ? current.todos : undefined)
            };

            activeSessions.set(data.sessionId, nextSession);
            if (validParentId) rememberSubAgentMetrics(validParentId, data.sessionId, nextSession);

            if (isNew) {
              log('HEARTBEAT-NEW', `>>> NEW SESSION CONNECTED: ${rawTitle} (${shortId(data.sessionId)})${validParentId ? ` [Sub-agent of ${shortId(validParentId)}]` : ''}`);
            }
          }
        } catch (e) {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    } else if (req.url === '/api/data') {
      const cards = getCards();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(cards));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(generateDashboardHTML());
    }
  });

  server.listen(DASHBOARD_PORT, '0.0.0.0', () => {
    log('INIT', `🚀 Server active at http://localhost:${DASHBOARD_PORT}`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startServer();
}
