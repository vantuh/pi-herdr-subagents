import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { test } from 'vitest';

import {
  isAgentResultInterrupted,
  readAgentQuestion,
  readAgentResult,
  readAgentSessionMeta,
} from '../src/artifacts.ts';
import { execHerdrApi } from '../src/herdr/cli.ts';
import { exportPaneLayout } from '../src/herdr/layout.ts';
import { loadCurrentAgents } from '../src/ui/poller.ts';
import {
  createE2eHarness,
  type E2eHarness,
} from '../test-support/e2e-harness.ts';
import {
  DEFAULT_RESULT_TEXT,
  isToolFollowUp,
  lastUserText,
  offeredTools,
} from '../test-support/mock-llm.ts';

/**
 * End-to-end flows against a real Herdr server with real Pi children.
 * Slow by nature (each scenario boots a server and one or more Pi processes);
 * run with `npm run test:e2e`.
 */

async function withE2e(
  options: Parameters<typeof createE2eHarness>[0],
  body: (harness: E2eHarness) => Promise<void>,
): Promise<void> {
  const harness = await createE2eHarness(options);
  try {
    await body(harness);
  } finally {
    await harness.dispose();
  }
}

test('spawns a real Pi child in a real pane, collects its result and closes the pane', async () => {
  await withE2e({}, async (harness) => {
    const before = await harness.snapshot();
    assert.equal(before.panes.length, 1);

    const result = await harness.call({
      agent: 'scout',
      task: 'Report the magic word.',
    });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /started/);
    const delivered = await harness.collect('Scout', 60000);
    assert.match(delivered.content, /MOCK_CHILD_OK/);

    // The child really was a Pi process talking to the model.
    assert.ok(harness.llm.requests.length >= 1);
    const prompt = harness.llm.requestsMentioning('Report the magic word.');
    assert.equal(prompt.length, 1);

    // The pane is gone again.
    const after = await harness.snapshot();
    assert.deepEqual(
      after.panes.map((pane) => pane.pane_id),
      [harness.orchestratorPaneId],
    );
    assert.deepEqual((await harness.readState()).agents, {});
  });
});

test('collects a working child across an isolated live server handoff without losing managed state', async () => {
  await withE2e({}, async (harness) => {
    const replies = Promise.withResolvers<void>();
    harness.llm.setScript(async () => {
      await replies.promise;
      return { text: 'HANDOFF_FINAL', delayMs: 0 };
    });
    const outcome = harness
      .call({ agent: 'scout', task: 'HANDOFF_TASK', name: 'Handoff Child' })
      .then(
        (result) => ({ result }),
        (error: Error) => ({ error }),
      );
    try {
      await harness.waitFor(
        () => harness.llm.requests.length === 1,
        'working handoff child',
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      const before = await harness.snapshot();
      const stateBefore = await harness.readState();
      const recordBefore = Object.values(stateBefore.agents)[0];
      assert.ok(recordBefore);
      const sessionBefore = await readAgentSessionMeta(recordBefore.resultFile);
      assert.ok(sessionBefore?.sessionId);
      assert.deepEqual(
        await execHerdrApi(
          'server.live_handoff',
          {
            expected_version: before.version,
          },
          AbortSignal.timeout(15000),
        ),
        { type: 'ok' },
      );
      const after = await harness.snapshot();
      assert.deepEqual(
        after.panes.map((pane) => pane.pane_id),
        before.panes.map((pane) => pane.pane_id),
      );
      const managed = await loadCurrentAgents();
      assert.equal(managed.length, 1);
      assert.equal(managed[0]?.automationName, recordBefore.automationName);
      assert.equal(
        managed[0]?.terminalId,
        after.panes.find((pane) => pane.pane_id === recordBefore.paneId)
          ?.terminal_id,
      );
      const recordAfter = Object.values((await harness.readState()).agents)[0];
      assert.equal(
        recordAfter?.ownerTerminalId,
        after.panes.find((pane) => pane.pane_id === recordBefore.ownerPaneId)
          ?.terminal_id,
      );
      assert.deepEqual(
        await readAgentSessionMeta(recordBefore.resultFile),
        sessionBefore,
      );
      replies.resolve();
      const started = await outcome;
      if ('error' in started) throw started.error;
      assert.match(started.result.content[0].text, /started/);
      const delivered = await harness.collect('Handoff Child', 60000);
      assert.match(delivered.content, /HANDOFF_FINAL/);
      assert.equal(harness.llm.requests.length, 1);
      assert.equal(harness.messages.length, 1);
      assert.deepEqual((await harness.readState()).agents, {});
    } finally {
      replies.resolve();
      await outcome;
    }
  });
});

test('current Herdr starts Pi with one CLI call during cold-shell initialization', async () => {
  await withE2e({ coldShell: true }, async (harness) => {
    for (let index = 0; index < 3; index++) {
      const created = JSON.parse(
        await harness.herdr([
          'pane',
          'split',
          harness.orchestratorPaneId,
          '--direction',
          'right',
          '--cwd',
          harness.cwd,
          '--env',
          'PI_AGENT_CHILD=1',
          '--env',
          'PROCESS_LAUNCHED_BY_Q=1',
          '--no-focus',
        ]),
      ).result.pane.pane_id;
      await harness.herdr([
        'agent',
        'start',
        `cold_${index}`,
        '--kind',
        'pi',
        '--pane',
        created,
        '--timeout',
        '30000',
        '--',
        '--model',
        'mock/mock-model',
        '--thinking',
        'off',
      ]);
      const agent = JSON.parse(await harness.herdr(['agent', 'get', created]))
        .result.agent;
      assert.equal(agent.agent, 'pi');
      assert.ok(['idle', 'done'].includes(agent.agent_status));
      await harness.herdr(['pane', 'close', created]);
    }
  });
});

test('collects a real fast completion without a duplicate Enter', async () => {
  await withE2e({}, async (harness) => {
    harness.llm.setScript(() => ({ text: DEFAULT_RESULT_TEXT, delayMs: 0 }));
    const result = await harness.call({ agent: 'scout', task: 'Fast result.' });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /started/);
    const delivered = await harness.collect('Scout', 60000);
    assert.match(delivered.content, /MOCK_CHILD_OK/);
    assert.equal(harness.llm.requests.length, 1);
  });
});

