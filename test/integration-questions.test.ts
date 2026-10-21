import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

import { test } from 'vitest';

import { withHarness } from '../test-support/integration-harness.ts';

/**
 * Child questions: the parked one-shot, detached question delivery and
 * answering a reused agent by label.
 */

test('returns a child question early, keeps the one-shot parked, and answers it by label', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior((turn) =>
      turn.turn === 1
        ? { question: 'Cookie session or JWT?' }
        : { result: 'Answered: cookie session' },
    );

    const asked = await harness.call({ agent: 'scout', task: 'Find auth' });
    assert.match(asked.content[0].text, /started/);
    const question = await harness.collect('Scout');
    assert.equal(question.customType, 'agent_question');
    assert.match(question.content, /Cookie session or JWT\?/);
    assert.match(question.content, /name "Scout"/);

    // Parked, not closed: pane and state record survive.
    assert.equal(harness.fake.panes.length, 2);
    const parked = Object.values((await harness.readState()).agents)[0];
    assert.equal(parked?.tabLabel, 'Scout');
    const questionFile = parked?.resultFile?.replace(
      /result\.md$/,
      'question.md',
    );
    assert.ok(questionFile);
    assert.ok(await fs.stat(questionFile).catch(() => null));

    const answered = await harness.callTool('agent_send', {
      name: 'Scout',
      message: 'Use the cookie session',
    });

    assert.equal(answered.details.reused, true);
    const answeredDelivery = await harness.collect('Scout');
    assert.match(answeredDelivery.content, /Answered: cookie session/);
    // The parked one-shot was reused, not duplicated.
    assert.equal(harness.fake.callsMatching('pane', 'split').length, 1);
    assert.equal(harness.fake.callsMatching('agent', 'prompt').length, 2);
    assert.deepEqual(
      harness.fake.panes.map((pane) => pane.pane_id),
      [harness.fake.orchestratorPane.pane_id],
    );
    assert.equal(await fs.stat(questionFile).catch(() => null), null);
  });
});

test('delivers a detached question without closing the agent', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({ question: 'Which module first?' }));

    await harness.call({
      agent: 'scout',
      task: 'Background job',
      name: 'Scout Detached',
    });
    await harness.collect('Scout Detached');

    await harness.waitFor(
      () => harness.messages.length > 0,
      'detached question delivery',
    );

    const [message] = harness.messages;
    assert.equal(message?.customType, 'agent_question');
    assert.match(message?.content ?? '', /Which module first\?/);
    assert.equal(message?.details.name, 'Scout Detached');
    // Still open and reusable by label.
    assert.equal(harness.fake.panes.length, 2);
    const record = Object.values((await harness.readState()).agents)[0];
    assert.equal(record?.detached, undefined);
    assert.equal(record?.tabLabel, 'Scout Detached');
  });
});

