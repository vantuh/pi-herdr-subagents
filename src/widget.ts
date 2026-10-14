import type { HerdrAgentInfo } from "./types.ts";

export const AGENTS_WIDGET_ID = "herdr-agents";
export const AGENTS_WIDGET_TICK_MS = 1000;

const MAX_LABEL_WIDTH = 28;

export type StatusTone = "active" | "attention" | "quiet";

export interface WidgetPaint {
  header(text: string): string;
  elapsed(text: string): string;
  status(text: string, tone: StatusTone): string;
}

const plainPaint: WidgetPaint = {
  header: (text) => text,
  elapsed: (text) => text,
  status: (text) => text,
};

/** `mm:ss` under an hour, `h:mm:ss` above it. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

export interface StatusView {
  text: string;
  tone: StatusTone;
}

/**
 * Herdr's `agent_status` mapped to what the Orchestrator needs to know.
 * `blocked` is the one status that asks for human action, so it carries the
 * hint instead of just the raw word.
 */
export function agentStatusView(status: string): StatusView {
  switch (status) {
    case "working":
      return { text: "working", tone: "active" };
    case "blocked":
      return { text: "blocked · attach to unblock", tone: "attention" };
    case "idle":
      return { text: "idle", tone: "quiet" };
    case "done":
      return { text: "done", tone: "quiet" };
    default:
      return { text: "starting", tone: "quiet" };
  }
}

export function truncateLabel(label: string, max = MAX_LABEL_WIDTH): string {
  if (label.length <= max) return label;
  return `${label.slice(0, max - 1)}…`;
}

/**
 * Elapsed time is measured from the state record's `updatedAt`, which the tool
 * rewrites on every spawn *and* every persistent reuse. That makes it "time in
 * the current task" rather than "pane age", which is what matters while
 * waiting.
 */
function elapsedLabel(agent: HerdrAgentInfo, now: number): string {
  if (!agent.updatedAt) return "--:--";
  const started = Date.parse(agent.updatedAt);
  if (Number.isNaN(started)) return "--:--";
  return formatElapsed(now - started);
}

/**
 * The widget exists to surface agents nobody is currently watching. While the
 * Orchestrator blocks on `wait: true`, the tool call already renders
 * "Waiting for Herdr agent <label>...", so a widget row would be a third copy
 * of the same fact.
 *
 * The one exception is `blocked`: Herdr reports it when the child sits on an
 * approval dialog or a question, and the tool call cannot distinguish that from
 * healthy work — it keeps showing the same "Waiting for…" line until timeout.
 * That state is the whole reason the row is worth keeping.
 */
/**
 * The same definition of "finished" the blocking path uses: `waitForAgent`
 * waits `--until idle --until done`. Keeping one definition means async
 * delivery cannot disagree with a synchronous wait about whether an agent is
 * done.
 */
export function isSettledAgentStatus(status: string): boolean {
  return status === "idle" || status === "done";
}

export function visibleWidgetAgents(
  agents: readonly HerdrAgentInfo[],
  awaitedLabels: ReadonlySet<string>,
): HerdrAgentInfo[] {
  return agents.filter(
    (agent) => !awaitedLabels.has(agent.tabLabel) || agent.status === "blocked",
  );
}

export function renderAgentWidgetLines(
  agents: readonly HerdrAgentInfo[],
  now: number,
  paint: WidgetPaint = plainPaint,
): string[] {
  if (agents.length === 0) return [];

  const rows = agents.map((agent) => ({
    elapsed: elapsedLabel(agent, now),
    label: truncateLabel(agent.tabLabel),
    status: agentStatusView(agent.status),
  }));

  const labelWidth = Math.max(...rows.map((row) => row.label.length));
  const elapsedWidth = Math.max(...rows.map((row) => row.elapsed.length));
  const working = rows.filter((row) => row.status.tone === "active").length;
  const suffix = working > 0 ? ` · ${working} working` : "";
  const lines = [
    paint.header(`Herdr agents · ${agents.length}${suffix}`),
    ...rows.map((row) =>
      [
        " ",
        paint.elapsed(row.elapsed.padStart(elapsedWidth)),
        " ",
        row.label.padEnd(labelWidth),
        "  ",
        paint.status(row.status.text, row.status.tone),
      ].join(""),
    ),
  ];

  return lines;
}
