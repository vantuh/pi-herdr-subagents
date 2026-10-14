import assert from 'node:assert/strict';
import { test } from 'vitest';

import { createHarness } from '../test-support/harness.ts';

for (const mode of ['rpc', 'json', 'print'] as const) {
  test(`${mode} has no detached collector or terminal overlay`, async () => {
    const harness = await createHarness({ mode, hasUI: mode === 'rpc' });
    try {
      await harness.fire('session_start');
      await harness.runCommand('herdr-agents');
      assert.match(
        harness.notifications.at(-1)?.message ?? '',
        /requires TUI mode/,
      );
      await harness.runCommand('council', 'Compare approaches.');
      assert.match(
        harness.notifications.at(-1)?.message ?? '',
        /requires TUI mode/,
      );
      assert.deepEqual(harness.userMessages, []);

      for (const task of ['Find it', undefined]) {
        const rejected = await harness.callRaw({
          agent: 'scout',
          tabLabel: 'Scout',
          task,
          wait: false,
        });
        assert.equal(rejected.isError, true);
        assert.match(
          rejected.content[0].text,
          /Non-TUI sessions require wait: true/,
        );
      }
      assert.equal(harness.fake.calls.length, 0);
      assert.equal(harness.widgets.size, 0);

      const completed = await harness.callRaw({
        agent: 'scout',
        task: 'Find it',
      });
      assert.equal(completed.details.waited, true);
      assert.equal(completed.details.closed, true);
      assert.equal(harness.widgets.size, 0);
      assert.deepEqual(harness.messages, []);
    } finally {
      await harness.dispose();
    }
  });
}
