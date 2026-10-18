import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { test } from 'vitest';

import { AGENTS_WIDGET_ID } from '../src/ui/widget.ts';
import { withHarness } from '../test-support/integration-harness.ts';
import type { HeldDialog } from '../test-support/mock-extension.ts';

/**
 * Child session cost in `/herdr-agents`: live rows read the published sample,
 * closed rows read the frozen history, and the widget stays context-only.
 */

test('/herdr-agents shows the published cost and leaves the widget alone', async () => {
  // An empty key list renders the modal once and cancels it.
  await withHarness({ dialogInputs: [[]] }, async (harness) => {
    harness.fake.setBehavior(() => ({
      question: 'Which file next?',
      context: { tokens: 38_000, contextWindow: 200_000 },
      cost: 0.024,
    }));
    await harness.call({
      agent: 'scout',
      task: 'first',
      tabLabel: 'Scout Cost',
    });
    harness.fake.setBehavior(() => ({
      question: 'Which file next?',
      context: { tokens: 5_000, contextWindow: 200_000 },
    }));
    await harness.call({
      agent: 'scout',
      task: 'second',
      tabLabel: 'Scout Free',
    });
    const widgetLines = () =>
      (harness.widgets.get(AGENTS_WIDGET_ID) ?? []) as string[];
    await harness.waitFor(
      () =>
        widgetLines().some(
          (line) => line.includes('Scout Cost') && line.includes('ctx 38k'),
        ) &&
        widgetLines().some(
          (line) => line.includes('Scout Free') && line.includes('ctx 5k'),
        ),
      'both agents in the widget',
    );

    await harness.runCommand('herdr-agents');

    const rows = harness.dialogLines[0]?.join('\n') ?? '';
    assert.match(
      rows,
      /Scout Cost \(scout\)\s+idle\s+• ~\$0\.024 • ctx 38k \/ 200k/,
      rows,
    );
    // No published cost is unknown, never a fabricated zero.
    assert.match(
      rows,
      /Scout Free \(scout\)\s+idle\s+• cost —\s+• ctx 5k \/ 200k/,
      rows,
    );

    const widget = widgetLines().join('\n');
    assert.match(widget, /ctx 38k \/ 200k/);
    assert.doesNotMatch(widget, /\$/);
  });
});

test('closing a one-shot freezes its cost for the closed row', async () => {
  await withHarness({ dialogInputs: [[]] }, async (harness) => {
    harness.fake.setBehavior(() => ({
      result: 'done',
      context: { tokens: 4_000, contextWindow: 200_000 },
      cost: 0.024,
    }));
    await harness.call({
      agent: 'scout',
      task: 'first',
      tabLabel: 'Scout Frozen',
    });
    const record = Object.values((await harness.readState()).agents)[0];
    const tempDir = path.dirname(record?.resultFile ?? '');
    await harness.collect('Scout Frozen');
    await harness.waitFor(
      async () => (await harness.readState()).closedHistory.length === 1,
      'the closed one-shot in history',
    );

    // The artifact is gone by now: the frozen value is what the row reads.
    assert.equal(await fs.stat(tempDir).catch(() => null), null);
    const archived = (await harness.readState()).closedHistory[0];
    assert.equal(archived?.sessionCost, 0.024);

    await harness.runCommand('herdr-agents');

    assert.match(
      harness.dialogLines[0]?.join('\n') ?? '',
      /Scout Frozen \(scout\)\s+closed\s+• ~\$0\.024\s+• /,
    );
  });
});

test('a resumed one-shot republishes its cumulative cost without doubling it', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({ result: 'first', cost: 0.024 }));
    await harness.call({
      agent: 'scout',
      task: 'first',
      tabLabel: 'Scout Resume',
    });
    await harness.collect('Scout Resume');
    await harness.waitFor(
      async () => (await harness.readState()).closedHistory.length === 1,
      'the first close',
    );

    // A close that raced the publish keeps the same session's frozen total.
    harness.fake.setBehavior(() => ({ result: 'second' }));
    await harness.call({
      agent: 'scout',
      task: 'second',
      tabLabel: 'Scout Resume',
      resumeClosed: true,
    });
    await harness.collect('Scout Resume');
    await harness.waitFor(
      async () =>
        (await harness.readState()).closedHistory[0]?.status === 'resumable',
      'the second close',
    );
    assert.equal(
      (await harness.readState()).closedHistory[0]?.sessionCost,
      0.024,
    );

    // The next generation publishes a larger cumulative total, which replaces
    // the frozen one instead of adding to it.
    harness.fake.setBehavior(() => ({ result: 'third', cost: 0.03 }));
    await harness.call({
      agent: 'scout',
      task: 'third',
      tabLabel: 'Scout Resume',
      resumeClosed: true,
    });
    await harness.collect('Scout Resume');
    await harness.waitFor(
      async () =>
        (await harness.readState()).closedHistory[0]?.sessionCost === 0.03,
      'the refreshed cost',
    );
    assert.equal(
      (await harness.readState()).closedHistory[0]?.sessionCost,
      0.03,
    );
  });
});