test('does not re-deliver the answered question or lose the result that follows it', async () => {
  // The answer path re-arms delivery, then clears the previous turn's artifacts
  // and prompts. A poller tick that lands between those two steps sees an armed
  // record beside the stale question, claims the run for it, re-delivers the
  // question and swallows the real result.
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior((turn) =>
      turn.prompt.includes('Stay working')
        ? { neverSettle: true }
        : turn.turn === 1
          ? { question: 'Which token?' }
          : { result: 'LIVE_ANSWER_20261021\n\nAGENT_RESULT: done' },
    );

    await harness.call({ agent: 'scout', task: 'Smoke the answer path' });
    const asked = await harness.collect('Scout');
    assert.equal(asked.customType, 'agent_question');
    // A second pane-layout agent makes the answer path rebalance the layout.
    await harness.call({
      agent: 'scout',
      task: 'Stay working',
      name: 'Other',
    });
    const before = harness.messages.length;

    // `layout.export` is the first Herdr call after the record is re-armed, so
    // holding it pins the answer path inside the window for a full tick.
    harness.fake.holdApi('layout.export');
    const answering = harness.callTool('agent_send', {
      name: 'Scout',
      message: 'Return exact token LIVE_ANSWER_20261021',
    });
    // Stays handled in case an assertion below abandons it mid-flight.
    void answering.catch(() => {});
    await harness.waitFor(async () => {
      const record = Object.values((await harness.readState()).agents).find(
        (item) => item.tabLabel === 'Scout',
      );
      return record?.detached === true;
    }, 'the answer path to re-arm delivery');
    const rearmed = Object.values((await harness.readState()).agents).find(
      (item) => item.tabLabel === 'Scout',
    );
    assert.ok(rearmed?.automationName);

    // A poller pass inspects the re-armed agent through `agent get`; that call
    // landing while `layout.export` is still held proves the pass ran inside
    // the window. Scout is the only settled agent, so the baseline count is
    // what separates this pass from the one that delivered the question.
    const inspected = () =>
      harness.fake.calls.filter(
        (argv) =>
          argv[0] === 'agent' &&
          argv[1] === 'get' &&
          argv[2] === rearmed?.automationName,
      ).length;
    const baseline = inspected();
    await harness.waitFor(
      () => inspected() > baseline,
      'a poller pass over the re-armed agent',
    );
    const reDelivered = harness.messages
      .slice(before)
      .filter((message) => message.customType === 'agent_question');
    harness.fake.releaseCommands();
    assert.deepEqual(
      reDelivered.map((message) => message.content),
      [],
      'the answered question must not be delivered again',
    );

    const answered = await answering;
    assert.match(answered.content[0].text, /^Answer sent to agent Scout /);

    const delivered = await harness.collect('Scout');
    assert.equal(delivered.customType, 'agent_result');
    assert.match(delivered.content, /LIVE_ANSWER_20261021/);
    // Delivered once: the one-shot closed and its history was archived.
    assert.deepEqual(
      harness.messages
        .slice(before)
        .filter((message) => message.customType === 'agent_result')
        .map((message) => message.details.name),
      ['Scout'],
    );
    assert.equal(
      harness.fake.panes.some((pane) => pane.pane_id === asked.details.paneId),
      false,
    );
    assert.equal(
      (await harness.readState()).closedHistory[0]?.tabLabel,
      'Scout',
    );
  });
});

test("does not accept a reused agent's previous settled state as this turn's result", async () => {
  // A parked one-shot still exposes its prior idle/done status, and the
  // old artifact is still on disk until this prompt clears it. Reuse happens
  // on the answer-by-label path now.
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior((turn) =>
      turn.turn === 1
        ? { question: 'Which approach?' }
        : // Keep reporting the first turn's idle + seq for a while.
          { result: 'SECOND TURN RESULT', staleWindowMs: 400 },
    );

    await harness.call({ agent: 'scout', task: 'one' });
    const firstDelivery = await harness.collect('Scout');
    assert.match(firstDelivery.content, /Which approach?/);
    const second = await harness.callTool('agent_send', {
      name: 'Scout',
      message: 'Approach B',
    });

    assert.equal(second.details.reused, true);
    assert.match(second.content[0].text, /^Answer sent to agent Scout /);
    assert.doesNotMatch(second.content[0].text, /Which approach?/);
    const secondDelivery = await harness.collect('Scout');
    assert.match(secondDelivery.content, /SECOND TURN RESULT/);
    assert.doesNotMatch(secondDelivery.content, /Which approach?/);
  });
});

test('a resumed one-shot can ask a question and be answered by label', async () => {
  await withHarness({}, async (harness) => {
    await harness.call({ agent: 'scout', task: 'first', name: 'Scout Resume' });
    await harness.collect('Scout Resume');
    harness.fake.setBehavior(() => ({ question: 'Which module?' }));
    const asked = await harness.callTool('agent_send', {
      message: 'continue',
      name: 'Scout Resume',
    });
    const question = await harness.collect('Scout Resume');
    assert.equal(question.customType, 'agent_question');
    assert.equal(asked.details.resumed, true);

    harness.fake.setBehavior(() => ({ result: 'answered' }));
    const answered = await harness.callTool('agent_send', {
      name: 'Scout Resume',
      message: 'the auth module',
    });
    const answeredDelivery = await harness.collect('Scout Resume');
    assert.equal(answered.details.reused, true);
    assert.match(answeredDelivery.content, /answered/);
  });
});
