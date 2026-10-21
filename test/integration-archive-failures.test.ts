import assert from 'node:assert/strict';

import { test } from 'vitest';

import { setFailNextStateMutation } from '../src/state/store.ts';
import { withHarness } from '../test-support/integration-harness.ts';

/**
 * Archive failures: staged history that cannot be promoted, and the live
 * one-shot it must not lose.
 */

test('detached one-shot completion archives before cleanup', async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: 'scout',
      task: 'background',
      name: 'Scout Detached Resume',
    });
    await harness.collect('Scout Detached Resume');
    await harness.waitFor(async () => {
      const history = (await harness.readState()).closedHistory ?? [];
      // Wait for the final status: the record is staged first and promoted
      // to resumable after pane cleanup, so a bare length check races.
      return (
        history.length === 1 &&
        history[0]?.status === 'resumable' &&
        harness.fake.panes.length === 1
      );
    }, 'detached one-shot to archive and close');
    const history = (await harness.readState()).closedHistory ?? [];
    assert.equal(history[0]?.tabLabel, 'Scout Detached Resume');
    assert.equal(history[0]?.status, 'resumable');
  });
});

test('missing continuation metadata does not close or archive a one-shot', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.skipSessionMeta();
    await harness.call({
      agent: 'scout',
      task: 'first',
      name: 'Scout Missing Meta',
    });
    const delivered = await harness.collect('Scout Missing Meta');
    assert.match(delivered.content, /session metadata is missing/);
    assert.equal(harness.fake.panes.length, 2);
    const history = (await harness.readState()).closedHistory ?? [];
    assert.equal(history.length, 0);
  });
});

test('stage write failure keeps the live one-shot and does not expose resumable history', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.holdChildren();
    await harness.call({
      agent: 'scout',
      task: 'background',
      name: 'Scout Stage Fail',
    });
    setFailNextStateMutation('stage');
    await harness.fake.releaseChildren();
    await harness.waitFor(async () => {
      const record = Object.values((await harness.readState()).agents)[0];
      return record?.detached !== true;
    }, 'detached claim to settle after failed stage');
    assert.equal(harness.fake.panes.length, 2);
    const history = (await harness.readState()).closedHistory ?? [];
    assert.equal(
      history.filter((item) => item.status === 'resumable').length,
      0,
    );
  });
});

test('close failure after staging keeps the live agent and is not resumable', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({ result: 'PRECIOUS RESULT' }));
    harness.fake.failCommand('pane close', 'pane_close_failed');
    await harness.call({
      agent: 'scout',
      task: 'Find it',
      name: 'Scout Close Fail',
    });
    const delivered = await harness.collect('Scout Close Fail');
    assert.match(delivered.content, /PRECIOUS RESULT/);
    assert.match(delivered.content, /failed to close/);
    assert.equal(harness.fake.panes.length, 2);
    const state = await harness.readState();
    assert.ok(Object.keys(state.agents).length > 0);
    assert.equal(
      (state.closedHistory ?? []).some((item) => item.status === 'resumable'),
      false,
    );
    assert.equal(state.closedHistory[0]?.status, 'staged');
  });
});

test('close success plus finalize failure still lets a later resume succeed', async () => {
  await withHarness({}, async (harness) => {
    setFailNextStateMutation('finalize', 3);
    const first = await harness.call({
      agent: 'scout',
      task: 'first',
      name: 'Scout Resume Finalize',
    });
    await harness.collect('Scout Resume Finalize');
    assert.equal(first.isError, undefined);
    assert.equal(harness.fake.panes.length, 1);
    const history = (await harness.readState()).closedHistory ?? [];
    assert.equal(history[0]?.status, 'resumable');
    const resumed = await harness.callTool('agent_send', {
      message: 'second',
      name: 'Scout Resume Finalize',
    });
    await harness.collect('Scout Resume Finalize');
    assert.equal(resumed.isError, undefined);
    assert.equal(resumed.details.resumed, true);
  });
});
