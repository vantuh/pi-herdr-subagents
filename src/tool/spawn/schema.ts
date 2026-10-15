import { Type } from 'typebox';

import { PaneLayout } from '../../herdr/layout/schema.ts';
import { CreatedPane } from '../../herdr/schema.ts';

export const TabCreateResponse = Type.Object({
  result: Type.Object({ root_pane: Type.Optional(CreatedPane) }),
});
export const PaneSplitResponse = Type.Object({
  result: Type.Object({ pane: Type.Optional(CreatedPane) }),
});
export const PaneLayoutResponse = Type.Object({
  result: Type.Optional(Type.Object({ layout: Type.Optional(PaneLayout) })),
});
