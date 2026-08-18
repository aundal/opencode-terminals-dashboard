# OpenCode Terminals Dashboard Plan

## Important Details
- Dashboard HTTP port: 31337.
- Dashboard lease port: 31338.
- Data endpoint: http://127.0.0.1:31337/api/data.
- Local plugin source: C:\Users\Daniel\.config\opencode\plugins\agent-dashboard.mjs.
- Sidebar plugin source: C:\Users\Daniel\.config\opencode\plugins\terminal-dashboard-sidebar.tsx.
- Repository: C:\Users\Daniel\opencode-terminals-dashboard.
- GitHub: aundal/opencode-terminals-dashboard.

## Future Tasks
- Consider clickable sub-agent rows in the sidebar.

## Current Behavior
- Parent cards stay Running while direct sub-agents are Running or ASKING PARENT.
- ASKING PARENT is yellow and does not trigger the user-response alarm.
- User-response alarms require alarmEligible=true from a verified parent prompt; guessed/legacy user_response heartbeats are displayed as Waiting (Idle).
- Aborted/cancelled/interrupted sessions stay Waiting (Interrupted) until real new work starts.
- Extended parent cost/tokens include direct sub-agent usage without parentheses.
- Extended parent messages always show total plus direct sub-agent contribution in parentheses.
- Running sessions decay to Waiting (Idle) after 30 seconds without activity.
- Resumed sessions show usage observed after the plugin sees the session, not old persisted OpenCode totals.
- Dashboard settings live in a gear menu beside search: view mode, grouping and alarm toggles.
- Grouping supports None, Label and Status. Status order is Error, User Request, Running, Waiting, Closed, Unknown.
- Group boxes use a lighter background than the page and reuse status colors for group labels.
- Top-level sessions do not decay from Running to Waiting; only explicit OpenCode idle events can do that.
- Label colors are stored per label with backwards compatibility for older string labels.
