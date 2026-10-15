import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { test } from 'vitest';

import { flagValue, withHarness } from '../test-support/integration-harness.ts';

/**
 * Detached delivery: poller claims, batching, done-status notifications,
 * archive ordering and scratch cleanup.
 */

test('submits one prompt and delivers a delayed result without another Enter', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({
      staleWindowMs: 300,
      result: 'Delayed acceptance',
    }));
    const started = await harness.call({ agent: 'scout', task: 'Find it' });
    assert.match(started.content[0].text, /started/);
    assert.equal(harness.fake.callsMatching('agent', 'send-keys').length, 0);
    assert.equal(harness.fake.callsMatching('agent', 'prompt').length, 1);
    const delivered = await harness.collect('Scout', 5000);
    assert.match(delivered.content, /Delayed acceptance/);
  });
});

test('delivers a fast completion without another Enter', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({ delayMs: 0, result: 'Fast completion' }));
    const started = await harness.call({ agent: 'scout', task: 'Find it' });
    assert.match(started.content[0].text, /started/);
    const delivered = await harness.collect('Scout');
    assert.match(delivered.content, /Fast completion/);
    assert.equal(harness.fake.callsMatching('agent', 'send-keys').length, 0);
    assert.deepEqual(
      harness.fake.panes.map((pane) => pane.pane_id),
      [harness.fake.orchestratorPane.pane_id],
    );
  });
});

test('a default call detaches in a UI session', async () => {
  await withHarness({}, async (harness) => {
    const started = await harness.callRaw({
      agent: 'scout',
      task: 'Background job',
    });

    assert.match(started.content[0].text, /started/);
    const record = Object.values((await harness.readState()).agents)[0];
    assert.equal(record?.detached, true);
  });
});

test('delivers a detached result through the widget poller and closes the one-shot', async () => {
  await withHarness({}, async (harness) => {
    const started = await harness.call({
      agent: 'scout',
      task: 'Background job',
    });

    assert.match(started.content[0].text, /started/);
    // Nobody is waiting, so the poller owns the result.
    const record = Object.values((await harness.readState()).agents)[0];
    assert.equal(record?.detached, true);

    await harness.waitFor(
      () => harness.messages.length > 0,
      'detached result delivery',
    );

    const [message] = harness.messages;
    assert.equal(message?.customType, 'herdr_agent_result');
    assert.match(message?.content ?? '', /finished on its own/);
    assert.match(message?.content ?? '', /Result from scout_/);
    assert.equal(message?.triggerTurn, true);
    // Pane-layout agents are visible on screen, so no notification ping.
    assert.equal(harness.fake.callsMatching('notification', 'show').length, 0);
    assert.equal(message?.details.tabLabel, 'Scout');

    // Delivered exactly once, pane closed, state pruned.
    await harness.fire('session_start');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(harness.messages.length, 1);
    assert.deepEqual(
      harness.fake.panes.map((pane) => pane.pane_id),
      [harness.fake.orchestratorPane.pane_id],
    );
    assert.deepEqual((await harness.readState()).agents, {});
  });
});

test('a poller tick with a stale idle snapshot does not deliver a still-working child', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({ neverSettle: true }));

    await harness.call({ agent: 'scout', task: 'Background job' });
    const record = Object.values((await harness.readState()).agents)[0];
    assert.ok(record?.resultFile && record.paneId && record.automationName);

    // The child appends assistant text to result.md before its turn ends.
    await fs.writeFile(record.resultFile, 'still working', 'utf8');
    // The tick's snapshot is taken before the prompt is submitted, so it
    // carries the pre-prompt `idle` while the live agent is `working`.
    const pane = harness.fake.paneById(record.paneId);
    assert.ok(pane);
    pane.agent_status = 'idle';

    const snapshots = harness.fake.callsMatching('api', 'snapshot').length;
    await harness.waitFor(
      () => harness.fake.callsMatching('api', 'snapshot').length > snapshots,
      'a widget poller tick',
    );
    // The tick must re-check the live status before delivering; delivering the
    // partial artifact instead is the race this test guards.
    await harness.waitFor(
      () =>
        harness.fake.callsMatching('agent', 'get').length > 0 ||
        harness.messages.length > 0,
      'the widget poller tick to settle the working child',
    );
    const gets = harness.fake.callsMatching('agent', 'get');
    assert.equal(gets.length, 1);
    assert.equal(gets[0]?.[2], record.automationName);
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(harness.messages.length, 0);
    assert.equal(harness.fake.callsMatching('pane', 'close').length, 0);
    assert.ok(
      harness.fake.panes.some((item) => item.pane_id === record.paneId),
      'the still-working agent pane must stay open',
    );
    const after = Object.values((await harness.readState()).agents)[0];
    assert.equal(after?.detached, true);
    assert.equal(after?.collected, undefined);
  });
});

