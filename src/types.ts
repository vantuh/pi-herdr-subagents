import { Type } from 'typebox';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';

/**
 * Shapes of everything read from JSON (Herdr CLI output, the state file).
 * Each schema is exported twice: the value validates, the type alias names the
 * validated shape, so `import type { PaneInfo }` keeps working unchanged.
 * Unknown extra fields stay allowed, so new Herdr fields never break parsing.
 */

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

const paneFields = {
  pane_id: Type.String(),
  tab_id: Type.String(),
  workspace_id: Type.String(),
  terminal_id: Type.Optional(Type.String()),
  label: Type.Optional(Type.String()),
  focused: Type.Optional(Type.Boolean()),
  agent: Type.Optional(Type.String()),
  agent_status: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  foreground_cwd: Type.Optional(Type.String()),
};

export const PaneInfo = Type.Object(paneFields);
export type PaneInfo = Static<typeof PaneInfo>;

/** `tab create` / `pane split` report a pane whose `tab_id` may be absent. */
export const CreatedPane = Type.Object({
  ...paneFields,
  tab_id: Type.Optional(Type.String()),
});
export type CreatedPane = Static<typeof CreatedPane>;

export const TabInfo = Type.Object({
  tab_id: Type.String(),
  label: Type.String(),
});
export type TabInfo = Static<typeof TabInfo>;

export const WorkspaceInfo = Type.Object({
  workspace_id: Type.String(),
  label: Type.Optional(Type.String()),
});
export type WorkspaceInfo = Static<typeof WorkspaceInfo>;

export const HerdrNamedAgent = Type.Object({
  ...paneFields,
  name: Type.Optional(Type.String()),
});
export type HerdrNamedAgent = Static<typeof HerdrNamedAgent>;

export const HerdrSessionSnapshot = Type.Object({
  panes: Type.Array(PaneInfo),
  tabs: Type.Array(TabInfo),
  agents: Type.Optional(Type.Array(HerdrNamedAgent)),
  focused_pane_id: Type.Optional(Type.String()),
});
export type HerdrSessionSnapshot = Static<typeof HerdrSessionSnapshot>;

/** "workspace" keeps every agent tab in a dedicated Agents workspace. */
export const HerdrAgentLayout = Type.Union([
  Type.Literal('pane'),
  Type.Literal('tab'),
  Type.Literal('workspace'),
]);
export type HerdrAgentLayout = Static<typeof HerdrAgentLayout>;

export function isHerdrAgentLayout(value: unknown): value is HerdrAgentLayout {
  return Value.Check(HerdrAgentLayout, value);
}

const agentRecordFields = {
  lifecycle: Type.Union([Type.Literal('oneshot'), Type.Literal('persistent')]),
  serverSocketPath: Type.Optional(Type.String()),
  paneId: Type.Optional(Type.String()),
  ownerPaneId: Type.Optional(Type.String()),
  tabLabel: Type.Optional(Type.String()),
  agent: Type.Optional(Type.String()),
  automationName: Type.Optional(Type.String()),
  resultFile: Type.Optional(Type.String()),
  layout: Type.Optional(HerdrAgentLayout),
  /** Spawn-time profile values Pi ignored; retained until the outcome is delivered. */
  spawnWarnings: Type.Optional(Type.Array(Type.String())),
  /**
   * Pending collection. Lives in the state file rather than memory so a
   * pending delivery survives `/reload`.
   */
  detached: Type.Optional(Type.Boolean()),
  /** A committed outcome claim; a new task's lifecycle record clears it. */
  collected: Type.Optional(Type.Boolean()),
  /**
   * Orchestrator pane `terminal_id` that spawned this agent. Widget, reuse,
   * and detached delivery all key off this so two Orchestrators in one
   * workspace do not claim each other's children.
   */
  ownerTerminalId: Type.Optional(Type.String()),
  /** Orchestrator Pi session UUID that spawned this agent. */
  ownerSessionId: Type.Optional(Type.String()),
  ownerSessionFile: Type.Optional(Type.String()),
  /** Closed-history slot this live agent is continuing, if any. */
  closedHistoryId: Type.Optional(Type.String()),
  closedHistoryGeneration: Type.Optional(Type.Number()),
  updatedAt: Type.String(),
};

export const HerdrAgentStateRecord = Type.Object(agentRecordFields);
/** Reading an older state file: `updatedAt` may be absent and is defaulted. */
export const HerdrAgentStateRecordInput = Type.Object(agentRecordFields, {
  required: ['lifecycle'],
});
export type HerdrAgentStateRecord = Static<typeof HerdrAgentStateRecord>;

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

export interface HerdrContext {
  panes: PaneInfo[];
  agents?: HerdrNamedAgent[];
  currentPane: PaneInfo;
  workspaceId: string;
  currentTab: string;
}
