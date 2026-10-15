import { Type } from 'typebox';
import type { Static } from 'typebox';

/**
 * Shapes of everything read from Herdr CLI/API output. Each schema is exported
 * twice: the value validates and the type alias names the validated shape.
 * Unknown extra fields stay allowed, so new Herdr fields never break parsing.
 */

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
