import assert from 'node:assert/strict';

import { test } from 'vitest';

import { AGENTS_WIDGET_ID } from '../src/ui/widget.ts';
import { flagValue, withHarness } from '../test-support/contract-harness.ts';

/**
 * Tab layout and widget lifecycle: label uniqueness, tab lookup by pane id
 * and the live-agent widget.
 */

test('keeps new tab labels unique across spawns', async () => {
  await withHarness({ layout: 'tab' }, async (harness) => {
    harness.fake.setBehavior(() => ({ neverSettle: true }));
    await harness.callRaw({ agent: 'scout', task: 'one', name: 'Scout A' });
    assert.equal(
      flagValue(
        harness.fake.callsMatching('tab', 'create')[0] ?? [],
        '--label',
      ),
      'Scout A',
    );

    await harness.callRaw({ agent: 'scout', task: 'two' });
    assert.equal(
      flagValue(
        harness.fake.callsMatching('tab', 'create')[1] ?? [],
        '--label',
      ),
      'Scout',
    );

    // The default label collides with the live second agent, so the third
    // spawn gets a suffixed label.
    await harness.callRaw({ agent: 'scout', task: 'three' });
    assert.equal(
      flagValue(
        harness.fake.callsMatching('tab', 'create')[2] ?? [],
        '--label',
      ),
      'Scout #2',
    );
    assert.equal(harness.fake.callsMatching('tab', 'create').length, 3);
  });
});

test("does not reprint spawn warnings on a reused agent's next turn", async () => {
  await withHarness(
    {
      profiles: [
        {
          name: 'worker',
          skills: ['ghost-skill'],
          body: 'BODY',
        },
      ],
    },
    async (harness) => {
      // First turn asks, so the second call reuses the parked agent.
      harness.fake.setBehavior((turn) =>
        turn.turn === 1
          ? { question: 'Which approach?' }
          : { result: 'worker done' },
      );
      const first = await harness.call({ agent: 'worker', task: 'one' });
      assert.equal(first.details.reused, false);
      assert.match(first.content[0].text, /Skills not found: ghost-skill/);
      await harness.collect('Worker');

      const reused = await harness.callTool('agent_send', {
        name: 'Worker',
        message: 'two',
      });
      assert.equal(reused.details.reused, true);
      assert.doesNotMatch(reused.content[0].text, /Skills not found/);
      assert.equal(reused.details.spawnWarnings, undefined);
    },
  );
});

test('resolves a renamed tab by pane id when tab create omits the tab id', async () => {
  await withHarness({ layout: 'tab' }, async (harness) => {
    harness.fake.omitCreatedTabId();
    harness.fake.renameCreatedTabs('pi');

    const result = await harness.call({ agent: 'scout', task: 'one' });

    // Recovered silently: the start completed and the poller closed the tab by id.
    assert.equal(result.isError, undefined);
    assert.ok(result.details.tabId);
    assert.equal(result.details.name, 'Scout');
    await harness.collect('Scout');
    assert.equal(
      harness.fake.callsMatching('tab', 'close')[0]?.[2],
      result.details.tabId,
    );
  });
});

test('shows live agents in the widget and clears it once none remain', async () => {
  // d closes the selected agent in the manager overlay.
  await withHarness({ dialogInputs: [['d']] }, async (harness) => {
    // A held child never starts its turn, so the agent is idle: visible in
    // the widget and closable by the manager.
    harness.fake.holdChildren();
    await harness.callRaw({
      agent: 'scout',
      task: 'stay',
      name: 'Scout Widget',
    });

    await harness.waitFor(
      () => harness.widgets.has(AGENTS_WIDGET_ID),
      'widget to appear',
    );
    const lines = harness.widgets.get(AGENTS_WIDGET_ID) as string[];
    assert.ok(
      lines.join('\n').includes('Scout Widget'),
      `widget should list the agent: ${JSON.stringify(lines)}`,
    );

    await harness.runCommand('agents');
    assert.equal(harness.fake.panes.length, 1);

    await harness.waitFor(
      () => !harness.widgets.has(AGENTS_WIDGET_ID),
      'widget to clear after the last agent is gone',
    );
  });
});

test('shows a live agent in the widget while its task is still running', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({ neverSettle: true }));
    await harness.call({ agent: 'scout', task: 'slow', name: 'Scout Awaited' });
    await harness.waitFor(
      () => harness.widgets.has(AGENTS_WIDGET_ID),
      'widget to appear',
    );
    const lines = harness.widgets.get(AGENTS_WIDGET_ID) as string[];
    assert.ok(lines.join('\n').includes('Scout Awaited'));
  });
});
