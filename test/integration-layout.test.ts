import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { LayoutNode } from '../test-support/fake-herdr/types.ts';
import { flagValue, withHarness } from '../test-support/integration-harness.ts';

/**
 * Pane-column placement: split direction, ratios, tab layout and the
 * Orchestrator pane target.
 */

function splitDirections(node: LayoutNode | undefined): string[] {
  if (!node || node.type === 'pane') return [];
  return [
    node.direction,
    ...splitDirections(node.first),
    ...splitDirections(node.second),
  ];
}

test('serializes parallel spawns into one agent column and rebalances it', async () => {
  await withHarness({}, async (harness) => {
    // All three stay working past the last placement, so the assertions below
    // describe three simultaneously live agents. A label is only reserved while
    // its agent exists — a finished agent frees it again.
    harness.fake.setBehavior((turn) => ({
      result: `Result from ${turn.agentName}`,
      delayMs: 1500,
    }));

    const results = await Promise.all([
      harness.call({ agent: 'scout', task: 'one' }),
      harness.call({ agent: 'scout', task: 'two' }),
      harness.call({ agent: 'scout', task: 'three' }),
    ]);

    for (const result of results) {
      assert.equal(result.isError, undefined);
      assert.match(result.content[0].text, /started/);
    }
    await harness.waitFor(
      () => harness.messages.length >= 3,
      'three pane results',
      8000,
    );

    const splits = harness.fake.callsMatching('pane', 'split');
    assert.equal(splits.length, 3);
    // Exactly one right split: the agent column is created once, then stacked.
    assert.deepEqual(
      splits.map((argv) => flagValue(argv, '--direction')),
      ['right', 'down', 'down'],
    );

    // Labels stay unique, so reuse-by-label cannot cross-wire two agents.
    assert.deepEqual(
      harness.fake.callsMatching('pane', 'rename').map((argv) => argv[3]),
      ['Scout', 'Scout #2', 'Scout #3'],
    );

    // The Orchestrator's own 60/40 split is never rebalanced (path []).
    assert.ok(harness.fake.ratioUpdates.length > 0);
    assert.ok(
      harness.fake.ratioUpdates.every((update) => update.path.length > 0),
    );
    // Three stacked agents means a 2/3 ratio at the top of the column.
    assert.ok(
      harness.fake.ratioUpdates.some(
        (update) => Math.abs(update.ratio - 2 / 3) < 0.01,
      ),
      `expected a 2/3 rebalance, got ${JSON.stringify(harness.fake.ratioUpdates)}`,
    );

    assert.deepEqual((await harness.readState()).agents, {});
  });
});

test('keeps a single right column when a third agent joins two live ones', async () => {
  await withHarness({}, async (harness) => {
    // Detached spawns that never settle keep three agents live at once.
    harness.fake.setBehavior(() => ({ neverSettle: true }));
    await harness.callRaw({ agent: 'scout', task: 'one', name: 'Scout A' });
    await harness.callRaw({ agent: 'scout', task: 'two', name: 'Scout B' });
    await harness.callRaw({ agent: 'scout', task: 'three', name: 'Scout C' });

    const root = harness.fake.layoutFor(harness.fake.orchestratorPane.tab_id);
    const directions = splitDirections(root);
    assert.equal(directions.filter((d) => d === 'right').length, 1);
    assert.equal(directions.filter((d) => d === 'down').length, 2);
    assert.equal(root?.type === 'split' ? root.ratio : undefined, 0.6);
    assert.equal(harness.fake.panes.length, 4);
  });
});

test('uses tabs instead of panes when the tab layout is configured', async () => {
  await withHarness({ layout: 'tab' }, async (harness) => {
    const result = await harness.call({ agent: 'scout', task: 'Find it' });

    assert.match(result.content[0].text, /started/);
    await harness.collect('Scout');
    const create = harness.fake.callsMatching('tab', 'create')[0];
    assert.ok(create, 'expected a tab create');
    assert.equal(flagValue(create, '--label'), 'Scout');
    assert.ok(create.includes('PI_AGENT_CHILD=1'));
    assert.equal(harness.fake.callsMatching('pane', 'split').length, 0);
    assert.equal(harness.fake.callsMatching('tab', 'close').length, 1);
    // No pane column to rebalance in tab layout.
    assert.equal(harness.fake.ratioUpdates.length, 0);
  });
});

test('targets the pane from HERDR_PANE_ID, not whatever Herdr reports as focused', async () => {
  // Focus can move to something the user clicked while a tool is running.
  await withHarness({}, async (harness) => {
    // Another pane holds focus; the Orchestrator is elsewhere.
    harness.fake.panes.push({
      pane_id: 'w1:decoy',
      tab_id: harness.fake.orchestratorPane.tab_id,
      workspace_id: harness.fake.workspaceId,
      terminal_id: 'term-decoy',
      focused: true,
      agent: 'pi',
      agent_status: 'idle',
      env: {},
    });
    harness.fake.focusedPaneId = 'w1:decoy';

    await harness.call({ agent: 'scout', task: 'Find it' });

    const split = harness.fake.callsMatching('pane', 'split')[0];
    assert.equal(split?.[2], harness.fake.orchestratorPane.pane_id);
  });
});
