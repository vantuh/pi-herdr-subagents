import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import type { HerdrAgentsState } from "./state.ts";
import { paneStateKey } from "./state.ts";
import type {
  HerdrAgentInfo,
  HerdrAgentLifecycle,
  HerdrContext,
  PaneInfo,
  ReusableAgentTab,
  TabInfo,
} from "./types.ts";

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }

    let onAbort: (() => void) | undefined;
    const cleanup = () => {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function execHerdr(
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let onAbort: (() => void) | undefined;
    const cleanup = () => {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    };

    const proc = execFile(
      "herdr",
      args,
      { signal, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        cleanup();
        if (error) {
          const message = stderr?.trim() || error.message;
          reject(new Error(`herdr ${args.join(" ")} failed: ${message}`));
          return;
        }
        resolve(stdout);
      },
    );

    if (signal) {
      onAbort = () => {
        proc.kill("SIGTERM");
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export function execHerdrApi(
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socketPath = process.env.HERDR_SOCKET_PATH;
    if (!socketPath) {
      reject(new Error("HERDR_SOCKET_PATH is not set."));
      return;
    }

    const requestId = `herdr-agents:${process.pid}:${Date.now()}:${Math.random()}`;
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;

    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => finish(new Error("Aborted"));

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;

      let response: {
        id?: string;
        result?: unknown;
        error?: { message?: string };
      };
      try {
        response = JSON.parse(buffer.slice(0, newline));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (response.id !== requestId) return;
      if (response.error) {
        finish(new Error(response.error.message ?? `${method} failed`));
        return;
      }
      finish(undefined, response.result);
    });
    socket.on("error", (error) => finish(error));
    socket.on("end", () => finish(new Error(`Herdr socket closed during ${method}.`)));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export async function listPanes(signal?: AbortSignal): Promise<PaneInfo[]> {
  const output = await execHerdr(["pane", "list"], signal);
  return JSON.parse(output).result.panes as PaneInfo[];
}

export async function getCurrentContext(
  signal?: AbortSignal,
): Promise<HerdrContext> {
  const panes = await listPanes(signal);
  const envPaneId = process.env.HERDR_PANE_ID;
  const currentPane =
    (envPaneId
      ? panes.find((pane) => pane.pane_id === envPaneId)
      : undefined) ?? panes.find((pane) => pane.focused);
  if (!currentPane) throw new Error("Could not find current Herdr pane.");
  return {
    panes,
    currentPane,
    workspaceId: currentPane.workspace_id,
    currentTab: currentPane.tab_id,
  };
}

export async function listTabs(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<TabInfo[]> {
  const output = await execHerdr(
    ["tab", "list", "--workspace", workspaceId],
    signal,
  );
  return JSON.parse(output).result.tabs as TabInfo[];
}

export function uniqueLabel(baseLabel: string, tabs: TabInfo[]): string {
  const labels = new Set(tabs.map((tab) => tab.label));
  if (!labels.has(baseLabel)) return baseLabel;

  for (let i = 2; ; i++) {
    const candidate = `${baseLabel} #${i}`;
    if (!labels.has(candidate)) return candidate;
  }
}

export function choosePaneForTab(
  panes: PaneInfo[],
  tabId: string,
): PaneInfo | undefined {
  const tabPanes = panes.filter((pane) => pane.tab_id === tabId);
  return tabPanes.find((pane) => pane.agent === "pi") ?? tabPanes[0];
}

export function findReusableAgentTab(
  context: HerdrContext,
  tabs: TabInfo[],
  baseLabel: string,
): ReusableAgentTab | undefined {
  const tab = tabs.find(
    (item) => item.label === baseLabel && item.tab_id !== context.currentTab,
  );
  if (!tab) return undefined;

  const pane = choosePaneForTab(context.panes, tab.tab_id);
  if (!pane || pane.agent !== "pi") return undefined;

  return { tab, pane };
}

export function findReusableAgentPane(
  context: HerdrContext,
  state: HerdrAgentsState,
  label: string,
): PaneInfo | undefined {
  return context.panes.find((pane) => {
    if (pane.workspace_id !== context.workspaceId) return false;
    if (pane.tab_id !== context.currentTab) return false;
    if (pane.pane_id === context.currentPane.pane_id || pane.agent !== "pi") {
      return false;
    }
    const key = paneStateKey(pane);
    const record = key ? state.agents[key] : undefined;
    return (
      (record?.layout === "pane" || record?.layout === undefined) &&
      record?.tabLabel === label
    );
  });
}

export function listManagedWorkspaceAgents(
  context: HerdrContext,
  state: HerdrAgentsState,
): HerdrAgentInfo[] {
  const agents: HerdrAgentInfo[] = [];

  for (const pane of context.panes) {
    if (pane.workspace_id !== context.workspaceId) continue;
    if (pane.pane_id === context.currentPane.pane_id) continue;

    const key = paneStateKey(pane);
    const record = key ? state.agents[key] : undefined;
    if (!record) continue;

    agents.push({
      tabId: pane.tab_id,
      tabLabel: record.tabLabel ?? pane.label ?? record.agent ?? "Agent",
      paneId: pane.pane_id,
      agent: record.agent ?? pane.agent ?? "pi",
      status: pane.agent_status ?? "unknown",
      lifecycle: record.lifecycle,
      layout:
        record.layout ?? (pane.tab_id === context.currentTab ? "pane" : "tab"),
      cwd: pane.foreground_cwd ?? pane.cwd,
    });
  }

  return agents.sort((a, b) => a.tabLabel.localeCompare(b.tabLabel));
}

export type PortableLayoutNode =
  | { type: "pane"; pane_id?: string }
  | {
      type: "split";
      direction: "right" | "down";
      ratio: number;
      first: PortableLayoutNode;
      second: PortableLayoutNode;
    };

export interface SplitRatioUpdate {
  path: boolean[];
  ratio: number;
}

function countManagedPanes(
  node: PortableLayoutNode,
  managedPaneIds: ReadonlySet<string>,
): number {
  if (node.type === "pane") {
    return node.pane_id && managedPaneIds.has(node.pane_id) ? 1 : 0;
  }
  return (
    countManagedPanes(node.first, managedPaneIds) +
    countManagedPanes(node.second, managedPaneIds)
  );
}

export function buildEqualAgentSplitRatios(
  root: PortableLayoutNode,
  managedPaneIds: ReadonlySet<string>,
): SplitRatioUpdate[] {
  const updates: SplitRatioUpdate[] = [];

  const visit = (node: PortableLayoutNode, path: boolean[]) => {
    if (node.type === "pane") return;

    const firstCount = countManagedPanes(node.first, managedPaneIds);
    const secondCount = countManagedPanes(node.second, managedPaneIds);
    const total = firstCount + secondCount;

    if (node.direction === "down" && firstCount > 0 && secondCount > 0) {
      updates.push({ path, ratio: firstCount / total });
    }
    if (firstCount > 0) visit(node.first, [...path, false]);
    if (secondCount > 0) visit(node.second, [...path, true]);
  };

  visit(root, []);
  return updates;
}

export async function exportPaneLayout(
  paneId: string,
  signal?: AbortSignal,
): Promise<{ tab_id: string; root: PortableLayoutNode }> {
  const result = (await execHerdrApi(
    "layout.export",
    { pane_id: paneId },
    signal,
  )) as { layout?: { tab_id?: string; root?: PortableLayoutNode } };
  if (!result.layout?.tab_id || !result.layout.root) {
    throw new Error("Malformed Herdr layout.export response.");
  }
  return { tab_id: result.layout.tab_id, root: result.layout.root };
}

export async function setLayoutSplitRatio(
  tabId: string,
  path: boolean[],
  ratio: number,
  signal?: AbortSignal,
): Promise<void> {
  await execHerdrApi(
    "layout.set_split_ratio",
    { tab_id: tabId, path, ratio },
    signal,
  );
}

interface PaneLayout {
  panes?: Array<{
    pane_id: string;
    rect?: { height?: number; width?: number };
  }>;
}

export function chooseAgentColumnSplitTarget(
  panes: PaneInfo[],
  layout?: PaneLayout,
): PaneInfo | undefined {
  const areaByPaneId = new Map(
    (layout?.panes ?? []).map((pane) => [
      pane.pane_id,
      (pane.rect?.height ?? 0) * (pane.rect?.width ?? 0),
    ]),
  );
  return [...panes].sort(
    (a, b) =>
      (areaByPaneId.get(b.pane_id) ?? 0) -
      (areaByPaneId.get(a.pane_id) ?? 0),
  )[0];
}

export function listCurrentWorkspaceAgents(
  context: HerdrContext,
  tabs: TabInfo[],
  lifecycleByTabId: ReadonlyMap<string, HerdrAgentLifecycle> = new Map(),
): HerdrAgentInfo[] {
  const tabsById = new Map(tabs.map((tab) => [tab.tab_id, tab]));
  const seenTabs = new Set<string>();
  const agents: HerdrAgentInfo[] = [];

  for (const pane of context.panes) {
    if (pane.workspace_id !== context.workspaceId) continue;
    if (pane.tab_id === context.currentTab) continue;
    if (!pane.agent) continue;
    if (seenTabs.has(pane.tab_id)) continue;

    const tab = tabsById.get(pane.tab_id);
    if (!tab) continue;

    seenTabs.add(pane.tab_id);
    const chosenPane = choosePaneForTab(context.panes, pane.tab_id) ?? pane;
    const lifecycle = lifecycleByTabId.get(chosenPane.tab_id);
    agents.push({
      tabId: chosenPane.tab_id,
      tabLabel: tab.label,
      paneId: chosenPane.pane_id,
      agent: chosenPane.agent ?? pane.agent,
      status: chosenPane.agent_status ?? tab.agent_status ?? "unknown",
      ...(lifecycle ? { lifecycle } : {}),
      cwd: chosenPane.foreground_cwd ?? chosenPane.cwd,
    });
  }

  return agents.sort((a, b) => a.tabLabel.localeCompare(b.tabLabel));
}

export interface AgentWaitState {
  sawActive: boolean;
  requireActiveFirst?: boolean;
}

export function observeAgentWaitState(
  pane: PaneInfo,
  state: AgentWaitState,
): boolean {
  if (pane.agent_status === "working" || pane.agent_status === "blocked") {
    state.sawActive = true;
  }

  // When reusing an existing pane (a persistent agent getting a new task),
  // Herdr's reported status can still be `done`/`idle` from the *previous*
  // task for a moment after the new prompt is sent, because the child Pi
  // process updates its status asynchronously. Requiring `sawActive` first
  // in that case prevents mistaking the previous task's leftover `done`
  // status for completion of the new one.
  if (pane.agent_status === "done") return state.sawActive || !state.requireActiveFirst;

  // Herdr reports `done` only until the finished pane is observed. After that,
  // the same completed agent can appear as `idle`, so treat idle as finished
  // only after this wait loop has seen the agent actually do work.
  return pane.agent_status === "idle" && state.sawActive;
}

export async function waitForAgentFinished(
  paneId: string,
  timeoutMs: number,
  signal?: AbortSignal,
  options?: { requireActiveFirst?: boolean },
): Promise<PaneInfo> {
  const startedAt = Date.now();
  const state: AgentWaitState = {
    sawActive: false,
    requireActiveFirst: options?.requireActiveFirst ?? false,
  };

  while (Date.now() - startedAt < timeoutMs) {
    const pane = (await listPanes(signal)).find(
      (item) => item.pane_id === paneId,
    );
    if (!pane) {
      throw new Error(`Herdr pane disappeared while waiting: ${paneId}`);
    }

    if (observeAgentWaitState(pane, state)) return pane;

    await sleep(500, signal);
  }

  throw new Error(
    `Timed out waiting for Herdr agent pane ${paneId} after ${timeoutMs}ms`,
  );
}
