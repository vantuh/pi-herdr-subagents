import assert from 'node:assert/strict';

import { afterAll, test } from 'vitest';

import {
  claimDetachedAgent,
  recordAgentLifecycle,
} from '../src/state/lifecycle.ts';
import {
  isAgentOwnedBy,
  pruneHerdrAgentsState,
} from '../src/state/live-records.ts';
import {
  emptyHerdrAgentsState,
  loadHerdrAgentsState,
  persistPrunedAgentsState,
} from '../src/state/store.ts';
import { createTempStateFixture, pane } from '../test-support/state-fixture.ts';

/**
 * Ownership and pruning: owner stamps, handoff reconciliation, pane pruning
 * and detached claims.
 */

const { tempStatePath, cleanup } = createTempStateFixture();

afterAll(cleanup);

test('preserves owner when a later record omits it', async () => {
  const filePath = await tempStatePath();
  const agentPane = pane();

  await recordAgentLifecycle(
    agentPane,
    { tabLabel: 'Scout', ownerTerminalId: 'term-orch' },
    filePath,
  );
  await recordAgentLifecycle(
    agentPane,
    { tabLabel: 'Scout', detached: true },
    filePath,
  );

  assert.equal(
    (await loadHerdrAgentsState(filePath)).agents['terminal:term-1']
      ?.ownerTerminalId,
    'term-orch',
  );
});

