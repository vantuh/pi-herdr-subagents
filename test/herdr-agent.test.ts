import assert from 'node:assert/strict';

import { test, vi } from 'vitest';

import { startAgent } from '../src/herdr/agent.ts';
import * as cli from '../src/herdr/cli.ts';

for (const code of ['agent_pane_busy', 'agent_kind_mismatch']) {
  test(`startAgent preserves cancellation errors during ${code} retry delays`, async () => {
    const controller = new AbortController();
    const exec = vi.spyOn(cli, 'execHerdr').mockImplementation(async (args) => {
      if (args[1] === 'start') {
        if (code === 'agent_pane_busy') {
          setImmediate(() => controller.abort());
        }
        throw new cli.HerdrCliError('not ready', code, args);
      }
      assert.equal(args[1], 'get');
      setImmediate(() => controller.abort());
      return JSON.stringify({
        result: { agent: { agent: 'shell', agent_status: 'working' } },
      });
    });
    try {
      await assert.rejects(startAgent('scout', 'pane', [], controller.signal), {
        name: 'Error',
        message: 'Aborted',
      });
      assert.equal(
        exec.mock.calls.filter(([args]) => args[1] === 'start').length,
        1,
      );
    } finally {
      exec.mockRestore();
    }
  });
}
