import { getHerdrAgentsWorkspaceLabel } from '../../config.ts';
import { execHerdr } from '../../herdr/cli.ts';
import { chooseAgentColumnSplitTarget } from '../../herdr/layout.ts';
import {
  listManagedWorkspaceAgents,
  uniqueLabel,
} from '../../herdr/placement.ts';
import type { PaneInfo } from '../../herdr/schema.ts';
import {
  getCurrentContext,
  listPanes,
  listTabs,
  resolveAgentsWorkspace,
} from '../../herdr/snapshot.ts';
import { parseJson } from '../../json.ts';
import {
  emptyHerdrAgentsState,
  persistPrunedAgentsState,
} from '../../state/store.ts';
import { bestEffort } from '../../utils.ts';
import { herdrChildEnvArgs } from '../child-args.ts';
import { textResult } from '../result.ts';
import {
  PaneLayoutResponse,
  PaneSplitResponse,
  TabCreateResponse,
} from './schema.ts';
import type {
  AgentPlacement,
  PlacementResolution,
  SpawnSettings,
  SpawnState,
  TaskInvocation,
} from './types.ts';

export async function resolveAgentPlacement(
  invocation: TaskInvocation,
  settings: SpawnSettings,
): Promise<PlacementResolution> {
  const { ctx, signal } = invocation;
  const { config, layout } = settings;
  // Refresh context only after acquiring the short placement lock so
  // parallel calls see panes and labels created by earlier calls.
  const current = await getCurrentContext(signal);

  let agentsWorkspaceId: string | undefined;
  let agentsWorkspaceCreated = false;
  let agentsWorkspaceRootTabId: string | undefined;
  if (layout === 'workspace') {
    const resolved = await resolveAgentsWorkspace(
      getHerdrAgentsWorkspaceLabel(config),
      {
        cwd: ctx.cwd,
        signal,
      },
    );
    agentsWorkspaceId = resolved.workspaceId;
    agentsWorkspaceCreated = resolved.created;
    agentsWorkspaceRootTabId = resolved.rootTabId;
    if (agentsWorkspaceId === current.workspaceId) {
      return {
        error: textResult(
          `The configured workspace.label matches this Orchestrator's own workspace. Change workspace.label in herdr-agents.json so agents spawn into a dedicated workspace instead of the Orchestrator's.`,
          { workspaceId: agentsWorkspaceId },
          true,
        ),
      };
    }
  }
  const usesTabs = layout === 'tab' || layout === 'workspace';
  const tabs = usesTabs
    ? await listTabs(agentsWorkspaceId ?? current.workspaceId, signal)
    : [];
  const state = await bestEffort(emptyHerdrAgentsState(), () =>
    persistPrunedAgentsState(
      { panes: current.panes, agents: current.agents },
      { signal },
    ),
  );

  return {
    placement: {
      current,
      state,
      tabs,
      usesTabs,
      agentsWorkspaceId,
      agentsWorkspaceCreated,
      agentsWorkspaceRootTabId,
    },
  };
}

export async function createAgentTab(
  invocation: TaskInvocation,
  settings: SpawnSettings,
  spawn: SpawnState,
  placement: AgentPlacement,
): Promise<void> {
  const { ctx, signal } = invocation;
  const { baseLabel } = settings;
  const { current, tabs, agentsWorkspaceId } = placement;

  if (!spawn.resumeClaim) {
    const managedTabs = listManagedWorkspaceAgents(current, placement.state)
      .filter((item) => tabs.some((tab) => tab.tab_id === item.tabId))
      .map((item) => ({ tab_id: item.tabId, label: item.tabLabel }));
    spawn.tabLabel = uniqueLabel(baseLabel, [...tabs, ...managedTabs]);
  }
  const createOutput = await execHerdr(
    [
      'tab',
      'create',
      '--workspace',
      agentsWorkspaceId ?? current.workspaceId,
      '--label',
      spawn.tabLabel,
      '--cwd',
      spawn.resumeClaim?.cwd ?? ctx.cwd,
      ...herdrChildEnvArgs(spawn.sessionMetaFile),
      '--no-focus',
    ],
    signal,
  );
  const createResult = parseJson(TabCreateResponse, createOutput)?.result;
  const rootPane = createResult?.root_pane;
  if (!rootPane) {
    throw new Error(
      `Malformed Herdr tab create output: missing result.root_pane.pane_id. Output: ${createOutput}`,
    );
  }
  spawn.paneId = rootPane.pane_id;
  spawn.agentPane = rootPane;
  spawn.tabId = rootPane.tab_id;

  if (!spawn.tabId) {
    spawn.tabId = (await listPanes(signal)).find(
      (pane) => pane.pane_id === spawn.paneId,
    )?.tab_id;
  }
}

export async function createAgentPane(
  invocation: TaskInvocation,
  settings: SpawnSettings,
  spawn: SpawnState,
  placement: AgentPlacement,
): Promise<void> {
  const { ctx, signal } = invocation;
  const { baseLabel } = settings;
  const { current, state } = placement;

  const managedAgents = listManagedWorkspaceAgents(current, state).filter(
    (item) => item.layout === 'pane' && item.tabId === current.currentTab,
  );
  if (!spawn.resumeClaim) {
    spawn.tabLabel = uniqueLabel(
      baseLabel,
      managedAgents.map((item) => ({
        tab_id: item.paneId,
        label: item.tabLabel,
      })),
    );
  }
  const managedPaneIds = new Set(managedAgents.map((item) => item.paneId));
  const managedPanes = current.panes.filter((pane) =>
    managedPaneIds.has(pane.pane_id),
  );
  let splitTarget: PaneInfo | undefined = managedPanes[0];
  if (managedPanes.length > 0) {
    const layoutOutput = await execHerdr(
      ['pane', 'layout', '--pane', current.currentPane.pane_id],
      signal,
    );
    const paneLayout = parseJson(PaneLayoutResponse, layoutOutput)?.result
      ?.layout;
    splitTarget = chooseAgentColumnSplitTarget(managedPanes, paneLayout);
  }

  const createOutput = await execHerdr(
    [
      'pane',
      'split',
      splitTarget?.pane_id ?? current.currentPane.pane_id,
      '--direction',
      splitTarget ? 'down' : 'right',
      '--ratio',
      splitTarget ? '0.5' : '0.6',
      '--cwd',
      spawn.resumeClaim?.cwd ?? ctx.cwd,
      ...herdrChildEnvArgs(spawn.sessionMetaFile),
      '--no-focus',
    ],
    signal,
  );
  const createResult = parseJson(PaneSplitResponse, createOutput)?.result;
  const createdPane = createResult?.pane;
  if (!createdPane) {
    throw new Error(
      `Malformed Herdr pane split output: missing result.pane.pane_id. Output: ${createOutput}`,
    );
  }
  spawn.paneId = createdPane.pane_id;
  spawn.tabId = createdPane.tab_id || current.currentTab;
  spawn.agentPane = createdPane;
  await execHerdr(['pane', 'rename', spawn.paneId, spawn.tabLabel], signal);
}