test('continues a closed one-shot via agent_send and keeps its context', async () => {
  await withE2e({}, async (harness) => {
    const first = await harness.call({
      agent: 'scout',
      task: 'First slice: count the routers.',
      name: 'Scout E2E',
    });
    assert.match(first.content[0].text, /started/);
    const firstDelivery = await harness.collect('Scout E2E', 60000);
    assert.match(firstDelivery.content, /MOCK_CHILD_OK/);

    const second = await harness.callTool('agent_send', {
      message: 'Second slice: now count the handlers.',
      name: 'Scout E2E',
    });
    assert.equal(second.details.resumed, true);
    await harness.collect('Scout E2E', 60000);

    // The resumed child runs with the archived session, so the second
    // request carries the first turn's history.
    const secondRequest = harness.llm.requestsMentioning(
      'Second slice: now count the handlers.',
    )[0];
    assert.ok(secondRequest, 'expected the second task to reach the model');
    const history = JSON.stringify(secondRequest.messages);
    assert.match(history, /First slice: count the routers\./);

    // The continued one-shot closed again after collection.
    const snapshot = await harness.snapshot();
    assert.deepEqual(
      snapshot.panes.map((pane) => pane.pane_id),
      [harness.orchestratorPaneId],
    );
    assert.deepEqual((await harness.readState()).agents, {});
  });
});

test('keeps a real question agent resumable after its workspace tab is renamed', async () => {
  await withE2e(
    { layout: 'workspace', profiles: [{ name: 'scout', tools: ['read'] }] },
    async (harness) => {
      harness.llm.setScript((body) => {
        if (isToolFollowUp(body)) {
          return { text: "Waiting for the Orchestrator's answer." };
        }
        if (lastUserText(body).includes('ANSWER:')) {
          return { text: DEFAULT_RESULT_TEXT };
        }
        return {
          toolCall: {
            name: 'ask_question',
            args: { question: 'Cookie session or JWT?' },
          },
        };
      });

      const asked = await harness.call({
        agent: 'scout',
        task: 'Find the auth flow.',
      });

      const question = await harness.collect('Scout', 60000);
      assert.equal(question.customType, 'agent_question');
      assert.match(question.content, /Cookie session or JWT\?/);

      // The real child publishes an absolute context sample at its finalized
      // turn, which is what the widget and the manager display.
      await harness.waitFor(async () => {
        const record = Object.values((await harness.readState()).agents)[0];
        return (
          (await readAgentSessionMeta(record?.resultFile))?.context !==
          undefined
        );
      }, 'the child to publish a context sample');
      const liveRecord = Object.values((await harness.readState()).agents)[0];
      const sample = (await readAgentSessionMeta(liveRecord?.resultFile))
        ?.context;
      assert.equal(typeof sample?.tokens, 'number');
      assert.ok((sample?.contextWindow ?? 0) > 0);

      // The restricted profile still got the question channel.
      assert.ok(
        offeredTools(harness.llm.requests[0] ?? {}).includes('ask_question'),
        `expected ask_question in ${JSON.stringify(offeredTools(harness.llm.requests[0] ?? {}))}`,
      );

      // A successful question terminates without a redundant model request.
      assert.equal(harness.llm.requests.length, 1);
      assert.equal((await harness.snapshot()).panes.length, 2);
      await harness.herdr(['tab', 'rename', asked.details.tabId, 'pi']);
      const rewaited = await harness.callTool('agent_status', {
        name: 'Scout',
      });
      assert.equal(rewaited.details.status, 'question');
      assert.equal(rewaited.details.name, 'Scout');

      const answered = await harness.callTool('agent_send', {
        name: 'Scout',
        message: 'ANSWER: cookie session.',
      });

      assert.equal(answered.details.reused, true);
      assert.equal(answered.details.name, 'Scout');
      const answeredDelivery = await harness.collect('Scout', 60000);
      assert.match(answeredDelivery.content, /MOCK_CHILD_OK/);
      assert.equal(harness.llm.requests.length, 2);
      assert.equal(
        (await harness.readState()).closedHistory[0]?.tabLabel,
        'Scout',
      );

      const resumed = await harness.callTool('agent_send', {
        name: 'Scout',
        message: 'ANSWER: verify remembered cookie session.',
      });
      assert.equal(resumed.details.resumed, true);
      await harness.collect('Scout', 60000);
      assert.match(
        JSON.stringify(harness.llm.requests.at(-1)?.messages),
        /ANSWER: cookie session\./,
      );
      assert.deepEqual(
        (await harness.snapshot()).panes.map((pane) => pane.pane_id),
        [harness.orchestratorPaneId],
      );
    },
  );
});

