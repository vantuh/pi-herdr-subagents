import assert from 'node:assert/strict';

import { afterAll, test } from 'vitest';

import {
  claimClosedHistory,
  finalizeStagedClosedOneShot,
  releaseClosedHistory,
  stageClosedOneShot,
} from '../src/state/closed-history.ts';
import { recordAgentLifecycle } from '../src/state/lifecycle.ts';
import { pruneHerdrAgentsState } from '../src/state/live-records.ts';
import type { ClosedAgentHistoryRecord } from '../src/state/schema.ts';
import {
  emptyHerdrAgentsState,
  loadHerdrAgentsState,
  persistPrunedAgentsState,
  setFailNextStateMutation,
  setFailNextStateSaves,
} from '../src/state/store.ts';
import {
  createTempStateFixture,
  history,
  pane,
} from '../test-support/state-fixture.ts';

/**
 * Closed-history transitions: staging, claiming, finalizing and release.
 */

const { tempStatePath, cleanup } = createTempStateFixture();
afterAll(cleanup);

async function stageHistory(
  filePath: string,
  input: Partial<Parameters<typeof stageClosedOneShot>[0]> = {},
): Promise<ClosedAgentHistoryRecord> {
  await recordAgentLifecycle(
    pane(),
    { tabLabel: 'Scout Resume', agent: 'scout', ownerSessionId: 'orch-a' },
    filePath,
  );
  return stageClosedOneShot(
    {
      livePane: pane(),
      ownerSessionId: 'orch-a',
      profileName: 'scout',
      tabLabel: 'Scout Resume',
      childSessionFile: '/tmp/a.jsonl',
      childSessionId: 'sid-a',
      cwd: '/tmp/repo',
      layout: 'pane',
      ...input,
    },
    filePath,
  );
}

async function resumableHistory(
  filePath: string,
  input: Partial<Parameters<typeof stageClosedOneShot>[0]> = {},
): Promise<ClosedAgentHistoryRecord> {
  const staged = await stageHistory(filePath, input);
  await finalizeStagedClosedOneShot(
    { historyId: staged.id, livePane: pane() },
    filePath,
  );
  return staged;
}

test('keeps one newest continuation slot per owner session and label', async () => {
  const filePath = await tempStatePath();
  const first = await stageHistory(filePath);
  const second = await stageHistory(filePath, {
    id: first.id,
    childSessionFile: '/tmp/b.jsonl',
    childSessionId: 'sid-b',
  });

  const state = await loadHerdrAgentsState(filePath);
  assert.equal(state.closedHistory.length, 1);
  assert.equal(state.closedHistory[0]?.id, first.id);
  assert.equal(state.closedHistory[0]?.childSessionId, 'sid-b');
  assert.equal(second.id, first.id);
});

test('does not let another orchestrator session claim closed history', async () => {
  const filePath = await tempStatePath();
  await stageHistory(filePath);

  const other = await claimClosedHistory(
    {
      ownerSessionId: 'orch-b',
      tabLabel: 'Scout Resume',
      profileName: 'scout',
    },
    filePath,
  );
  assert.equal(other.ok, false);
  if (!other.ok)
    assert.match(other.error, /owned by this Orchestrator session/);
});

test('claims a closed history slot exactly once and can release it', async () => {
  const filePath = await tempStatePath();
  const archived = await resumableHistory(filePath);

  const results = await Promise.all([
    claimClosedHistory(
      {
        ownerSessionId: 'orch-a',
        tabLabel: 'Scout Resume',
        profileName: 'scout',
      },
      filePath,
    ),
    claimClosedHistory(
      {
        ownerSessionId: 'orch-a',
        tabLabel: 'Scout Resume',
        profileName: 'scout',
      },
      filePath,
    ),
    claimClosedHistory(
      {
        ownerSessionId: 'orch-a',
        tabLabel: 'Scout Resume',
        profileName: 'scout',
      },
      filePath,
    ),
  ]);
  assert.equal(results.filter((item) => item.ok).length, 1);

  const winner = results.find((item) => item.ok);
  assert.ok(winner && winner.ok);
  await releaseClosedHistory(
    winner.record.id,
    winner.record.claimGeneration,
    filePath,
  );
  const again = await claimClosedHistory(
    {
      ownerSessionId: 'orch-a',
      tabLabel: 'Scout Resume',
      profileName: 'scout',
    },
    filePath,
  );
  assert.equal(again.ok, true);
  assert.equal(archived.id, winner.record.id);
});

test('releases stale claimed history that has no live generation', async () => {
  const filePath = await tempStatePath();
  const archived = await resumableHistory(filePath);
  const claimed = await claimClosedHistory(
    {
      ownerSessionId: 'orch-a',
      tabLabel: 'Scout Resume',
      profileName: 'scout',
    },
    filePath,
  );
  assert.equal(claimed.ok, true);
  const previous = process.env.HERDR_AGENTS_CLAIM_LEASE_MS;
  process.env.HERDR_AGENTS_CLAIM_LEASE_MS = '0';
  try {
    const loaded = await loadHerdrAgentsState(filePath);
    assert.equal(loaded.closedHistory[0]?.id, archived.id);
    assert.equal(loaded.closedHistory[0]?.status, 'resumable');
  } finally {
    if (previous === undefined) delete process.env.HERDR_AGENTS_CLAIM_LEASE_MS;
    else process.env.HERDR_AGENTS_CLAIM_LEASE_MS = previous;
  }
});

