import { execFile } from "node:child_process";
import type { HerdrContext, PaneInfo, TabInfo } from "./types.ts";

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

export interface AgentWaitState {
  sawActive: boolean;
}

export function observeAgentWaitState(
  pane: PaneInfo,
  state: AgentWaitState,
): boolean {
  if (pane.agent_status === "working" || pane.agent_status === "blocked") {
    state.sawActive = true;
  }

  if (pane.agent_status === "done") return true;

  // Herdr reports `done` only until the finished pane is observed. After that,
  // the same completed agent can appear as `idle`, so treat idle as finished
  // only after this wait loop has seen the agent actually do work.
  return pane.agent_status === "idle" && state.sawActive;
}

export async function waitForAgentFinished(
  paneId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<PaneInfo> {
  const startedAt = Date.now();
  const state: AgentWaitState = { sawActive: false };

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
