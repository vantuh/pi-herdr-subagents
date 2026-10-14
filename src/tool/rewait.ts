import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
} from '@earendil-works/pi-coding-agent';

import {
  getHerdrAgentsWorkspaceLabel,
  loadHerdrAgentsConfig,
} from '../config.ts';
import { waitForAgent } from '../herdr/agent.ts';
import {
  findReusableAgentPane,
  findReusableAgentTab,
} from '../herdr/placement.ts';
import {
  findAgentsWorkspaceId,
  getCurrentContext,
  listTabs,
} from '../herdr/snapshot.ts';
import { formatAgentQuestion } from '../prompts.ts';
import {
  claimDetachedAgent,
  emptyHerdrAgentsState,
  paneStateKey,
  persistPrunedAgentsState,
  type HerdrAgentStateRecord,
} from '../state/store.ts';
import type { AgentProfile, HerdrAgentLayout, PaneInfo } from '../types.ts';
import { beginAwaitingAgent, endAwaitingAgent } from '../ui/poller.ts';
import {
  formatSpawnWarnings,
  formatWaitInterrupted,
  isRecoverableWaitInterrupt,
  waitInterruptReason,
} from '../utils.ts';
import {
  bestEffort,
  closeOneShot,
  dropCollectedSpawnWarnings,
  formatCollectedOutput,
  readSettledAgentOutput,
  spawnWarningDetails,
} from './one-shot.ts';

export function resumedDetails(resumed: boolean): { resumed?: boolean } {
  return resumed ? { resumed: true } : {};
}

export function resumeClosedLiveDecision(input: {
  label: string;
  pane: PaneInfo;
  record?: HerdrAgentStateRecord;
  answeringQuestion: boolean;
}): { action: 'reuse' } | { action: 'reject'; text: string } {
  if (input.answeringQuestion) return { action: 'reuse' };
  const status = input.pane.agent_status;
  if (status === 'working' || status === 'blocked') {
    return {
      action: 'reject',
      text: `A live Herdr agent named "${input.label}" is still working. Omit task to re-wait; do not resume a closed copy over live work.`,
    };
  }
  if (input.record?.detached) {
    return {
      action: 'reject',
      text: `A live Herdr agent named "${input.label}" already settled and is waiting to be collected. Re-wait or let the widget deliver it; do not resume a closed copy over live work.`,
    };
  }
  return {
    action: 'reject',
    text: `A live Herdr agent named "${input.label}" is still open. Re-wait or answer it; do not resume a closed copy over live work.`,
  };
}