test('delivers an unseen done completion, notifies, and closes the one-shot', async () => {
  await withHarness({ layout: 'workspace' }, async (harness) => {
    // The child settles as `done` — Herdr's marker for background work the
    // user has never seen — instead of `idle`.
    harness.fake.setBehavior(() => ({
      result: 'Background done.',
      settleStatus: 'done',
    }));

    await harness.call({
      agent: 'scout',
      task: 'Background job',
    });

    await harness.waitFor(
      () => harness.messages.length > 0,
      'detached done-status delivery',
    );

    const [message] = harness.messages;
    assert.equal(message?.customType, 'herdr_agent_result');
    assert.match(message?.content ?? '', /Background done\./);
    assert.equal(message?.triggerTurn, true);

    // Unseen completions ping the user through Herdr's own notifications.
    const notify = harness.fake.callsMatching('notification', 'show')[0];
    assert.ok(notify, 'expected a Herdr notification');
    assert.equal(notify[2], 'Pi · Scout finished');
    assert.equal(flagValue(notify, '--body'), 'Background done.');

    // Delivered exactly once, tab closed, state pruned.
    await harness.fire('session_start');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(harness.messages.length, 1);
    // Only the agent's own tab existed; the poller closed it and the emptied
    // workspace vanished with it.
    assert.equal(
      harness.fake.workspaces.find(
        (workspace) => workspace.label === 'subagents',
      ),
      undefined,
    );
    assert.deepEqual((await harness.readState()).agents, {});
  });
});

test('collects a child that finishes as done rather than idle', async () => {
  // Completed children can settle as either status.
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({
      result: 'DONE-STATUS RESULT',
      settleStatus: 'done',
    }));

    const result = await harness.call({ agent: 'scout', task: 'Find it' });
    const delivered = await harness.collect(result.details.tabLabel);

    assert.match(delivered.content, /DONE-STATUS RESULT/);
  });
});

test('removes the managed temp directory on close but keeps it while an agent runs', async () => {
  // system.md and result.md share one private temp dir per agent.
  await withHarness(
    { profiles: [{ name: 'scout' }, { name: 'worker' }] },
    async (harness) => {
      // A detached agent that never settles keeps its directory.
      harness.fake.setBehavior((turn) =>
        turn.agentName.startsWith('scout')
          ? { neverSettle: true }
          : { result: 'worker done' },
      );
      await harness.callRaw({ agent: 'scout', task: 'keep me' });
      const detachedRecord = Object.values(
        (await harness.readState()).agents,
      )[0];
      const detachedDir = path.dirname(detachedRecord?.resultFile ?? '');
      assert.ok(detachedRecord?.resultFile);
      // result.md is cleared after spawn and re-created when the child writes.
      assert.deepEqual((await fs.readdir(detachedDir)).sort(), [
        'session.json',
        'system.md',
      ]);

      await harness.call({ agent: 'worker', task: 'close me' });
      await harness.collect('Worker');
      // The closed one-shot's own directory is gone; the running one is kept.
      const dirs = await fs.readdir(path.dirname(detachedDir));
      assert.equal(
        dirs.filter((name) => name.startsWith('herdr-agent-')).length,
        1,
      );
      assert.ok(
        await fs.stat(path.join(detachedDir, 'system.md')).catch(() => null),
      );
    },
  );
});

test('delivers two detached outcomes as one batch with a single turn trigger', async () => {
  // Two agents asking in parallel used to surface a whole turn apart, because
  // triggering on the first message made the rest queue behind that turn.
  await withHarness({ isIdle: false }, async (harness) => {
    harness.fake.setBehavior((turn) => ({
      question: `Question from ${turn.agentName}?`,
    }));

    // Neither child runs until both are spawned, so both settle in the same
    // poller tick — the condition the batching exists for.
    harness.fake.holdChildren();
    await harness.call({
      agent: 'scout',
      task: 'a',
      tabLabel: 'Scout A',
    });
    await harness.call({
      agent: 'scout',
      task: 'b',
      tabLabel: 'Scout B',
    });
    await harness.fake.releaseChildren();

    await harness.waitFor(
      () => harness.messages.length >= 2,
      'both detached questions delivered',
    );

    assert.equal(harness.messages.length, 2);
    assert.deepEqual(
      harness.messages.map((message) => message.customType),
      ['herdr_agent_question', 'herdr_agent_question'],
    );
    // Only the last message starts a turn; both are steered because the
    // Orchestrator is mid-turn.
    assert.deepEqual(
      harness.messages.map((message) => message.triggerTurn),
      [undefined, true],
    );
    assert.deepEqual(
      harness.messages.map((message) => message.deliverAs),
      ['steer', 'steer'],
    );
    assert.deepEqual(
      harness.messages.map((message) => message.details.tabLabel).sort(),
      ['Scout A', 'Scout B'],
    );
  });
});
