import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

import { test } from 'vitest';

import { withHarness } from '../test-support/integration-harness.ts';

/**
 * The harness's state-file protocol. Tests edit state through `updateState`
 * (the extension's locked read-modify-write); a raw `writeFile` can be caught
 * mid-truncation by a poller read, which quarantines the file.
 */

test('readState reports a corrupt state file instead of an empty one', async () => {
  await withHarness({}, async (harness) => {
    await fs.writeFile(harness.statePath, 'not json', 'utf8');

    // An empty state here would be written back by a test and read as "no
    // agents owned", hiding the corruption behind a wrong list.
    await assert.rejects(() => harness.readState());
    assert.equal(await fs.readFile(harness.statePath, 'utf8'), 'not json');
  });
});

test('updateState loads, edits and saves the state file under the lock', async () => {
  await withHarness({}, async (harness) => {
    await harness.updateState((state) => {
      state.agents['terminal:x'] = {
        lifecycle: 'oneshot',
        tabLabel: 'Added',
        updatedAt: new Date().toISOString(),
      };
    });

    const stored = JSON.parse(await fs.readFile(harness.statePath, 'utf8'));
    assert.equal(stored.agents['terminal:x']?.tabLabel, 'Added');
    assert.equal((await fs.stat(harness.statePath)).mode & 0o777, 0o600);
  });
});
