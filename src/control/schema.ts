import { Type } from 'typebox';
import type { Static } from 'typebox';

export const ControlAction = Type.Union([
  Type.Literal('steer'),
  Type.Literal('interrupt'),
]);
export type ControlAction = Static<typeof ControlAction>;

/** Child-written outcomes; the parent reports `unknown` on its own. */
export const ControlStatus = Type.Union([
  Type.Literal('queued'),
  Type.Literal('aborted'),
  Type.Literal('requested'),
  Type.Literal('idle'),
]);
export type ControlStatus = Static<typeof ControlStatus>;

/**
 * The id becomes part of an acknowledgement file name, so a value read back
 * from disk must not be able to name a path outside the control directory.
 */
export const ControlId = Type.String({ pattern: '^[A-Za-z0-9-]{1,64}$' });
export type ControlId = Static<typeof ControlId>;

export const ControlRequest = Type.Object({
  id: ControlId,
  action: ControlAction,
  message: Type.Optional(Type.String()),
  createdAt: Type.Number(),
});
export type ControlRequest = Static<typeof ControlRequest>;

export const ControlAck = Type.Object({
  id: ControlId,
  action: ControlAction,
  status: ControlStatus,
  at: Type.Number(),
});
export type ControlAck = Static<typeof ControlAck>;
