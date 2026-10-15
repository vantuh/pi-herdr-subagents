import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

import { afterAll, test } from 'vitest';

import {
  emptyHerdrAgentsState,
  loadHerdrAgentsState,
} from '../src/state/store.ts';
import {
  createTempStateFixture,
  history,
} from '../test-support/state-fixture.ts';

/**
 * State-file versions: v1 migration, tolerant record parsing, and quarantine
 * of unreadable files.
 */

const { tempStatePath, cleanup } = createTempStateFixture();

afterAll(cleanup);

test('ignores corrupted state files', async () => {
  const filePath = await tempStatePath();
  await fs.writeFile(filePath, 'not json', 'utf8');

  assert.deepEqual(
    await loadHerdrAgentsState(filePath),
    emptyHerdrAgentsState(),
  );
});

test('migrates v1 state to v2 and keeps live terminal-keyed records', async () => {
  const filePath = await tempStatePath();
  await fs.writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      agents: {
        'terminal:term-1': {
          lifecycle: 'oneshot',
          tabLabel: 'Scout',
          ownerTerminalId: 'term-orch',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    }),
  );

  const loaded = await loadHerdrAgentsState(filePath);
  assert.equal(loaded.version, 2);
  assert.equal(loaded.agents['terminal:term-1']?.tabLabel, 'Scout');
  assert.deepEqual(loaded.closedHistory, []);
});

test('loads v2 closed history without rewriting an unknown future version', async () => {
  const filePath = await tempStatePath();
  await fs.writeFile(
    filePath,
    JSON.stringify({
      version: 2,
      agents: {},
      closedHistory: [history({ id: 'keep-me' })],
    }),
  );
  const loaded = await loadHerdrAgentsState(filePath);
  assert.equal(loaded.version, 2);
  assert.equal(loaded.closedHistory[0]?.id, 'keep-me');
  const onDisk = JSON.parse(await fs.readFile(filePath, 'utf8')) as {
    version: number;
  };
  assert.equal(onDisk.version, 2);
});

