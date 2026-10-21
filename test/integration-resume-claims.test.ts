import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

import { test } from 'vitest';

import { setFailNextStateSaves } from '../src/state/store.ts';
import type { Harness } from '../test-support/harness.ts';
import { withHarness } from '../test-support/integration-harness.ts';

/**
 * Resume claims: invalidation keeps a slot invalid, a failed invalidation
 * releases the claim again, and concurrent resumes have one winner.
 */

function failStateReadOnce(
  harness: Harness,
  whenContent: (raw: string) => boolean,
): () => void {
  const realReadFile = fs.readFile.bind(fs);
  let armed = true;
  fs.readFile = (async (...args: unknown[]) => {
    const real = realReadFile as (...inner: unknown[]) => Promise<unknown>;
    if (args[0] !== harness.statePath || !armed) return real(...args);
    const raw = String(await real(harness.statePath, 'utf8'));
    if (!whenContent(raw)) return raw;
    armed = false;
    const error = new Error(
      `EACCES: permission denied, open '${harness.statePath}'`,
    ) as NodeJS.ErrnoException;
    error.code = 'EACCES';
    throw error;
  }) as typeof fs.readFile;
  return () => {
    fs.readFile = realReadFile;
  };
}

async function seedClosedOneShotWithMissingSession(
  harness: Harness,
): Promise<Awaited<ReturnType<Harness['readState']>>> {
  await harness.call({ agent: 'scout', task: 'first', name: 'Scout Resume' });
  await harness.collect('Scout Resume');
  await harness.fire('session_shutdown');
  const state = await harness.readState();
  await fs.rm(state.closedHistory[0]!.childSessionFile);
  await fs.writeFile(harness.statePath, JSON.stringify(state));
  return state;
}

test('agent_send fails closed when placement state pruning fails', async () => {
  await withHarness({}, async (harness) => {
    await harness.call({ agent: 'scout', task: 'first', name: 'Scout Resume' });
    await harness.collect('Scout Resume');
    await harness.fire('session_shutdown');
    const state = await harness.readState();
    const history = state.closedHistory[0]!;
    await fs.rm(history.childSessionFile);
    state.agents['terminal:gone'] = {
      lifecycle: 'oneshot',
      paneId: 'gone',
      collected: false,
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(harness.statePath, JSON.stringify(state));
    setFailNextStateSaves(1);

    const result = await harness.callTool('agent_send', {
      message: 'again',
      name: 'Scout Resume',
    });
    assert.equal(result.isError, true);
    assert.equal(
      result.content[0].text,
      'No agent named "Scout Resume" found for this session. Use agent_spawn to start one.',
    );
    assert.equal(harness.fake.callsMatching('agent', 'start').length, 1);
    assert.equal(harness.fake.callsMatching('pane', 'split').length, 1);
    assert.deepEqual(
      (await harness.readState()).closedHistory,
      state.closedHistory,
    );
  });
});

test('agent_send releases no claim when invalidation succeeded', async () => {
  await withHarness({}, async (harness) => {
    const state = await seedClosedOneShotWithMissingSession(harness);
    const restore = failStateReadOnce(harness, (raw) =>
      raw.includes('"status": "invalid"'),
    );
    try {
      const result = await harness.callTool('agent_send', {
        message: 'again',
        name: 'Scout Resume',
      });
      assert.equal(result.isError, true);
      assert.equal(
        result.content[0].text,
        'Cannot resume "Scout Resume": child session file is missing, corrupt, or does not match the stored session id/cwd.',
      );
    } finally {
      restore();
    }

    const after = await harness.readState();
    assert.equal(after.closedHistory.length, state.closedHistory.length);
    assert.equal(after.closedHistory[0]!.status, 'invalid');
    assert.equal(harness.fake.callsMatching('agent', 'start').length, 1);
  });
});

test('agent_send releases the claim again when invalidation failed', async () => {
  await withHarness({}, async (harness) => {
    const state = await seedClosedOneShotWithMissingSession(harness);
    const restore = failStateReadOnce(harness, (raw) =>
      raw.includes('"status": "claimed"'),
    );
    try {
      const result = await harness.callTool('agent_send', {
        message: 'again',
        name: 'Scout Resume',
      });
      assert.equal(result.isError, true);
      assert.match(
        result.content[0].text,
        /missing, corrupt, or does not match/,
      );
    } finally {
      restore();
    }

    const after = await harness.readState();
    assert.equal(after.closedHistory[0]!.status, 'resumable');
    assert.equal('claimedAt' in after.closedHistory[0]!, false);
    assert.equal(
      after.closedHistory[0]!.claimGeneration,
      state.closedHistory[0]!.claimGeneration + 1,
    );
  });
});

test('concurrent agent_send resumes have a single winner', async () => {
  await withHarness({}, async (harness) => {
    await harness.call({ agent: 'scout', task: 'first', name: 'Scout Resume' });
    await harness.collect('Scout Resume');
    harness.fake.setBehavior(() => ({
      result: 'resumed',
      delayMs: 400,
    }));
    const results = await Promise.all([
      harness.callTool('agent_send', { message: 'a', name: 'Scout Resume' }),
      harness.callTool('agent_send', { message: 'b', name: 'Scout Resume' }),
    ]);
    assert.equal(results.filter((item) => !item.isError).length, 1);
    assert.equal(results.filter((item) => item.isError).length, 1);
  });
});