test('stacks two real agent panes into a single right column', async () => {
  await withE2e({}, async (harness) => {
    // Children stall long enough to stay live while the layout is checked.
    harness.llm.setScript(() => ({
      delayMs: 30000,
      text: 'Still working.',
    }));
    // Detached spawns keep both children live while the layout is checked.
    await Promise.all([
      harness.callRaw({ agent: 'scout', task: 'one', name: 'Scout One' }),
      harness.callRaw({ agent: 'scout', task: 'two', name: 'Scout Two' }),
    ]);

    const snapshot = await harness.snapshot();
    assert.equal(snapshot.panes.length, 3);
    // All three live in the Orchestrator's tab: one column, not extra tabs.
    assert.equal(new Set(snapshot.panes.map((pane) => pane.tab_id)).size, 1);

    const layout = await exportPaneLayout(harness.orchestratorPaneId);
    assert.equal(layout.root.type, 'split');
    if (layout.root.type !== 'split') return;
    assert.equal(layout.root.direction, 'right');
    assert.ok(
      Math.abs(layout.root.ratio - 0.6) < 0.02,
      `Orchestrator column should stay at 60%, got ${layout.root.ratio}`,
    );
    assert.equal(layout.root.second.type, 'split');
    if (layout.root.second.type !== 'split') return;
    assert.equal(layout.root.second.direction, 'down');
    // Rebalanced to equal halves.
    assert.ok(
      Math.abs(layout.root.second.ratio - 0.5) < 0.02,
      `agent column should be even, got ${layout.root.second.ratio}`,
    );
  });
});

test("delivers a detached real child's result and closes its pane on its own", async () => {
  // The only mechanism with no real-process coverage otherwise: nobody waits,
  // so the widget poller has to notice a real Pi child settling, read its
  // artifact, push it into the session and close the real pane.
  await withE2e({}, async (harness) => {
    await harness.call({ agent: 'scout', task: 'Report the magic word.' });
    assert.equal((await harness.snapshot()).panes.length, 2);

    await harness.waitFor(
      () => harness.messages.length > 0,
      'detached delivery from a real child',
      60000,
    );

    const [message] = harness.messages;
    assert.equal(message?.customType, 'agent_result');
    assert.match(message?.content ?? '', /MOCK_CHILD_OK/);
    assert.equal(message?.triggerTurn, true);

    await harness.waitFor(
      async () => (await harness.snapshot()).panes.length === 1,
      'the one-shot pane to be closed by the poller',
      15000,
    );
    assert.deepEqual((await harness.readState()).agents, {});
  });
});

test('does not deliver a real intermediate assistant artifact while a detached tool turn remains active', async () => {
  await withE2e({}, async (harness) => {
    const finalReply = Promise.withResolvers<void>();
    harness.llm.setScript(async (body) => {
      if (isToolFollowUp(body)) {
        await finalReply.promise;
        return { text: 'FINAL_TOOL_TURN_REPORT', delayMs: 0 };
      }
      return {
        text: 'Now the test file imports.',
        toolCall: {
          name: 'bash',
          args: { command: 'printf INTERMEDIATE_TOOL_DONE' },
        },
        delayMs: 0,
      };
    });
    try {
      await harness.call({
        agent: 'scout',
        task: 'Investigate intermediate delivery',
        name: 'Intermediate Child',
      });
      await harness.waitFor(
        () => harness.llm.requests.length >= 2 || harness.messages.length > 0,
        'intermediate tool follow-up',
      );
      assert.equal(
        harness.messages.length,
        0,
        'delivered an intermediate assistant message',
      );
      assert.equal(harness.llm.requests.length, 2);
      const record = Object.values((await harness.readState()).agents)[0];
      assert.ok(record);
      assert.equal(
        await readAgentResult(record.resultFile),
        'Now the test file imports.',
      );
      const child = (await harness.snapshot()).panes.find(
        (pane) => pane.pane_id === record.paneId,
      );
      assert.ok(child);
      await new Promise((resolve) => setTimeout(resolve, 2200));
      assert.equal(
        harness.messages.length,
        0,
        'poller delivered intermediate artifact before the final response',
      );
      assert.equal((await harness.snapshot()).panes.length, 2);
      assert.equal(
        Object.values((await harness.readState()).agents)[0]?.detached,
        true,
      );
      finalReply.resolve();
      await harness.waitFor(
        () => harness.messages.length === 1,
        'final tool-turn delivery',
        60000,
      );
      // The whole turn is delivered once: intermediate text, then the report.
      assert.match(
        harness.messages[0]?.content ?? '',
        /Now the test file imports\.\n\nFINAL_TOOL_TURN_REPORT/,
      );
      assert.equal((await harness.snapshot()).panes.length, 1);
      assert.equal(harness.llm.requests.length, 2);
    } finally {
      finalReply.resolve();
    }
  });
});

