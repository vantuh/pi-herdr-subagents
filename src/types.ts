export type SystemPromptMode = "append" | "replace";

export interface AgentProfile {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  thinking?: string;
  /** `[]` (frontmatter `skills: none`) means "no skills"; undefined keeps full discovery. */
  skills?: string[];
  systemPromptMode?: SystemPromptMode;
  disableModelInvocation?: boolean;
  systemPrompt: string;
  source: "user" | "project";
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
  focused?: boolean;
  agent_status?: string;
}

export type HerdrAgentLifecycle = "oneshot" | "persistent";
/** "workspace" keeps every agent tab in a dedicated Agents workspace. */
export type HerdrAgentLayout = "pane" | "tab" | "workspace";

export interface WorkspaceInfo {
  workspace_id: string;
  label?: string;
  focused?: boolean;
}

export interface HerdrAgentInfo {
  tabId: string;
  tabLabel: string;
  paneId: string;
  agent: string;
  automationName?: string;
  resultFile?: string;
  status: string;
  lifecycle?: HerdrAgentLifecycle;
  layout?: HerdrAgentLayout;
  cwd?: string;
  /** State-record timestamp: when this agent last received a task. */
  updatedAt?: string;
  /** Spawn-time profile values Pi ignored; surfaced in every collection path. */
  spawnWarnings?: string[];
  /** Spawned with `wait: false` and not yet collected. */
  detached?: boolean;
  /** Pane terminal id — the state-record key. */
  terminalId?: string;
  ownerSessionId?: string;
  ownerSessionFile?: string;
  closedHistoryId?: string;
  closedHistoryGeneration?: number;
}

export interface ReusableAgentTab {
  tab: TabInfo;
  pane: PaneInfo;
}

export interface HerdrSessionSnapshot {
  panes: PaneInfo[];
  tabs: TabInfo[];
  focused_pane_id?: string;
  focused_tab_id?: string;
  focused_workspace_id?: string;
  protocol?: number;
  version?: string;
}

export interface HerdrContext {
  panes: PaneInfo[];
  currentPane: PaneInfo;
  workspaceId: string;
  currentTab: string;
}
