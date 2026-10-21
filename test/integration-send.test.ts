import assert from 'node:assert/strict';

import { test } from 'vitest';

import { withHarness } from '../test-support/integration-harness.ts';

/**
 * `agent_send` dispatch order: a live agent with a parked question takes the
 * message as its answer; any other live agent gets it as a steer; a closed
 * one-shot of this session resumes; anything else is an unknown name.
 * `agent_spawn` never reaches an existing agent.
 */

test('agent_send answers a parked question before it considers a steer', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior((turn) =>
      turn.turn === 1
        ? { question: 'Which color?', controlAck: 'queued' }
        : { result: 'green', controlAck: 'queued' },
    );
    await harness.call({ agent: 'scout', task: 'Choose', name: 'Scout Q' });
    await harness.collect('Scout Q');

    const answered = await harness.callTool('agent_send', {
      name: 'Scout Q',
      message: 'green',
    });

    assert.equal(answered.isError, undefined);
    assert.equal(answered.details.reused, true);
    assert.equal(answered.details.action, undefined);
    assert.equal(harness.fake.callsMatching('agent', 'start').length, 1);
    assert.equal(harness.fake.callsMatching('agent', 'prompt').length, 2);
    assert.match((await harness.collect('Scout Q')).content, /green/);
  });
});

test('agent_send steers a live working agent', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({
      neverSettle: true,
      controlAck: 'queued',
    }));
    await harness.call({ agent: 'scout', task: 'Long', name: 'Scout W' });

    const steered = await harness.callTool('agent_send', {
      name: 'Scout W',
      message: 'use the cache',
    });

    assert.equal(steered.isError, undefined);
    assert.equal(steered.details.action, 'steer');
    assert.equal(steered.details.status, 'queued');
    assert.equal(harness.fake.callsMatching('agent', 'prompt').length, 1);
  });
});

test('agent_send refuses a settled live agent whose result is pending', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({ neverSettle: true, controlAck: 'idle' }));
    await harness.call({ agent: 'scout', task: 'Long', name: 'Scout S' });

    const refused = await harness.callTool('agent_send', {
      name: 'Scout S',
      message: 'anything?',
    });

    assert.equal(refused.details.status, 'idle');
    assert.match(refused.content[0].text, /result arrives automatically/);
    assert.equal(harness.fake.callsMatching('agent', 'prompt').length, 1);
  });
});

test('agent_send refuses to steer a live agent owned by another session', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({
      neverSettle: true,
      controlAck: 'queued',
    }));
    await harness.call({ agent: 'scout', task: 'Long', name: 'Scout F' });
    await harness.updateState((state) => {
      for (const record of Object.values(state.agents)) {
        record.ownerSessionId = 'another-orchestrator-session';
      }
    });

    const refused = await harness.callTool('agent_send', {
      name: 'Scout F',
      message: 'steal',
    });

    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /not owned by this Orchestrator/);
  });
});

test('agent_send resumes a closed agent with the profile stored in its record', async () => {
  await withHarness(
    { profiles: [{ name: 'scout' }, { name: 'worker' }] },
    async (harness) => {
      await harness.call({ agent: 'worker', task: 'first', name: 'Closed W' });
      await harness.collect('Closed W');

      const resumed = await harness.callTool('agent_send', {
        name: 'Closed W',
        message: 'again',
      });

      assert.equal(resumed.isError, undefined);
      assert.equal(resumed.details.resumed, true);
      assert.equal(resumed.details.agent.name, 'worker');
      assert.equal(harness.fake.callsMatching('agent', 'start').length, 2);
    },
  );
});

test('agent_send to an unknown name starts nothing', async () => {
  await withHarness({}, async (harness) => {
    const result = await harness.callTool('agent_send', {
      name: 'Nobody',
      message: 'hello',
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /No agent named "Nobody"/);
    assert.deepEqual(harness.fake.callsMatching('agent', 'start'), []);
  });
});

test('agent_spawn refuses a name that matches a live agent, even one with a parked question', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({ question: 'Which color?' }));
    await harness.call({ agent: 'scout', task: 'Choose', name: 'Scout P' });
    await harness.collect('Scout P');
    const prompts = harness.fake.callsMatching('agent', 'prompt').length;

    const refused = await harness.call({
      agent: 'scout',
      task: 'new work',
      name: 'Scout P',
    });

    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /Use agent_send with that name/);
    assert.equal(harness.fake.callsMatching('agent', 'start').length, 1);
    assert.equal(harness.fake.callsMatching('agent', 'prompt').length, prompts);
  });
});

test('agent_spawn without a name never reuses a live agent of the same role', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior((turn) =>
      turn.turn === 1 ? { question: 'Which color?' } : { neverSettle: true },
    );
    await harness.call({ agent: 'scout', task: 'Choose' });
    await harness.collect('Scout');

    const second = await harness.call({ agent: 'scout', task: 'Other work' });

    assert.equal(second.isError, undefined);
    assert.equal(second.details.reused, false);
    assert.equal(second.details.name, 'Scout #2');
    assert.equal(harness.fake.callsMatching('agent', 'start').length, 2);
  });
});