test('keeps an escaped child open for correction and delivers the complete result once', async () => {
  await withE2e({}, async (harness) => {
    harness.llm.setScript((body) => {
      if (
        lastUserText(body) ===
        'Correction: stop the timer and finish the original task'
      ) {
        return { text: 'FINAL_AFTER_CORRECTION', delayMs: 0 };
      }
      return {
        text: 'PARTIAL_BEFORE_ESCAPE',
        toolCall: {
          name: 'bash',
          args: { command: 'printf started > escape-tool-started; sleep 30' },
        },
        delayMs: 0,
      };
    });
    await harness.call({ agent: 'scout', task: 'ORIGINAL_ESCAPE_TASK' });
    const record = Object.values((await harness.readState()).agents)[0];
    assert.ok(record);
    await harness.waitFor(
      () =>
        fs.stat(path.join(harness.cwd, 'escape-tool-started')).then(
          () => true,
          () => false,
        ),
      'the real child tool to start before Escape',
    );
    const session = await readAgentSessionMeta(record.resultFile);
    assert.ok(session?.sessionId);
    await harness.herdr(['agent', 'send-keys', record.automationName!, 'esc']);
    await harness.waitFor(async () => {
      const child = (await harness.snapshot()).panes.find(
        (pane) => pane.pane_id === record.paneId,
      );
      return harness.messages.length > 0 || child?.agent_status === 'idle';
    }, 'Escape to settle the child');
    await new Promise((resolve) => setTimeout(resolve, 2200));
    assert.equal(
      harness.messages.length,
      0,
      'delivered a partial result after Escape',
    );
    assert.equal((await harness.snapshot()).panes.length, 2);
    assert.equal(
      await readAgentResult(record.resultFile),
      'PARTIAL_BEFORE_ESCAPE',
    );
    const paused = Object.values((await harness.readState()).agents)[0];
    assert.equal(paused?.paneId, record.paneId);
    assert.equal(paused?.detached, true);
    assert.equal(harness.llm.requests.length, 1);

    await harness.herdr([
      'agent',
      'prompt',
      record.automationName!,
      'Correction: stop the timer and finish the original task',
    ]);
    await harness.waitFor(
      () => harness.messages.length === 1,
      'corrected result delivery',
    );
    assert.equal(harness.messages[0]?.customType, 'agent_result');
    assert.match(
      harness.messages[0]?.content ?? '',
      /PARTIAL_BEFORE_ESCAPE\n\nFINAL_AFTER_CORRECTION/,
    );
    assert.equal(harness.llm.requests.length, 2);
    const history = JSON.stringify(harness.llm.requests[1]?.messages);
    assert.match(history, /ORIGINAL_ESCAPE_TASK/);
    assert.match(history, /PARTIAL_BEFORE_ESCAPE/);
    assert.equal((await harness.snapshot()).panes.length, 1);
    const state = await harness.readState();
    assert.deepEqual(state.agents, {});
    assert.equal(state.closedHistory[0]?.childSessionId, session.sessionId);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(harness.messages.length, 1);
  });
});

test('keeps a rate-limited child open through a model switch, manual continuation and steering', async () => {
  await withE2e({}, async (harness) => {
    const recoveryReply = Promise.withResolvers<void>();
    harness.llm.setScript(async (body, index) => {
      if (index === 0) {
        return {
          text: 'PARTIAL_BEFORE_LIMIT',
          toolCall: { name: 'bash', args: { command: 'printf WORK_STARTED' } },
          delayMs: 0,
        };
      }
      if (lastUserText(body) === 'continue') {
        await recoveryReply.promise;
        return { text: 'RECOVERED_AFTER_MODEL_SWITCH', delayMs: 0 };
      }
      if (lastUserText(body) === 'Finish the original task') {
        return { text: 'STEERED_FINAL', delayMs: 0 };
      }
      return { error: { status: 429, message: 'Model quota exhausted' } };
    });
    await harness.call({ agent: 'scout', task: 'Recover from a model limit' });
    const record = Object.values((await harness.readState()).agents)[0];
    assert.ok(record);
    await harness.waitFor(
      async () => {
        const child = (await harness.snapshot()).panes.find(
          (pane) => pane.pane_id === record.paneId,
        );
        return (
          harness.messages.length > 0 ||
          (harness.llm.requests.length >= 2 && child?.agent_status === 'idle')
        );
      },
      'rate-limited child to settle',
      60000,
    );
    await new Promise((resolve) => setTimeout(resolve, 2200));
    assert.equal(
      harness.messages.length,
      0,
      'delivered a rate-limited partial result',
    );
    assert.equal((await harness.snapshot()).panes.length, 2);
    assert.equal(
      await readAgentResult(record.resultFile),
      'PARTIAL_BEFORE_LIMIT',
    );
    assert.equal(
      Object.values((await harness.readState()).agents)[0]?.detached,
      true,
    );

    await harness.herdr([
      'agent',
      'prompt',
      record.automationName!,
      '/model mock/recovery-model',
    ]);
    try {
      await harness.herdr([
        'agent',
        'prompt',
        record.automationName!,
        'continue',
      ]);
      await harness.waitFor(
        () =>
          harness.llm.requests.some(
            (body) => lastUserText(body) === 'continue',
          ),
        'manual continuation to reach the recovery model',
      );
      await harness.herdr([
        'agent',
        'prompt',
        record.automationName!,
        'Finish the original task',
      ]);
    } finally {
      recoveryReply.resolve();
    }
    const delivered = await harness.collect('Scout', 60000);
    assert.match(
      delivered.content,
      /PARTIAL_BEFORE_LIMIT\n\nRECOVERED_AFTER_MODEL_SWITCH\n\nSTEERED_FINAL/,
    );
    const recovery = harness.llm.requests.find(
      (body) => lastUserText(body) === 'continue',
    );
    assert.equal(recovery?.model, 'recovery-model');
    assert.equal((await harness.snapshot()).panes.length, 1);
    assert.equal(harness.messages.length, 1);
  });
});

