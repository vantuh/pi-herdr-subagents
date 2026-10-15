import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

import { afterAll, test } from 'vitest';

import {
  claimDetachedAgent,
  clearAgentSpawnWarnings,
  deleteAgentLifecycle,
  recordAgentLifecycle,
} from '../src/state/lifecycle.ts';
import { paneStateKey } from '../src/state/live-records.ts';
import { loadHerdrAgentsState } from '../src/state/store.ts';
import { createTempStateFixture, pane } from '../test-support/state-fixture.ts';

/**
 * Lifecycle records: terminal-keyed state, spawn warnings, and concurrent
 * record/delete mutations.
 */

const { tempStatePath, cleanup } = createTempStateFixture();

afterAll(cleanup);

test('uses terminal id as the durable pane state key', () => {
  assert.equal(paneStateKey(pane()), 'terminal:term-1');
  assert.equal(paneStateKey(pane({ terminal_id: undefined })), undefined);
});

test('records and loads agent lifecycle state', async () => {
  const filePath = await tempStatePath();

  await recordAgentLifecycle(
    pane(),
    {
      serverSocketPath: '/isolated/lifecycle.sock',
      tabLabel: 'Researcher',
      agent: 'researcher',
      automationName: 'researcher_ab12cd34',
      resultFile: '/tmp/herdr-agent-test/result.md',
      layout: 'pane',
      spawnWarnings: ['Skill missing.'],
      ownerTerminalId: 'term-orch',
    },
    filePath,
  );

  const state = await loadHerdrAgentsState(filePath);
  assert.deepEqual(state.agents['terminal:term-1'], {
    lifecycle: 'oneshot',
    paneId: 'pane-1',
    serverSocketPath: '/isolated/lifecycle.sock',
    tabLabel: 'Researcher',
    agent: 'researcher',
    automationName: 'researcher_ab12cd34',
    resultFile: '/tmp/herdr-agent-test/result.md',
    layout: 'pane',
    spawnWarnings: ['Skill missing.'],
    ownerTerminalId: 'term-orch',
    updatedAt: state.agents['terminal:term-1']?.updatedAt,
  });
});

test('preserves inert persistent records without restamping or claiming them', async () => {
  const filePath = await tempStatePath();
  const record = {
    lifecycle: 'persistent',
    detached: true,
    tabLabel: 'Legacy',
    ownerTerminalId: 'term-orch',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const before = JSON.stringify({
    version: 2,
    agents: { 'terminal:term-1': record },
    closedHistory: [],
  });
  await fs.writeFile(filePath, before);
  await recordAgentLifecycle(pane(), { tabLabel: 'Replacement' }, filePath);
  assert.equal(await claimDetachedAgent(pane(), filePath), false);
  assert.deepEqual(
    (await loadHerdrAgentsState(filePath)).agents['terminal:term-1'],
    record,
  );
  assert.equal(await fs.readFile(filePath, 'utf8'), before);
});

test('clears spawn warnings after a successful collect', async () => {
  const filePath = await tempStatePath();
  const agentPane = pane();

  await recordAgentLifecycle(
    agentPane,
    { spawnWarnings: ['Skill missing.'] },
    filePath,
  );
  await clearAgentSpawnWarnings(agentPane, filePath);

  assert.equal(
    (await loadHerdrAgentsState(filePath)).agents['terminal:term-1']
      ?.spawnWarnings,
    undefined,
  );
});

test('recordAgentLifecycle is a no-op when terminal_id is missing', async () => {
  const filePath = await tempStatePath();

  await recordAgentLifecycle(pane({ terminal_id: undefined }), {}, filePath);

  await assert.rejects(fs.access(filePath));
});

test('deleteAgentLifecycle is a no-op when terminal_id is missing', async () => {
  const filePath = await tempStatePath();
  await recordAgentLifecycle(pane(), {}, filePath);

  await deleteAgentLifecycle(pane({ terminal_id: undefined }), filePath);

  const state = await loadHerdrAgentsState(filePath);
  assert.ok(state.agents['terminal:term-1']);
});

test("concurrent recordAgentLifecycle calls in the same process don't lose entries", async () => {
  const filePath = await tempStatePath();

  const panes = Array.from({ length: 20 }, (_, i) =>
    pane({ terminal_id: `term-${i}` }),
  );

  await Promise.all(
    panes.map((p, i) =>
      recordAgentLifecycle(p, { agent: `agent-${i}` }, filePath),
    ),
  );

  const state = await loadHerdrAgentsState(filePath);
  assert.equal(Object.keys(state.agents).length, panes.length);
  for (let i = 0; i < panes.length; i++) {
    assert.equal(state.agents[`terminal:term-${i}`]?.agent, `agent-${i}`);
  }
});

test("concurrent record and delete calls for the same terminal don't corrupt state", async () => {
  const filePath = await tempStatePath();
  const survivor = pane({ terminal_id: 'term-survivor' });

  await Promise.all([
    recordAgentLifecycle(pane(), { agent: 'a' }, filePath),
    recordAgentLifecycle(survivor, { agent: 'b' }, filePath),
    deleteAgentLifecycle(pane(), filePath),
    recordAgentLifecycle(survivor, { agent: 'c' }, filePath),
  ]);

  const state = await loadHerdrAgentsState(filePath);
  // The last queued write for the survivor terminal must win.
  assert.equal(state.agents['terminal:term-survivor']?.agent, 'c');
});
