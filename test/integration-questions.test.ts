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
    assert.equal(question.customType, 'herdr_agent_question');
    assert.match(question.content, /Cookie session or JWT\?/);
    assert.match(question.content, /tabLabel "Scout"/);

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

    const answered = await harness.call({
      agent: 'scout',
      task: 'Use the cookie session',
      tabLabel: 'Scout',
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
      tabLabel: 'Scout Detached',
    });
    await harness.collect('Scout Detached');

    await harness.waitFor(
      () => harness.messages.length > 0,
      'detached question delivery',
    );

    const [message] = harness.messages;
    assert.equal(message?.customType, 'herdr_agent_question');
    assert.match(message?.content ?? '', /Which module first\?/);
    assert.equal(message?.details.tabLabel, 'Scout Detached');
    // Still open and reusable by label.
    assert.equal(harness.fake.panes.length, 2);
    const record = Object.values((await harness.readState()).agents)[0];
    assert.equal(record?.detached, undefined);
    assert.equal(record?.tabLabel, 'Scout Detached');
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
    const second = await harness.call({
      agent: 'scout',
      task: 'Approach B',
      tabLabel: 'Scout',
    });

    assert.equal(second.details.reused, true);
    assert.match(second.content[0].text, /^Answer sent to Herdr agent Scout /);
    assert.doesNotMatch(second.content[0].text, /Which approach?/);
    const secondDelivery = await harness.collect('Scout');
    assert.match(secondDelivery.content, /SECOND TURN RESULT/);
    assert.doesNotMatch(secondDelivery.content, /Which approach?/);
  });
});

test('a resumed one-shot can ask a question and be answered by label', async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: 'scout',
      task: 'first',
      tabLabel: 'Scout Resume',
    });
    await harness.collect('Scout Resume');
    harness.fake.setBehavior(() => ({ question: 'Which module?' }));
    const asked = await harness.call({
      agent: 'scout',
      task: 'continue',
      tabLabel: 'Scout Resume',
      resumeClosed: true,
    });
    const question = await harness.collect('Scout Resume');
    assert.equal(question.customType, 'herdr_agent_question');
    assert.equal(asked.details.resumed, true);

    harness.fake.setBehavior(() => ({ result: 'answered' }));
    const answered = await harness.call({
      agent: 'scout',
      task: 'the auth module',
      tabLabel: 'Scout Resume',
    });
    const answeredDelivery = await harness.collect('Scout Resume');
    assert.equal(answered.details.reused, true);
    assert.match(answeredDelivery.content, /answered/);
  });
});
