import type { ContextMetrics } from '../artifacts/schema.ts';
import type { HerdrAgentLayout } from '../config/schema.ts';
import type { HerdrAgentStateInfoFields } from '../state/schema.ts';
import type { HerdrNamedAgent, PaneInfo, TabInfo } from './schema.ts';

export interface ReusableAgentTab {
  tab: TabInfo;
  pane: PaneInfo;
}

export interface HerdrContext {
  panes: PaneInfo[];
  agents?: HerdrNamedAgent[];
  currentPane: PaneInfo;
  workspaceId: string;
  currentTab: string;
}

export interface HerdrAgentInfo extends HerdrAgentStateInfoFields {
  tabId: string;
  tabLabel: string;
  paneId: string;
  agent: string;
  status: string;
  lifecycle?: 'oneshot';
  layout?: HerdrAgentLayout;
  cwd?: string;
  /** Pane terminal id — the state-record key. */
  terminalId?: string;
  /** Display-only context sample; never persisted with the agent record. */
  context?: ContextMetrics;
}
