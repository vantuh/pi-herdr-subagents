import type { AgentToolResult } from '@earendil-works/pi-coding-agent';

import { discoverAgents } from '../../agents.ts';
import {
  readAgentQuestion,
  resumableSessionDirError,
  validateResumableSessionFile,
} from '../../artifacts.ts';
import {
  findReusableAgentPane,
  findReusableAgentTab,
  findUnresolvedOwnedAgent,
} from '../../herdr/placement.ts';
import {
  claimClosedHistory,
  findOwnedClosedHistory,
  markClosedHistoryInvalid,
  releaseClosedHistory,
} from '../../state/closed-history.ts';
import { paneStateKey } from '../../state/live-records.ts';
import { bestEffort } from '../../utils.ts';
import { textResult } from '../result.ts';
import { resumeClosedLiveDecision } from '../status.ts';
import type {
  AgentPlacement,
  SpawnSettings,
  SpawnState,
  TaskInvocation,
} from './types.ts';

export async function reuseParkedAgent(
  invocation: TaskInvocation,
  settings: SpawnSettings,
  spawn: SpawnState,
  placement: AgentPlacement,
): Promise<AgentToolResult<Record<string, unknown>> | undefined> {
  const { params } = invocation;
  const { current, state, tabs, usesTabs } = placement;
  const { baseLabel, resumeClosed } = settings;
  const unresolved = findUnresolvedOwnedAgent(
    current,
    state,
    baseLabel,
    settings.owner.ownerSessionId,
  );
  if (unresolved) {
    return textResult(
      `Owned Herdr target ${unresolved.automationName} is still live, but its legacy owner/pane identity cannot be reconciled safely. Inspect that target; do not resend the task or spawn a replacement.`,
      { tabLabel: baseLabel },
      true,
    );
  }

  const candidateTab = usesTabs
    ? findReusableAgentTab(current, tabs, baseLabel, state)
    : undefined;
  const candidatePane = usesTabs
    ? candidateTab?.pane
    : findReusableAgentPane(current, state, baseLabel);
  const candidateKey = candidatePane ? paneStateKey(candidatePane) : undefined;
  const candidateRecord = candidateKey ? state.agents[candidateKey] : undefined;
  const answeringQuestion =
    !!candidateRecord &&
    (await bestEffort(undefined, () =>
      readAgentQuestion(candidateRecord.resultFile),
    )) !== undefined;

  // A task explicitly addressed by label to a live agent is almost
  // certainly a failed reuse: silently spawning a
  // duplicate ("... #2") would orphan the live pane. Default labels
  // fall through — parallel spawns of one profile get suffixed labels
  // via uniqueLabel. Fail loudly with the alternatives instead.
  if (
    params.tabLabel?.trim() &&
    !resumeClosed &&
    !answeringQuestion &&
    candidatePane
  ) {
    return textResult(
      `A live Herdr agent named "${baseLabel}" already exists and cannot receive a new task. If it is still working, call herdr_agent again with the same tabLabel and no task to check its status. If it already settled, wait for the result to be delivered, then use resumeClosed: true with the same tabLabel to continue it with its context. If you want a fresh agent, pass a different tabLabel.`,
      {
        tabLabel: baseLabel,
        paneId: candidatePane.pane_id,
        existingLifecycle: candidateRecord?.lifecycle,
      },
      true,
    );
  }

  if (resumeClosed && candidatePane) {
    const decision = resumeClosedLiveDecision({
      label: baseLabel,
      pane: candidatePane,
      record: candidateRecord,
      answeringQuestion,
    });
    if (decision.action === 'reject') {
      return textResult(
        decision.text,
        {
          resumeClosed: true,
          tabLabel: baseLabel,
          paneId: candidatePane.pane_id,
          liveStatus: candidatePane.agent_status,
          detached: candidateRecord?.detached === true,
        },
        true,
      );
    }
  }

  if (answeringQuestion && candidatePane) {
    spawn.reused = true;
    spawn.tabId = candidateTab?.tab.tab_id ?? candidatePane.tab_id;
    spawn.tabLabel = candidateRecord?.tabLabel ?? baseLabel;
    spawn.paneId = candidatePane.pane_id;
    spawn.agentPane = candidatePane;
    spawn.automationName = candidateRecord?.automationName;
    spawn.resultFile = candidateRecord?.resultFile;
    // A new task on an existing pane is not the first collection:
    // do not copy spawn-time notes onto subsequent turns.
  }
  return undefined;
}

export async function claimClosedHistoryForResume(
  invocation: TaskInvocation,
  settings: SpawnSettings,
  spawn: SpawnState,
  placement: AgentPlacement,
): Promise<AgentToolResult<Record<string, unknown>> | undefined> {
  const { params } = invocation;
  const { resumeClosed, owner } = settings;
  if (!resumeClosed || spawn.reused) return undefined;

  if (!owner.ownerSessionId) {
    return textResult(
      'Cannot resume a closed agent: this Orchestrator session has no session id.',
      { resumeClosed: true },
      true,
    );
  }
  const existing = findOwnedClosedHistory(
    placement.state,
    owner.ownerSessionId,
    params.tabLabel!.trim(),
  );
  if (!existing) {
    return textResult(
      `No closed one-shot Herdr agent named "${params.tabLabel!.trim()}" is owned by this Orchestrator session.`,
      { resumeClosed: true },
      true,
    );
  }
  const claimed = await claimClosedHistory({
    ownerSessionId: owner.ownerSessionId,
    tabLabel: existing.tabLabel,
    profileName: spawn.agent.name,
  });
  if (!claimed.ok) {
    return textResult(claimed.error, { resumeClosed: true }, true);
  }

  spawn.resumeClaim = claimed.record;
  const record = claimed.record;
  const cwdError = await resumableSessionDirError(record.cwd);
  const header = cwdError
    ? undefined
    : await validateResumableSessionFile(record.childSessionFile, {
        sessionId: record.childSessionId,
        cwd: record.cwd,
      });
  if (cwdError || !header) {
    const invalidated = await bestEffort(false, async () => {
      await markClosedHistoryInvalid(record.id, record.claimGeneration);
      return true;
    });
    // A successful invalidation already drops the claim; releasing it again
    // would only add a state read that can fail over the error below.
    if (!invalidated) {
      await bestEffort(undefined, () =>
        releaseClosedHistory(record.id, record.claimGeneration),
      );
    }
    return textResult(
      cwdError
        ? `Cannot resume "${record.tabLabel}": ${cwdError}`
        : `Cannot resume "${record.tabLabel}": child session file is missing, corrupt, or does not match the stored session id/cwd.`,
      { resumeClosed: true },
      true,
    );
  }
  spawn.resumed = true;
  spawn.tabLabel = claimed.record.tabLabel;
  const resumedAgents = await discoverAgents(claimed.record.cwd);
  spawn.agent =
    resumedAgents.find((item) => item.name === params.agent) ?? spawn.agent;
  return undefined;
}
