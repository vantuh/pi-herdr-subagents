import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { afterAll, test } from 'vitest';

import { pruneExpiredReports } from '../src/reports.ts';
import { migrateHerdrAgentStorage } from '../src/state/migrate.ts';
import { createTempStateFixture } from '../test-support/state-fixture.ts';

/**
 * The one-time rename of the pre-package-name storage files: state, reports and
 * every case where the two names meet.
 */

const { tempDir, cleanup } = createTempStateFixture();
afterAll(cleanup);

const LEGACY_STATE = 'herdr-agents-state.json';
const NEW_STATE = 'pi-herdr-subagents-state.json';
const LEGACY_REPORTS = 'herdr-agents-results';
const NEW_REPORTS = 'pi-herdr-subagents-results';

const STATE = `${JSON.stringify({
  version: 2,
  agents: {},
  closedHistory: [],
})}\n`;

interface Paths {
  dir: string;
  statePath: string;
  legacyStatePath: string;
  reportsDir: string;
  legacyReportsDir: string;
  warnings: string[];
}

async function paths(): Promise<Paths> {
  const dir = await tempDir();
  return {
    dir,
    statePath: path.join(dir, NEW_STATE),
    legacyStatePath: path.join(dir, LEGACY_STATE),
    reportsDir: path.join(dir, NEW_REPORTS),
    legacyReportsDir: path.join(dir, LEGACY_REPORTS),
    warnings: [],
  };
}

function migrate(targets: Paths): Promise<void> {
  return migrateHerdrAgentStorage({
    agentDir: targets.dir,
    statePath: targets.statePath,
    warn: (message) => targets.warnings.push(message),
  });
}

async function exists(target: string): Promise<boolean> {
  return await fs
    .lstat(target)
    .then(() => true)
    .catch(() => false);
}

test('renames a legacy state file when the new name is absent', async () => {
  const targets = await paths();
  await fs.writeFile(targets.legacyStatePath, STATE, 'utf8');

  await migrate(targets);

  assert.equal(await fs.readFile(targets.statePath, 'utf8'), STATE);
  assert.equal(await exists(targets.legacyStatePath), false);
  assert.deepEqual(targets.warnings, []);

  // Idempotent: a second load has nothing left to move and says nothing.
  await migrate(targets);
  assert.equal(await fs.readFile(targets.statePath, 'utf8'), STATE);
  assert.deepEqual(targets.warnings, []);
});

test('leaves a state file already at the new name alone', async () => {
  const targets = await paths();
  await fs.writeFile(targets.statePath, STATE, 'utf8');

  await migrate(targets);

  assert.equal(await fs.readFile(targets.statePath, 'utf8'), STATE);
  assert.equal(await exists(targets.legacyStatePath), false);
  assert.deepEqual(targets.warnings, []);
});

test('keeps the new state file and the legacy one when both exist', async () => {
  const targets = await paths();
  const legacy = `${JSON.stringify({ version: 2, agents: {}, closedHistory: [] })}\n`;
  await fs.writeFile(targets.legacyStatePath, legacy, 'utf8');
  await fs.writeFile(targets.statePath, STATE, 'utf8');

  await migrate(targets);

  // Never merged: the new file is untouched and the old one stays as it was.
  assert.equal(await fs.readFile(targets.statePath, 'utf8'), STATE);
  assert.equal(await fs.readFile(targets.legacyStatePath, 'utf8'), legacy);
  assert.equal(targets.warnings.length, 1);
  assert.match(targets.warnings[0]!, /both exist/);
  assert.match(targets.warnings[0]!, new RegExp(targets.legacyStatePath));
});

test('writes nothing when neither storage name exists', async () => {
  const targets = await paths();

  await migrate(targets);

  assert.deepEqual(await fs.readdir(targets.dir), []);
  assert.deepEqual(targets.warnings, []);
});

test('moves the reports directory in the same parent, keeping the file names', async () => {
  const targets = await paths();
  const stamp = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  const report = `${stamp
    .toISOString()
    .replace(/[-:.]/g, '')}-scout-1a2b3c4d.md`;
  await fs.mkdir(targets.legacyReportsDir, { mode: 0o700 });
  await fs.writeFile(path.join(targets.legacyReportsDir, report), 'kept');

  await migrate(targets);

  assert.equal(
    await fs.readFile(path.join(targets.reportsDir, report), 'utf8'),
    'kept',
  );
  assert.equal(await exists(targets.legacyReportsDir), false);
  assert.deepEqual(targets.warnings, []);

  // The moved report keeps its stamp, so prune still dates it and removes it.
  const removed = await pruneExpiredReports({ reportsDir: targets.reportsDir });
  assert.equal(removed, 1);
  assert.deepEqual(await fs.readdir(targets.reportsDir), []);
});

test('refuses a symlinked reports directory without touching it', async () => {
  const targets = await paths();
  const realDir = path.join(targets.dir, 'elsewhere');
  await fs.mkdir(realDir);
  await fs.writeFile(path.join(realDir, 'notes.md'), 'mine');
  await fs.symlink(realDir, targets.legacyReportsDir);

  await migrate(targets);

  assert.equal(
    (await fs.lstat(targets.legacyReportsDir)).isSymbolicLink(),
    true,
  );
  assert.equal(await exists(targets.reportsDir), false);
  assert.equal(
    await fs.readFile(path.join(realDir, 'notes.md'), 'utf8'),
    'mine',
  );
  assert.equal(targets.warnings.length, 1);
  assert.match(targets.warnings[0]!, /refusing to move the symlink/);
});
