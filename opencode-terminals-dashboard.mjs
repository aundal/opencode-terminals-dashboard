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
const RUNNING_DECAY_MS = 12000;
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
  }
  if (event) {
    if (typeof event.sessionId === 'string' && isSessionId(event.sessionId)) return event.sessionId;
    if (typeof event.session_id === 'string' && isSessionId(event.session_id)) return event.session_id;
    if (typeof event.sessionID === 'string' && isSessionId(event.sessionID)) return event.sessionID;
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
  if (!tokens || typeof tokens !== 'object') return 0;
  let total = 0;
  for (const value of Object.values(tokens)) {
    if (typeof value === 'number' && isFinite(value)) total += value;
  }
  return total;
}

function preferSessionTokens(currentTokens, nextTokens) {
  if (!nextTokens || typeof nextTokens !== 'object') return currentTokens;
  if (!currentTokens || typeof currentTokens !== 'object') return nextTokens;
  return tokenTotal(nextTokens) >= tokenTotal(currentTokens) ? nextTokens : currentTokens;
}

function zeroTokensLike(tokens) {
  const out = {};
  if (!tokens || typeof tokens !== 'object') return out;
  for (const key of Object.keys(tokens)) out[key] = 0;
  return out;
}

function subtractTokens(totalTokens, baseTokens) {
  if (!totalTokens || typeof totalTokens !== 'object') return undefined;
  const out = {};
  for (const key of Object.keys(totalTokens)) {
    const total = typeof totalTokens[key] === 'number' && isFinite(totalTokens[key]) ? totalTokens[key] : 0;
    const base = baseTokens && typeof baseTokens[key] === 'number' && isFinite(baseTokens[key]) ? baseTokens[key] : 0;
    out[key] = Math.max(0, total - base);
  }
  return out;
}

