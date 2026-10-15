import type { AgentToolResult } from '@earendil-works/pi-coding-agent';

import { createAgentTempFiles, removeAgentTempFiles } from '../../artifacts.ts';
import { execHerdr } from '../../herdr/cli.ts';
import { listPanes } from '../../herdr/snapshot.ts';
import { CHILD_PROTOCOL } from '../../prompts.ts';
import { releaseClosedHistory } from '../../state/closed-history.ts';
import { ensureAgentsWidget } from '../../ui/poller.ts';
import { bestEffort } from '../../utils.ts';
import { closeTargetArgs, independentCleanupSignal } from '../one-shot.ts';
import {
  claimClosedHistoryForResume,
  reuseParkedAgent,
} from './continuation.ts';
import { runAgentTurn, startAndRecordAgent } from './lifecycle.ts';
import { acquirePanePlacementLock } from './placement-lock.ts';
import {
  createAgentPane,
  createAgentTab,
  resolveAgentPlacement,
} from './targets.ts';
import type {
  SpawnSettings,
  SpawnState,
  SpawnTarget,
  SpawnTargetResult,
  TaskInvocation,
} from './types.ts';

export async function runAgentTask(
  invocation: TaskInvocation,
  settings: SpawnSettings,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const spawn: SpawnState = {
    agent: settings.agent,
    tabLabel: settings.baseLabel,
    reused: false,
    resumed: false,
    resumeDurable: false,
    spawnWarnings: [],
  };
  // Pane spawns need the lock so parallel calls cannot create competing
  // right columns; workspace spawns serialize the Agents-workspace lookup
  // through it (within this process) so two parallel first spawns cannot
  // create it twice. The lock is released once the agent's tab is visible
  // to listTabs. Label uniqueness is computed client-side via uniqueLabel,
  // so subsequent `agent start` calls stay serialized only for placement.
  const releasePlacement =
    settings.layout === 'pane' || settings.layout === 'workspace'
      ? await acquirePanePlacementLock()
      : () => {};
  let target!: SpawnTarget;
  let placementReleased = false;
  const releasePlacementOnce = () => {
    if (placementReleased) return;
    placementReleased = true;
    releasePlacement();
  };

  try {
    const prepared = await prepareSpawnTarget(
      invocation,
      settings,
      spawn,
      releasePlacementOnce,
    );
    if ('error' in prepared) return prepared.error;
    target = prepared.target;
  } catch (error) {
    if (spawn.resumeClaim && !spawn.resumeDurable) {
      const cleanupSignal = independentCleanupSignal();
      let closedPartial = true;
      if (spawn.paneId && spawn.tabId) {
        const { paneId, tabId } = spawn;
        closedPartial = await bestEffort(false, async () => {
          await execHerdr(
            closeTargetArgs(settings.layout, tabId, paneId),
            cleanupSignal,
          );
          return true;
        });
      }
      await bestEffort(undefined, () => removeAgentTempFiles(spawn.resultFile));
      if (closedPartial) {
        await releaseClosedHistory(
          spawn.resumeClaim.id,
          spawn.resumeClaim.claimGeneration,
        );
      }
    }
    throw error;
  } finally {
    releasePlacementOnce();
  }

  ensureAgentsWidget(invocation.pi, invocation.ctx);

  return await runAgentTurn(invocation, spawn, target);
}

async function prepareSpawnTarget(
  invocation: TaskInvocation,
  settings: SpawnSettings,
  spawn: SpawnState,
  releasePlacementOnce: () => void,
): Promise<SpawnTargetResult> {
  const resolved = await resolveAgentPlacement(invocation, settings);
  if ('error' in resolved) return { error: resolved.error };
  const placement = resolved.placement;

  const earlyReuse = await reuseParkedAgent(
    invocation,
    settings,
    spawn,
    placement,
  );
  if (earlyReuse) return { error: earlyReuse };

  const earlyClaim = await claimClosedHistoryForResume(
    invocation,
    settings,
    spawn,
    placement,
  );
  if (earlyClaim) return { error: earlyClaim };

  if (!spawn.reused) {
    const profilePrompt = [spawn.agent.systemPrompt, CHILD_PROTOCOL]
      .filter(Boolean)
      .join('\n\n');
    const tempFiles = await createAgentTempFiles(profilePrompt);
    spawn.resultFile = tempFiles.resultFile;
    spawn.sessionMetaFile = tempFiles.sessionMetaFile;
    spawn.systemFile = tempFiles.systemFile;
  }

  if (!spawn.reused && placement.usesTabs) {
    await createAgentTab(invocation, settings, spawn, placement);
  }

  // The agent's tab now exists and is visible to the next `listTabs`,
  // so workspace spawns no longer need the placement lock. Uniqueness of
  // the label is computed client-side (uniqueLabel) — releasing here
  // still leaves a same-label parallel spawn window, which the
  // reuse contract already rules out (reuse is sequential by tabLabel).
  // Best effort: close the known root shell tab `workspace create`
  // starts every new workspace with. Only the creating spawn does this,
  // and only by id — never by "empty pane" heuristics, which can race
  // a sibling spawn whose agent has not started.
  if (settings.layout === 'workspace') {
    if (
      placement.agentsWorkspaceCreated &&
      !spawn.reused &&
      placement.agentsWorkspaceRootTabId
    ) {
      await bestEffort(undefined, () =>
        execHerdr(
          ['tab', 'close', placement.agentsWorkspaceRootTabId!],
          invocation.signal,
        ),
      );
    }
    releasePlacementOnce();
  }

  if (!spawn.reused && settings.layout === 'pane') {
    await createAgentPane(invocation, settings, spawn, placement);
  }

  const paneId = spawn.paneId;
  if (!spawn.tabId || !paneId) {
    throw new Error(
      `Could not identify Herdr tab or pane for ${spawn.tabLabel}.`,
    );
  }
  const tabId = spawn.tabId;

  if (!spawn.agentPane?.terminal_id) {
    spawn.agentPane = (await listPanes(invocation.signal)).find(
      (pane) => pane.pane_id === paneId,
    );
  }

  await startAndRecordAgent(invocation, settings, spawn, placement);
  return { target: { tabId, paneId } };
}
