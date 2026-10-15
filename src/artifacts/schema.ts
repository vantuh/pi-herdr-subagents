import { Type } from 'typebox';
import type { Static } from 'typebox';

export const ChildSessionMeta = Type.Object({
  sessionId: Type.String(),
  sessionFile: Type.Optional(Type.String()),
  cwd: Type.String(),
  updatedAt: Type.Optional(Type.String()),
});
export type ChildSessionMeta = Static<typeof ChildSessionMeta>;

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
