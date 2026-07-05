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
  focused?: boolean;
  agent?: string;
  agent_status?: string;
}

export interface TabInfo {
  tab_id: string;
  label: string;
  focused?: boolean;
  agent_status?: string;
}

export interface HerdrContext {
  panes: PaneInfo[];
  currentPane: PaneInfo;
  workspaceId: string;
  currentTab: string;
}
