export interface AgentProfile {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
}

export interface PaneInfo {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  terminal_id?: string;
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

export interface HerdrAgentInfo {
  tabId: string;
  tabLabel: string;
  paneId: string;
  agent: string;
  status: string;
  lifecycle?: HerdrAgentLifecycle;
  cwd?: string;
}

export interface ReusableAgentTab {
  tab: TabInfo;
  pane: PaneInfo;
}

export interface HerdrContext {
  panes: PaneInfo[];
  currentPane: PaneInfo;
  workspaceId: string;
  currentTab: string;
}
