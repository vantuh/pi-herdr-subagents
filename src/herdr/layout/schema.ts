import { Type } from 'typebox';
import type { Static } from 'typebox';

/** Layout tree from `layout.export`; `node` refers to itself by definition name. */
export const PortableLayoutNode = Type.Cyclic(
  {
    node: Type.Union([
      Type.Object({
        type: Type.Literal('pane'),
        pane_id: Type.Optional(Type.String()),
      }),
      Type.Object({
        type: Type.Literal('split'),
        direction: Type.Union([Type.Literal('right'), Type.Literal('down')]),
        ratio: Type.Number(),
        first: Type.Ref('node'),
        second: Type.Ref('node'),
      }),
    ]),
  },
  'node',
);
export type PortableLayoutNode = Static<typeof PortableLayoutNode>;

export const ExportedLayoutResponse = Type.Object({
  layout: Type.Object({ tab_id: Type.String(), root: PortableLayoutNode }),
});

export const PaneLayout = Type.Object({
  panes: Type.Optional(
    Type.Array(
      Type.Object({
        pane_id: Type.String(),
        rect: Type.Optional(
          Type.Object({
            height: Type.Optional(Type.Number()),
            width: Type.Optional(Type.Number()),
          }),
        ),
      }),
    ),
  ),
});
export type PaneLayout = Static<typeof PaneLayout>;
