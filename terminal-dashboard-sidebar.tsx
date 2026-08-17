/** @jsxImportSource @opentui/solid */

import { createSignal, For, Show, onCleanup, onMount } from "solid-js";

const PLUGIN_ID = "terminal-dashboard-sidebar";
const DASHBOARD_URL = "http://127.0.0.1:31337/api/data";
const REFRESH_MS = 2000;
const EXPANDED_KV_KEY = "terminal_dashboard_expanded";
const TITLE_MAX = 35;

function clipTitle(value: string) {
  const s = String(value || "");
  if (s.length <= TITLE_MAX) return s;
  return `${s.slice(0, TITLE_MAX - 3)}...`;
}

function statusColor(theme: any, type: string) {
  switch (type) {
    case "running": return theme.success;
    case "user_response": return theme.warning;
    case "failed":
    case "interrupted": return theme.error;
    case "retrying": return "#f97316";
    case "closed": return theme.textMuted;
    default: return theme.text;
  }
}

function SidebarView(props: { api: any }) {
  const [expanded, setExpanded] = createSignal(false);
  const [cards, setCards] = createSignal<any[]>([]);
  const [offline, setOffline] = createSignal(false);

  onMount(() => {
    try {
      setExpanded(props.api.kv?.get?.(EXPANDED_KV_KEY, false) === true);
    } catch {}

    const refresh = async () => {
      try {
        const res = await fetch(DASHBOARD_URL);
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        setCards(Array.isArray(data) ? data : []);
        setOffline(false);
      } catch {
        setOffline(true);
      }
    };

    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    onCleanup(() => clearInterval(timer));
  });

  const theme = () => props.api.theme.current;

  const toggleExpanded = () => {
    const next = !expanded();
    setExpanded(next);
    try {
      props.api.kv?.set?.(EXPANDED_KV_KEY, next);
    } catch {}
  };

  const renderCard = (c: any, depth: number) => {
    const indent = depth > 0 ? "  " : "";
    return (
      <For each={[c]}>
        {(item) => (
          <>
            <text fg={theme().textMuted}>
              {indent}
              <span style={{ fg: statusColor(theme(), item.status?.type) }}>●</span>{" "}
              {clipTitle(item.title)}
            </text>
            <For each={item.subAgents || []}>
              {(sub) => renderCard(sub, depth + 1)}
            </For>
          </>
        )}
      </For>
    );
  };

  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1} onMouseDown={toggleExpanded}>
        <text fg={theme().text}>
          <b>{expanded() ? "▼" : "▶"}</b>
        </text>
        <text fg={theme().text}>
          <b>Terminal Dashboard:</b>
        </text>
      </box>
      <Show when={expanded()}>
        <Show when={!offline()} fallback={<text fg={theme().textMuted}>Dashboard offline</text>}>
          <For each={cards()}>
            {(c) => renderCard(c, 0)}
          </For>
        </Show>
      </Show>
    </box>
  );
}

const plugin = {
  id: PLUGIN_ID,
  async tui(api: any) {
    api.slots.register({
      order: -10000,
      slots: {
        sidebar_content: () => <SidebarView api={api} />,
      },
    });
  },
};

export default plugin;