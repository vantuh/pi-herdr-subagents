import { Type } from 'typebox';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';

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

/**
 * User configuration, read from `herdr-agents.json` in the Pi agent dir
 * (`~/.pi/agent/herdr-agents.json` by default). Same pattern as kiro-acp:
 * a missing or invalid file yields `{}`, so every field falls back to its
 * default and a broken config can never break spawning.
 *
 * State-file internals (`PI_AGENTS_STATE_PATH`, `PI_AGENTS_LOCK_WAIT_MS`,
 * `PI_AGENTS_CLAIM_LEASE_MS`) stay environment-only: they exist for test
 * harnesses and debugging, not for users.
 */
export const HerdrAgentsConfig = Type.Object({
  /** Agent target layout, normalized on read. Default: "workspace". */
  layout: Type.Optional(Type.String()),
  workspace: Type.Optional(
    Type.Object({
      /** Label of the dedicated Agents workspace. Default: "subagents". */
      label: Type.Optional(Type.String()),
    }),
  ),
});
export type HerdrAgentsConfig = Static<typeof HerdrAgentsConfig>;

/**
 * Reading the user file: each setting is read on its own, so one malformed
 * field or container cannot discard the others (`{"workspace":null}` keeps
 * `layout`). Normalization decides which value survives.
 */
export const ConfigLayoutField = Type.Object({
  layout: Type.Optional(Type.Unknown()),
});
export const ConfigWorkspaceField = Type.Object({
  workspace: Type.Optional(
    Type.Object({ label: Type.Optional(Type.Unknown()) }),
  ),
});
