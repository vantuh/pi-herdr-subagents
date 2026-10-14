import {
  isAgentOwnedBy,
  paneStateKey,
  type HerdrAgentsState,
} from '../state/store.ts';
import type {
  HerdrAgentInfo,
  HerdrContext,
  PaneInfo,
  ReusableAgentTab,
  TabInfo,
} from '../types.ts';
import { execHerdrApi } from './cli.ts';

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
  return tabPanes.find((pane) => pane.agent === 'pi') ?? tabPanes[0];
}

export function findReusableAgentTab(
  context: HerdrContext,
  tabs: TabInfo[],
  baseLabel: string,
  state: HerdrAgentsState,
): ReusableAgentTab | undefined {
  // Record-driven first: the recorded tabLabel is authoritative (uniqueLabel
  // may have renamed the tab at spawn time), and ownership keeps a second
  // Orchestrator sharing the Agents workspace from adopting a foreign agent.
  for (const [key, record] of Object.entries(state.agents)) {
    if (record.tabLabel !== baseLabel) continue;
    // Only tab/workspace agents are reusable through this tab-based lookup;
    // pane-layout agents belong to the Orchestrator's own split column.
    if (record.layout !== 'tab' && record.layout !== 'workspace') continue;
    const terminalId = key.startsWith('terminal:')
      ? key.slice('terminal:'.length)
      : undefined;
    const pane = terminalId
      ? context.panes.find((item) => item.terminal_id === terminalId)
      : undefined;
    if (!pane || pane.agent !== 'pi') continue;
    if (
      !isAgentOwnedBy(
        record,
        context.currentPane.terminal_id,
        pane.tab_id,
        context.currentTab,
      )
    ) {
      continue;
    }
    const tab = tabs.find((item) => item.tab_id === pane.tab_id);
    return {
      pane,
      tab: tab ?? { tab_id: pane.tab_id, label: record.tabLabel },
    };
  }

  // Fall back to a live label scan, skipping tabs owned by other sessions.
  for (const tab of tabs) {
    if (tab.label !== baseLabel || tab.tab_id === context.currentTab) continue;
    const pane = choosePaneForTab(context.panes, tab.tab_id);
    if (!pane || pane.agent !== 'pi') continue;
    const key = paneStateKey(pane);
    const record = key ? state.agents[key] : undefined;
    if (
      !record ||
      (record.tabLabel !== undefined && record.tabLabel !== baseLabel) ||
      !isAgentOwnedBy(
        record,
        context.currentPane.terminal_id,
        pane.tab_id,
        context.currentTab,
      )
    ) {
      continue;
    }
    return { tab, pane };
  }
  return undefined;
}

export function findReusableAgentPane(
  context: HerdrContext,
  state: HerdrAgentsState,
  label: string,
): PaneInfo | undefined {
  return context.panes.find((pane) => {
    if (pane.workspace_id !== context.workspaceId) return false;
    if (pane.tab_id !== context.currentTab) return false;
    if (pane.pane_id === context.currentPane.pane_id || pane.agent !== 'pi') {
      return false;
    }
    const key = paneStateKey(pane);
    const record = key ? state.agents[key] : undefined;
    if (
      !record ||
      !isAgentOwnedBy(
        record,
        context.currentPane.terminal_id,
        pane.tab_id,
        context.currentTab,
      )
    ) {
      return false;
    }
    return (
      (record.layout === 'pane' || record.layout === undefined) &&
      record.tabLabel === label
    );
  });
}

export function listManagedWorkspaceAgents(
  context: HerdrContext,
  state: HerdrAgentsState,
): HerdrAgentInfo[] {
  const agents: HerdrAgentInfo[] = [];

  for (const pane of context.panes) {
    if (pane.pane_id === context.currentPane.pane_id) continue;

    const key = paneStateKey(pane);
    const record = key ? state.agents[key] : undefined;
    if (!record) continue;
    // Workspace-layout agents live in the dedicated Agents workspace, so they
    // are matched by record rather than by the current workspace id.
    if (
      pane.workspace_id !== context.workspaceId &&
      record.layout !== 'workspace'
    ) {
      continue;
    }
    if (
      !isAgentOwnedBy(
        record,
        context.currentPane.terminal_id,
        pane.tab_id,
        context.currentTab,
      )
    ) {
      continue;
    }

    agents.push({
      tabId: pane.tab_id,
      tabLabel: record.tabLabel ?? pane.label ?? record.agent ?? 'Agent',
      paneId: pane.pane_id,
      agent: record.agent ?? pane.agent ?? 'pi',
      ...(record.automationName
        ? { automationName: record.automationName }
        : {}),
      ...(record.resultFile ? { resultFile: record.resultFile } : {}),
      status: pane.agent_status ?? 'unknown',
      lifecycle: record.lifecycle,
      layout:
        record.layout ?? (pane.tab_id === context.currentTab ? 'pane' : 'tab'),
      cwd: pane.foreground_cwd ?? pane.cwd,
      ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
      ...(record.spawnWarnings?.length
        ? { spawnWarnings: record.spawnWarnings }
        : {}),
      ...(record.detached ? { detached: true } : {}),
      ...(pane.terminal_id ? { terminalId: pane.terminal_id } : {}),
      ...(record.ownerSessionId
        ? { ownerSessionId: record.ownerSessionId }
        : {}),
      ...(record.ownerSessionFile
        ? { ownerSessionFile: record.ownerSessionFile }
        : {}),
      ...(record.closedHistoryId
        ? { closedHistoryId: record.closedHistoryId }
        : {}),
      ...(record.closedHistoryGeneration
        ? { closedHistoryGeneration: record.closedHistoryGeneration }
        : {}),
    });
  }

  return agents.sort((a, b) => a.tabLabel.localeCompare(b.tabLabel));
}

export type PortableLayoutNode =
  | { type: 'pane'; pane_id?: string }
  | {
      type: 'split';
      direction: 'right' | 'down';
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
  if (node.type === 'pane') {
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
    if (node.type === 'pane') return;

    const firstCount = countManagedPanes(node.first, managedPaneIds);
    const secondCount = countManagedPanes(node.second, managedPaneIds);
    const total = firstCount + secondCount;

    if (node.direction === 'down' && firstCount > 0 && secondCount > 0) {
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
    'layout.export',
    { pane_id: paneId },
    signal,
  )) as { layout?: { tab_id?: string; root?: PortableLayoutNode } };
  if (!result.layout?.tab_id || !result.layout.root) {
    throw new Error('Malformed Herdr layout.export response.');
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
    'layout.set_split_ratio',
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
      (areaByPaneId.get(b.pane_id) ?? 0) - (areaByPaneId.get(a.pane_id) ?? 0),
  )[0];
}
