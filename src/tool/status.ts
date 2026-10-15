import type { AgentProfile } from '../agents/types.ts';
import { readAgentQuestion, readAgentResult } from '../artifacts.ts';
import { getHerdrAgentsWorkspaceLabel } from '../config.ts';
import type { HerdrAgentLayout, HerdrAgentsConfig } from '../config/schema.ts';
import { getAgentSnapshot, isSettledAgentStatus } from '../herdr/agent.ts';
import {
  findReusableAgentPane,
  findReusableAgentTab,
  findUnresolvedOwnedAgent,
} from '../herdr/placement.ts';
import type { PaneInfo } from '../herdr/schema.ts';
import {
  findAgentsWorkspaceId,
  listTabs,
  loadContextWithState,
} from '../herdr/snapshot.ts';
import {
  formatAssistantPreview,
  formatSpawnWarnings,
  spawnWarningDetails,
} from '../output.ts';
import { formatAgentQuestion } from '../prompts.ts';
import type { HerdrAgentStateRecord } from '../state/schema.ts';
import { paneStateKey } from '../state/store.ts';
import { textResult } from './result.ts';

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
  config: HerdrAgentsConfig;
  ownerSessionId?: string;
  signal?: AbortSignal;
}) {
  const { agent, baseLabel, layout, signal } = args;
  if (!args.tabLabel?.trim()) {
    return textResult('tabLabel is required when task is omitted.', {}, true);
  }

  const { context: current, state } = await loadContextWithState(signal);
  // Tab and workspace layouts reuse by tab label; workspace tabs live in the
  // dedicated Agents workspace, so they are listed from there. A status check
  // is a pure lookup — it must never create the workspace.
  const usesTabs = layout === 'tab' || layout === 'workspace';
  const agentsWorkspaceId =
    layout === 'workspace'
      ? await findAgentsWorkspaceId(
          getHerdrAgentsWorkspaceLabel(args.config),
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
    return textResult(
      unresolved
        ? `Owned Herdr target ${unresolved.automationName} is still live, but its legacy owner/pane identity cannot be reconciled safely. Inspect that target; do not resend the task or spawn a replacement.`
        : `No running Herdr agent named "${baseLabel}" found.`,
      {},
      true,
    );
  }

  const spawnWarnings = record?.spawnWarnings ?? [];
  const question = await readAgentQuestion(record?.resultFile);
  if (question) {
    return textResult(
      formatSpawnWarnings(
        formatAgentQuestion(label, record?.agent ?? agent.name, question),
        spawnWarnings,
      ),
      {
        tabId,
        paneId: pane.pane_id,
        tabLabel: label,
        agent,
        status: 'question',
        closed: false,
        ...spawnWarningDetails(spawnWarnings),
      },
    );
  }

  if (record?.collected) {
    return textResult(
      `Herdr agent ${label} was already collected. Close it with /herdr-agents if it is still open, then continue it with resumeClosed and the same tabLabel. Do not resend the previous task.`,
      {
        tabId,
        paneId: pane.pane_id,
        tabLabel: label,
      },
    );
  }

  const snapshot = await getAgentSnapshot(target, signal);
  const artifact = await readAgentResult(record?.resultFile);
  const settledWithoutResult =
    isSettledAgentStatus(snapshot.status) && artifact === undefined;
  const statusLine = settledWithoutResult
    ? `Herdr agent ${label} (${pane.pane_id}) finished without a result.`
    : `Herdr agent ${label} (${pane.pane_id}) status: ${snapshot.status}.`;
  const text = artifact
    ? `${statusLine}\n\nLatest assistant text (preview; not a completion):\n${formatAssistantPreview(artifact)}`
    : statusLine;
  return textResult(formatSpawnWarnings(text, spawnWarnings), {
    tabId,
    paneId: pane.pane_id,
    tabLabel: label,
    agent,
    status: snapshot.status,
    ...spawnWarningDetails(spawnWarnings),
  });
}
