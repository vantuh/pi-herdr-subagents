import {
  readAgentQuestion,
  readAgentResult,
  readAgentSessionMeta,
  removeAgentTempFiles,
  validateResumableSessionFile,
} from '../artifacts.ts';
import { readAgent } from '../herdr/agent.ts';
import { execHerdr } from '../herdr/cli.ts';
import {
  buildEqualAgentSplitRatios,
  exportPaneLayout,
  listManagedWorkspaceAgents,
  setLayoutSplitRatio,
} from '../herdr/placement.ts';
import { getCurrentContext, listPanes } from '../herdr/snapshot.ts';
import {
  finalizeStagedClosedOneShot,
  stageClosedOneShot,
} from '../state/closed-history.ts';
import {
  clearAgentSpawnWarnings,
  deleteAgentLifecycle,
  emptyHerdrAgentsState,
  loadHerdrAgentsState,
  paneStateKey,
  persistPrunedAgentsState,
} from '../state/store.ts';
import type { HerdrAgentLayout, PaneInfo } from '../types.ts';
import { formatAgentOutput, formatSpawnWarnings } from '../utils.ts';

export // Lifecycle state persistence (state/store.ts) is best-effort: a failure to
// load/save/prune/record/delete must never abort agent execution/output or
// manager listing. This swallows the error and returns a fallback so callers
// can proceed without persisted lifecycle info.
async function bestEffort<T>(fallback: T, task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch {
    return fallback;
  }
}

const RESUME_CLEANUP_TIMEOUT_MS = 8_000;
const FINALIZE_RETRY_ATTEMPTS = 3;

export function independentCleanupSignal(
  timeoutMs = RESUME_CLEANUP_TIMEOUT_MS,
): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function rebalanceCurrentPaneAgents(
  signal?: AbortSignal,
): Promise<void> {
  const current = await getCurrentContext(signal);
  const state = await bestEffort(emptyHerdrAgentsState(), () =>
    persistPrunedAgentsState(current.panes),
  );
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
    });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  try {
    await execHerdr(
      // Pane layout dissolves one split; tab and workspace layouts close the
      // agent's whole tab (workspace tabs live in the Agents workspace).
      target.layout === 'pane'
        ? ['pane', 'close', target.paneId]
        : ['tab', 'close', target.tabId],
      target.signal,
    );
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  const finalizeOnce = async () => {
    if (stagedId) {
      await finalizeStagedClosedOneShot({
        historyId: stagedId,
        livePane: target.lifecyclePane,
      });
    } else if (target.lifecyclePane) {
      await deleteAgentLifecycle(target.lifecyclePane);
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
  if (finalizeError) {
    await bestEffort(false, async () => {
      const panes = await listPanes(independentCleanupSignal());
      const state = await persistPrunedAgentsState(panes);
      if (!stagedId) return true;
      const record = state.closedHistory.find((item) => item.id === stagedId);
      return record?.status === 'resumable';
    });
  }

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

  const staged = await stageClosedOneShot({
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
  });
  return staged.id;
}

export function formatCollectedOutput(
  output: string,
  tabLabel: string,
  closeError: string | undefined,
  warnings: readonly string[],
): string {
  return formatSpawnWarnings(
    formatAgentOutput(output, tabLabel, closeError),
    warnings,
  );
}

export async function readSettledAgentOutput(
  resultFile: string | undefined,
  target: string,
  signal?: AbortSignal,
): Promise<{ question: string } | { output: string }> {
  const question = await readAgentQuestion(resultFile);
  if (question) return { question };
  const artifact = await readAgentResult(resultFile);
  return { output: artifact ?? (await readAgent(target, signal)) };
}

export function spawnWarningDetails(warnings: readonly string[]): {
  spawnWarnings?: string[];
} {
  return warnings.length > 0 ? { spawnWarnings: [...warnings] } : {};
}

export async function dropCollectedSpawnWarnings(
  pane: Pick<PaneInfo, 'terminal_id'> | undefined,
): Promise<void> {
  if (!pane?.terminal_id) return;
  await bestEffort(undefined, () => clearAgentSpawnWarnings(pane));
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
