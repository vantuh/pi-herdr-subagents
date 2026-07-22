import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import type { HerdrAgentsState } from "./state.ts";
import { paneStateKey } from "./state.ts";
import type {
  HerdrAgentInfo,
  HerdrAgentLifecycle,
  HerdrContext,
  HerdrSessionSnapshot,
  PaneInfo,
  ReusableAgentTab,
  TabInfo,
} from "./types.ts";

export class HerdrCliError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly args: readonly string[],
  ) {
    super(message);
    this.name = "HerdrCliError";
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function redactHerdrArgs(args: readonly string[]): string[] {
  if (args[0] === "agent" && args[1] === "prompt" && args.length >= 4) {
    return [...args.slice(0, 3), "<prompt>", ...args.slice(4)];
  }
  return [...args];
}

function parseHerdrError(stderr: string, fallback: string): {
  code?: string;
  message: string;
} {
  try {
    const parsed = JSON.parse(stderr) as {
      error?: { code?: string; message?: string };
    };
    if (parsed.error?.message) {
      return { code: parsed.error.code, message: parsed.error.message };
    }
  } catch {
    // Herdr may also emit a human-readable CLI validation error.
  }
  return { message: stderr || fallback };
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
      process.env.HERDR_BIN_PATH || "herdr",
      args,
      { signal, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        cleanup();
        if (error) {
          const parsed = parseHerdrError(stderr?.trim(), error.message);
          const safeArgs = redactHerdrArgs(args);
          const code = parsed.code ? ` [${parsed.code}]` : "";
          reject(
            new HerdrCliError(
              `herdr ${safeArgs.join(" ")} failed${code}: ${parsed.message}`,
              parsed.code,
              safeArgs,
            ),
          );
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

export async function getSessionSnapshot(
  signal?: AbortSignal,
): Promise<HerdrSessionSnapshot> {
  const output = await execHerdr(["api", "snapshot"], signal);
  const snapshot = JSON.parse(output)?.result?.snapshot as
    | HerdrSessionSnapshot
    | undefined;
  if (!snapshot || !Array.isArray(snapshot.panes) || !Array.isArray(snapshot.tabs)) {
    throw new Error("Malformed Herdr api snapshot response.");
  }
  return snapshot;
}

export async function listPanes(signal?: AbortSignal): Promise<PaneInfo[]> {
  return (await getSessionSnapshot(signal)).panes;
}

export async function getCurrentContext(
  signal?: AbortSignal,
): Promise<HerdrContext> {
  const snapshot = await getSessionSnapshot(signal);
  const panes = snapshot.panes;
  const envPaneId = process.env.HERDR_PANE_ID;
  const currentPane =
    (envPaneId
      ? panes.find((pane) => pane.pane_id === envPaneId)
      : undefined) ??
    (snapshot.focused_pane_id
      ? panes.find((pane) => pane.pane_id === snapshot.focused_pane_id)
      : undefined) ??
    panes.find((pane) => pane.focused);
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
      ...(record.automationName
        ? { automationName: record.automationName }
        : {}),
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

export async function startAgent(
  name: string,
  paneId: string,
  piArgs: string[],
  signal?: AbortSignal,
): Promise<void> {
  const args = [
    "agent",
    "start",
    name,
    "--kind",
    "pi",
    "--pane",
    paneId,
    "--timeout",
    "30000",
    "--",
    ...piArgs,
  ];
  const shellReadyDeadline = Date.now() + 5000;

  while (true) {
    try {
      await execHerdr(args, signal);
      return;
    } catch (error) {
      if (
        !(error instanceof HerdrCliError) ||
        error.code !== "agent_pane_busy" ||
        Date.now() >= shellReadyDeadline
      ) {
        throw error;
      }
      await delay(100, signal);
    }
  }
}

export function buildAgentPromptArgs(
  target: string,
  prompt: string,
  options: { wait: boolean; timeoutMs: number },
): string[] {
  const args = ["agent", "prompt", target, prompt];
  if (options.wait) {
    args.push(
      "--wait",
      "--until",
      "idle",
      "--until",
      "done",
      "--timeout",
      String(options.timeoutMs),
    );
  }
  return args;
}

export async function promptAgent(
  target: string,
  prompt: string,
  options: { wait: boolean; timeoutMs: number },
  signal?: AbortSignal,
): Promise<void> {
  await execHerdr(buildAgentPromptArgs(target, prompt, options), signal);
}

export async function waitForAgent(
  target: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  await execHerdr(
    [
      "agent",
      "wait",
      target,
      "--until",
      "idle",
      "--until",
      "done",
      "--timeout",
      String(timeoutMs),
    ],
    signal,
  );
}

export function readAgent(
  target: string,
  signal?: AbortSignal,
): Promise<string> {
  return execHerdr(
    [
      "agent",
      "read",
      target,
      "--source",
      "recent-unwrapped",
      "--lines",
      "180",
    ],
    signal,
  );
}
