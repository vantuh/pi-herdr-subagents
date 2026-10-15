import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

import { test } from 'vitest';

import { withHarness } from '../test-support/contract-harness.ts';

/**
 * Result contract: `details`, content text, and every failure that surfaces
 * as a thrown error.
 */

test('a successful one-shot reports the full details contract', async () => {
  await withHarness({}, async (harness) => {
    const result = await harness.call({ agent: 'scout', task: 'Find it' });

    assert.deepEqual(Object.keys(result.details).sort(), [
      'agent',
      'paneId',
      'reused',
      'tabId',
      'tabLabel',
    ]);
    assert.equal(result.details.tabLabel, 'Scout');
    assert.match(result.content[0].text, /started/);
    // The agent profile travels back whole, not just by name.
    assert.equal(result.details.agent.name, 'scout');
    assert.equal(result.details.agent.source, 'project');
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, 'text');
  });
});

test('status check reports status only and never reads the pane', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({}));
    await harness.call({ agent: 'scout', task: 'Find it', tabLabel: 'Scout' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const status = await harness.call({ agent: 'scout', tabLabel: 'Scout' });

    assert.equal(
      status.content[0].text,
      'Herdr agent Scout (w1:p2) finished without a result.',
    );
    assert.deepEqual(harness.fake.callsMatching('agent', 'read'), []);

    // The child writes its assistant text before the turn ends, so a status
    // check previews it verbatim under an explicit non-completion header.
    const record = Object.values((await harness.readState()).agents)[0];
    assert.ok(record?.resultFile);
    await fs.writeFile(
      record.resultFile,
      'Working on the status path.\n\n• bullet kept\n────',
    );
    const previewed = await harness.call({ agent: 'scout', tabLabel: 'Scout' });

    assert.equal(
      previewed.content[0].text,
      'Herdr agent Scout (w1:p2) status: idle.\n\n' +
        'Latest assistant text (preview; not a completion):\n' +
        'Working on the status path.\n\n• bullet kept\n────',
    );
  });
});

test("keeps the child's output when closing its pane fails", async () => {
  // Losing a collected result because cleanup failed would be the worst
  // possible trade, so the warning is appended instead of replacing it.
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({ result: 'PRECIOUS RESULT' }));
    harness.fake.failCommand('pane close', 'pane_close_failed');

    const started = await harness.call({ agent: 'scout', task: 'Find it' });
    assert.equal(started.isError, undefined);
    const delivered = await harness.collect('Scout');

    assert.match(delivered.content, /PRECIOUS RESULT/);
    assert.match(delivered.content, /Warning: failed to close one-shot/);
    // The pane is still there, so it stays visible to the user and the widget.
    assert.equal(harness.fake.panes.length, 2);
  });
});

test('reports malformed Herdr output with the command and the payload', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.malformCommand('pane split', '<html>nope</html>');

    await assert.rejects(
      () => harness.call({ agent: 'scout', task: 'Find it' }),
      (error: unknown) => {
        assert.match(String(error), /Malformed Herdr pane split output/);
        assert.match(String(error), /<html>nope<\/html>/);
        return true;
      },
    );
  });
});

test('reports a pane split that returns no pane id', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.malformCommand('pane split', JSON.stringify({ result: {} }));

    await assert.rejects(
      () => harness.call({ agent: 'scout', task: 'Find it' }),
      (error: unknown) => {
        assert.match(String(error), /missing result\.pane\.pane_id/);
        return true;
      },
    );
  });
});

test('reports a malformed snapshot instead of guessing the current pane', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.malformCommand(
      'api snapshot',
      JSON.stringify({ result: { snapshot: { panes: [] } } }),
    );

    await assert.rejects(
      () => harness.call({ agent: 'scout', task: 'Find it' }),
      (error: unknown) => {
        assert.match(String(error), /Malformed Herdr api snapshot response/);
        return true;
      },
    );
  });
});

test('rejects a snapshot whose pane has a wrongly typed known field', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.malformCommand(
      'api snapshot',
      JSON.stringify({
        result: {
          snapshot: {
            panes: [
              {
                pane_id: 'w1:p1',
                tab_id: 'w1:t1',
                workspace_id: 'w1',
                focused: 'yes',
              },
            ],
            tabs: [],
          },
        },
      }),
    );

    await assert.rejects(
      () => harness.call({ agent: 'scout', task: 'Find it' }),
      (error: unknown) => {
        assert.match(String(error), /Malformed Herdr api snapshot response/);
        return true;
      },
    );
  });
});

test('refuses to work when it cannot identify its own pane', async () => {
  await withHarness({ paneIdEnv: 'w1:does-not-exist' }, async (harness) => {
    // Nothing focused either, so there is no fallback.
    harness.fake.orchestratorPane.focused = false;
    harness.fake.focusedPaneId = '';

    await assert.rejects(
      () => harness.call({ agent: 'scout', task: 'Find it' }),
      (error: unknown) => {
        assert.match(String(error), /Could not find current Herdr pane/);
        return true;
      },
    );
    assert.deepEqual(harness.fake.callsMatching('pane', 'split'), []);
  });
});

test('runs the whole flow even when the state file is unusable', async () => {
  // State is bookkeeping: a failed save must not abort the spawn. The poller
  // can only deliver an agent it recorded, so the result stays in the artifact.
  await withHarness({}, async (harness) => {
    await fs.mkdir(harness.statePath, { recursive: true });

    const result = await harness.call({ agent: 'scout', task: 'Find it' });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /started/);
    const prompt =
      harness.fake.callsMatching('agent', 'prompt').at(-1)?.[3] ?? '';
    const resultFile = /^HERDR_RESULT_FILE:\s*(.+)$/m.exec(prompt)?.[1]?.trim();
    assert.ok(resultFile);
    await harness.waitFor(async () => {
      try {
        return /Result from scout_/.test(await fs.readFile(resultFile, 'utf8'));
      } catch {
        return false;
      }
    }, 'child result artifact');
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(harness.messages.length, 0);
  });
});
