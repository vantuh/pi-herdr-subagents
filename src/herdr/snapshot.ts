import type {
  HerdrContext,
  HerdrSessionSnapshot,
  PaneInfo,
  TabInfo,
  WorkspaceInfo,
} from '../types.ts';
import { execHerdr } from './cli.ts';

export async function getSessionSnapshot(
  signal?: AbortSignal,
): Promise<HerdrSessionSnapshot> {
  const output = await execHerdr(['api', 'snapshot'], signal);
  const snapshot = JSON.parse(output)?.result?.snapshot as
    | HerdrSessionSnapshot
    | undefined;
  if (
    !snapshot ||
    !Array.isArray(snapshot.panes) ||
    !Array.isArray(snapshot.tabs) ||
    (snapshot.agents !== undefined && !Array.isArray(snapshot.agents))
  ) {
    throw new Error('Malformed Herdr api snapshot response.');
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
  if (!currentPane) throw new Error('Could not find current Herdr pane.');
  return {
    panes,
    agents: snapshot.agents,
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
    ['tab', 'list', '--workspace', workspaceId],
    signal,
  );
  return JSON.parse(output).result.tabs as TabInfo[];
}

export function parseWorkspaceListOutput(output: string): WorkspaceInfo[] {
  let parsed: { result?: { workspaces?: unknown } };
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Malformed Herdr workspace list output: ${message}`);
  }
  const workspaces = parsed.result?.workspaces;
  if (!Array.isArray(workspaces)) {
    throw new Error(
      'Malformed Herdr workspace list output: expected result.workspaces.',
    );
  }
  return workspaces
    .filter(
      (item): item is WorkspaceInfo & { workspace_id: string } =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as WorkspaceInfo).workspace_id === 'string',
    )
    .map(({ workspace_id, label }) => ({
      workspace_id,
      ...(typeof label === 'string' ? { label } : {}),
    }));
}

async function listWorkspaces(
  signal?: AbortSignal,
): Promise<WorkspaceInfo[]> {
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
  try {
    const parsed = JSON.parse(output) as {
      result?: {
        workspace?: { workspace_id?: unknown };
        tab?: { tab_id?: unknown };
      };
    };
    const workspaceId = parsed.result?.workspace?.workspace_id;
    const rootTabId = parsed.result?.tab?.tab_id;
    return {
      ...(typeof workspaceId === 'string' && workspaceId.length > 0
        ? { workspaceId }
        : {}),
      ...(typeof rootTabId === 'string' && rootTabId.length > 0
        ? { rootTabId }
        : {}),
    };
  } catch {
    return {};
  }
}

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
  const existing = (await listWorkspaces(signal)).find(
    (workspace) => workspace.label === label,
  );
  if (existing?.workspace_id) {
    return { workspaceId: existing.workspace_id, created: false };
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
  const rescanned = (await listWorkspaces(signal)).find(
    (workspace) => workspace.label === label,
  );
  if (rescanned?.workspace_id) {
    return { workspaceId: rescanned.workspace_id, created: true };
  }
  throw new Error(
    `Malformed Herdr workspace create output: missing result.workspace.workspace_id. Output: ${output}`,
  );
}

