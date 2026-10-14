import { readAgentQuestion, readAgentResult } from '../artifacts.ts';
import {
  getHerdrAgentsWorkspaceLabel,
  loadHerdrAgentsConfig,
} from '../config.ts';
import {
  getAgentSnapshot,
  isSettledAgentStatus,
  readAgent,
} from '../herdr/agent.ts';
import {
  findReusableAgentPane,
  findReusableAgentTab,
  findUnresolvedOwnedAgent,
} from '../herdr/placement.ts';
import {
  findAgentsWorkspaceId,
  getCurrentContext,
  listTabs,
} from '../herdr/snapshot.ts';
import { formatAgentQuestion } from '../prompts.ts';
import {
  emptyHerdrAgentsState,
  paneStateKey,
  persistPrunedAgentsState,
  type HerdrAgentStateRecord,
} from '../state/store.ts';
import type { AgentProfile, HerdrAgentLayout, PaneInfo } from '../types.ts';
import { bestEffort, formatSpawnWarnings } from '../utils.ts';
import { spawnWarningDetails } from './one-shot.ts';

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
      text: `A live Herdr agent named "${input.label}" is still working. Check its status with the same tabLabel and no task; do not resume a closed copy over live work.`,
    };
  }
  if (input.record?.detached) {
    return {
      action: 'reject',
      text: `A live Herdr agent named "${input.label}" already settled and is waiting to be delivered. Wait for delivery; do not resume a closed copy over live work.`,
    };
  }
  return {
    action: 'reject',
    text: `A live Herdr agent named "${input.label}" is still open. Check its status or answer it; do not resume a closed copy over live work.`,
  };
}

export async function executeAgentStatus(args: {
  agent: AgentProfile;
  tabLabel: string | undefined;
  baseLabel: string;
  layout: HerdrAgentLayout;
  ownerSessionId?: string;
  signal?: AbortSignal;
}) {
  const { agent, baseLabel, layout, signal } = args;
  if (!args.tabLabel?.trim()) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'tabLabel is required when task is omitted.',
        },
      ],
      details: {},
      isError: true,
    };
  }

  const current = await getCurrentContext(signal);
  const state = await bestEffort(emptyHerdrAgentsState(), () =>
    persistPrunedAgentsState(
      current.panes,
      undefined,
      undefined,
      undefined,
      current.agents,
    ),
  );
  // Tab and workspace layouts reuse by tab label; workspace tabs live in the
  // dedicated Agents workspace, so they are listed from there. A status check
  // is a pure lookup — it must never create the workspace.
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
  const stateKey = pane ? paneStateKey(pane) : undefined;
  const record = stateKey ? state.agents[stateKey] : undefined;
  const label = record?.tabLabel ?? baseLabel;
  const target = record?.automationName ?? pane?.pane_id;
  if (!pane || !tabId || !target) {
    const unresolved = findUnresolvedOwnedAgent(
      current,
      state,
      baseLabel,
      args.ownerSessionId,
    );
    return {
      content: [
        {
          type: 'text' as const,
          text: unresolved
            ? `Owned Herdr target ${unresolved.automationName} is still live, but its legacy owner/pane identity cannot be reconciled safely. Inspect that target; do not resend the task or spawn a replacement.`
            : `No running Herdr agent named "${baseLabel}" found.`,
        },
      ],
      details: {},
      isError: true,
    };
  }

  const spawnWarnings = record?.spawnWarnings ?? [];
  const question = await readAgentQuestion(record?.resultFile);
  if (question) {
    return {
      content: [
        {
          type: 'text' as const,
          text: formatSpawnWarnings(
            formatAgentQuestion(label, record?.agent ?? agent.name, question),
            spawnWarnings,
          ),
        },
      ],
      details: {
        tabId,
        paneId: pane.pane_id,
        tabLabel: label,
        agent,
        status: 'question',
        closed: false,
        ...spawnWarningDetails(spawnWarnings),
      },
    };
  }

  if (record?.collected) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Herdr agent ${label} was already collected. Close it with /herdr-agents if it is still open, then continue it with resumeClosed and the same tabLabel. Do not resend the previous task.`,
        },
      ],
      details: {
        tabId,
        paneId: pane.pane_id,
        tabLabel: label,
      },
    };
  }

  const snapshot = await getAgentSnapshot(target, signal);
  const recent = await readAgent(target, signal);
  const artifact = await readAgentResult(record?.resultFile);
  const finishedWithoutResult =
    isSettledAgentStatus(snapshot.status) && artifact === undefined;
  const text = finishedWithoutResult
    ? `Herdr agent ${label} (${pane.pane_id}) finished without a result.\n\n${recent}`
    : `Herdr agent ${label} (${pane.pane_id}) status: ${snapshot.status}.\n\n${recent}`;
  return {
    content: [
      {
        type: 'text' as const,
        text: formatSpawnWarnings(text, spawnWarnings),
      },
    ],
    details: {
      tabId,
      paneId: pane.pane_id,
      tabLabel: label,
      agent,
      status: snapshot.status,
      ...spawnWarningDetails(spawnWarnings),
    },
  };
}