test('batches a real detached result and question with one turn trigger', async () => {
  await withE2e({}, async (harness) => {
    const replies = Promise.withResolvers<void>();
    harness.llm.setScript(async (body) => {
      await replies.promise;
      return lastUserText(body).includes('QUESTION_BATCH')
        ? {
            toolCall: {
              name: 'ask_question',
              args: { question: 'Batch decision?' },
            },
            delayMs: 0,
          }
        : { text: DEFAULT_RESULT_TEXT, delayMs: 0 };
    });
    try {
      await Promise.all([
        harness.callRaw({
          agent: 'scout',
          task: 'RESULT_BATCH',
          name: 'Batch Result',
        }),
        harness.callRaw({
          agent: 'scout',
          task: 'QUESTION_BATCH',
          name: 'Batch Question',
        }),
      ]);
      await harness.waitFor(
        () => harness.llm.requests.length === 2,
        'both real children to start',
      );
      await harness.fire('session_shutdown');
      replies.resolve();
      await harness.waitFor(
        async () => {
          const children = (await harness.snapshot()).panes.filter(
            (pane) => pane.pane_id !== harness.orchestratorPaneId,
          );
          return (
            children.length === 2 &&
            children.every((pane) =>
              ['idle', 'done'].includes(pane.agent_status ?? ''),
            )
          );
        },
        'both real children to settle',
        60000,
      );
      await harness.reload();
      await harness.waitFor(
        () => harness.messages.length === 2,
        'batched detached delivery',
      );
      assert.deepEqual(
        harness.messages.map((message) => message.triggerTurn),
        [undefined, true],
      );
      assert.deepEqual(
        harness.messages.map((message) => message.customType).sort(),
        ['agent_question', 'agent_result'],
      );
      assert.equal(harness.llm.requests.length, 2);
      const records = Object.values((await harness.readState()).agents);
      assert.equal(records.length, 1);
      assert.equal(records[0]?.tabLabel, 'Batch Question');
      assert.equal(records[0]?.detached, undefined);
      assert.equal((await harness.snapshot()).panes.length, 2);
    } finally {
      replies.resolve();
    }
  });
});

test('resumes a closed real one-shot with prior conversation context', async () => {
  await withE2e({}, async (harness) => {
    const first = await harness.call({
      agent: 'scout',
      task: 'Remember the token ALPHA-42.',
      name: 'Scout Resume E2E',
    });
    assert.equal(first.isError, undefined);
    const firstDelivery = await harness.collect('Scout Resume E2E', 60000);
    assert.match(firstDelivery.content, /MOCK_CHILD_OK/);
    const history = (await harness.readState()).closedHistory ?? [];
    assert.equal(history.length, 1);
    assert.ok(history[0]?.childSessionFile);

    const resumed = await harness.callTool('agent_send', {
      message: 'What token did I ask you to remember?',
      name: 'Scout Resume E2E',
    });
    assert.equal(resumed.isError, undefined);
    assert.equal(resumed.details.resumed, true);
    await harness.collect('Scout Resume E2E', 60000);

    const secondRequest = harness.llm.requestsMentioning(
      'What token did I ask you to remember?',
    )[0];
    assert.ok(secondRequest, 'expected the resumed task to reach the model');
    const historyText = JSON.stringify(secondRequest.messages);
    assert.match(historyText, /Remember the token ALPHA-42/);
  });
});

test("spawns a real child into the Agents workspace and never touches the Orchestrator's tab", async () => {
  await withE2e({ layout: 'workspace' }, async (harness) => {
    const before = await harness.snapshot();
    assert.equal(before.panes.length, 1);

    const result = await harness.call({
      agent: 'scout',
      task: 'Report the magic word.',
    });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /started/);
    const delivered = await harness.collect('Scout', 60000);
    assert.match(delivered.content, /MOCK_CHILD_OK/);

    // The child ran in the dedicated Agents workspace, not beside the
    // Orchestrator. The spawn drops the empty root tab, and collection closes
    // the agent tab — real Herdr then removes the emptied workspace itself.
    const workspaces = JSON.parse(await harness.herdr(['workspace', 'list']));
    const agentsWorkspace = (workspaces?.result?.workspaces ?? []).find(
      (workspace: { label?: string }) => workspace.label === 'subagents',
    );
    assert.equal(
      agentsWorkspace,
      undefined,
      `expected the emptied Agents workspace to be gone, got ${JSON.stringify(workspaces?.result?.workspaces)}`,
    );

    const after = await harness.snapshot();
    const orchestratorWsId = harness.orchestratorPaneId.split(':')[0];
    assert.deepEqual(
      after.panes
        .filter((pane) => pane.workspace_id === orchestratorWsId)
        .map((pane) => pane.pane_id),
      [harness.orchestratorPaneId],
    );
    assert.deepEqual((await harness.readState()).agents, {});
  });
});