test('/herdr-agents watches from an empty list until an agent appears', async () => {
  let dialog: HeldDialog | undefined;
  await withHarness(
    { onDialog: (held) => (dialog = held) },
    async (harness) => {
      const running = harness.runCommand('herdr-agents');
      await harness.waitFor(() => dialog !== undefined, 'the modal to open');
      assert.match(
        dialog!.render().join('\n'),
        /No managed Herdr agents\. Watching for new ones/,
      );

      // A parallel spawn must appear without reopening the command.
      harness.fake.setBehavior(() => ({ question: 'Which file next?' }));
      await harness.call({
        agent: 'scout',
        task: 'first',
        tabLabel: 'Scout Late',
      });
      await harness.waitFor(
        () => dialog!.render().join('\n').includes('Scout Late (scout)'),
        'the spawned agent in the open modal',
      );

      dialog!.component.handleInput('\r');
      await running;

      const focus = harness.fake.callsMatching('agent', 'focus')[0];
      assert.ok(
        focus,
        `expected an agent focus, calls: ${JSON.stringify(harness.fake.calls.slice(-4))}`,
      );
      assert.equal(focus[2], harness.fake.paneByLabel('Scout Late')?.pane_id);
      assert.match(
        harness.notifications.at(-1)?.message ?? '',
        /Focused Herdr agent "Scout Late"/,
      );
    },
  );
});

test('/herdr-agents updates context and cost and focuses a newly spawned agent', async () => {
  let dialog: HeldDialog | undefined;
  await withHarness(
    { onDialog: (held) => (dialog = held) },
    async (harness) => {
      harness.fake.setBehavior(() => ({
        question: 'Which file next?',
        context: { tokens: 38_000, contextWindow: 200_000 },
        cost: 0.024,
      }));
      await harness.call({
        agent: 'scout',
        task: 'first',
        tabLabel: 'Scout A',
      });
      await harness.waitFor(
        () =>
          ((harness.widgets.get(AGENTS_WIDGET_ID) ?? []) as string[]).some(
            (line) => line.includes('Scout A') && line.includes('ctx 38k'),
          ),
        'the first child context in the widget',
      );

      const running = harness.runCommand('herdr-agents');
      await harness.waitFor(() => dialog !== undefined, 'the modal to open');
      const rows = () => dialog!.render().join('\n');
      assert.match(
        rows(),
        /Scout A \(scout\)\s+idle\s+• ~\$0\.024 • ctx 38k \/ 200k/,
      );

      // A newer published sample must reach the open modal on its own tick.
      const record = Object.values((await harness.readState()).agents)[0];
      assert.ok(record?.resultFile);
      const metaFile = path.join(
        path.dirname(record.resultFile),
        'session.json',
      );
      const meta = JSON.parse(await fs.readFile(metaFile, 'utf8'));
      await fs.writeFile(
        metaFile,
        `${JSON.stringify({
          ...meta,
          context: { tokens: 8_000, contextWindow: 200_000 },
          sessionCost: 0.05,
        })}\n`,
        'utf8',
      );
      await harness.waitFor(
        () => rows().includes('~$0.050 • ctx 8k / 200k'),
        'the updated context and cost in the open modal',
      );

      // A second agent appears in the same open modal, and the selection
      // resolves against the refreshed rows.
      harness.fake.setBehavior(() => ({ question: 'Which file next?' }));
      await harness.call({
        agent: 'scout',
        task: 'second',
        tabLabel: 'Scout B',
      });
      await harness.waitFor(
        () => rows().includes('Scout B (scout)'),
        'the second agent in the open modal',
      );

      dialog!.component.handleInput('\x1b[B');
      dialog!.component.handleInput('\r');
      await running;

      const focus = harness.fake.callsMatching('agent', 'focus')[0];
      assert.ok(
        focus,
        `expected an agent focus, calls: ${JSON.stringify(harness.fake.calls.slice(-4))}`,
      );
      assert.equal(focus[2], harness.fake.paneByLabel('Scout B')?.pane_id);
      assert.match(
        harness.notifications.at(-1)?.message ?? '',
        /Focused Herdr agent "Scout B"/,
      );
    },
  );
});
