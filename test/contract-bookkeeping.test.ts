import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { test } from 'vitest';

import { withHarness } from '../test-support/contract-harness.ts';

/**
 * Bookkeeping: state pruning, state-file permissions and config reloads.
 */

test('does not touch the layout while a single agent is alone in the column', async () => {
  await withHarness({}, async (harness) => {
    // A detached agent that never settles stays live in the column.
    harness.fake.setBehavior(() => ({ neverSettle: true }));
    await harness.callRaw({ agent: 'scout', task: 'solo' });

    // Rebalancing two or more agents is the only reason to move ratios.
    assert.deepEqual(harness.fake.ratioUpdates, []);
  });
});

test('prunes state records for panes Herdr no longer reports', async () => {
  await withHarness({}, async (harness) => {
    // A detached agent that never settles keeps its live record.
    harness.fake.setBehavior(() => ({ neverSettle: true }));
    await harness.callRaw({ agent: 'scout', task: 'one', name: 'Scout Stale' });
    const statePath = harness.statePath;
    const before = JSON.parse(await fs.readFile(statePath, 'utf8'));
    before.agents['terminal:ghost'] = {
      lifecycle: 'persistent',
      tabLabel: 'Ghost',
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(statePath, JSON.stringify(before));

    // Any path that lists managed agents reconciles the file.
    await harness.runCommand('herdr-agents');

    const after = await harness.readState();
    assert.deepEqual(
      Object.keys(after.agents).filter((key) => key.includes('ghost')),
      [],
    );
    assert.equal(Object.keys(after.agents).length, 1);
  });
});

test('writes the state file with owner-only permissions', async () => {
  await withHarness({}, async (harness) => {
    // A detached agent keeps its record and artifacts alive for the check.
    harness.fake.setBehavior(() => ({ neverSettle: true }));
    await harness.callRaw({ agent: 'scout', task: 'one' });

    const stats = await fs.stat(harness.statePath);
    assert.equal(stats.mode & 0o777, 0o600);
    // Same for the artifacts, which carry task and result text.
    const record = Object.values((await harness.readState()).agents)[0];
    const artifactDir = path.dirname(record?.resultFile ?? '');
    const system = await fs.stat(path.join(artifactDir, 'system.md'));
    assert.equal(system.mode & 0o777, 0o600);
  });
});

test('reads herdr-agents.json once per extension load', async () => {
  await withHarness({ layout: 'pane' }, async (harness) => {
    // The first spawn resolves the read; only then is the file rewritten.
    await harness.callRaw({ agent: 'scout', task: 'first', name: 'One' });

    const agentDir = process.env.PI_CODING_AGENT_DIR;
    assert.ok(agentDir, 'expected the harness to set PI_CODING_AGENT_DIR');
    await fs.writeFile(
      path.join(agentDir, 'herdr-agents.json'),
      `${JSON.stringify({ layout: 'tab' })}\n`,
    );

    await harness.callRaw({ agent: 'scout', task: 'second', name: 'Two' });

    // Still the layout loaded at activation, not the one now in the file.
    assert.equal(harness.fake.callsMatching('pane', 'split').length, 2);
    assert.equal(harness.fake.callsMatching('tab', 'create').length, 0);
  });
});
