import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { parseJson } from '../json.ts';
import {
  emptyHerdrAgentsState,
  persistPrunedAgentsState,
  type HerdrAgentsState,
} from '../state/store.ts';
import { HerdrSessionSnapshot, TabInfo, WorkspaceInfo } from '../types.ts';
import { type HerdrContext, type PaneInfo } from '../types.ts';
import { bestEffort } from '../utils.ts';
import { execHerdr } from './cli.ts';

const SnapshotResponse = Type.Object({
  result: Type.Object({ snapshot: HerdrSessionSnapshot }),
});

export async function getSessionSnapshot(
  signal?: AbortSignal,
): Promise<HerdrSessionSnapshot> {
  const parsed = parseJson(
    SnapshotResponse,
    await execHerdr(['api', 'snapshot'], signal),
  );
  if (!parsed) {
    throw new Error('Malformed Herdr api snapshot response.');
  }
  return parsed.result.snapshot;
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
  if (!currentPane) throw new Error('Could not find current Herdr pane.');
  return {
    panes,
    agents: snapshot.agents,
    currentPane,
    workspaceId: currentPane.workspace_id,
    currentTab: currentPane.tab_id,
  };
}

const TabListResponse = Type.Object({
  result: Type.Object({ tabs: Type.Array(TabInfo) }),
});

export async function listTabs(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<TabInfo[]> {
  const output = await execHerdr(
    ['tab', 'list', '--workspace', workspaceId],
    signal,
  );
  const parsed = parseJson(TabListResponse, output);
  if (!parsed) {
    throw new Error('Malformed Herdr tab list output.');
  }
  return parsed.result.tabs;
}

const WorkspaceListResponse = Type.Object({
  result: Type.Object({ workspaces: Type.Array(Type.Unknown()) }),
});

/** A wrong-typed `label` drops the label, not the workspace. */
const WorkspaceListItem = Type.Object({
  workspace_id: Type.String(),
  label: Type.Optional(Type.Unknown()),
});

/** Items are checked one by one: a bad entry is dropped, not the whole list. */
export function parseWorkspaceListOutput(output: string): WorkspaceInfo[] {
  const parsed = parseJson(WorkspaceListResponse, output);
  if (!parsed) {
    throw new Error(
      'Malformed Herdr workspace list output: expected result.workspaces.',
    );
  }
  return parsed.result.workspaces.flatMap((workspace) =>
    Value.Check(WorkspaceListItem, workspace)
      ? [
          {
            workspace_id: workspace.workspace_id,
            ...(typeof workspace.label === 'string' && workspace.label
              ? { label: workspace.label }
              : {}),
          },
        ]
      : [],
  );
}

async function listWorkspaces(signal?: AbortSignal): Promise<WorkspaceInfo[]> {
  return parseWorkspaceListOutput(
    await execHerdr(['workspace', 'list'], signal),
  );
}

/**
 * Read-only workspace lookup: never creates. A status check is a pure search,
 * so a missing Agents workspace simply means "no agents to find".
 */
export async function findAgentsWorkspaceId(
  label: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return (await listWorkspaces(signal)).find(
    (workspace) => workspace.label === label,
  )?.workspace_id;
}

/** Parse `workspace create` output for the new workspace and its root tab. */
export function parseCreatedWorkspace(output: string): {
  workspaceId?: string;
  rootTabId?: string;
} {
  const parsed = parseJson(CreatedWorkspaceResponse, output);
  const workspaceId = parsed?.result?.workspace?.workspace_id;
  const rootTabId = parsed?.result?.tab?.tab_id;
  return {
    ...(workspaceId && workspaceId.length > 0 ? { workspaceId } : {}),
    ...(rootTabId && rootTabId.length > 0 ? { rootTabId } : {}),
  };
}

const CreatedWorkspaceResponse = Type.Object({
  result: Type.Optional(
    Type.Object({
      workspace: Type.Optional(Type.Object({ workspace_id: Type.String() })),
      tab: Type.Optional(Type.Object({ tab_id: Type.String() })),
    }),
  ),
});

/**
 * Find the managed agents workspace by label, creating it when missing.
 *
 * Resolved on every spawn from the live `workspace list`: if the user closed
 * the workspace by hand, the next spawn creates a fresh one instead of failing
 * on a stale recorded id.
 */
export async function resolveAgentsWorkspace(
  label: string,
  options: { cwd?: string; signal?: AbortSignal } = {},
): Promise<{ workspaceId: string; created: boolean; rootTabId?: string }> {
  const { cwd, signal } = options;
  const existingId = await findAgentsWorkspaceId(label, signal);
  if (existingId) {
    return { workspaceId: existingId, created: false };
  }

  const output = await execHerdr(
    [
      'workspace',
      'create',
      '--label',
      label,
      ...(cwd ? ['--cwd', cwd] : []),
      '--no-focus',
    ],
    signal,
  );
  const parsed = parseCreatedWorkspace(output);
  if (parsed.workspaceId) {
    return {
      workspaceId: parsed.workspaceId,
      created: true,
      ...(parsed.rootTabId ? { rootTabId: parsed.rootTabId } : {}),
    };
  }

  // Some versions may omit the id: fall back to a label re-scan.
  // Missing rootTabId degrades gracefully (caller skips root-tab cleanup).
  const rescanned = await findAgentsWorkspaceId(label, signal);
  if (rescanned) {
    return { workspaceId: rescanned, created: true };
  }
  throw new Error(
    `Malformed Herdr workspace create output: missing result.workspace.workspace_id. Output: ${output}`,
  );
}

/** Snapshot plus pruned managed state, the pair every listing caller needs. */
export async function loadContextWithState(
  signal?: AbortSignal,
): Promise<{ context: HerdrContext; state: HerdrAgentsState }> {
  const context = await getCurrentContext(signal);
  signal?.throwIfAborted();
  const state = await bestEffort(emptyHerdrAgentsState(), () =>
    persistPrunedAgentsState(
      { panes: context.panes, agents: context.agents },
      { signal },
    ),
  );
  return { context, state };
}
