import { Type } from 'typebox';
import type { Static } from 'typebox';

// Pi cannot determine context tokens immediately after compaction.
export const ContextMetrics = Type.Object({
  tokens: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  contextWindow: Type.Number({ exclusiveMinimum: 0 }),
});
export type ContextMetrics = Static<typeof ContextMetrics>;

const childSessionMetaFields = {
  sessionId: Type.String(),
  sessionFile: Type.Optional(Type.String()),
  cwd: Type.String(),
  updatedAt: Type.Optional(Type.String()),
};

export const ChildSessionMeta = Type.Object({
  ...childSessionMetaFields,
  context: Type.Optional(ContextMetrics),
});
export type ChildSessionMeta = Static<typeof ChildSessionMeta>;

// Invalid display metrics must not discard the session identity used for resume.
export const ChildSessionMetaInput = Type.Object({
  ...childSessionMetaFields,
  context: Type.Optional(Type.Unknown()),
});
export type ChildSessionMetaInput = Static<typeof ChildSessionMetaInput>;

export const PiSessionHeader = Type.Object({
  type: Type.Literal('session'),
  id: Type.String(),
  cwd: Type.String(),
});
export type PiSessionHeader = Static<typeof PiSessionHeader>;

export const TextPart = Type.Object({
  type: Type.Literal('text'),
  text: Type.String(),
});

export const MessageContent = Type.Object({
  content: Type.Optional(
    Type.Union([Type.String(), Type.Array(Type.Unknown())]),
  ),
});

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
