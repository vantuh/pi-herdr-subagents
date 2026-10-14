export interface AgentProfile {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  thinking?: string;
  /** `[]` (frontmatter `skills: none`) means "no skills"; undefined keeps full discovery. */
  skills?: string[];
  systemPromptMode?: 'append' | 'replace';
  disableModelInvocation?: boolean;
  systemPrompt: string;
  source: 'user' | 'project';
  filePath: string;
}

export interface PaneInfo {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  terminal_id?: string;
  label?: string;
  focused?: boolean;
  agent?: string;
  agent_status?: string;
  cwd?: string;
  foreground_cwd?: string;
}

export interface TabInfo {
  tab_id: string;
  label: string;
}

/** "workspace" keeps every agent tab in a dedicated Agents workspace. */
export type HerdrAgentLayout = 'pane' | 'tab' | 'workspace';

export function isHerdrAgentLayout(value: unknown): value is HerdrAgentLayout {
  return value === 'pane' || value === 'tab' || value === 'workspace';
}

export interface WorkspaceInfo {
  workspace_id: string;
  label?: string;
}

export interface HerdrAgentStateRecord {
  lifecycle: 'oneshot' | 'persistent';
  serverSocketPath?: string;
  paneId?: string;
  ownerPaneId?: string;
  tabLabel?: string;
  agent?: string;
  automationName?: string;
  resultFile?: string;
  layout?: HerdrAgentLayout;
  /** Spawn-time profile values Pi ignored; retained until the outcome is delivered. */
  spawnWarnings?: string[];
  /**
   * Pending collection. Lives in the state file rather than memory so a
   * pending delivery survives `/reload`.
   */
  detached?: boolean;
  /** A committed outcome claim; a new task's lifecycle record clears it. */
  collected?: boolean;
  /**
   * Orchestrator pane `terminal_id` that spawned this agent. Widget, reuse,
   * and detached delivery all key off this so two Orchestrators in one
   * workspace do not claim each other's children.
   */
  ownerTerminalId?: string;
  /** Orchestrator Pi session UUID that spawned this agent. */
  ownerSessionId?: string;
  ownerSessionFile?: string;
  /** Closed-history slot this live agent is continuing, if any. */
  closedHistoryId?: string;
  closedHistoryGeneration?: number;
  updatedAt: string;
}

/** State-record fields a listed managed agent exposes. */
export type HerdrAgentStateInfoFields = Pick<
  HerdrAgentStateRecord,
  | 'automationName'
  | 'resultFile'
  | 'spawnWarnings'
  | 'detached'
  | 'ownerSessionId'
  | 'ownerSessionFile'
  | 'closedHistoryId'
  | 'closedHistoryGeneration'
> & { updatedAt?: string };

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
}

export interface ReusableAgentTab {
  tab: TabInfo;
  pane: PaneInfo;
}

export interface HerdrNamedAgent extends PaneInfo {
  name?: string;
}

export interface HerdrSessionSnapshot {
  panes: PaneInfo[];
  agents?: HerdrNamedAgent[];
  tabs: TabInfo[];
  focused_pane_id?: string;
}

export interface HerdrContext {
  panes: PaneInfo[];
  agents?: HerdrNamedAgent[];
  currentPane: PaneInfo;
  workspaceId: string;
  currentTab: string;
}