test('delivers an unseen real child that finishes in the background', async () => {
  // Real-Herdr coverage for background completion: nobody waits and the
  // child's tab is never focused by any UI. The poller has to notice the
  // settled child, read its artifact, push the result into the session and
  // close the tab. Herdr reports such work as `done`; in a fully headless
  // harness its seen/unseen heuristic is not deterministic run-to-run, so the
  // strict `done` semantics are pinned by the FakeHerdr integration test and
  // cross-checked here with a server-side wait witness.
  await withE2e({ layout: 'workspace' }, async (harness) => {
    await harness.call({ agent: 'scout', task: 'Report the magic word.' });

    // Server-side witness: resolves only if the unseen child really reached
    // Herdr's `done` state while its tab was still open. If the poller closes
    // it first, the wait reports unknown-agent and the snapshot statuses below
    // are the remaining evidence.
    const record = Object.values((await harness.readState()).agents)[0];
    assert.ok(record?.automationName);
    const doneWitness = harness
      .herdr([
        'agent',
        'wait',
        record.automationName!,
        '--until',
        'done',
        '--timeout',
        '30000',
      ])
      .then(() => true)
      .catch(() => false);

    const seenStatuses = new Set<string>();
    await harness.waitFor(
      async () => {
        const snapshot = await harness.snapshot();
        for (const pane of snapshot.panes) {
          if (
            pane.agent === 'pi' &&
            pane.pane_id !== harness.orchestratorPaneId
          ) {
            seenStatuses.add(pane.agent_status ?? '');
          }
        }
        return harness.messages.length > 0;
      },
      'detached delivery from an unseen real child',
      60000,
    );

    // Whatever Herdr called the settled state, it was a finished one, and the
    // child really reached `done` server-side in the witnessed runs.
    assert.ok(
      seenStatuses.has('done') ||
        seenStatuses.has('idle') ||
        (await doneWitness),
      `expected a settled unseen child, saw: ${[...seenStatuses].join(', ') || 'nothing'}`,
    );

    const [message] = harness.messages;
    assert.equal(message?.customType, 'agent_result');
    assert.match(message?.content ?? '', /MOCK_CHILD_OK/);
    assert.equal(message?.triggerTurn, true);

    await harness.waitFor(
      async () => {
        const snapshot = await harness.snapshot();
        const orchestratorWsId = harness.orchestratorPaneId.split(':')[0];
        const remaining = snapshot.panes.filter(
          (pane) =>
            pane.workspace_id === orchestratorWsId &&
            pane.pane_id !== harness.orchestratorPaneId,
        );
        return remaining.length === 0;
      },
      'the unseen one-shot tab to be closed by the poller',
      15000,
    );
    assert.deepEqual((await harness.readState()).agents, {});
  });
});

test('archives a long real child result and delivers an excerpt with its report path', async () => {
  // A real Pi child writing a report longer than the retained budget: the
  // delivered message must carry the excerpt and the path, and the file must
  // still hold the whole text after the child's own pane has closed.
  await withE2e({}, async (harness) => {
    const report = [
      'FINDINGS',
      ...Array.from(
        { length: 60 },
        (_, index) => `finding ${index}: ${'evidence '.repeat(20).trim()}`,
      ),
      'AGENT_RESULT: done — MOCK_CHILD_OK',
    ].join('\n');
    harness.llm.setScript(() => ({ text: report, delayMs: 0 }));

    await harness.call({ agent: 'scout', task: 'Write a long report.' });
    await harness.waitFor(
      () => harness.messages.length > 0,
      'detached delivery of a long real result',
      60000,
    );

    const [message] = harness.messages;
    assert.equal(message?.customType, 'agent_result');
    assert.match(message?.content ?? '', /characters omitted/);
    assert.match(message?.content ?? '', /FINDINGS/);
    assert.match(message?.content ?? '', /MOCK_CHILD_OK/);

    const reportPath = /Full report saved to (\S+)/.exec(
      message?.content ?? '',
    )?.[1];
    assert.ok(reportPath, 'expected a report path line');
    assert.equal(
      path.dirname(reportPath),
      path.join(harness.root, 'home', '.pi', 'agent', 'pi-herdr-subagents-results'),
      'the report belongs to the hermetic agent dir',
    );
    assert.equal(await fs.readFile(reportPath, 'utf8'), report);
  });
});

