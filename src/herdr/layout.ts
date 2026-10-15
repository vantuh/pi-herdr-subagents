import { Value } from 'typebox/value';

import { execHerdrApi } from './cli.ts';
import {
  ExportedLayoutResponse,
  type PaneLayout,
  type PortableLayoutNode,
} from './layout/schema.ts';
import { listManagedWorkspaceAgents } from './placement.ts';
import type { PaneInfo } from './schema.ts';
import { loadContextWithState } from './snapshot.ts';

interface SplitRatioUpdate {
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
  const value = await execHerdrApi(
    'layout.export',
    { pane_id: paneId },
    signal,
  );
  if (!Value.Check(ExportedLayoutResponse, value) || !value.layout.tab_id) {
    throw new Error('Malformed Herdr layout.export response.');
  }
  return { tab_id: value.layout.tab_id, root: value.layout.root };
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

export async function rebalanceCurrentPaneAgents(
  signal?: AbortSignal,
): Promise<void> {
  const { context: current, state } = await loadContextWithState(signal);
  const agents = listManagedWorkspaceAgents(current, state).filter(
    (agent) => agent.layout === 'pane' && agent.tabId === current.currentTab,
  );
  if (agents.length < 2) return;

  const layout = await exportPaneLayout(current.currentPane.pane_id, signal);
  const managedPaneIds = new Set(agents.map((agent) => agent.paneId));
  const updates = buildEqualAgentSplitRatios(layout.root, managedPaneIds);
  for (const update of updates) {
    await setLayoutSplitRatio(layout.tab_id, update.path, update.ratio, signal);
  }
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
