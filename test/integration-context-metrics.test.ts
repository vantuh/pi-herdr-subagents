import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { test } from 'vitest';

import { AGENTS_WIDGET_ID } from '../src/ui/widget.ts';
import { withHarness } from '../test-support/integration-harness.ts';

/**
 * Context metrics on the Orchestrator's two surfaces: the above-editor widget
 * and the `/herdr-agents` rows. The values come from the child's published
 * session metadata, never from the pane.
 */

test('the widget shows each child context sample and survives a corrupt one', async () => {
  await withHarness({}, async (harness) => {
    // A parked question keeps each child open after its finalized turn.
    harness.fake.setBehavior(() => ({
      question: 'Which file next?',
      context: { tokens: 38_000, contextWindow: 200_000 },
    }));
    await harness.call({ agent: 'scout', task: 'first', name: 'Scout A' });
    harness.fake.setBehavior(() => ({
      question: 'Which file next?',
      context: { tokens: 0, contextWindow: 128_000 },
    }));
    await harness.call({ agent: 'scout', task: 'second', name: 'Scout B' });

    const widgetLines = () =>
      (harness.widgets.get(AGENTS_WIDGET_ID) ?? []) as string[];
    await harness.waitFor(
      () =>
        widgetLines().some(
          (line) => line.includes('Scout B') && line.includes('ctx 0 / 128k'),
        ),
      'the second context sample in the widget',
    );
    assert.match(
      widgetLines().join('\n'),
      /Scout A.*ctx 38k \/ 200k/,
      `expected both samples: ${JSON.stringify(widgetLines())}`,
    );

    // One unreadable artifact must not blank the other row or the widget.
    const records = Object.values((await harness.readState()).agents);
    const scoutB = records.find((record) => record.tabLabel === 'Scout B');
    assert.ok(scoutB?.resultFile);
    await fs.writeFile(
      path.join(path.dirname(scoutB.resultFile), 'session.json'),
      'not json\n',
      'utf8',
    );

    await harness.waitFor(
      () =>
        widgetLines().some(
          (line) => line.includes('Scout B') && line.includes('ctx —'),
        ),
      'the unknown context for the corrupt agent',
    );
    assert.match(
      widgetLines().join('\n'),
      /Scout A.*ctx 38k \/ 200k/,
      `the readable row must stay: ${JSON.stringify(widgetLines())}`,
    );
  });
});

test('/herdr-agents still lists and focuses agents while hydrating context', async () => {
  // enter focuses the first listed row.
  await withHarness({ dialogInputs: [['\r']] }, async (harness) => {
    harness.fake.setBehavior(() => ({
      question: 'Which file next?',
      context: { tokens: 5_000, contextWindow: 200_000 },
    }));
    await harness.call({ agent: 'scout', task: 'first', name: 'Scout A' });
    harness.fake.setBehavior(() => ({
      question: 'Which file next?',
      context: { tokens: 7_000, contextWindow: 200_000 },
    }));
    await harness.call({ agent: 'scout', task: 'second', name: 'Scout B' });

    // Corrupt the row the manager lists second: the first row must stay usable.
    const records = Object.values((await harness.readState()).agents);
    const scoutB = records.find((record) => record.tabLabel === 'Scout B');
    assert.ok(scoutB?.resultFile);
    await fs.writeFile(
      path.join(path.dirname(scoutB.resultFile), 'session.json'),
      'not json\n',
      'utf8',
    );

    await harness.runCommand('herdr-agents');

    const focus = harness.fake.callsMatching('agent', 'focus')[0];
    assert.ok(
      focus,
      `expected an agent focus, calls: ${JSON.stringify(harness.fake.calls.slice(-4))}`,
    );
    assert.equal(focus[2], harness.fake.paneByLabel('Scout A')?.pane_id);
    assert.match(
      harness.notifications.at(-1)?.message ?? '',
      /Focused agent "Scout A"/,
    );
  });
});
