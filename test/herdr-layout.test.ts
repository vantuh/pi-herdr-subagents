import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  buildEqualAgentSplitRatios,
  chooseAgentColumnSplitTarget,
} from '../src/herdr/layout.ts';
import type { PaneInfo } from '../src/herdr/schema.ts';

/**
 * Pane-column layout: equal ratios and split-target choice.
 */

test('builds equal ratios for three vertically stacked agent panes', () => {
  const root = {
    type: 'split' as const,
    direction: 'right' as const,
    ratio: 0.6,
    first: { type: 'pane' as const, pane_id: 'orchestrator' },
    second: {
      type: 'split' as const,
      direction: 'down' as const,
      ratio: 0.5,
      first: { type: 'pane' as const, pane_id: 'agent-1' },
      second: {
        type: 'split' as const,
        direction: 'down' as const,
        ratio: 0.5,
        first: { type: 'pane' as const, pane_id: 'agent-2' },
        second: { type: 'pane' as const, pane_id: 'agent-3' },
      },
    },
  };

  assert.deepEqual(
    buildEqualAgentSplitRatios(
      root,
      new Set(['agent-1', 'agent-2', 'agent-3']),
    ),
    [
      { path: [true], ratio: 1 / 3 },
      { path: [true, true], ratio: 1 / 2 },
    ],
  );
});

test('does not resize the outer orchestrator split', () => {
  const root = {
    type: 'split' as const,
    direction: 'right' as const,
    ratio: 0.6,
    first: { type: 'pane' as const, pane_id: 'orchestrator' },
    second: { type: 'pane' as const, pane_id: 'agent' },
  };

  assert.deepEqual(buildEqualAgentSplitRatios(root, new Set(['agent'])), []);
});

test('splits the largest existing agent pane in the right column', () => {
  const panes: PaneInfo[] = [
    { pane_id: 'small', tab_id: 'tab', workspace_id: 'workspace' },
    { pane_id: 'large', tab_id: 'tab', workspace_id: 'workspace' },
  ];

  assert.equal(
    chooseAgentColumnSplitTarget(panes, {
      panes: [
        { pane_id: 'small', rect: { width: 40, height: 20 } },
        { pane_id: 'large', rect: { width: 40, height: 40 } },
      ],
    })?.pane_id,
    'large',
  );
});
