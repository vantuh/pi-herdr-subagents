import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';

import type { AgentProfile } from '../../agents/types.ts';
import type {
  HerdrAgentLayout,
  HerdrAgentsConfig,
} from '../../config/schema.ts';
import type { CreatedPane, TabInfo } from '../../herdr/schema.ts';
import type { HerdrContext } from '../../herdr/types.ts';
import type {
  ClosedAgentHistoryRecord,
  HerdrAgentsState,
} from '../../state/schema.ts';
import type { orchestratorIdentity } from '../child-args.ts';

export interface SpawnTarget {
  tabId: string;
  paneId: string;
}

export interface TaskInvocation {
  pi: ExtensionAPI;
  /** Absent when reopening a closed agent for reading: no turn is sent. */
  task?: string;
  signal: AbortSignal | undefined;
  onUpdate: AgentToolUpdateCallback<Record<string, unknown>> | undefined;
  ctx: ExtensionContext;
}

export type SpawnMode = 'spawn' | 'answer' | 'resume';

export interface SpawnSettings {
  agent: AgentProfile;
  config: HerdrAgentsConfig;
  layout: HerdrAgentLayout;
  baseLabel: string;
  /** `answer` reuses a live agent's parked question; `resume` reopens a closed one. */
  mode: SpawnMode;
  /** Only a caller-chosen name is refused when it matches a live agent. */
  explicitName: boolean;
  owner: ReturnType<typeof orchestratorIdentity>;
}

// Shared progress lets cleanup see claims and targets even when a phase throws.
export interface SpawnState {
  agent: AgentProfile;
  tabLabel: string;
  tabId?: string;
  paneId?: string;
  agentPane?: CreatedPane;
  lifecycleRecorded?: boolean;
  automationName?: string;
  resultFile?: string;
  sessionMetaFile?: string;
  systemFile?: string;
  reused: boolean;
  resumed: boolean;
  resumeClaim?: ClosedAgentHistoryRecord;
  resumeDurable: boolean;
  /** Populated only on a fresh spawn: frontmatter fields pi can't honor. */
  spawnWarnings: string[];
}

export interface AgentPlacement {
  current: HerdrContext;
  state: HerdrAgentsState;
  tabs: TabInfo[];
  usesTabs: boolean;
  agentsWorkspaceId?: string;
  agentsWorkspaceCreated: boolean;
  agentsWorkspaceRootTabId?: string;
}

export type PlacementResolution =
  | { error: AgentToolResult<Record<string, unknown>> }
  | { placement: AgentPlacement };

export type SpawnTargetResult =
  | { error: AgentToolResult<Record<string, unknown>> }
  | { target: SpawnTarget };