test('does not release a claimed generation that still has a live agent', async () => {
  const filePath = await tempStatePath();
  await resumableHistory(filePath);
  const claimed = await claimClosedHistory(
    {
      ownerSessionId: 'orch-a',
      tabLabel: 'Scout Resume',
      profileName: 'scout',
    },
    filePath,
  );
  assert.ok(claimed.ok);
  if (!claimed.ok) return;
  await recordAgentLifecycle(
    pane(),
    {
      tabLabel: 'Scout Resume',
      closedHistoryId: claimed.record.id,
      closedHistoryGeneration: claimed.record.claimGeneration,
    },
    filePath,
  );
  const previous = process.env.HERDR_AGENTS_CLAIM_LEASE_MS;
  process.env.HERDR_AGENTS_CLAIM_LEASE_MS = '0';
  try {
    const loaded = await loadHerdrAgentsState(filePath);
    assert.equal(loaded.closedHistory[0]?.status, 'claimed');
    const again = await claimClosedHistory(
      {
        ownerSessionId: 'orch-a',
        tabLabel: 'Scout Resume',
        profileName: 'scout',
      },
      filePath,
    );
    assert.equal(again.ok, false);
  } finally {
    if (previous === undefined) delete process.env.HERDR_AGENTS_CLAIM_LEASE_MS;
    else process.env.HERDR_AGENTS_CLAIM_LEASE_MS = previous;
  }
});

test('finalizes staged history after the live pane disappears', async () => {
  const state = emptyHerdrAgentsState();
  state.agents['terminal:term-1'] = {
    lifecycle: 'oneshot',
    closedHistoryId: 'ch-1',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  state.closedHistory.push(
    history({ id: 'ch-1', status: 'staged', tabLabel: 'Scout Resume' }),
  );
  pruneHerdrAgentsState(state, []);
  assert.equal(state.agents['terminal:term-1'], undefined);
  assert.equal(state.closedHistory[0]?.status, 'resumable');
});

test('stages continuation metadata and finalizes it atomically', async () => {
  const filePath = await tempStatePath();
  await recordAgentLifecycle(
    pane(),
    { tabLabel: 'Scout Resume', agent: 'scout', ownerSessionId: 'orch-a' },
    filePath,
  );
  const staged = await stageClosedOneShot(
    {
      livePane: pane(),
      ownerSessionId: 'orch-a',
      profileName: 'scout',
      tabLabel: 'Scout Resume',
      childSessionFile: '/tmp/a.jsonl',
      childSessionId: 'sid-a',
      cwd: '/tmp/repo',
      layout: 'pane',
    },
    filePath,
  );
  assert.equal(staged.status, 'staged');
  assert.equal(
    (await loadHerdrAgentsState(filePath)).agents['terminal:term-1']
      ?.closedHistoryId,
    staged.id,
  );
  await finalizeStagedClosedOneShot(
    { historyId: staged.id, livePane: pane() },
    filePath,
  );
  const after = await loadHerdrAgentsState(filePath);
  assert.equal(after.agents['terminal:term-1'], undefined);
  assert.equal(after.closedHistory[0]?.status, 'resumable');
});

test('stage write failure leaves live state and no resumable history', async () => {
  const filePath = await tempStatePath();
  await recordAgentLifecycle(
    pane(),
    { tabLabel: 'Scout Resume', agent: 'scout', ownerSessionId: 'orch-a' },
    filePath,
  );
  setFailNextStateSaves(1);
  try {
    await assert.rejects(
      () =>
        stageClosedOneShot(
          {
            livePane: pane(),
            ownerSessionId: 'orch-a',
            profileName: 'scout',
            tabLabel: 'Scout Resume',
            childSessionFile: '/tmp/a.jsonl',
            childSessionId: 'sid-a',
            cwd: '/tmp/repo',
            layout: 'pane',
          },
          filePath,
        ),
      /injected state save failure/,
    );
    const after = await loadHerdrAgentsState(filePath);
    assert.ok(after.agents['terminal:term-1']);
    assert.equal(after.closedHistory.length, 0);
  } finally {
    setFailNextStateSaves(0);
  }
});

test('persistPrunedAgentsState finalizes staged history when the live terminal is gone', async () => {
  const filePath = await tempStatePath();
  await recordAgentLifecycle(
    pane(),
    { tabLabel: 'Scout Resume', agent: 'scout', ownerSessionId: 'orch-a' },
    filePath,
  );
  const staged = await stageClosedOneShot(
    {
      livePane: pane(),
      ownerSessionId: 'orch-a',
      profileName: 'scout',
      tabLabel: 'Scout Resume',
      childSessionFile: '/tmp/a.jsonl',
      childSessionId: 'sid-a',
      cwd: '/tmp/repo',
      layout: 'pane',
    },
    filePath,
  );
  setFailNextStateMutation('finalize');
  await assert.rejects(
    () =>
      finalizeStagedClosedOneShot(
        { historyId: staged.id, livePane: pane() },
        filePath,
      ),
    /injected finalize state save failure/,
  );
  const before = await loadHerdrAgentsState(filePath);
  assert.equal(before.closedHistory[0]?.status, 'staged');
  assert.ok(before.agents['terminal:term-1']);
  const after = await persistPrunedAgentsState({ panes: [] }, { filePath });
  assert.equal(after.agents['terminal:term-1'], undefined);
  assert.equal(after.closedHistory[0]?.status, 'resumable');
});
