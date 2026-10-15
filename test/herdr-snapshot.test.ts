import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  parseCreatedWorkspace,
  parseWorkspaceListOutput,
} from '../src/herdr/snapshot.ts';
import { buildAgentFinishedNotificationArgs } from '../src/ui/detached-outcomes.ts';

/**
 * Snapshot output parsing and the agent-finished notification.
 */

test('parses the workspace list envelope and drops malformed entries', () => {
  assert.deepEqual(
    parseWorkspaceListOutput(
      JSON.stringify({
        result: {
          workspaces: [
            { workspace_id: 'w1', label: 'main', focused: true },
            { workspace_id: 'w2', label: 'Agents' },
            { label: 'no id' },
            'junk',
          ],
        },
      }),
    ),
    [
      { workspace_id: 'w1', label: 'main' },
      { workspace_id: 'w2', label: 'Agents' },
    ],
  );
  assert.throws(() => parseWorkspaceListOutput('this is not json'));
  assert.throws(() => parseWorkspaceListOutput(JSON.stringify({ result: {} })));
});

test('reads the created workspace id and root tab id from workspace create output', () => {
  assert.deepEqual(
    parseCreatedWorkspace(
      JSON.stringify({
        result: {
          workspace: { workspace_id: 'w7' },
          tab: { tab_id: 'w7:t1' },
        },
      }),
    ),
    { workspaceId: 'w7', rootTabId: 'w7:t1' },
  );
  assert.deepEqual(
    parseCreatedWorkspace(
      JSON.stringify({ result: { workspace: { workspace_id: 'w7' } } }),
    ),
    { workspaceId: 'w7' },
  );
  assert.deepEqual(parseCreatedWorkspace('this is not json'), {});
  assert.deepEqual(
    parseCreatedWorkspace(JSON.stringify({ result: { workspace: {} } })),
    {},
  );
});

test('builds the agent-finished notification with a truncated body', () => {
  assert.deepEqual(
    buildAgentFinishedNotificationArgs('Scout', 'scout_ab12', 'All done.'),
    ['notification', 'show', 'Pi · Scout finished', '--body', 'All done.'],
  );

  const long = 'x'.repeat(500);
  const args = buildAgentFinishedNotificationArgs('Scout', 'scout', long);
  const body = args.at(-1)!;
  assert.equal(body.length, 401); // 400 chars + ellipsis
  assert.ok(body.endsWith('…'));
  assert.deepEqual(
    buildAgentFinishedNotificationArgs('Scout', 'scout', '   '),
    [
      'notification',
      'show',
      'Pi · Scout finished',
      '--body',
      'scout finished with an empty result.',
    ],
  );
});
