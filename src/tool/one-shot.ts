import {
  readAgentSessionMeta,
  removeAgentTempFiles,
  validateResumableSessionFile,
} from '../artifacts.ts';
import { execHerdr } from '../herdr/cli.ts';
import {
  buildEqualAgentSplitRatios,
  exportPaneLayout,
  listManagedWorkspaceAgents,
  setLayoutSplitRatio,
} from '../herdr/placement.ts';
import { getSessionSnapshot, loadContextWithState } from '../herdr/snapshot.ts';
import {
  finalizeStagedClosedOneShot,
  stageClosedOneShot,
} from '../state/closed-history.ts';
import {
  clearAgentSpawnWarnings,
  deleteAgentLifecycle,
  loadHerdrAgentsState,
  paneStateKey,
  persistPrunedAgentsState,
} from '../state/store.ts';
import type { HerdrAgentLayout, PaneInfo } from '../types.ts';
import { bestEffort, errorMessage } from '../utils.ts';

const RESUME_CLEANUP_TIMEOUT_MS = 8_000;
const FINALIZE_RETRY_ATTEMPTS = 3;

export function independentCleanupSignal(
  timeoutMs = RESUME_CLEANUP_TIMEOUT_MS,
): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
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

/**
 * Pane layout closes one split; tab and workspace layouts close the agent's
 * whole tab (workspace tabs live in the Agents workspace).
 */
export function closeTargetArgs(
  layout: HerdrAgentLayout | undefined,
  tabId: string,
  paneId: string,
): string[] {
  return layout === 'pane'
    ? ['pane', 'close', paneId]
    : ['tab', 'close', tabId];
}

/**
 * Close a one-shot pane/tab after durably staging continuation metadata.
 * Stage first; close only after a successful stage; then atomically finalize
 * history as resumable and delete live state.
 */
export async function closeOneShot(target: {
  layout?: HerdrAgentLayout;
  tabId: string;
  paneId: string;
  resultFile?: string;
  lifecyclePane?: Pick<PaneInfo, 'terminal_id'>;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  let stagedId: string | undefined;
  try {
    stagedId = await stageClosedOneShotIfEligible({
      resultFile: target.resultFile,
      lifecyclePane: target.lifecyclePane,
      signal: target.signal,
    });
  } catch (error) {
    return errorMessage(error);
  }

  try {
    await execHerdr(
      closeTargetArgs(target.layout, target.tabId, target.paneId),
      target.signal,
    );
  } catch (error) {
    return errorMessage(error);
  }

  const finalizeOnce = async () => {
    if (stagedId) {
      await finalizeStagedClosedOneShot(
        {
          historyId: stagedId,
          livePane: target.lifecyclePane,
        },
        undefined,
        target.signal,
      );
    } else if (target.lifecyclePane) {
      await deleteAgentLifecycle(
        target.lifecyclePane,
        undefined,
        target.signal,
      );
    }
  };

  let finalizeError: string | undefined;
  for (let attempt = 0; attempt < FINALIZE_RETRY_ATTEMPTS; attempt++) {
    try {
      await finalizeOnce();
      finalizeError = undefined;
      break;
    } catch (error) {
      finalizeError = errorMessage(error);
    }
  }
  if (target.signal?.aborted) return errorMessage(target.signal.reason);
  if (finalizeError) {
    await bestEffort(false, async () => {
      const cleanupSignal = target.signal ?? independentCleanupSignal();
      const snapshot = await getSessionSnapshot(cleanupSignal);
      const state = await persistPrunedAgentsState(
        { panes: snapshot.panes, agents: snapshot.agents },
        { signal: cleanupSignal },
      );
      if (!stagedId) return true;
      const record = state.closedHistory.find((item) => item.id === stagedId);
      return record?.status === 'resumable';
    });
  }

  if (target.signal?.aborted) return errorMessage(target.signal.reason);
  await bestEffort(undefined, () => removeAgentTempFiles(target.resultFile));
  // Only pane-layout closes change a split column; tab/workspace closes remove
  // whole tabs and must not touch the Orchestrator's pane geometry.
  if (target.layout === 'pane') {
    await bestEffort(undefined, () =>
      rebalanceCurrentPaneAgents(target.signal),
    );
  }
  return undefined;
}

async function stageClosedOneShotIfEligible(target: {
  resultFile?: string;
  lifecyclePane?: Pick<PaneInfo, 'terminal_id'>;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  if (!target.lifecyclePane) return undefined;
  let state;
  try {
    state = await loadHerdrAgentsState();
  } catch {
    return undefined;
  }
  const key = paneStateKey(target.lifecyclePane);
  const live = key ? state.agents[key] : undefined;
  if (!live) return undefined;
  if (live.lifecycle !== 'oneshot') return undefined;
  if (!live.ownerSessionId || !live.tabLabel || !live.agent) {
    throw new Error(
      `Cannot close "${live.tabLabel ?? 'one-shot'}": missing owner/label/profile metadata needed to resume later.`,
    );
  }

  const meta = await readAgentSessionMeta(target.resultFile);
  if (!meta?.sessionFile || !meta.sessionId) {
    throw new Error(
      `Cannot close "${live.tabLabel}": child session metadata is missing, so the one-shot cannot be archived for resume.`,
    );
  }
  const header = await validateResumableSessionFile(meta.sessionFile, {
    sessionId: meta.sessionId,
    cwd: meta.cwd,
  });
  if (!header) {
    throw new Error(
      `Cannot close "${live.tabLabel}": child session file is missing, corrupt, or does not match the stored session id/cwd.`,
    );
  }

  target.signal?.throwIfAborted();
  const staged = await stageClosedOneShot(
    {
      ...(live.closedHistoryId ? { id: live.closedHistoryId } : {}),
      livePane: target.lifecyclePane,
      ownerSessionId: live.ownerSessionId,
      ...(live.ownerSessionFile
        ? { ownerSessionFile: live.ownerSessionFile }
        : {}),
      profileName: live.agent,
      tabLabel: live.tabLabel,
      childSessionFile: meta.sessionFile,
      childSessionId: header.id,
      cwd: header.cwd,
      layout: live.layout ?? 'pane',
    },
    undefined,
    target.signal,
  );
  return staged.id;
}

export function spawnWarningDetails(warnings: readonly string[]): {
  spawnWarnings?: string[];
} {
  return warnings.length > 0 ? { spawnWarnings: [...warnings] } : {};
}

export async function dropCollectedSpawnWarnings(
  pane: Pick<PaneInfo, 'terminal_id'> | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (!pane?.terminal_id) return;
  await bestEffort(undefined, () =>
    clearAgentSpawnWarnings(pane, undefined, signal),
  );
}

let panePlacementQueue: Promise<void> = Promise.resolve();

export async function acquirePanePlacementLock(): Promise<() => void> {
  const previous = panePlacementQueue;
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  panePlacementQueue = previous.then(() => current);
  await previous;
  return release;
}
