import type { AgentToolResult } from '@earendil-works/pi-coding-agent';

import {
  clearAgentQuestion,
  clearAgentResult,
  createResultFile,
  RESULT_FILE_MARKER,
} from '../../artifacts.ts';
import { promptAgent, startAgent } from '../../herdr/agent.ts';
import { rebalanceCurrentPaneAgents } from '../../herdr/layout.ts';
import { listPanes } from '../../herdr/snapshot.ts';
import { formatSpawnWarnings, spawnWarningDetails } from '../../output.ts';
import { NO_WAIT_HINT } from '../../prompts.ts';
import { recordAgentLifecycle } from '../../state/lifecycle.ts';
import { bestEffort, makeHerdrAgentName } from '../../utils.ts';
import { buildChildPiArgs } from '../child-args.ts';
import { textResult } from '../result.ts';
import type {
  AgentPlacement,
  SpawnSettings,
  SpawnState,
  SpawnTarget,
  TaskInvocation,
} from './types.ts';

function resumedDetails(resumed: boolean): { resumed?: boolean } {
  return resumed ? { resumed: true } : {};
}

function turnDetails(
  spawn: SpawnState,
  target: { tabId?: string; paneId?: string },
): Record<string, unknown> {
  return {
    tabId: target.tabId,
    paneId: target.paneId,
    name: spawn.tabLabel,
    reused: spawn.reused,
    ...resumedDetails(spawn.resumed),
    agent: spawn.agent,
    ...spawnWarningDetails(spawn.spawnWarnings),
  };
}

export async function startAndRecordAgent(
  invocation: TaskInvocation,
  settings: SpawnSettings,
  spawn: SpawnState,
  placement: AgentPlacement,
): Promise<void> {
  const { ctx, signal, onUpdate } = invocation;
  const { layout } = settings;

  if (!spawn.reused) {
    spawn.automationName = makeHerdrAgentName(spawn.agent.name);
    const built = await buildChildPiArgs({
      agent: spawn.agent,
      tabLabel: spawn.tabLabel,
      systemFile: spawn.systemFile!,
      cwd: spawn.resumeClaim?.cwd ?? ctx.cwd,
      ...(spawn.resumeClaim
        ? { sessionFile: spawn.resumeClaim.childSessionFile }
        : {}),
    });
    spawn.spawnWarnings = built.spawnWarnings;
    const piArgs = built.piArgs;

    onUpdate?.({
      content: [
        {
          type: 'text',
          text: spawn.resumed
            ? `Resuming Herdr agent ${spawn.tabLabel} (${spawn.paneId})...`
            : `Starting Herdr agent ${spawn.tabLabel} (${spawn.paneId})...`,
        },
      ],
      details: turnDetails(spawn, {
        tabId: spawn.tabId,
        paneId: spawn.paneId,
      }),
    });
    await startAgent(spawn.automationName, spawn.paneId!, piArgs, signal);
    spawn.agentPane =
      (await listPanes(signal)).find((pane) => pane.pane_id === spawn.paneId) ??
      spawn.agentPane;
  } else {
    spawn.resultFile ??= await createResultFile();
  }

  if (spawn.agentPane) {
    const pane = spawn.agentPane;
    const writeLifecycle = () =>
      recordAgentLifecycle(pane, {
        tabLabel: spawn.tabLabel,
        agent: spawn.agent.name,
        automationName: spawn.automationName,
        resultFile: spawn.resultFile,
        layout,
        ...(spawn.spawnWarnings.length > 0
          ? { spawnWarnings: spawn.spawnWarnings }
          : {}),
        // A reopened closed agent gets no task, so no outcome is pending.
        detached: invocation.task !== undefined,
        ownerPaneId: placement.current.currentPane.pane_id,
        ...(placement.current.currentPane.terminal_id
          ? { ownerTerminalId: placement.current.currentPane.terminal_id }
          : {}),
        ...settings.owner,
        ...(spawn.resumeClaim
          ? {
              closedHistoryId: spawn.resumeClaim.id,
              closedHistoryGeneration: spawn.resumeClaim.claimGeneration,
            }
          : {}),
      }).then(() => {
        spawn.lifecycleRecorded = !!pane.terminal_id;
      });
    if (spawn.resumeClaim) {
      await writeLifecycle();
      spawn.resumeDurable = true;
    } else {
      await bestEffort(undefined, writeLifecycle);
    }
  } else if (spawn.resumeClaim) {
    throw new Error(
      `Could not record a live lifecycle for resumed Herdr agent ${spawn.tabLabel}.`,
    );
  }
  if (layout === 'pane') {
    await bestEffort(undefined, () => rebalanceCurrentPaneAgents(signal));
  }
}

export async function runAgentTurn(
  invocation: TaskInvocation,
  spawn: SpawnState,
  target: SpawnTarget,
  task: string,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const { signal, onUpdate } = invocation;
  const { tabId, paneId } = target;
  const tabLabel = spawn.tabLabel;

  const promptTarget = spawn.automationName ?? paneId;
  const taskPrompt = [
    `You are the ${spawn.agent.name} Herdr agent.`,
    '',
    'Task from Orchestrator:',
    task,
    '',
    'All assistant text you write for this task is captured as the result artifact.',
    `${RESULT_FILE_MARKER} ${spawn.resultFile}`,
  ].join('\n');

  await clearAgentResult(spawn.resultFile);
  // A leftover question from the previous turn would otherwise be reported
  // again as soon as this prompt finishes.
  await clearAgentQuestion(spawn.resultFile);

  onUpdate?.({
    content: [
      {
        type: 'text',
        text: `Sending task to Herdr agent ${tabLabel} (${paneId})...`,
      },
    ],
    details: {
      tabId,
      paneId,
      name: tabLabel,
      reused: spawn.reused,
      agent: spawn.agent,
    },
  });

  await promptAgent(promptTarget, taskPrompt, signal);

  return textResult(
    formatSpawnWarnings(
      `${spawn.reused ? `Answer sent to Herdr agent ${tabLabel}` : `Herdr agent ${tabLabel} started`} (${paneId}). ${NO_WAIT_HINT}`,
      spawn.spawnWarnings,
    ),
    turnDetails(spawn, target),
  );
}