export async function executeRewait(
  pi: ExtensionAPI,
  args: {
    agent: AgentProfile;
    tabLabel: string | undefined;
    baseLabel: string;
    layout: HerdrAgentLayout;
    wait: boolean;
    timeoutMs: number;
    signal?: AbortSignal;
    onUpdate?: AgentToolUpdateCallback<Record<string, unknown>>;
  },
) {
  const { agent, baseLabel, layout, wait, timeoutMs, signal, onUpdate } = args;
  if (!args.tabLabel?.trim()) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'tabLabel is required when task is omitted (re-wait mode).',
        },
      ],
      isError: true,
    };
  }

  const current = await getCurrentContext(signal);
  const state = await bestEffort(emptyHerdrAgentsState(), () =>
    persistPrunedAgentsState(current.panes),
  );
  // Tab and workspace layouts reuse by tab label; workspace tabs live in the
  // dedicated Agents workspace, so they are listed from there. Re-wait is a
  // pure lookup — it must never create the workspace, so a missing one just
  // means there is nothing to find.
  const usesTabs = layout === 'tab' || layout === 'workspace';
  const agentsWorkspaceId =
    layout === 'workspace'
      ? await findAgentsWorkspaceId(
          getHerdrAgentsWorkspaceLabel(await loadHerdrAgentsConfig()),
          signal,
        )
      : undefined;
  const tabs =
    usesTabs && (layout !== 'workspace' || agentsWorkspaceId)
      ? await listTabs(agentsWorkspaceId ?? current.workspaceId, signal)
      : [];
  const reusableTab = usesTabs
    ? findReusableAgentTab(current, tabs, baseLabel, state)
    : undefined;
  const reusablePane =
    layout === 'pane'
      ? findReusableAgentPane(current, state, baseLabel)
      : undefined;
  const pane = reusableTab?.pane ?? reusablePane;
  const tabId = reusableTab?.tab.tab_id ?? reusablePane?.tab_id;
  const label = reusableTab?.tab.label ?? baseLabel;
  const stateKey = pane ? paneStateKey(pane) : undefined;
  const record = stateKey ? state.agents[stateKey] : undefined;
  const target = record?.automationName ?? pane?.pane_id;
  if (!pane || !tabId || !target) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `No running Herdr agent named "${baseLabel}" found to re-wait on.`,
        },
      ],
      isError: true,
    };
  }

  onUpdate?.({
    content: [
      {
        type: 'text',
        text: `Reconnecting to existing Herdr agent ${label} (${pane.pane_id})...`,
      },
    ],
    details: { tabId, paneId: pane.pane_id, tabLabel: label, agent },
  });

  if (!wait) {
    const spawnWarnings = record?.spawnWarnings ?? [];
    return {
      content: [
        {
          type: 'text' as const,
          text: formatSpawnWarnings(
            `Herdr agent ${label} (${pane.pane_id}) is still running.`,
            spawnWarnings,
          ),
        },
      ],
      details: {
        tabId,
        paneId: pane.pane_id,
        tabLabel: label,
        agent,
        waited: false,
        ...spawnWarningDetails(spawnWarnings),
      },
    };
  }

  const blockedLabel = `waiting for ${label}`;
  pi.events.emit('herdr:blocked', { active: true, label: blockedLabel });
  beginAwaitingAgent(label);
  try {
    await waitForAgent(target, timeoutMs, signal);
    const settled = await readSettledAgentOutput(
      record?.resultFile,
      target,
      signal,
    );
    if ('question' in settled) {
      const spawnWarnings = record?.spawnWarnings ?? [];
      await dropCollectedSpawnWarnings(pane);
      return {
        content: [
          {
            type: 'text' as const,
            text: formatSpawnWarnings(
              formatAgentQuestion(
                label,
                record?.agent ?? agent.name,
                settled.question,
              ),
              spawnWarnings,
            ),
          },
        ],
        details: {
          tabId,
          paneId: pane.pane_id,
          tabLabel: label,
          closed: false,
          agent,
          waited: true,
          status: 'question',
          ...spawnWarningDetails(spawnWarnings),
        },
      };
    }
    // An explicit re-wait collects the result, so release the poller's claim.
    await bestEffort(false, () => claimDetachedAgent(pane));
    let closed = false;
    let closeError: string | undefined;
    if (record?.lifecycle === 'oneshot') {
      closeError = await closeOneShot({
        layout: record.layout,
        tabId,
        paneId: pane.pane_id,
        resultFile: record.resultFile,
        lifecyclePane: pane,
        signal,
      });
      closed = closeError === undefined;
    }
    const spawnWarnings = record?.spawnWarnings ?? [];
    const text = formatCollectedOutput(
      settled.output,
      label,
      closeError,
      spawnWarnings,
    );
    await dropCollectedSpawnWarnings(pane);
    return {
      content: [{ type: 'text' as const, text }],
      details: {
        tabId,
        paneId: pane.pane_id,
        tabLabel: label,
        agent,
        waited: true,
        closed,
        closeError,
        ...spawnWarningDetails(spawnWarnings),
      },
    };
  } catch (error) {
    if (isRecoverableWaitInterrupt(error)) {
      const reason = waitInterruptReason(error);
      const spawnWarnings = record?.spawnWarnings ?? [];
      return {
        content: [
          {
            type: 'text' as const,
            text: formatSpawnWarnings(
              formatWaitInterrupted(label, reason),
              spawnWarnings,
            ),
          },
        ],
        details: {
          tabId,
          paneId: pane.pane_id,
          tabLabel: label,
          agent,
          waited: false,
          interrupted: true,
          interruptReason: reason,
          ...spawnWarningDetails(spawnWarnings),
        },
      };
    }
    throw error;
  } finally {
    endAwaitingAgent(label);
    pi.events.emit('herdr:blocked', {
      active: false,
      label: blockedLabel,
    });
  }
}
