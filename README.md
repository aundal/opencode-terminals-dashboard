# opencode-terminals-dashboard

Live dashboard for opencode agent sessions — browser-based, real-time, zero dependencies. Comes with an optional TUI sidebar plugin that shows live session status inside the opencode terminal UI.

![Status](https://img.shields.io/badge/status-active-brightgreen)

Tracks every opencode terminal in your network and shows its sessions as live cards: status, runtime, idle time, sub-agents, todos, cost/tokens, errors and retries. The dashboard server starts automatically with the first opencode terminal and shuts itself down when the last one closes.

## Features

- **Live session cards** — status, runtime, idle time, model and agent per session
- **Sub-agent trees** — nested cards for sub-agents, collapsible accordion
- **Statuses** — Running, Waiting (Idle), Waiting for User Response, Waiting (Interrupted), Retrying, Failed, Closed, UNKNOWN (fallback)
- **Sub-agent parent handoff** — sub-agents can show ASKING PARENT without triggering the user-response alarm; alarms only fire for verified parent prompts
- **Error tooltips** — hover a failed card to see the error message (`session.error` events)
- **Retry tooltips** — hover the Retrying badge for attempt count and reason (`retry` status, `RetryPart`)
- **Cost & tokens** — live usage observed since the dashboard saw the session; parent totals include sub-agent usage (extended mode)
- **Msg/Compaction counters** — message and compaction counts per session; parent message counts always show sub-agent messages in parentheses
- **Todos** — collapsible TODOS accordion with per-item status icons (pending / in_progress / completed / cancelled)
- **Filter** — filter cards by title, agent or status
- **Gear menu** — view mode, grouping mode and alarm toggles next to search
- **Auto folding** — toggle TODO and sub-agent accordion auto folding from the gear menu
- **Info modes** — *Compact*, *Normal* and *Extended* (cost, tokens, msgs, compactions)
- **Grouping** — group by status, label or no grouping
- **Label colors** — choose from 10 premade label colors from the right-click label menu
- **Alarm sounds** — Web Audio beeps on selected status transitions
- **Auto-start & auto-kill server** — spawned on demand by the first opencode terminal, exits 30s after the last terminal closes
- **Session replacement cleanup** — when `/new` creates a replacement session, the old conversation is removed from the live dashboard
- **Self-healing** — if the server dies, running terminals respawn it and immediately resync all sessions
- **TUI sidebar plugin** — foldable `Terminal Dashboard:` section in the opencode TUI sidebar with live per-session status

## Installation

1. Copy `opencode-terminals-dashboard.mjs` into your opencode plugins folder:

   ```
   ~/.config/opencode/plugins/opencode-terminals-dashboard.mjs
   ```

2. Restart opencode.

3. Open the dashboard in your browser:

   ```
   http://localhost:31337
   ```

### TUI Sidebar Plugin (optional)

Shows a foldable `Terminal Dashboard:` section in the opencode TUI sidebar. Each session is listed with a status dot and its title (capped at 35 chars); sub-agents are indented under their parent. Click a session to open it in the current terminal. Click the header to expand/collapse (state is persisted).

Status colors:

| Status | Color |
|--------|-------|
| running | green |
| user_response | yellow |
| failed / interrupted | red |
| retrying | orange |
| closed | gray |
| waiting / unknown | white |

1. Copy the sidebar plugin into your opencode plugins folder:

   ```
   ~/.config/opencode/plugins/terminal-dashboard-sidebar.tsx
   ```

2. Add it to the `plugin` array in `~/.config/opencode/tui.json`:

   ```json
   {
     "plugin": [
       "./plugins/terminal-dashboard-sidebar.tsx"
     ]
   }
   ```

3. Make sure the dashboard server plugin (`opencode-terminals-dashboard.mjs`) is installed — the sidebar reads its data from `http://127.0.0.1:31337/api/data`.

4. Restart opencode. The section appears in the sidebar of the session view.

> TUI plugins need `@opentui/solid` and `solid-js` in your config folder's `package.json`. opencode installs these automatically on startup.

### Removing built-in sidebar blocks

The opencode TUI ships with built-in sidebar blocks (e.g. the `Context` block showing tokens, % used and $ spent). They are internal plugins and can be disabled per plugin id via `plugin_enabled` in `~/.config/opencode/tui.json`:

```json
{
  "plugin_enabled": {
    "internal:sidebar-context": false
  },
  "plugin": [
    "./plugins/terminal-dashboard-sidebar.tsx"
  ]
}
```

Restart opencode afterwards. Other built-in sidebar blocks follow the same pattern (`internal:sidebar-files`, `internal:sidebar-todo`, `internal:sidebar-lsp`, `internal:sidebar-mcp`, `internal:sidebar-footer`).

The server is started automatically by the first opencode terminal and stopped 30 seconds after the last terminal closes. No manual setup required.

> Optional: run the server standalone with `node opencode-terminals-dashboard.mjs` (the plugin then leases to the existing server instead of spawning a new one).

## How it works

```
opencode terminal A ──┐                 ┌─ HTTP heartbeat (31337) ──┐
opencode terminal B ──┤  TCP lease (31338)  ┌──────────────────────┐ │
                      └──────────────────► │ Dashboard server     │◄┘
                                           │ (node, single file)  │
                                           └──────────────────────┘
```

- Each opencode terminal runs the plugin, which listens to the opencode event bus
  (`session.status`, `message.updated`, `message.part.updated`, `session.error`,
  `todo.updated`, `session.diff`, …) and forwards telemetry over HTTP heartbeats.
- Each terminal holds one **TCP lease** (port `31338`) against the dashboard server.
  When the last lease drops, the server waits 30 seconds (grace for reconnects) and exits.
- If the server is missing, the plugin spawns it (`detached`, auto-selected runtime:
  `node` / `bun` / PATH lookup) and pushes all known sessions immediately on reconnect.

## Ports

| Port | Purpose |
|------|---------|
| 31337 | HTTP dashboard + `/api/heartbeat` + `/api/data` |
| 31338 | TCP lease tracking (terminals ↔ server) |

## Configuration

| Setting | How |
|---------|-----|
| Info mode / alarm / filter | UI controls, persisted in `localStorage` |
| Debug log | Set env `DEBUG=1` (or `OPENCODE_DEBUG`) to append to `~/opencode-debug.log` |
| Shutdown grace | `SHUTDOWN_GRACE_MS` in `startServer()` (default 30000 ms) |

## Security notes

- **Write protection:** `POST /api/heartbeat` requires a bearer token when the `DASHBOARD_TOKEN` environment variable is set (set it on the machine running opencode — spawned servers inherit it). Without a token, heartbeats are rejected with `401`. If `DASHBOARD_TOKEN` is unset, the server stays open (backwards compatible).
- **Read endpoints are open:** `GET /api/data` and the dashboard page require no auth and the server binds `0.0.0.0` — session titles, agent/model, todos, cost and error messages are visible to anyone on the LAN. Use the token for write protection, or bind the server to localhost if LAN visibility is not needed.
- **Token consistency:** all opencode terminals must share the same `DASHBOARD_TOKEN`. A terminal without the token will silently get `401` responses and its sessions will not appear.
- All event-derived strings are HTML-escaped before rendering (XSS-safe).
- Session IDs are strictly validated (`ses_` prefix; `msg_`/`prt_` IDs rejected).
- The lease port (`31338`) binds `127.0.0.1` only.
