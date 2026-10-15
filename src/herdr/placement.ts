import type {
  HerdrAgentStateInfoFields,
  HerdrAgentStateRecord,
  HerdrAgentsState,
} from '../state/schema.ts';
import {
  isAgentOwnedBy,
  liveAgentWithAutomationName,
  paneStateKey,
} from '../state/store.ts';
import type { PaneInfo, TabInfo } from './schema.ts';
import type {
  HerdrAgentInfo,
  HerdrContext,
  ReusableAgentTab,
} from './types.ts';

export function findUnresolvedOwnedAgent(
  context: HerdrContext,
  state: HerdrAgentsState,
  label: string,
  ownerSessionId: string | undefined,
): HerdrAgentStateRecord | undefined {
  if (!ownerSessionId) return undefined;
  return Object.entries(state.agents).find(
    ([key, record]) =>
      record.lifecycle === 'oneshot' &&
      record.serverSocketPath === process.env.HERDR_SOCKET_PATH &&
      record.ownerSessionId === ownerSessionId &&
      record.tabLabel === label &&
      !context.panes.some((pane) => paneStateKey(pane) === key) &&
      liveAgentWithAutomationName(record, context.agents ?? []) !== undefined,
  )?.[1];
}

export function uniqueLabel(baseLabel: string, tabs: TabInfo[]): string {
  const labels = new Set(tabs.map((tab) => tab.label));
  if (!labels.has(baseLabel)) return baseLabel;

  for (let i = 2; ; i++) {
    const candidate = `${baseLabel} #${i}`;
    if (!labels.has(candidate)) return candidate;
  }
}

function choosePaneForTab(
  panes: PaneInfo[],
  tabId: string,
): PaneInfo | undefined {
  const tabPanes = panes.filter((pane) => pane.tab_id === tabId);
  return tabPanes.find((pane) => pane.agent === 'pi') ?? tabPanes[0];
}

export function findReusableAgentTab(
  context: HerdrContext,
  tabs: TabInfo[],
  baseLabel: string,
  state: HerdrAgentsState,
): ReusableAgentTab | undefined {
  // Record-driven first: the recorded tabLabel is authoritative (uniqueLabel
  // may have renamed the tab at spawn time), and ownership keeps a second
  // Orchestrator sharing the Agents workspace from adopting a foreign agent.
  for (const [key, record] of Object.entries(state.agents)) {
    if (record.tabLabel !== baseLabel) continue;
    // Only tab/workspace agents are reusable through this tab-based lookup;
    // pane-layout agents belong to the Orchestrator's own split column.
    if (record.layout !== 'tab' && record.layout !== 'workspace') continue;
    const pane = context.panes.find((item) => paneStateKey(item) === key);
    if (!pane || pane.agent !== 'pi') continue;
    if (
      !isAgentOwnedBy(
        record,
        context.currentPane.terminal_id,
        pane.tab_id,
        context.currentTab,
      )
    ) {
      continue;
    }
    const tab = tabs.find((item) => item.tab_id === pane.tab_id);
    return {
      pane,
      tab: tab ?? { tab_id: pane.tab_id, label: record.tabLabel },
    };
  }

  // Fall back to a live label scan, skipping tabs owned by other sessions.
  for (const tab of tabs) {
    if (tab.label !== baseLabel || tab.tab_id === context.currentTab) continue;
    const pane = choosePaneForTab(context.panes, tab.tab_id);
    if (!pane || pane.agent !== 'pi') continue;
    const key = paneStateKey(pane);
    const record = key ? state.agents[key] : undefined;
    if (
      !record ||
      (record.tabLabel !== undefined && record.tabLabel !== baseLabel) ||
      !isAgentOwnedBy(
        record,
        context.currentPane.terminal_id,
        pane.tab_id,
        context.currentTab,
      )
    ) {
      continue;
    }
    return { tab, pane };
  }
  return undefined;
}

export function findReusableAgentPane(
  context: HerdrContext,
  state: HerdrAgentsState,
  label: string,
): PaneInfo | undefined {
  return context.panes.find((pane) => {
    if (pane.workspace_id !== context.workspaceId) return false;
    if (pane.tab_id !== context.currentTab) return false;
    if (pane.pane_id === context.currentPane.pane_id || pane.agent !== 'pi') {
      return false;
    }
    const key = paneStateKey(pane);
    const record = key ? state.agents[key] : undefined;
    if (
      !record ||
      !isAgentOwnedBy(
        record,
        context.currentPane.terminal_id,
        pane.tab_id,
        context.currentTab,
      )
    ) {
      return false;
    }
    return (
      (record.layout === 'pane' || record.layout === undefined) &&
      record.tabLabel === label
    );
  });
}

/** State fields a listed managed agent exposes; ownership internals stay out. */
function pickAgentStateFields(
  record: HerdrAgentStateRecord,
): HerdrAgentStateInfoFields {
  return {
    ...(record.automationName ? { automationName: record.automationName } : {}),
    ...(record.resultFile ? { resultFile: record.resultFile } : {}),
    ...(record.spawnWarnings?.length
      ? { spawnWarnings: record.spawnWarnings }
      : {}),
    ...(record.detached ? { detached: true } : {}),
    ...(record.ownerSessionId ? { ownerSessionId: record.ownerSessionId } : {}),
    ...(record.ownerSessionFile
      ? { ownerSessionFile: record.ownerSessionFile }
      : {}),
    ...(record.closedHistoryId
      ? { closedHistoryId: record.closedHistoryId }
      : {}),
    ...(record.closedHistoryGeneration
      ? { closedHistoryGeneration: record.closedHistoryGeneration }
      : {}),
    ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
  };
}

export function listManagedWorkspaceAgents(
  context: HerdrContext,
  state: HerdrAgentsState,
): HerdrAgentInfo[] {
  const agents: HerdrAgentInfo[] = [];

  for (const pane of context.panes) {
    if (pane.pane_id === context.currentPane.pane_id) continue;

    const key = paneStateKey(pane);
    const record = key ? state.agents[key] : undefined;
    if (!record) continue;
    // Workspace-layout agents live in the dedicated Agents workspace, so they
    // are matched by record rather than by the current workspace id.
    if (
      pane.workspace_id !== context.workspaceId &&
      record.layout !== 'workspace'
    ) {
      continue;
    }
    if (
      !isAgentOwnedBy(
        record,
        context.currentPane.terminal_id,
        pane.tab_id,
        context.currentTab,
      )
    ) {
      continue;
    }

    agents.push({
      ...pickAgentStateFields(record),
      tabId: pane.tab_id,
      tabLabel: record.tabLabel ?? pane.label ?? record.agent ?? 'Agent',
      paneId: pane.pane_id,
      agent: record.agent ?? pane.agent ?? 'pi',
      status: pane.agent_status ?? 'unknown',
      lifecycle: record.lifecycle,
      layout:
        record.layout ?? (pane.tab_id === context.currentTab ? 'pane' : 'tab'),
      cwd: pane.foreground_cwd ?? pane.cwd,
      ...(pane.terminal_id ? { terminalId: pane.terminal_id } : {}),
    });
  }

  return agents.sort((a, b) => a.tabLabel.localeCompare(b.tabLabel));
}
