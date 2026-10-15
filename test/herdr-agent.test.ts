import assert from 'node:assert/strict';

import { test, vi } from 'vitest';

import { readAgent, startAgent } from '../src/herdr/agent.ts';
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

test('readAgent retries once with the visible source when the history is unavailable', async () => {
  const controller = new AbortController();
  const calls: Array<{ args: string[]; signal?: AbortSignal }> = [];
  const exec = vi
    .spyOn(cli, 'execHerdr')
    .mockImplementation(async (args, signal) => {
      calls.push({ args, signal });
      if (calls.length === 1) {
        throw new cli.HerdrCliError('agent is working', 'agent_not_idle', args);
      }
      return 'visible transcript';
    });
  try {
    assert.equal(
      await readAgent('Scout', controller.signal),
      'visible transcript',
    );
  } finally {
    exec.mockRestore();
  }

  assert.deepEqual(
    calls.map((call) => call.args),
    [
      [
        'agent',
        'read',
        'Scout',
        '--source',
        'recent-unwrapped',
        '--lines',
        '180',
      ],
      ['agent', 'read', 'Scout', '--source', 'visible'],
    ],
  );
  assert.equal(calls[0]!.signal, controller.signal);
  assert.equal(calls[1]!.signal, controller.signal);
});

for (const [label, makeFailure] of [
  [
    'a different Herdr error code',
    () => new cli.HerdrCliError('unknown agent', 'agent_not_found', []),
  ],
  ['a non-Herdr failure', () => new Error('herdr exploded')],
] as const) {
  test(`readAgent propagates ${label} without retrying`, async () => {
    const exec = vi.spyOn(cli, 'execHerdr').mockImplementation(async () => {
      throw makeFailure();
    });
    try {
      await assert.rejects(readAgent('Scout'), makeFailure().constructor);
      assert.equal(exec.mock.calls.length, 1);
      assert.equal(exec.mock.calls[0]![0][3], '--source');
      assert.equal(exec.mock.calls[0]![0][4], 'recent-unwrapped');
    } finally {
      exec.mockRestore();
    }
  });
}

test('readAgent propagates a failure of the visible fallback', async () => {
  const exec = vi.spyOn(cli, 'execHerdr').mockImplementation(async (args) => {
    throw new cli.HerdrCliError('agent is working', 'agent_not_idle', args);
  });
  try {
    await assert.rejects(readAgent('Scout'), {
      name: 'HerdrCliError',
      message: 'agent is working',
    });
    assert.deepEqual(
      exec.mock.calls.map(([args]) => args),
      [
        [
          'agent',
          'read',
          'Scout',
          '--source',
          'recent-unwrapped',
          '--lines',
          '180',
        ],
        ['agent', 'read', 'Scout', '--source', 'visible'],
      ],
    );
  } finally {
    exec.mockRestore();
  }
});
