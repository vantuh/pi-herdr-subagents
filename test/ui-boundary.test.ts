import assert from 'node:assert/strict';

import { test } from 'vitest';

import { createHarness } from '../test-support/harness.ts';

for (const mode of ['rpc', 'json', 'print'] as const) {
  test(`${mode} has no detached collector or terminal overlay`, async () => {
    const harness = await createHarness({ mode, hasUI: mode === 'rpc' });
    try {
      await harness.fire('session_start');
      await harness.runCommand('agents');
      assert.match(
        harness.notifications.at(-1)?.message ?? '',
        /requires TUI mode/,
      );
      assert.deepEqual(harness.userMessages, []);

      const calls: Array<[string, Record<string, unknown>]> = [
        ['agent_spawn', { agent: 'scout', task: 'Find it' }],
        ['agent_send', { name: 'Scout', message: 'Go' }],
        ['agent_stop', { name: 'Scout' }],
        ['agent_status', { name: 'Scout' }],
        ['agent_status', {}],
      ];
      for (const [tool, params] of calls) {
        const rejected = await harness.callTool(tool, params);
        assert.equal(rejected.isError, true, tool);
        assert.match(rejected.content[0].text, /requires TUI mode/, tool);
      }
      assert.equal(harness.fake.calls.length, 0);
      assert.equal(harness.widgets.size, 0);
      assert.deepEqual(harness.messages, []);
    } finally {
      await harness.dispose();
    }
  });
}