function addTokens(a, b) {
  const out = {};
  for (const tokens of [a, b]) {
    if (!tokens || typeof tokens !== 'object') continue;
    for (const [key, value] of Object.entries(tokens)) {
      if (typeof value === 'number' && isFinite(value)) out[key] = (out[key] || 0) + value;
    }
  }
  return Object.keys(out).length ? out : undefined;
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
    const timeElapsed = now - lastTime;

    // RULE 1: Module-level hard rate limit — Never send more than 1 report per 1000ms for the same session across all instances
    if (!force && !statusChanged && timeElapsed < 1000) {
      return;
    }

    // RULE 2: Heartbeat interval — If < 5 seconds elapsed, only send if status or title actually changed
    if (!force && !statusChanged && !titleChanged && timeElapsed < 5000) {
      return;
    }

    globalSessionThrottles.set(s.sessionId, now);
    globalSessionLastState.set(s.sessionId, { status: s.status, title: s.title });

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

      // Inactivity Decay: If session was marked 'running', but no events arrived for 12s, decay to 'waiting'
      if (s.status === 'running' && inactiveMs > RUNNING_DECAY_MS) {
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
        baseTokens: undefined,
        rawCost: undefined,
        rawTokens: undefined,
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

    // 1. Cost / tokens: show usage observed in this dashboard session, not persisted totals.
    if (typeof info.cost === 'number') {
      s.rawCost = typeof s.rawCost === 'number' ? Math.max(s.rawCost, info.cost) : info.cost;
      if (typeof s.baseCost !== 'number') s.baseCost = isSessionCreate ? 0 : s.rawCost;
      s.cost = Math.max(0, s.rawCost - s.baseCost);
    }
    if (info.tokens && typeof info.tokens === 'object') {
      s.rawTokens = preferSessionTokens(s.rawTokens, info.tokens);
      if (!s.baseTokens || typeof s.baseTokens !== 'object') s.baseTokens = isSessionCreate ? zeroTokensLike(s.rawTokens) : s.rawTokens;
      s.tokens = subtractTokens(s.rawTokens, s.baseTokens);
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
        activeSessions.delete(id);
        continue;
      }

      // Retain explicit closed sessions briefly before purging completely.
      if (session.status === 'closed' && session.closedAt && (now - session.closedAt > CLOSED_SESSION_RETENTION_MS)) {
        log('PURGE', `Closed session retention expired (${CLOSED_SESSION_RETENTION_MS / 1000}s): ${shortId(id)} (${session.title})`);
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
    if (!tokens || typeof tokens !== 'object') return null;
    const fmt = (n) => {
      if (typeof n !== 'number' || !isFinite(n)) return null;
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
      return String(n);
    };
    const parts = [];
    const input = fmt(tokens.input);
    const output = fmt(tokens.output);
    if (input !== null) parts.push(input + ' in');
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
    applyFormattedMetrics(card);
    return card;
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

    // Parent cards include their direct sub-agent usage and stay running while sub-agents are active.
    for (const card of rootCards) {
      if (card.subAgents && card.subAgents.length > 0) {
        let subAgentCostValue = 0;
        let subAgentTokensValue;
        let subAgentMsgCount = 0;
        for (const sub of card.subAgents) {
          if (typeof sub.costValue === 'number' && isFinite(sub.costValue)) subAgentCostValue += sub.costValue;
          subAgentTokensValue = addTokens(subAgentTokensValue, sub.tokensValue);
          subAgentMsgCount += sub.msgCount || 0;
        }

        card.subAgentCostValue = subAgentCostValue;
        card.subAgentTokensValue = subAgentTokensValue;
        card.subAgentMsgCount = subAgentMsgCount;
        if (typeof card.costValue === 'number' && isFinite(card.costValue)) card.costValue += subAgentCostValue;
        else if (subAgentCostValue > 0) card.costValue = subAgentCostValue;
        card.tokensValue = addTokens(card.tokensValue, subAgentTokensValue);
        card.msgCount = (card.msgCount || 0) + subAgentMsgCount;
        applyFormattedMetrics(card);

        const hasActiveSubAgent = card.subAgents.some(sub => sub.status.type === 'running' || sub.status.type === 'asking_parent');
        if (hasActiveSubAgent && card.status.type !== 'closed') {
          card.status = parseStatusInfo('running');
          card.waitingTime = null;
          card.isCacheCold = false;
        }
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

    function getLabel(id) { return window.dashboardLabels[id] || null; }
    function setLabel(id, label) {
      if (label) window.dashboardLabels[id] = label; else delete window.dashboardLabels[id];
      try { localStorage.setItem('dashboardLabels', JSON.stringify(window.dashboardLabels)); } catch(e) {}
    }

    function labelBadge(id) {
      var l = getLabel(id);
      return l ? '<span class="session-label">' + esc(l) + '</span>' : '';
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
        line1.push('<span class="label">Uptime:</span> <span class="value">' + c.totalUptime + '</span>');
        line1.push('<span class="divider">-</span> <span class="label">Runtime:</span> <span class="value">' + c.runtime + '</span>');
        if (c.waitingTime) line1.push('<span class="divider">-</span> <span class="label">Idle:</span> <span class="value highlight-waiting">' + c.waitingTime + '</span>' + (c.isCacheCold ? ' <span class="cold-cache" title="Cache cold">&#10052;</span>' : ''));
      }

      var line2 = [];
      function pushMetric(html) {
        if (line2.length) line2.push('<span class="divider">-</span> ' + html);
        else line2.push(html);
      }
      if (extended && c.msgCount > 0) pushMetric('<span class="label">Msgs:</span> <span class="value">' + c.msgCount + (c.subAgentMsgCount > 0 ? ' (' + c.subAgentMsgCount + ')' : '') + '</span>');
      if (extended && c.cost) pushMetric('<span class="label">Cost:</span> <span class="value">' + esc(c.cost) + (c.subAgentCost ? ' (' + esc(c.subAgentCost) + ')' : '') + '</span>');
      if (extended && c.tokens) pushMetric('<span class="label">Tokens:</span> <span class="value" title="In = tokens sent to the model (prompt, context, tools) / Out = tokens generated by the model (response, reasoning)">' + esc(c.tokens) + (c.subAgentTokens ? ' (' + esc(c.subAgentTokens) + ')' : '') + '</span>');
      if (extended && c.compactionCount > 0) pushMetric('<span class="label">Compactions:</span> <span class="value">' + c.compactionCount + '</span>');

      var html = '<div>' + line1.join('') + '</div>';
      if (line2.length) html += '<div>' + line2.join('') + '</div>';
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
      var isOpen = window.openStates['todo-' + c.id] === true;
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
        var o = ctx.createOscillator();
        var g = ctx.createGain();
        o.connect(g);
        g.connect(ctx.destination);
        o.type = 'sine';
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.12, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
        o.start();
        o.stop(ctx.currentTime + dur);
      } catch(e) {}
    }

    function checkAlarms(cards, jobsDone, errors, users) {
      if (!jobsDone && !errors && !users) { window.lastStatuses = {}; return; }
      var now = {};
      cards.forEach(function(c) { now[c.id] = { status: c.status.type, alarmEligible: c.alarmEligible === true }; });
      Object.keys(now).forEach(function(id) {
        var prev = window.lastStatuses[id];
        if (prev && prev.status !== now[id].status) {
          if (now[id].status === 'failed' && errors) beep(880, 0.5);
          else if (now[id].status === 'user_response' && now[id].alarmEligible && users) beep(660, 0.3);
          else if (now[id].status === 'closed' && jobsDone) beep(520, 0.3);
        }
      });
      window.lastStatuses = now;
    }

    function renderSubAgent(sub, mode) {
      var extended = mode === 'extended';
      var compact = mode === 'compact';
      var badgeTitle = statusTitle(sub);
      return '<div class="sub-card status-' + sub.status.color + '" data-session-id="' + sub.id + '">' +
        '<div class="card-header">' +
          '<div class="sub-session-title">&#129302; ' + esc(sub.title) + labelBadge(sub.id) + '</div>' +
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

    function render(cards) {
      var container = document.getElementById('grid');
      var mode = document.getElementById('infoMode').value;
      var extended = mode === 'extended';
      var compact = mode === 'compact';
      var q = document.getElementById('filterInput').value.trim().toLowerCase();

      checkAlarms(cards,
        document.getElementById('alarmJobsDone').value === 'yes',
        document.getElementById('alarmErrors').value === 'yes',
        document.getElementById('alarmUsers').value === 'yes');

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
        container.innerHTML = '<div class="offline-box">' +
          '<div class="offline-title">No open OpenCode terminals detected.</div>' +
          '<div class="offline-tip">Open a terminal window and run opencode to see live session status.</div>' +
        '</div>';
        return;
      }

      var html = cards.map(function(c) {
        var isOpen = window.openStates[c.id] === true;
        var openAttr = isOpen ? ' open' : '';
        var badgeTitle = statusTitle(c);

        var subAgentsHTML = (c.subAgents && c.subAgents.length > 0)
          ? '<div class="sub-agents-container">' +
              '<details data-card-id="' + c.id + '" class="sub-agents-details"' + openAttr + '>' +
                '<summary class="sub-agents-summary">' +
                  '<span class="chevron">&#9654;</span> ACTIVE SUB-AGENTS (' + c.subAgents.length + '):' +
                '</summary>' +
                '<div class="sub-agents-list">' +
                  c.subAgents.map(function(sub) { return renderSubAgent(sub, mode); }).join('') +
                '</div>' +
              '</details>' +
            '</div>'
          : '';

        return '<div class="card status-' + c.status.color + '" data-session-id="' + c.id + '">' +
          '<div class="card-header">' +
            '<div class="session-title">' + esc(c.title) + labelBadge(c.id) + '</div>' +
            '<div class="subtitle-row">' +
              '<span class="session-subtitle">' + esc(c.agent) + ' (' + esc(c.model) + ')</span>' +
              '<span class="badge badge-' + c.status.color + '"' + (badgeTitle ? ' title="' + esc(badgeTitle) + '"' : '') + '>' + c.status.label + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="card-body">' +
            '<div class="time-compact">' + metaLine(c, extended, compact) + '</div>' +
          '</div>' +
          todosHTML(c) +
          subAgentsHTML +
          (compact ? '' : '<div class="card-footer">Session ID: ' + shortId(c.id) + '</div>') +
        '</div>';
      }).join('');

      container.innerHTML = html;
    }

    function loadSettings() {
      var infoMode = document.getElementById('infoMode');
      var savedInfo = localStorage.getItem('dashboardInfoMode');
      if (savedInfo) infoMode.value = savedInfo;
      infoMode.addEventListener('change', function() { localStorage.setItem('dashboardInfoMode', infoMode.value); refresh(); });
      [
        ['alarmJobsDone', 'dashboardAlarmJobsDone'],
        ['alarmErrors', 'dashboardAlarmErrors'],
        ['alarmUsers', 'dashboardAlarmUsers']
      ].forEach(function(pair) {
        var sel = document.getElementById(pair[0]);
        var saved = localStorage.getItem(pair[1]);
        if (saved) sel.value = saved;
        sel.addEventListener('change', function() { localStorage.setItem(pair[1], sel.value); });
      });
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
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 20px; }
    .card { background: #1e293b; border-radius: 8px; border-left: 6px solid #64748b; padding: 16px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.3); display: flex; flex-direction: column; transition: all 0.3s ease; }
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
    .time-compact .divider { margin: 0 6px; color: #475569; }
    .time-compact .highlight-waiting { color: #fde047; font-weight: 600; }
    .time-compact .cold-cache { color: #7dd3fc; font-size: 0.9rem; vertical-align: middle; }
    .time-compact > div + div { margin-top: 2px; }
    .session-label { display: inline-block; margin-left: 8px; font-size: 0.7rem; font-weight: 600; color: #0f172a; background: #7dd3fc; border-radius: 4px; padding: 1px 6px; vertical-align: middle; }
    .context-menu { position: fixed; background: #1e293b; border: 1px solid #334155; border-radius: 6px; box-shadow: 0 8px 16px rgba(0, 0, 0, 0.4); padding: 4px; z-index: 1000; min-width: 140px; }
    .context-menu button { display: block; width: 100%; text-align: left; background: none; border: none; color: #f8fafc; padding: 6px 10px; font-size: 0.8rem; font-family: system-ui, -apple-system, sans-serif; cursor: pointer; border-radius: 4px; }
    .context-menu button:hover { background: #334155; }

    .controls { display: flex; gap: 12px; margin-bottom: 20px; align-items: center; flex-wrap: wrap; }
    .controls input, .controls select {
      background: #1e293b; color: #f8fafc; border: 1px solid #334155; border-radius: 6px;
      padding: 8px 12px; font-size: 0.85rem; font-family: system-ui, -apple-system, sans-serif;
    }
    .controls input { flex: 1; min-width: 180px; }
    .controls input::placeholder { color: #64748b; }
    .controls select { cursor: pointer; }
    .controls select:hover { border-color: #475569; }

    .alarm-section { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; background: #1e293b; border: 1px solid #334155; border-radius: 6px; padding: 6px 12px; }
    .alarm-title { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #94a3b8; margin-right: 4px; }
    .alarm-section label { display: flex; align-items: center; gap: 6px; font-size: 0.8rem; color: #cbd5e1; }
    .alarm-section select { background: #0f172a; color: #f8fafc; border: 1px solid #334155; border-radius: 6px; padding: 6px 8px; font-size: 0.8rem; font-family: system-ui, -apple-system, sans-serif; cursor: pointer; }
    .alarm-section select:hover { border-color: #475569; }

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
  </style>
</head>
<body>
  <h1>OpenCode Active Terminals Dashboard</h1>
  <div class="controls">
    <input id="filterInput" type="text" placeholder="Filter: title, agent, status..." />
    <select id="infoMode">
      <option value="compact">Compact</option>
      <option value="standard">Standard</option>
      <option value="extended">Extended</option>
    </select>
    <div class="alarm-section">
      <span class="alarm-title">Alarms</span>
      <label>Jobs done: <select id="alarmJobsDone"><option value="no">No</option><option value="yes">Yes</option></select></label>
      <label>Errors: <select id="alarmErrors"><option value="no">No</option><option value="yes">Yes</option></select></label>
      <label>User requests: <select id="alarmUsers"><option value="no">No</option><option value="yes">Yes</option></select></label>
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

            if (data.status === 'closed') {
              log('CLOSE', `Terminal closed signal received: ${shortId(data.sessionId)}`);
              if (data.remove === true) {
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

            const tokenState = (() => {
              if (!data.tokens || typeof data.tokens !== 'object') {
                return {
                  tokens: current ? current.tokens : undefined,
                  rawTokens: current ? current.rawTokens : undefined,
                  baseTokens: current ? current.baseTokens : undefined
                };
              }
              if (data.observedUsage === true) {
                return { tokens: data.tokens, rawTokens: undefined, baseTokens: undefined };
              }
              const rawTokens = preferSessionTokens(current ? current.rawTokens : undefined, data.tokens);
              const baseTokens = current && current.baseTokens && typeof current.baseTokens === 'object' ? current.baseTokens : rawTokens;
              return { tokens: subtractTokens(rawTokens, baseTokens), rawTokens: rawTokens, baseTokens: baseTokens };
            })();

            activeSessions.set(data.sessionId, {
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
            });

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
