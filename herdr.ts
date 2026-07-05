import { execFile } from "node:child_process";
import type { HerdrContext, PaneInfo, TabInfo } from "./types.ts";

export function execHerdr(
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = execFile(
      "herdr",
      args,
      { signal, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const message = stderr?.trim() || error.message;
          reject(new Error(`herdr ${args.join(" ")} failed: ${message}`));
          return;
        }
        resolve(stdout);
      },
    );

    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          proc.kill("SIGTERM");
        },
        { once: true },
      );
    }
  });
}

export async function getCurrentContext(
  signal?: AbortSignal,
): Promise<HerdrContext> {
  const output = await execHerdr(["pane", "list"], signal);
  const panes = JSON.parse(output).result.panes as PaneInfo[];
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
