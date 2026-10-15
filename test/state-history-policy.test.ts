import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { afterAll, test } from 'vitest';

import {
  CLOSED_HISTORY_MAX_GLOBAL,
  CLOSED_HISTORY_MAX_PER_OWNER,
  CLOSED_HISTORY_TTL_MS,
  pruneClosedHistory,
} from '../src/state/history-policy.ts';
import { pruneHerdrAgentsState } from '../src/state/live-records.ts';
import { emptyHerdrAgentsState } from '../src/state/store.ts';
import {
  createTempStateFixture,
  history,
  pane,
} from '../test-support/state-fixture.ts';

/**
 * Closed-history policy: what pruning keeps, drops and bounds.
 */

const { tempDir, cleanup } = createTempStateFixture();
afterAll(cleanup);

test('keeps live records terminal-keyed while pruning closed history bounds', () => {
  const state = emptyHerdrAgentsState();
  state.agents['terminal:term-1'] = {
    lifecycle: 'oneshot',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  for (let i = 0; i < CLOSED_HISTORY_MAX_PER_OWNER + 5; i++) {
    state.closedHistory.push(
      history({
        id: `ch-${i}`,
        tabLabel: `Label ${i}`,
        closedAt: new Date(Date.now() - i * 1000).toISOString(),
      }),
    );
  }
  assert.equal(pruneHerdrAgentsState(state, [pane()]), false);
  assert.ok(state.agents['terminal:term-1']);
  pruneClosedHistory(state);
  assert.equal(state.closedHistory.length, CLOSED_HISTORY_MAX_PER_OWNER);
});

test('drops expired closed history but never claimed in-flight slots', () => {
  const state = emptyHerdrAgentsState();
  state.closedHistory.push(
    history({
      id: 'old',
      closedAt: new Date(
        Date.now() - CLOSED_HISTORY_TTL_MS - 1000,
      ).toISOString(),
    }),
    history({
      id: 'claimed-old',
      status: 'claimed',
      closedAt: new Date(
        Date.now() - CLOSED_HISTORY_TTL_MS - 1000,
      ).toISOString(),
    }),
  );
  pruneClosedHistory(state);
  assert.deepEqual(
    state.closedHistory.map((record) => record.id),
    ['claimed-old'],
  );
});

test('caps closed history globally without deleting session files', async () => {
  const dir = await tempDir();
  const state = emptyHerdrAgentsState();
  const files: string[] = [];
  for (let i = 0; i < CLOSED_HISTORY_MAX_GLOBAL + 3; i++) {
    const sessionFile = path.join(dir, `s-${i}.jsonl`);
    await fs.writeFile(sessionFile, '{}\n');
    files.push(sessionFile);
    state.closedHistory.push(
      history({
        id: `g-${i}`,
        ownerSessionId: `owner-${i}`,
        tabLabel: `L${i}`,
        childSessionFile: sessionFile,
        closedAt: new Date(Date.now() - i * 1000).toISOString(),
      }),
    );
  }
  pruneClosedHistory(state);
  assert.ok(state.closedHistory.length <= CLOSED_HISTORY_MAX_GLOBAL);
  for (const file of files) {
    await fs.access(file);
  }
});
