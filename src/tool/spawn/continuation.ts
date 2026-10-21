import type { AgentToolResult } from '@earendil-works/pi-coding-agent';

import { discoverAgents } from '../../agents.ts';
import { readAgentQuestion } from '../../artifacts.ts';
import {
  resumableSessionDirError,
  validateResumableSessionFile,
} from '../../artifacts/sessions.ts';
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
import {
  liveAgentResumeRefusal,
  unresolvedOwnedAgentResult,
} from '../status.ts';
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
  const { current, state, tabs, usesTabs } = placement;
  const { baseLabel, mode } = settings;
  const unresolved = findUnresolvedOwnedAgent(
    current,
    state,
    baseLabel,
    settings.owner.ownerSessionId,
  );
  if (unresolved) {
    return unresolvedOwnedAgentResult(unresolved);
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

  // A caller-chosen name that matches a live agent is almost certainly a
  // failed reuse: silently spawning a duplicate ("... #2") would orphan the
  // live pane. Default names fall through — parallel spawns of one profile get
  // suffixed labels via uniqueLabel.
  if (mode === 'spawn' && settings.explicitName && candidatePane) {
    return textResult(
      `A live agent named "${baseLabel}" already exists. Use agent_send with that name to answer or steer it, or pass a different name for a fresh agent.`,
      {
        name: baseLabel,
        paneId: candidatePane.pane_id,
        existingLifecycle: candidateRecord?.lifecycle,
      },
      true,
    );
  }

  if (mode === 'resume' && candidatePane) {
    const refusal = liveAgentResumeRefusal({
      label: baseLabel,
      pane: candidatePane,
      record: candidateRecord,
    });
    return textResult(
      refusal,
      {
        name: baseLabel,
        paneId: candidatePane.pane_id,
        liveStatus: candidatePane.agent_status,
        detached: candidateRecord?.detached === true,
      },
      true,
    );
  }

  if (mode === 'answer') {
    if (!answeringQuestion || !candidatePane) {
      return textResult(
        `Agent "${baseLabel}" has no parked question to answer.`,
        { name: baseLabel },
        true,
      );
    }
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
  const { mode, owner, baseLabel } = settings;
  if (mode !== 'resume' || spawn.reused) return undefined;

  if (!owner.ownerSessionId) {
    return textResult(
      'Cannot resume a closed agent: this Orchestrator session has no session id.',
      { name: baseLabel },
      true,
    );
  }
  const existing = findOwnedClosedHistory(
    placement.state,
    owner.ownerSessionId,
    baseLabel,
  );
  if (!existing) {
    return textResult(
      `No closed one-shot Herdr agent named "${baseLabel}" is owned by this Orchestrator session.`,
      { name: baseLabel },
      true,
    );
  }
  const claimed = await claimClosedHistory({
    ownerSessionId: owner.ownerSessionId,
    tabLabel: existing.tabLabel,
    profileName: spawn.agent.name,
  });
  if (!claimed.ok) {
    return textResult(claimed.error, { name: baseLabel }, true);
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
      { name: baseLabel },
      true,
    );
  }
  spawn.resumed = true;
  spawn.tabLabel = claimed.record.tabLabel;
  const resumedAgents = await discoverAgents(claimed.record.cwd);
  spawn.agent =
    resumedAgents.find((item) => item.name === spawn.agent.name) ?? spawn.agent;
  return undefined;
}
