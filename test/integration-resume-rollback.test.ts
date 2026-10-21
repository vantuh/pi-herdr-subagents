import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { test } from 'vitest';

import { setFailNextStateMutation } from '../src/state/store.ts';
import { withHarness } from '../test-support/integration-harness.ts';

/**
 * Resume rollback: partial spawns, prompt failures and path redaction.
 */

test('spawn failure after claim releases the closed history slot', async () => {
  await withHarness({}, async (harness) => {
    await harness.call({ agent: 'scout', task: 'first', name: 'Scout Resume' });
    await harness.collect('Scout Resume');
    harness.fake.failEveryStart('agent_start_failed');
    await assert.rejects(() =>
      harness.callTool('agent_send', {
        message: 'again',
        name: 'Scout Resume',
      }),
    );
    const history = (await harness.readState()).closedHistory ?? [];
    assert.equal(history[0]?.status, 'resumable');
  });
});

test('malformed target creation after claim rolls the history slot back', async () => {
  await withHarness({}, async (harness) => {
    await harness.call({ agent: 'scout', task: 'first', name: 'Scout Resume' });
    await harness.collect('Scout Resume');
    harness.fake.malformCommand('pane split', '<html>nope</html>');
    await assert.rejects(() =>
      harness.callTool('agent_send', {
        message: 'again',
        name: 'Scout Resume',
      }),
    );
    const history = (await harness.readState()).closedHistory ?? [];
    assert.equal(history[0]?.status, 'resumable');
    assert.equal(harness.fake.panes.length, 1);
  });
});

test('lifecycle write failure after start releases the claim and closes the partial target', async () => {
  await withHarness({}, async (harness) => {
    await harness.call({ agent: 'scout', task: 'first', name: 'Scout Resume' });
    await harness.collect('Scout Resume');
    setFailNextStateMutation('lifecycle');
    await assert.rejects(() =>
      harness.callTool('agent_send', {
        message: 'again',
        name: 'Scout Resume',
      }),
    );
    const history = (await harness.readState()).closedHistory ?? [];
    assert.equal(history[0]?.status, 'resumable');
    assert.equal(harness.fake.panes.length, 1);
  });
});

test('failed resume spawn redacts session and temp paths from the error', async () => {
  await withHarness({}, async (harness) => {
    await harness.call({ agent: 'scout', task: 'first', name: 'Scout Resume' });
    await harness.collect('Scout Resume');
    const history = (await harness.readState()).closedHistory ?? [];
    const sessionFile = history[0]?.childSessionFile;
    assert.ok(sessionFile);
    harness.fake.failEveryStart('agent_start_failed');
    await assert.rejects(
      () =>
        harness.callTool('agent_send', {
          message: 'again',
          name: 'Scout Resume',
        }),
      (error: unknown) => {
        const text = String(error);
        assert.equal(text.includes(sessionFile), false);
        assert.equal(text.includes('herdr-agent-'), false);
        assert.match(text, /agent_start_failed/);
        return true;
      },
    );
  });
});

test('aborted resume spawn still cleans up with an independent signal', async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: 'scout',
      task: 'first',
      name: 'Scout Resume Abort',
    });
    await harness.collect('Scout Resume Abort');
    harness.fake.delayAgentStart(800);
    const controller = new AbortController();
    const pending = harness.callTool(
      'agent_send',
      { message: 'again', name: 'Scout Resume Abort' },
      { signal: controller.signal },
    );
    await harness.waitFor(
      () => harness.fake.callsMatching('agent', 'start').length > 1,
      'resume agent start to begin',
    );
    controller.abort();
    await assert.rejects(() => pending);
    const history = (await harness.readState()).closedHistory ?? [];
    assert.equal(history[0]?.status, 'resumable');
    assert.equal(harness.fake.panes.length, 1);
  });
});

test('unconfirmed rollback close keeps the claim instead of a resumable duplicate', async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: 'scout',
      task: 'first',
      name: 'Scout Resume CloseFail',
    });
    await harness.collect('Scout Resume CloseFail');
    harness.fake.failEveryStart('agent_start_failed');
    harness.fake.failCommand('pane close', 'pane_close_failed');
    await assert.rejects(() =>
      harness.callTool('agent_send', {
        message: 'again',
        name: 'Scout Resume CloseFail',
      }),
    );
    const history = (await harness.readState()).closedHistory ?? [];
    assert.equal(history[0]?.status, 'claimed');
    assert.equal(harness.fake.panes.length, 2);
  });
});

test('prompt failure after a durable resume leaves the live generation recoverable', async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: 'scout',
      task: 'first',
      name: 'Scout Resume Prompt',
    });
    await harness.collect('Scout Resume Prompt');
    harness.fake.failCommand('agent prompt', 'agent_prompt_failed', {
      times: 1,
    });
    await assert.rejects(() =>
      harness.callTool('agent_send', {
        message: 'again',
        name: 'Scout Resume Prompt',
      }),
    );
    const state = await harness.readState();
    assert.equal(state.closedHistory[0]?.status, 'claimed');
    assert.ok(Object.keys(state.agents).length > 0);
    assert.equal(harness.fake.panes.length, 2);
  });
});

test('failed resume spawn redacts session paths that contain whitespace', async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: 'scout',
      task: 'first',
      name: 'Scout Space Path',
    });
    await harness.collect('Scout Space Path');
    const state = JSON.parse(await fs.readFile(harness.statePath, 'utf8'));
    const sessionFile = state.closedHistory[0].childSessionFile as string;
    const spaced = path.join(path.dirname(sessionFile), 'child session.jsonl');
    await fs.rename(sessionFile, spaced);
    const raw = await fs.readFile(spaced, 'utf8');
    const [headerLine, ...rest] = raw.split('\n');
    await fs.writeFile(spaced, [headerLine, ...rest].join('\n'));
    state.closedHistory[0].childSessionFile = spaced;
    await fs.writeFile(
      harness.statePath,
      `${JSON.stringify(state, null, 2)}\n`,
    );
    harness.fake.failEveryStart('agent_start_failed');
    await assert.rejects(
      () =>
        harness.callTool('agent_send', {
          message: 'again',
          name: 'Scout Space Path',
        }),
      (error: unknown) => {
        const text = String(error);
        assert.equal(text.includes(spaced), false);
        assert.equal(text.includes('child session.jsonl'), false);
        assert.match(text, /agent_start_failed/);
        return true;
      },
    );
  });
});