test('steers a real running child and delivers its post-steer answer once', async () => {
  await withE2e({}, async (harness) => {
    // A held reply is the barrier: the run is live until the test releases it,
    // so the steer lands in a run that cannot settle on its own.
    const firstReply = Promise.withResolvers<void>();
    harness.llm.setScript(async (body) => {
      if (
        JSON.stringify(body.messages ?? []).includes('STEER_LIVE_CORRECTION')
      ) {
        return { text: 'ANSWER_AFTER_CORRECTION', delayMs: 0 };
      }
      await firstReply.promise;
      return { text: 'ANSWER_BEFORE_CORRECTION', delayMs: 0 };
    });
    try {
      const spawned = await harness.call({
        agent: 'scout',
        task: 'STEER_LIVE_TASK',
        name: 'Steer Child',
      });
      assert.equal(spawned.isError, undefined);
      await harness.waitFor(
        () => harness.llm.requests.length === 1,
        'the child to reach its first model request',
        60000,
      );

      // Observation, never an assertion of absence: whether Herdr reports the
      // child idle while its run is held.
      const statuses = new Set<string>();
      for (let index = 0; index < 10; index++) {
        const child = (await harness.snapshot()).panes.find(
          (pane) =>
            pane.agent === 'pi' && pane.pane_id !== harness.orchestratorPaneId,
        );
        if (child?.agent_status) statuses.add(child.agent_status);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      console.info(
        `[e2e] child statuses while the first reply was held: ${[...statuses].join(', ')}`,
      );
      assert.ok(
        statuses.has('working'),
        `expected a working child, saw: ${[...statuses].join(', ') || 'nothing'}`,
      );

      const steered = await harness.callTool('agent_send', {
        name: 'Steer Child',
        message: 'STEER_LIVE_CORRECTION: answer the second half too.',
      });
      assert.equal(steered.details.action, 'steer');
      assert.equal(steered.details.status, 'queued');
      // The steer enters a turn boundary after this held turn, so the run has
      // not settled and the poller has nothing to deliver.
      assert.equal(
        harness.messages.length,
        0,
        'delivered a result before the child settled',
      );
      assert.equal((await harness.snapshot()).panes.length, 2);

      firstReply.resolve();
      await harness.waitFor(
        () => harness.llm.requests.length === 2,
        'the steered turn boundary to reach the model',
        60000,
      );
      assert.match(
        JSON.stringify(harness.llm.requests[1]?.messages ?? []),
        /STEER_LIVE_CORRECTION/,
      );

      const delivered = await harness.collect('Steer Child', 60000);
      assert.equal(delivered.customType, 'agent_result');
      assert.match(
        delivered.content,
        /ANSWER_BEFORE_CORRECTION\n\nANSWER_AFTER_CORRECTION/,
      );
      assert.equal(harness.messages.length, 1);
      await harness.waitFor(
        async () => (await harness.snapshot()).panes.length === 1,
        'the steered one-shot pane to be closed after the real settle',
        15000,
      );
      assert.deepEqual((await harness.readState()).agents, {});
    } finally {
      firstReply.resolve();
    }
  });
});

test('interrupts a real running child and never consumes its queued steer', async () => {
  await withE2e({}, async (harness) => {
    harness.llm.setScript((body) => {
      if (
        JSON.stringify(body.messages ?? []).includes('MANUAL_CONTINUATION_TASK')
      ) {
        return { text: 'ANSWER_AFTER_INTERRUPT', delayMs: 0 };
      }
      return {
        text: 'PARTIAL_BEFORE_INTERRUPT',
        toolCall: {
          name: 'bash',
          args: {
            command: 'printf started > interrupt-tool-started; sleep 30',
          },
        },
        delayMs: 0,
      };
    });

    await harness.call({
      agent: 'scout',
      task: 'INTERRUPT_TARGET_TASK',
      name: 'Interrupt Child',
    });
    const record = Object.values((await harness.readState()).agents)[0];
    assert.ok(record?.automationName);
    await harness.waitFor(
      () =>
        fs.stat(path.join(harness.cwd, 'interrupt-tool-started')).then(
          () => true,
          () => false,
        ),
      'the real child tool to start before the interrupt',
    );
    assert.equal(
      await readAgentResult(record.resultFile),
      'PARTIAL_BEFORE_INTERRUPT',
    );

    // The tool call holds the turn, so only the abort can end this run: the
    // steer is queued into it and cannot reach a turn boundary first.
    const steered = await harness.callTool('agent_send', {
      name: 'Interrupt Child',
      message: 'STEER_BEFORE_INTERRUPT',
    });
    assert.equal(steered.details.status, 'queued');

    const interrupted = await harness.callTool('agent_stop', {
      name: 'Interrupt Child',
    });
    assert.equal(interrupted.details.action, 'interrupt');
    assert.equal(interrupted.details.status, 'aborted');
    assert.equal(interrupted.details.paneId, record.paneId);

    // Ordinary path: the child wrote its marker before the abort, so no poller
    // tick delivers the partial text and the child stays live. A collection
    // already in flight could still deliver it (accepted race, D5).
    await new Promise((resolve) => setTimeout(resolve, 2200));
    assert.equal(harness.messages.length, 0, 'delivered an interrupted run');
    assert.equal(await isAgentResultInterrupted(record.resultFile), true);
    assert.equal(
      await readAgentResult(record.resultFile),
      'PARTIAL_BEFORE_INTERRUPT',
    );
    assert.equal((await harness.snapshot()).panes.length, 2);
    const live = Object.values((await harness.readState()).agents)[0];
    assert.equal(live?.paneId, record.paneId);
    assert.equal(live?.detached, true);

    // Manual continuation in the child's own pane: the documented recovery for
    // a live interrupted child.
    await harness.herdr([
      'agent',
      'prompt',
      record.automationName!,
      'MANUAL_CONTINUATION_TASK',
    ]);
    await harness.waitFor(
      () => harness.llm.requests.length === 2,
      'the manual continuation to reach the model',
      60000,
    );

    const delivered = await harness.collect('Interrupt Child', 60000);
    assert.match(
      delivered.content,
      /PARTIAL_BEFORE_INTERRUPT\n\nANSWER_AFTER_INTERRUPT/,
    );
    assert.equal(harness.messages.length, 1);
    await harness.waitFor(
      async () => (await harness.snapshot()).panes.length === 1,
      'the continued one-shot pane to be closed',
      15000,
    );
    assert.deepEqual((await harness.readState()).agents, {});
    // Scanned only now, so every request body of the completed recovery run is
    // covered — not just the one that carried the task. Whole bodies, not the
    // last user text: the steer was queued as a custom message and must never
    // reach this child's model context.
    assert.deepEqual(
      harness.llm.requests.filter((body) =>
        JSON.stringify(body).includes('STEER_BEFORE_INTERRUPT'),
      ),
      [],
      'the aborted run consumed the queued steer',
    );
    assert.equal(harness.llm.requests.length, 2);
  });
});

test('delivers a real child question once when an interrupt lands on its steered continuation', async () => {
  await withE2e({}, async (harness) => {
    // Two real barriers. The first reply is held so the steer is queued before
    // the terminating tool runs; the steered continuation is held so the
    // question is already on disk while the child is still in its run.
    const firstReply = Promise.withResolvers<void>();
    // Never resolved: the interrupt aborts this request, so no reply is due and
    // a late one would write to a socket the abort already destroyed.
    const continuationHeld = new Promise<never>(() => {});
    harness.llm.setScript(async (_body, index) => {
      if (index === 0) {
        await firstReply.promise;
        return {
          toolCall: {
            name: 'ask_question',
            args: { question: 'QUESTION_OVER_INTERRUPT: cookie or JWT?' },
          },
          delayMs: 0,
        };
      }
      await continuationHeld;
      return { text: 'UNREACHED_CONTINUATION_ANSWER', delayMs: 0 };
    });
    try {
      await harness.call({
        agent: 'scout',
        task: 'QUESTION_INTERRUPT_TASK',
        name: 'Question Child',
      });
      await harness.waitFor(
        () => harness.llm.requests.length === 1,
        'the child to reach its first model request',
        60000,
      );
      const steered = await harness.callTool('agent_send', {
        name: 'Question Child',
        message: 'STEER_INTO_QUESTION_TURN',
      });
      assert.equal(steered.details.status, 'queued');

      firstReply.resolve();
      // Pi re-reads the steering queue after a terminating tool call completes
      // (`agent-loop.js`: `hasMoreToolCalls || pendingMessages.length > 0`), so
      // `ask_question` does not end the run while a steer is queued.
      await harness.waitFor(
        () => harness.llm.requests.length === 2,
        'the steered continuation after the terminating question',
        60000,
      );
      assert.match(
        JSON.stringify(harness.llm.requests[1]?.messages ?? []),
        /STEER_INTO_QUESTION_TURN/,
      );
      const record = Object.values((await harness.readState()).agents)[0];
      assert.equal(
        await readAgentQuestion(record?.resultFile),
        'QUESTION_OVER_INTERRUPT: cookie or JWT?',
      );

      const interrupted = await harness.callTool('agent_stop', {
        name: 'Question Child',
      });
      assert.equal(interrupted.details.action, 'interrupt');
      assert.equal(interrupted.details.status, 'aborted');

      // The question branch of the poller never consults the interrupted
      // marker, so the pre-written question is delivered while the marker that
      // blocked the run's own text stays set.
      await harness.waitFor(
        () => harness.messages.length > 0,
        'the pre-written question to be delivered',
        60000,
      );
      const [question] = harness.messages;
      assert.equal(question?.customType, 'agent_question');
      assert.match(question?.content ?? '', /cookie or JWT\?/);
      assert.equal(await isAgentResultInterrupted(record?.resultFile), true);
      assert.equal((await readAgentResult(record?.resultFile)) ?? '', '');

      // Several more poller ticks: one delivery, no result, child still open.
      await new Promise((resolve) => setTimeout(resolve, 2200));
      assert.equal(harness.messages.length, 1);
      assert.equal(
        harness.messages.filter(
          (message) => message.customType === 'agent_result',
        ).length,
        0,
      );
      assert.equal((await harness.snapshot()).panes.length, 2);
      const live = Object.values((await harness.readState()).agents)[0];
      assert.equal(live?.paneId, record?.paneId);
      assert.equal(
        await readAgentQuestion(live?.resultFile),
        'QUESTION_OVER_INTERRUPT: cookie or JWT?',
      );
    } finally {
      firstReply.resolve();
    }
  });
});
