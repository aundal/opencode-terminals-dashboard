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
- Extended parent metrics show total usage with direct sub-agent contribution in parentheses.
- Resumed sessions show usage observed after the plugin sees the session, not old persisted OpenCode totals.
