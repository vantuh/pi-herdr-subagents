import { Type } from 'typebox';
import type { Static } from 'typebox';

import { HerdrAgentLayout } from '../config/schema.ts';

/**
 * State-file contract. The stored shape and the reading shape stay separate
 * where their validation differs. Unknown extra fields stay allowed.
 */

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

export const ClosedHistoryStatus = Type.Union([
  Type.Literal('resumable'),
  Type.Literal('claimed'),
  Type.Literal('invalid'),
  Type.Literal('staged'),
]);
export type ClosedHistoryStatus = Static<typeof ClosedHistoryStatus>;

const closedHistoryFields = {
  id: Type.String(),
  ownerSessionId: Type.String(),
  ownerSessionFile: Type.Optional(Type.String()),
  profileName: Type.String(),
  tabLabel: Type.String(),
  childSessionFile: Type.String(),
  childSessionId: Type.String(),
  cwd: Type.String(),
  layout: HerdrAgentLayout,
  lifecycle: Type.Literal('oneshot'),
  createdAt: Type.String(),
  closedAt: Type.String(),
  status: ClosedHistoryStatus,
  claimGeneration: Type.Number(),
  claimedAt: Type.Optional(Type.String()),
  /** Frozen child-session USD estimate; absent when the child recorded none. */
  sessionCost: Type.Optional(Type.Number({ minimum: 0 })),
};
const closedHistoryRequired = [
  'id',
  'ownerSessionId',
  'profileName',
  'tabLabel',
  'childSessionFile',
  'childSessionId',
  'cwd',
  'layout',
  'lifecycle',
  'status',
];

export const ClosedAgentHistoryRecord = Type.Object(closedHistoryFields, {
  required: [
    ...closedHistoryRequired,
    'createdAt',
    'closedAt',
    'claimGeneration',
  ],
});
/** Reading an older state file: timestamps and the generation are defaulted. */
export const ClosedAgentHistoryRecordInput = Type.Object(
  {
    ...closedHistoryFields,
    // A malformed optional cost must not drop a resumable record.
    sessionCost: Type.Optional(Type.Unknown()),
  },
  { required: closedHistoryRequired },
);
export type ClosedAgentHistoryRecord = Static<typeof ClosedAgentHistoryRecord>;

export interface HerdrAgentsState {
  version: 2;
  agents: Record<string, HerdrAgentStateRecord>;
  closedHistory: ClosedAgentHistoryRecord[];
}

export const StateEnvelope = Type.Object({
  version: Type.Optional(Type.Unknown()),
  agents: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  closedHistory: Type.Optional(Type.Unknown()),
});
