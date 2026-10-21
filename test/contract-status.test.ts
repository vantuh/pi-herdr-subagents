import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  AGENT_QUESTION_MESSAGE_TYPE,
  AGENT_RESULT_MESSAGE_TYPE,
} from '../src/ui/renderers.ts';
import { withHarness } from '../test-support/contract-harness.ts';

/**
 * Status and detached delivery: exact status text, argument guards and the
 * warnings that ride along with a delivered result.
 */

test('a status check reports status and does not prompt, wait, or close', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({ neverSettle: true }));
    const started = await harness.callRaw({
      agent: 'scout',
      task: 'long',
      name: 'Scout RW',
    });
    assert.match(started.content[0].text, /Do not check its status/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const before = harness.fake.calls.length;

    const result = await harness.callTool('agent_status', { name: 'Scout RW' });

    assert.equal(result.isError, undefined);
    assert.equal(result.details.status, 'working');
    assert.match(result.content[0].text, /status: working/);
    assert.match(result.content[0].text, /Do not check its status/);
    const after = harness.fake.calls.slice(before);
    assert.deepEqual(
      after.filter((argv) =>
        ['prompt', 'wait', 'close'].includes(argv[1] ?? ''),
      ),
      [],
    );
    const record = Object.values((await harness.readState()).agents)[0];
    assert.equal(record?.detached, true);
  });
});

test('agent_send to an unknown name reports it and starts nothing', async () => {
  await withHarness({}, async (harness) => {
    const result = await harness.callTool('agent_send', {
      name: 'Ghost',
      message: 'Go',
    });

    assert.equal(result.isError, true);
    assert.match(
      result.content[0].text,
      /No agent named "Ghost" found for this session\. Use agent_spawn to start one\./,
    );
    assert.deepEqual(harness.fake.callsMatching('agent', 'start'), []);
  });
});

test('agent_spawn without agent or task starts nothing', async () => {
  await withHarness({}, async (harness) => {
    const noAgent = await harness.call({ task: 'Go' });
    assert.equal(noAgent.isError, true);
    assert.match(noAgent.content[0].text, /agent is required\./);

    const noTask = await harness.call({ agent: 'scout', task: '  ' });
    assert.equal(noTask.isError, true);
    assert.match(noTask.content[0].text, /task is required\./);
    assert.deepEqual(harness.fake.callsMatching('agent', 'start'), []);
  });
});

test('agent_send requires a name and a message and starts nothing', async () => {
  await withHarness({}, async (harness) => {
    const noMessage = await harness.callTool('agent_send', {
      name: 'Scout Resume',
      message: ' ',
    });
    assert.equal(noMessage.isError, true);
    assert.match(noMessage.content[0].text, /message is required\./);

    const noName = await harness.callTool('agent_send', {
      name: '',
      message: 'continue',
    });
    assert.equal(noName.isError, true);
    assert.match(noName.content[0].text, /name is required\./);
    assert.deepEqual(harness.fake.callsMatching('agent', 'start'), []);
  });
});

test('agent_status does not resume a closed agent', async () => {
  await withHarness({}, async (harness) => {
    await harness.call({ agent: 'scout', task: 'one', name: 'Scout Closed' });
    await harness.collect('Scout Closed');
    const starts = harness.fake.callsMatching('agent', 'start').length;

    const result = await harness.callTool('agent_status', {
      name: 'Scout Closed',
    });
    assert.equal(result.isError, true);
    assert.match(
      result.content[0].text,
      /No running agent named "Scout Closed"/,
    );
    assert.equal(harness.fake.callsMatching('agent', 'start').length, starts);
  });
});

test('delivers a detached one-shot result and closes the agent', async () => {
  await withHarness({}, async (harness) => {
    await harness.callRaw({
      agent: 'scout',
      task: 'background',
      name: 'Scout Detached',
    });

    await harness.waitFor(
      () => harness.messages.length > 0,
      'detached one-shot delivery',
    );

    const [message] = harness.messages;
    assert.equal(message?.customType, AGENT_RESULT_MESSAGE_TYPE);
    assert.equal(message?.details.lifecycle, undefined);
    // A one-shot is closed by delivery, and its record is pruned.
    assert.equal(harness.fake.panes.length, 1);
    assert.deepEqual(
      harness.fake.callsMatching('pane', 'close').length > 0,
      true,
    );
    assert.deepEqual((await harness.readState()).agents, {});
  });
});

test('keeps spawn warnings visible through detached delivery', async () => {
  await withHarness(
    {
      profiles: [
        {
          name: 'worker',
          thinking: 'sideways',
          skills: ['ghost-skill'],
          body: 'BODY',
        },
      ],
    },
    async (harness) => {
      const started = await harness.call({
        agent: 'worker',
        task: 'background',
      });
      assert.match(started.content[0].text, /Spawn warnings:/);

      await harness.waitFor(
        () => harness.messages.length > 0,
        'detached warning delivery',
      );
      const delivered = harness.messages[0];
      assert.match(delivered?.content ?? '', /Spawn warnings:/);
      assert.match(
        String(delivered?.details.result ?? ''),
        /Skills not found: ghost-skill/,
      );
    },
  );
});

test('keeps spawn warnings out of a detached question body', async () => {
  await withHarness(
    {
      profiles: [
        {
          name: 'worker',
          skills: ['ghost-skill'],
          body: 'BODY',
        },
      ],
    },
    async (harness) => {
      harness.fake.setBehavior(() => ({ question: 'Which module first?' }));

      await harness.call({ agent: 'worker', task: 'background' });

      await harness.waitFor(
        () => harness.messages.length > 0,
        'detached question warning delivery',
      );
      const delivered = harness.messages[0];
      assert.equal(delivered?.customType, AGENT_QUESTION_MESSAGE_TYPE);
      assert.equal(delivered?.details.question, 'Which module first?');
      assert.deepEqual(delivered?.details.spawnWarnings, [
        'Skills not found: ghost-skill.',
      ]);
      assert.match(delivered?.content ?? '', /Spawn warnings:/);
      assert.match(delivered?.content ?? '', /Which module first\?/);
    },
  );
});

test('keeps the claim when a detached agent settles with nothing to deliver', async () => {
  // Without an artifact there is no usable result, so the flag stays set and
  // the status check reports the agent as finished without a result.
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({}));
    await harness.call({
      agent: 'scout',
      task: 'background',
      name: 'Scout Silent',
    });

    await harness.waitFor(async () => {
      const record = Object.values((await harness.readState()).agents)[0];
      return record?.detached === true && harness.fake.panes.length === 2;
    }, 'agent settled while still claimed');

    // Give the poller a couple of ticks to prove it stays quiet.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.deepEqual(harness.messages, []);
    const record = Object.values((await harness.readState()).agents)[0];
    assert.equal(record?.detached, true);
  });
});
