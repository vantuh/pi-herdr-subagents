import type { LayoutNode, PaneSplit } from './types.ts';

/**
 * Pure pane-tree operations for the fake Herdr server.
 *
 * The simulator keeps its own pane tree so split, close and rebalance are
 * observable; it deliberately does not reuse the production layout schema.
 */

const VIEWPORT = { width: 120, height: 40 };

/** Replace `targetPaneId` with a split node holding it and the new pane. */
export function splitNode(
  node: LayoutNode,
  targetPaneId: string,
  split: PaneSplit,
): LayoutNode {
  if (node.type === 'pane') {
    if (node.pane_id !== targetPaneId) return node;
    return {
      type: 'split',
      direction: split.direction,
      ratio: split.ratio,
      first: node,
      second: { type: 'pane', pane_id: split.newPaneId },
    };
  }
  return {
    ...node,
    first: splitNode(node.first, targetPaneId, split),
    second: splitNode(node.second, targetPaneId, split),
  };
}

/** Drop a pane, collapsing a split whose other side survived. */
export function removeFromNode(
  node: LayoutNode,
  paneId: string,
): LayoutNode | undefined {
  if (node.type === 'pane') {
    return node.pane_id === paneId ? undefined : node;
  }
  const first = removeFromNode(node.first, paneId);
  const second = removeFromNode(node.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

export function computeRects(
  node: LayoutNode,
  rect = { x: 0, y: 0, ...VIEWPORT },
): Array<{ pane_id: string; rect: typeof rect }> {
  if (node.type === 'pane') return [{ pane_id: node.pane_id, rect }];

  if (node.direction === 'right') {
    const width = Math.round(rect.width * node.ratio);
    return [
      ...computeRects(node.first, { ...rect, width }),
      ...computeRects(node.second, {
        ...rect,
        x: rect.x + width,
        width: rect.width - width,
      }),
    ];
  }
  const height = Math.round(rect.height * node.ratio);
  return [
    ...computeRects(node.first, { ...rect, height }),
    ...computeRects(node.second, {
      ...rect,
      y: rect.y + height,
      height: rect.height - height,
    }),
  ];
}