test('treats a stamped record as owned only by that orchestrator', () => {
  const record = {
    lifecycle: 'oneshot' as const,
    ownerTerminalId: 'term-a',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  assert.equal(isAgentOwnedBy(record, 'term-a', 'tab-b', 'tab-a'), true);
  assert.equal(isAgentOwnedBy(record, 'term-b', 'tab-b', 'tab-a'), false);
  assert.equal(isAgentOwnedBy(record, undefined, 'tab-a', 'tab-a'), false);
});

test('legacy pane records without owner stay in the current tab only', () => {
  const record = {
    lifecycle: 'oneshot' as const,
    layout: 'pane' as const,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  assert.equal(isAgentOwnedBy(record, 'term-a', 'tab-a', 'tab-a'), true);
  assert.equal(isAgentOwnedBy(record, 'term-a', 'tab-b', 'tab-a'), false);
});

test('legacy tab records without owner stay visible until restamped', () => {
  const record = {
    lifecycle: 'oneshot' as const,
    layout: 'tab' as const,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  assert.equal(isAgentOwnedBy(record, 'term-b', 'tab-worker', 'tab-a'), true);
});

test('workspace records without owner are never treated as owned', () => {
  // Workspace layout has no pre-stamping era, so an unstamped record cannot
  // be a leftover from an older version — it must stay invisible (and
  // unstealable) to every Orchestrator.
  const record = {
    lifecycle: 'oneshot' as const,
    layout: 'workspace' as const,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  // A workspace record's pane lives in the Agents workspace, never in the
  // Orchestrator's current tab, so the pane-locality fallback cannot claim it.
  assert.equal(isAgentOwnedBy(record, 'term-a', 'tab-worker', 'tab-a'), false);
});

test('prunes state for terminals no longer reported by Herdr', () => {
  const state = emptyHerdrAgentsState();
  state.agents['terminal:term-1'] = {
    lifecycle: 'oneshot',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  state.agents['terminal:gone'] = {
    lifecycle: 'oneshot',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  assert.equal(pruneHerdrAgentsState(state, [pane()]), true);
  assert.deepEqual(Object.keys(state.agents), ['terminal:term-1']);
  assert.equal(pruneHerdrAgentsState(state, [pane()]), false);
});

test('two server snapshots sharing a state file prune only their own records', async () => {
  const filePath = await tempStatePath();
  const serverA = '/isolated/server-a.sock';
  const serverB = '/isolated/server-b.sock';
  const childA = pane({ terminal_id: 'child-a' });
  const childB = pane({ terminal_id: 'child-b' });
  await recordAgentLifecycle(childA, { serverSocketPath: serverA }, filePath);
  await recordAgentLifecycle(childB, { serverSocketPath: serverB }, filePath);

  await persistPrunedAgentsState(
    { panes: [childA] },
    { filePath, serverSocketPath: serverA },
  );
  assert.deepEqual(Object.keys((await loadHerdrAgentsState(filePath)).agents), [
    'terminal:child-a',
    'terminal:child-b',
  ]);
  await persistPrunedAgentsState(
    { panes: [childB] },
    { filePath, serverSocketPath: serverB },
  );
  assert.equal(
    (await loadHerdrAgentsState(filePath)).agents['terminal:child-a']
      ?.serverSocketPath,
    serverA,
  );
  await persistPrunedAgentsState(
    { panes: [] },
    { filePath, serverSocketPath: serverA },
  );
  assert.deepEqual(Object.keys((await loadHerdrAgentsState(filePath)).agents), [
    'terminal:child-b',
  ]);
  await persistPrunedAgentsState(
    { panes: [] },
    { filePath, serverSocketPath: serverB },
  );
  assert.deepEqual((await loadHerdrAgentsState(filePath)).agents, {});
});

test('legacy records retain pruning behavior while foreign stamped records stay untouched', () => {
  const state = emptyHerdrAgentsState();
  state.agents['terminal:legacy'] = { lifecycle: 'oneshot', updatedAt: '' };
  state.agents['terminal:foreign'] = {
    lifecycle: 'oneshot',
    serverSocketPath: '/isolated/other.sock',
    updatedAt: '',
  };
  assert.equal(
    pruneHerdrAgentsState(state, [], '/isolated/current.sock'),
    true,
  );
  assert.deepEqual(Object.keys(state.agents), ['terminal:foreign']);
  assert.equal(
    isAgentOwnedBy(
      state.agents['terminal:foreign'],
      undefined,
      'tab-1',
      'tab-1',
    ),
    false,
  );
});

test('handoff reconciles only the recorded automation target and owner pane on the same server', async () => {
  const filePath = await tempStatePath();
  const socket = '/isolated/handoff.sock';
  await recordAgentLifecycle(
    pane(),
    {
      serverSocketPath: socket,
      automationName: 'owned_1234',
      tabLabel: 'Same label',
      ownerPaneId: 'owner',
      ownerTerminalId: 'old-owner',
      ownerSessionId: 'session-owner',
    },
    filePath,
  );
  const child = pane({ terminal_id: 'new-child', agent: 'pi' });
  const owner = pane({ pane_id: 'owner', terminal_id: 'new-owner' });
  const foreign = pane({
    pane_id: 'foreign',
    terminal_id: 'foreign-child',
    agent: 'pi',
    label: 'Same label',
  });
  const names = [
    { ...child, name: 'owned_1234' },
    { ...foreign, name: 'foreign_1234' },
  ];
  const state = await persistPrunedAgentsState(
    { panes: [child, owner, foreign], agents: names },
    { filePath, serverSocketPath: socket },
  );
  assert.equal(state.agents['terminal:term-1'], undefined);
  assert.equal(
    state.agents['terminal:new-child']?.ownerTerminalId,
    'new-owner',
  );
  assert.equal(state.agents['terminal:foreign-child'], undefined);
});

test('claims a detached agent exactly once', async () => {
  const filePath = await tempStatePath();
  const target = pane({ terminal_id: 'term-async' });

  await recordAgentLifecycle(
    target,
    { tabLabel: 'Async', detached: true },
    filePath,
  );

  assert.equal(await claimDetachedAgent(target, filePath), true);
  assert.equal(await claimDetachedAgent(target, filePath), false);

  const state = await loadHerdrAgentsState(filePath);
  assert.equal(state.agents['terminal:term-async']?.detached, undefined);
  // Only the claim is released; the record itself must survive.
  assert.equal(state.agents['terminal:term-async']?.tabLabel, 'Async');
});

test('does not claim an agent that was never detached', async () => {
  const filePath = await tempStatePath();
  const target = pane({ terminal_id: 'term-sync' });

  await recordAgentLifecycle(target, { tabLabel: 'Sync' }, filePath);

  assert.equal(await claimDetachedAgent(target, filePath), false);
});

test('does not claim an unknown agent', async () => {
  const filePath = await tempStatePath();
  assert.equal(
    await claimDetachedAgent(pane({ terminal_id: 'term-missing' }), filePath),
    false,
  );
  assert.equal(
    await claimDetachedAgent(pane({ terminal_id: undefined }), filePath),
    false,
  );
});

test('serializes concurrent claims so only one wins', async () => {
  const filePath = await tempStatePath();
  const target = pane({ terminal_id: 'term-race' });

  await recordAgentLifecycle(
    target,
    { tabLabel: 'Race', detached: true },
    filePath,
  );

  const results = await Promise.all([
    claimDetachedAgent(target, filePath),
    claimDetachedAgent(target, filePath),
    claimDetachedAgent(target, filePath),
  ]);

  assert.equal(results.filter(Boolean).length, 1);
});

test('persists the detached flag across a reload of the state file', async () => {
  const filePath = await tempStatePath();
  const target = pane({ terminal_id: 'term-reload' });

  await recordAgentLifecycle(
    target,
    { tabLabel: 'Reload', detached: true },
    filePath,
  );

  const reloaded = await loadHerdrAgentsState(filePath);
  assert.equal(reloaded.agents['terminal:term-reload']?.detached, true);
});