test('quarantines unknown future versions instead of silently rewriting them', async () => {
  const filePath = await tempStatePath();
  const original = {
    version: 99,
    agents: {
      'terminal:term-1': {
        lifecycle: 'oneshot',
        tabLabel: 'Keep',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  };
  await fs.writeFile(filePath, `${JSON.stringify(original)}\n`);
  const loaded = await loadHerdrAgentsState(filePath);
  assert.deepEqual(loaded, emptyHerdrAgentsState());
  await assert.rejects(fs.access(filePath));
  const quarantined = JSON.parse(
    await fs.readFile(`${filePath}.quarantine.v99`, 'utf8'),
  ) as typeof original;
  assert.equal(quarantined.version, 99);
  assert.equal(quarantined.agents['terminal:term-1']?.tabLabel, 'Keep');
});

test('explicitly migrates numeric v1 to in-memory v2', async () => {
  const filePath = await tempStatePath();
  await fs.writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      agents: {
        'terminal:term-1': {
          lifecycle: 'oneshot',
          tabLabel: 'Legacy',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    }),
  );
  const loaded = await loadHerdrAgentsState(filePath);
  assert.equal(loaded.version, 2);
  assert.equal(loaded.agents['terminal:term-1']?.tabLabel, 'Legacy');
  assert.deepEqual(loaded.closedHistory, []);
  const onDisk = JSON.parse(await fs.readFile(filePath, 'utf8')) as {
    version: number;
  };
  assert.equal(onDisk.version, 1);
});

test('quarantines missing versions instead of treating them as v1', async () => {
  const filePath = await tempStatePath();
  const original = JSON.stringify({
    agents: {
      'terminal:term-1': {
        lifecycle: 'oneshot',
        tabLabel: 'Keep',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  });
  await fs.writeFile(filePath, `${original}\n`);
  const loaded = await loadHerdrAgentsState(filePath);
  assert.deepEqual(loaded, emptyHerdrAgentsState());
  await assert.rejects(fs.access(filePath));
  const quarantined = await fs.readFile(
    `${filePath}.quarantine.vmissing`,
    'utf8',
  );
  assert.equal(quarantined.trim(), original);
});

test('quarantines malformed JSON instead of overwriting it', async () => {
  const filePath = await tempStatePath();
  await fs.writeFile(filePath, '{not json\n');
  const loaded = await loadHerdrAgentsState(filePath);
  assert.deepEqual(loaded, emptyHerdrAgentsState());
  await fs.access(`${filePath}.quarantine.vjson`);
  assert.equal(
    await fs.readFile(`${filePath}.quarantine.vjson`, 'utf8'),
    '{not json\n',
  );
});

test('quarantines malformed versions instead of migrating them', async () => {
  const filePath = await tempStatePath();
  await fs.writeFile(
    filePath,
    `${JSON.stringify({ version: 'two', agents: {} })}\n`,
  );
  const loaded = await loadHerdrAgentsState(filePath);
  assert.deepEqual(loaded, emptyHerdrAgentsState());
  await fs.access(`${filePath}.quarantine.vtwo`);
});

test('a record missing defaultable fields gets defaults and keeps its siblings', async () => {
  const filePath = await tempStatePath();
  const now = new Date().toISOString();
  await fs.writeFile(
    filePath,
    `${JSON.stringify({
      version: 2,
      agents: {
        'terminal:undated': { lifecycle: 'oneshot', tabLabel: 'Undated' },
        'terminal:dated': {
          lifecycle: 'oneshot',
          tabLabel: 'Dated',
          updatedAt: now,
        },
      },
      closedHistory: [
        {
          id: 'h-undated',
          ownerSessionId: 'orch-a',
          profileName: 'scout',
          tabLabel: 'Scout',
          childSessionFile: '/isolated/child.jsonl',
          childSessionId: 'child-1',
          cwd: '/isolated',
          layout: 'tab',
          lifecycle: 'oneshot',
          closedAt: now,
          status: 'resumable',
        },
      ],
    })}\n`,
  );
  const loaded = await loadHerdrAgentsState(filePath);
  assert.deepEqual(Object.keys(loaded.agents), [
    'terminal:undated',
    'terminal:dated',
  ]);
  assert.equal(
    loaded.agents['terminal:undated']?.updatedAt,
    new Date(0).toISOString(),
  );
  assert.deepEqual(
    loaded.closedHistory.map((record) => [
      record.id,
      record.createdAt,
      record.claimGeneration,
    ]),
    [['h-undated', new Date(0).toISOString(), 0]],
  );
});

test('drops a record with a wrongly typed optional field, keeping its siblings', async () => {
  const filePath = await tempStatePath();
  const now = new Date().toISOString();
  await fs.writeFile(
    filePath,
    `${JSON.stringify({
      version: 2,
      agents: {
        'terminal:good': {
          lifecycle: 'oneshot',
          tabLabel: 'Keep',
          updatedAt: now,
        },
        'terminal:bad': {
          lifecycle: 'oneshot',
          tabLabel: 'Drop',
          detached: 'yes',
          updatedAt: now,
        },
      },
      closedHistory: [
        {
          id: 'h-good',
          ownerSessionId: 'orch-a',
          profileName: 'scout',
          tabLabel: 'Scout',
          childSessionFile: '/isolated/child.jsonl',
          childSessionId: 'child-1',
          cwd: '/isolated',
          layout: 'tab',
          lifecycle: 'oneshot',
          createdAt: now,
          closedAt: now,
          status: 'resumable',
          claimGeneration: 0,
        },
        {
          id: 'h-bad',
          ownerSessionId: 'orch-a',
          profileName: 'scout',
          tabLabel: 'Scout',
          childSessionFile: '/isolated/child.jsonl',
          childSessionId: 'child-2',
          cwd: '/isolated',
          layout: 'tab',
          lifecycle: 'oneshot',
          createdAt: now,
          closedAt: now,
          status: 'resumable',
          claimGeneration: 0,
          claimedAt: 42,
        },
      ],
    })}\n`,
  );
  const loaded = await loadHerdrAgentsState(filePath);
  assert.deepEqual(Object.keys(loaded.agents), ['terminal:good']);
  assert.deepEqual(
    loaded.closedHistory.map((record) => record.id),
    ['h-good'],
  );
});
