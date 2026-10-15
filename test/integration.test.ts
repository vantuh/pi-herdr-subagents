import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { test } from 'vitest';

import {
  setFailNextStateSaves,
  setFailNextStateMutation,
  clearStateSaveFailures,
} from '../src/state/store.ts';
import type { LayoutNode } from '../test-support/fake-herdr.ts';
import {
  type Harness,
  type HarnessOptions,
  createHarness,
} from '../test-support/harness.ts';

/**
 * Integration tests for the whole `herdr_agent` flow: the real extension runs
 * against a fake Herdr (real subprocess CLI calls, real socket API, real state
 * file, real result artifacts) with simulated Pi children. Only the terminal
 * and the child LLM are faked.
 */

async function withHarness(
  options: HarnessOptions,
  body: (harness: Harness) => Promise<void>,
): Promise<void> {
  const harness = await createHarness(options);
  try {
    await body(harness);
  } finally {
    clearStateSaveFailures();
    await harness.dispose();
  }
}

function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function splitDirections(node: LayoutNode | undefined): string[] {
  if (!node || node.type === 'pane') return [];
  return [
    node.direction,
    ...splitDirections(node.first),
    ...splitDirections(node.second),
  ];
}

/**
 * Fail one state-file read once the stored content matches, standing in for a
 * transient EACCES arriving between two locked state mutations.
 */
function failStateReadOnce(
  harness: Harness,
  whenContent: (raw: string) => boolean,
): () => void {
  const realReadFile = fs.readFile.bind(fs);
  let armed = true;
  fs.readFile = (async (...args: unknown[]) => {
    const real = realReadFile as (...inner: unknown[]) => Promise<unknown>;
    if (args[0] !== harness.statePath || !armed) return real(...args);
    const raw = String(await real(harness.statePath, 'utf8'));
    if (!whenContent(raw)) return raw;
    armed = false;
    const error = new Error(
      `EACCES: permission denied, open '${harness.statePath}'`,
    ) as NodeJS.ErrnoException;
    error.code = 'EACCES';
    throw error;
  }) as typeof fs.readFile;
  return () => {
    fs.readFile = realReadFile;
  };
}

/** Close a one-shot and delete its child session file so resume validation fails. */
async function seedClosedOneShotWithMissingSession(
  harness: Harness,
): Promise<Awaited<ReturnType<Harness['readState']>>> {
  await harness.call({
    agent: 'scout',
    task: 'first',
    tabLabel: 'Scout Resume',
  });
  await harness.collect('Scout Resume');
  await harness.fire('session_shutdown');
  const state = await harness.readState();
  await fs.rm(state.closedHistory[0]!.childSessionFile);
  await fs.writeFile(harness.statePath, JSON.stringify(state));
  return state;
}

test('spawns a one-shot pane agent, collects the artifact and closes it', async () => {
  await withHarness({}, async (harness) => {
    const result = await harness.call({
      agent: 'scout',
      task: 'Find the auth flow',
    });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /started/);
    assert.equal(result.details.reused, false);
    assert.equal(result.details.closed, undefined);

    const delivered = await harness.collect('Scout');
    assert.match(delivered.content, /Result from scout_/);

    // 60/40 split off the Orchestrator, child markers on the new pane.
    const split = harness.fake.callsMatching('pane', 'split')[0];
    assert.ok(split, 'expected a pane split');
    assert.equal(split[2], harness.fake.orchestratorPane.pane_id);
    assert.equal(flagValue(split, '--direction'), 'right');
    assert.equal(flagValue(split, '--ratio'), '0.6');
    assert.equal(flagValue(split, '--cwd'), harness.cwd);
    assert.ok(split.includes('HERDR_AGENT_CHILD=1'));
    assert.ok(split.includes('PROCESS_LAUNCHED_BY_Q=1'));
    assert.ok(split.includes('--no-focus'));

    const start = harness.fake.callsMatching('agent', 'start')[0];
    assert.ok(start);
    assert.equal(flagValue(start, '--kind'), 'pi');
    assert.equal(flagValue(start, '--name'), 'Scout');
    assert.match(start[2], /^scout_[0-9a-f]{8}$/);

    // The prompt carries the task and the result-file channel.
    const prompt = harness.fake.callsMatching('agent', 'prompt')[0];
    assert.ok(prompt);
    assert.match(prompt[3], /Task from Orchestrator:\nFind the auth flow/);
    assert.match(prompt[3], /^HERDR_RESULT_FILE: \S+result\.md$/m);

    // Pane closed, layout back to a single pane, state pruned.
    assert.deepEqual(
      harness.fake.panes.map((pane) => pane.pane_id),
      [harness.fake.orchestratorPane.pane_id],
    );
    assert.equal(
      harness.fake.layoutFor(harness.fake.orchestratorPane.tab_id)?.type,
      'pane',
    );
    assert.deepEqual((await harness.readState()).agents, {});
  });
});

test('status check shows scrollback when the child writes no artifact', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({
      transcript: 'only scrollback, no HERDR_RESULT',
    }));

    await harness.call({ agent: 'scout', task: 'Look around' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const result = await harness.call({ agent: 'scout', tabLabel: 'Scout' });

    assert.match(result.content[0].text, /finished without a result/);
    assert.match(result.content[0].text, /only scrollback, no HERDR_RESULT/);
    assert.equal(result.details.status, 'idle');
    assert.equal(harness.messages.length, 0);
    const read = harness.fake.callsMatching('agent', 'read')[0];
    assert.ok(read);
    assert.equal(
      read.includes('--source') && read[read.indexOf('--source') + 1],
      'recent-unwrapped',
    );
  });
});

test('status check falls back to the visible screen when Herdr rejects the history read', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({ neverSettle: true }));

    await harness.call({ agent: 'scout', task: 'Look around' });

    // Production Herdr cannot scroll alternate-screen history while Pi works.
    harness.fake.failCommand('agent read', 'agent_not_idle', { times: 1 });
    const result = await harness.call({ agent: 'scout', tabLabel: 'Scout' });

    assert.equal(result.isError, undefined);
    assert.equal(result.details.status, 'working');

    const record = Object.values((await harness.readState()).agents)[0];
    assert.ok(record?.automationName);
    assert.deepEqual(harness.fake.callsMatching('agent', 'read'), [
      [
        'agent',
        'read',
        record.automationName,
        '--source',
        'recent-unwrapped',
        '--lines',
        '180',
      ],
      ['agent', 'read', record.automationName, '--source', 'visible'],
    ]);

    // The status check still only prompts once (at spawn) and closes nothing.
    assert.equal(harness.fake.callsMatching('agent', 'prompt').length, 1);
    assert.equal(harness.fake.callsMatching('agent', 'wait').length, 0);
    assert.equal(harness.fake.callsMatching('pane', 'close').length, 0);
    assert.equal(record.detached, true);
    assert.equal(record.collected, undefined);
    assert.ok(
      harness.fake.panes.some((pane) => pane.pane_id === record.paneId),
      'the detached agent pane must stay open',
    );
    assert.equal(harness.messages.length, 0);
  });
});

test('passes profile model and tool allowlist to the child and closes the one-shot', async () => {
  await withHarness(
    {
      profiles: [
        {
          name: 'worker',
          tools: ['read', 'edit'],
          model: 'sonnet',
          body: 'WORKER PROFILE BODY',
        },
      ],
    },
    async (harness) => {
      // Detached: no close, so the spawn-time system prompt stays readable.
      const first = await harness.callRaw({
        agent: 'worker',
        task: 'Slice one',
      });
      assert.equal(first.details.closed, undefined);

      const start = harness.fake.callsMatching('agent', 'start')[0];
      assert.ok(start);
      assert.equal(flagValue(start, '--model'), 'sonnet');
      // ask_question is force-added so a restricted child can still ask.
      assert.equal(flagValue(start, '--tools'), 'read,edit,ask_question');

      const systemFile = flagValue(start, '--append-system-prompt');
      assert.ok(systemFile);
      const systemPrompt = await fs.readFile(systemFile, 'utf8');
      assert.match(systemPrompt, /WORKER PROFILE BODY/);
      assert.match(systemPrompt, /## Herdr agent protocol/);

      assert.equal(harness.fake.callsMatching('agent', 'start').length, 1);
      assert.equal(harness.fake.callsMatching('agent', 'prompt').length, 1);
    },
  );
});

test('a caller model field does not replace the profile model', async () => {
  await withHarness(
    {
      profiles: [
        {
          name: 'worker',
          model: 'sonnet',
          body: 'WORKER PROFILE BODY',
        },
      ],
    },
    async (harness) => {
      const result = await harness.callRaw({
        agent: 'worker',
        task: 'Slice one',
        model: 'opus-5',
      });
      assert.equal(result.isError ?? false, false);

      const start = harness.fake.callsMatching('agent', 'start')[0];
      assert.ok(start);
      assert.equal(flagValue(start, '--model'), 'sonnet');
      // Other profile settings are untouched.
      const systemFile = flagValue(start, '--append-system-prompt');
      assert.ok(systemFile);
      assert.match(
        await fs.readFile(systemFile, 'utf8'),
        /WORKER PROFILE BODY/,
      );
    },
  );
});

test('rejects a task addressed to a live agent by its label', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({ neverSettle: true }));
    const first = await harness.callRaw({
      agent: 'scout',
      task: 'First task',
      tabLabel: 'Scout — repo',
    });
    assert.equal(first.isError ?? false, false);

    // A task addressed by label to a live agent must not silently spawn a
    // duplicate "#2" agent.
    const duplicate = await harness.call({
      agent: 'scout',
      task: 'Follow-up task',
      tabLabel: 'Scout — repo',
    });
    assert.equal(duplicate.isError, true);
    assert.match(
      duplicate.content[0].text,
      /live Herdr agent named "Scout — repo" already exists/,
    );
    assert.match(duplicate.content[0].text, /check its status/);
    assert.match(duplicate.content[0].text, /resumeClosed/);
    assert.equal(harness.fake.panes.length, 2); // orchestrator + agent
    assert.equal(harness.fake.callsMatching('agent', 'start').length, 1);
    assert.equal(harness.fake.callsMatching('agent', 'prompt').length, 1);

    const record = Object.values((await harness.readState()).agents)[0];
    assert.ok(record?.automationName);
    await harness.fake.completeAgent(record.automationName, 'Late result');

    const delivered = await harness.collect('Scout — repo');
    assert.match(delivered.content, /Late result/);
    assert.equal(harness.fake.callsMatching('agent', 'prompt').length, 1);
  });
});

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

test('serializes parallel spawns into one agent column and rebalances it', async () => {
  await withHarness({}, async (harness) => {
    // All three stay working past the last placement, so the assertions below
    // describe three simultaneously live agents. A label is only reserved while
    // its agent exists — a finished agent frees it again.
    harness.fake.setBehavior((turn) => ({
      result: `Result from ${turn.agentName}`,
      delayMs: 1500,
    }));

    const results = await Promise.all([
      harness.call({ agent: 'scout', task: 'one' }),
      harness.call({ agent: 'scout', task: 'two' }),
      harness.call({ agent: 'scout', task: 'three' }),
    ]);

    for (const result of results) {
      assert.equal(result.isError, undefined);
      assert.match(result.content[0].text, /started/);
    }
    await harness.waitFor(
      () => harness.messages.length >= 3,
      'three pane results',
      8000,
    );

    const splits = harness.fake.callsMatching('pane', 'split');
    assert.equal(splits.length, 3);
    // Exactly one right split: the agent column is created once, then stacked.
    assert.deepEqual(
      splits.map((argv) => flagValue(argv, '--direction')),
      ['right', 'down', 'down'],
    );

    // Labels stay unique, so reuse-by-label cannot cross-wire two agents.
    assert.deepEqual(
      harness.fake.callsMatching('pane', 'rename').map((argv) => argv[3]),
      ['Scout', 'Scout #2', 'Scout #3'],
    );

    // The Orchestrator's own 60/40 split is never rebalanced (path []).
    assert.ok(harness.fake.ratioUpdates.length > 0);
    assert.ok(
      harness.fake.ratioUpdates.every((update) => update.path.length > 0),
    );
    // Three stacked agents means a 2/3 ratio at the top of the column.
    assert.ok(
      harness.fake.ratioUpdates.some(
        (update) => Math.abs(update.ratio - 2 / 3) < 0.01,
      ),
      `expected a 2/3 rebalance, got ${JSON.stringify(harness.fake.ratioUpdates)}`,
    );

    assert.deepEqual((await harness.readState()).agents, {});
  });
});

test('keeps a single right column when a third agent joins two live ones', async () => {
  await withHarness({}, async (harness) => {
    // Detached spawns that never settle keep three agents live at once.
    harness.fake.setBehavior(() => ({ neverSettle: true }));
    await harness.callRaw({
      agent: 'scout',
      task: 'one',
      tabLabel: 'Scout A',
    });
    await harness.callRaw({
      agent: 'scout',
      task: 'two',
      tabLabel: 'Scout B',
    });
    await harness.callRaw({
      agent: 'scout',
      task: 'three',
      tabLabel: 'Scout C',
    });

    const root = harness.fake.layoutFor(harness.fake.orchestratorPane.tab_id);
    const directions = splitDirections(root);
    assert.equal(directions.filter((d) => d === 'right').length, 1);
    assert.equal(directions.filter((d) => d === 'down').length, 2);
    assert.equal(root?.type === 'split' ? root.ratio : undefined, 0.6);
    assert.equal(harness.fake.panes.length, 4);
  });
});

test('retries a busy child shell without creating another target or prompt', async () => {
  await withHarness({ layout: 'workspace' }, async (harness) => {
    harness.fake.queueStartFailures('agent_pane_busy', 'agent_pane_busy');

    const result = await harness.call({ agent: 'scout', task: 'Find it' });

    assert.equal(result.isError, undefined);
    await harness.collect('Scout');
    assert.equal(harness.fake.callsMatching('agent', 'start').length, 3);
    assert.equal(harness.fake.callsMatching('tab', 'create').length, 1);
    assert.equal(harness.fake.callsMatching('agent', 'prompt').length, 1);
  });
});

test('aborts busy-shell retries without submitting a prompt', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.failEveryStart('agent_pane_busy');
    const controller = new AbortController();
    const pending = harness.call(
      { agent: 'scout', task: 'Find it' },
      { signal: controller.signal },
    );
    const rejected = assert.rejects(pending);
    await harness.waitFor(
      () => harness.fake.callsMatching('agent', 'start').length >= 2,
      'busy-shell retry',
    );
    controller.abort();
    await rejected;
    assert.equal(harness.fake.callsMatching('agent', 'prompt').length, 0);
    assert.equal(harness.fake.callsMatching('pane', 'close').length, 0);
  });
});

test('recovers from a transient agent kind mismatch by waiting and renaming', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.queueStartFailures('agent_kind_mismatch');

    const result = await harness.call({ agent: 'scout', task: 'Find it' });

    assert.equal(result.isError, undefined);
    // Started once (the launch did happen), then renamed to the requested name.
    assert.equal(harness.fake.callsMatching('agent', 'start').length, 1);
    const rename = harness.fake.callsMatching('agent', 'rename')[0];
    assert.ok(rename, 'expected the automation name to be reassigned');
    assert.match(rename[3], /^scout_[0-9a-f]{8}$/);
    assert.ok(harness.fake.callsMatching('agent', 'get').length > 0);
  });
});

test('submits one prompt and delivers a delayed result without another Enter', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({
      staleWindowMs: 300,
      result: 'Delayed acceptance',
    }));
    const started = await harness.call({ agent: 'scout', task: 'Find it' });
    assert.match(started.content[0].text, /started/);
    assert.equal(harness.fake.callsMatching('agent', 'send-keys').length, 0);
    assert.equal(harness.fake.callsMatching('agent', 'prompt').length, 1);
    const delivered = await harness.collect('Scout', 5000);
    assert.match(delivered.content, /Delayed acceptance/);
  });
});

test('a stalled prompt returns immediately and leaves the pane open', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({ stalled: true }));
    const result = await harness.call({ agent: 'scout', task: 'Find it' });
    assert.match(result.content[0].text, /started/);
    assert.equal(harness.fake.panes.length, 2);
    assert.equal(harness.fake.callsMatching('agent', 'send-keys').length, 0);
    assert.equal(harness.fake.callsMatching('agent', 'prompt').length, 1);
    assert.equal(harness.messages.length, 0);
  });
});

test('delivers a fast completion without another Enter', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({ delayMs: 0, result: 'Fast completion' }));
    const started = await harness.call({ agent: 'scout', task: 'Find it' });
    assert.match(started.content[0].text, /started/);
    const delivered = await harness.collect('Scout');
    assert.match(delivered.content, /Fast completion/);
    assert.equal(harness.fake.callsMatching('agent', 'send-keys').length, 0);
    assert.deepEqual(
      harness.fake.panes.map((pane) => pane.pane_id),
      [harness.fake.orchestratorPane.pane_id],
    );
  });
});

test('returns before a never-settling agent finishes and leaves it open', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({ neverSettle: true }));
    const started = await harness.call({
      agent: 'scout',
      task: 'Long job',
    });
    assert.match(started.content[0].text, /started/);
    assert.equal(harness.fake.panes.length, 2);
    assert.equal(harness.fake.callsMatching('agent', 'prompt').length, 1);
    assert.equal(harness.messages.length, 0);
  });
});

test('rejects a status check for an unknown label', async () => {
  await withHarness({}, async (harness) => {
    const result = await harness.call({ agent: 'scout', tabLabel: 'Ghost' });

    assert.equal(result.isError, true);
    assert.match(
      result.content[0].text,
      /No running Herdr agent named "Ghost"/,
    );
  });
});

test('requires a label when task is omitted', async () => {
  await withHarness({}, async (harness) => {
    const result = await harness.call({ agent: 'scout' });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /tabLabel is required/);
  });
});

test('a blank task is a status check and does not spawn', async () => {
  await withHarness({}, async (harness) => {
    const missing = await harness.call({ agent: 'scout', task: '   ' });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /tabLabel is required/);
    assert.equal(harness.fake.callsMatching('agent', 'start').length, 0);

    const unknown = await harness.call({
      agent: 'scout',
      task: '',
      tabLabel: 'Ghost',
    });
    assert.equal(unknown.isError, true);
    assert.match(
      unknown.content[0].text,
      /No running Herdr agent named "Ghost"/,
    );
    assert.equal(harness.fake.callsMatching('agent', 'start').length, 0);
  });
});

test('rejects an unknown agent profile before touching Herdr', async () => {
  await withHarness({}, async (harness) => {
    const result = await harness.call({ agent: 'nope', task: 'anything' });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unknown Herdr agent: nope/);
    assert.match(result.content[0].text, /scout/);
    assert.equal(harness.fake.calls.length, 0);
  });
});

test('a default call detaches in a UI session', async () => {
  await withHarness({}, async (harness) => {
    const started = await harness.callRaw({
      agent: 'scout',
      task: 'Background job',
    });

    assert.match(started.content[0].text, /started/);
    const record = Object.values((await harness.readState()).agents)[0];
    assert.equal(record?.detached, true);
  });
});

test('delivers a detached result through the widget poller and closes the one-shot', async () => {
  await withHarness({}, async (harness) => {
    const started = await harness.call({
      agent: 'scout',
      task: 'Background job',
    });

    assert.match(started.content[0].text, /started/);
    // Nobody is waiting, so the poller owns the result.
    const record = Object.values((await harness.readState()).agents)[0];
    assert.equal(record?.detached, true);

    await harness.waitFor(
      () => harness.messages.length > 0,
      'detached result delivery',
    );

    const [message] = harness.messages;
    assert.equal(message?.customType, 'herdr_agent_result');
    assert.match(message?.content ?? '', /finished on its own/);
    assert.match(message?.content ?? '', /Result from scout_/);
    assert.equal(message?.triggerTurn, true);
    // Pane-layout agents are visible on screen, so no notification ping.
    assert.equal(harness.fake.callsMatching('notification', 'show').length, 0);
    assert.equal(message?.details.tabLabel, 'Scout');

    // Delivered exactly once, pane closed, state pruned.
    await harness.fire('session_start');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(harness.messages.length, 1);
    assert.deepEqual(
      harness.fake.panes.map((pane) => pane.pane_id),
      [harness.fake.orchestratorPane.pane_id],
    );
    assert.deepEqual((await harness.readState()).agents, {});
  });
});

test('status check keeps ownership after a simulated handoff changes both terminals', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.holdChildren();
    harness.fake.setBehavior(() => ({
      question: 'Handoff question?',
      delayMs: 0,
    }));
    await harness.call({
      agent: 'scout',
      task: 'One task',
      tabLabel: 'Handoff Question',
    });
    const before = Object.values((await harness.readState()).agents)[0];
    harness.fake.simulateLiveHandoff();
    const result = await harness.call({
      agent: 'scout',
      tabLabel: 'Handoff Question',
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.details.tabLabel, 'Handoff Question');
    await harness.fake.releaseChildren();
    const delivered = await harness.collect('Handoff Question');
    assert.match(delivered.content, /Handoff question/);
    const after = Object.values((await harness.readState()).agents)[0];
    assert.notEqual(after?.ownerTerminalId, before?.ownerTerminalId);
    assert.equal(after?.ownerSessionId, before?.ownerSessionId);
    assert.equal(after?.automationName, before?.automationName);
    assert.equal(harness.fake.callsMatching('pane', 'close').length, 0);
    harness.fake.setBehavior(() => ({ result: 'HANDOFF_ANSWER' }));
    const answered = await harness.call({
      agent: 'scout',
      tabLabel: 'Handoff Question',
      task: 'Answer',
    });
    assert.equal(answered.details.reused, true);
    const answer = await harness.collect('Handoff Question');
    assert.match(answer.content, /HANDOFF_ANSWER/);
    assert.equal(harness.fake.callsMatching('agent', 'start').length, 1);
  });
});

test('unreconcilable legacy handoff records are retained without adopting or replacing the child', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({ neverSettle: true }));
    await harness.call({
      agent: 'scout',
      task: 'One task',
      tabLabel: 'Legacy Handoff',
    });
    const state = await harness.readState();
    for (const record of Object.values(state.agents)) delete record.ownerPaneId;
    await fs.writeFile(harness.statePath, JSON.stringify(state));
    harness.fake.simulateLiveHandoff();
    const rewait = await harness.call({
      agent: 'scout',
      tabLabel: 'Legacy Handoff',
    });
    assert.equal(rewait.isError, true);
    assert.match(
      rewait.content[0].text,
      /still live.*cannot be reconciled safely/,
    );
    const duplicate = await harness.call({
      agent: 'scout',
      tabLabel: 'Legacy Handoff',
      task: 'Do not duplicate',
    });
    assert.equal(duplicate.isError, true);
    assert.equal(harness.fake.callsMatching('agent', 'start').length, 1);
    assert.equal(harness.fake.callsMatching('agent', 'prompt').length, 1);
    assert.equal(Object.keys((await harness.readState()).agents).length, 1);
  });
});

test('session_shutdown cancels an in-flight widget tick without pruning or restarting', async () => {
  await withHarness({}, async (harness) => {
    // Hold the tick inside its first Herdr call, which is where a real tick sits
    // when a test tears its harness down.
    harness.fake.holdCommand('api snapshot');
    await fs.writeFile(
      harness.statePath,
      `${JSON.stringify(
        {
          version: 2,
          agents: {
            'terminal:gone': {
              lifecycle: 'oneshot',
              tabLabel: 'Gone',
              updatedAt: new Date().toISOString(),
            },
          },
          closedHistory: [],
        },
        null,
        2,
      )}\n`,
    );

    await harness.fire('session_start');
    await harness.waitFor(
      () => harness.fake.callsMatching('api', 'snapshot').length > 0,
      'the first widget tick',
    );

    let settled = false;
    const shutdown = harness
      .fire('session_shutdown')
      .then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Recorded before the release, so a failed assertion still tears down.
    const settledWhileHeld = settled;

    harness.fake.releaseCommands();
    await shutdown;

    assert.equal(
      settledWhileHeld,
      true,
      'shutdown did not cancel the held Herdr call',
    );
    assert.ok((await harness.readState()).agents['terminal:gone']);
    const calls = harness.fake.callsMatching('api', 'snapshot').length;
    await harness.fire('session_start');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(harness.fake.callsMatching('api', 'snapshot').length, calls);
    assert.equal(harness.messages.length, 0);
  });
});

test('shutdown cancels a widget state-lock wait without leaving a pruning mutation queued', async () => {
  await withHarness({}, async (harness) => {
    await fs.mkdir(`${harness.statePath}.lock`);
    const before = JSON.stringify({
      version: 2,
      agents: { 'terminal:gone': { lifecycle: 'oneshot', updatedAt: '' } },
      closedHistory: [],
    });
    await fs.writeFile(harness.statePath, before);
    await harness.fire('session_start');
    await harness.waitFor(
      () => harness.fake.callsMatching('api', 'snapshot').length > 0,
      'widget snapshot',
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await harness.fire('session_shutdown');
    await fs.rmdir(`${harness.statePath}.lock`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await fs.readFile(harness.statePath, 'utf8'), before);
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

test('uses tabs instead of panes when the tab layout is configured', async () => {
  await withHarness({ layout: 'tab' }, async (harness) => {
    const result = await harness.call({ agent: 'scout', task: 'Find it' });

    assert.match(result.content[0].text, /started/);
    await harness.collect('Scout');
    const create = harness.fake.callsMatching('tab', 'create')[0];
    assert.ok(create, 'expected a tab create');
    assert.equal(flagValue(create, '--label'), 'Scout');
    assert.ok(create.includes('HERDR_AGENT_CHILD=1'));
    assert.equal(harness.fake.callsMatching('pane', 'split').length, 0);
    assert.equal(harness.fake.callsMatching('tab', 'close').length, 1);
    // No pane column to rebalance in tab layout.
    assert.equal(harness.fake.ratioUpdates.length, 0);
  });
});

test('spawns a one-shot into the Agents workspace and closes its tab', async () => {
  await withHarness({ layout: 'workspace' }, async (harness) => {
    const result = await harness.call({ agent: 'scout', task: 'Find it' });

    assert.match(result.content[0].text, /started/);
    await harness.collect('Scout');

    // The Agents workspace was resolved live and created once, unfocused.
    assert.ok(
      harness.fake.callsMatching('workspace', 'list').length >= 1,
      'expected a workspace list lookup',
    );
    const create = harness.fake.callsMatching('workspace', 'create')[0];
    assert.ok(create, 'expected the Agents workspace to be created');
    assert.equal(flagValue(create, '--label'), 'subagents');
    assert.ok(create.includes('--no-focus'));

    const workspaceCreate = harness.fake.callsMatching(
      'workspace',
      'create',
    )[0];
    assert.ok(workspaceCreate, 'expected a workspace create');

    // The agent got its own tab in the new Agents workspace, not a split and
    // not a tab next to the Orchestrator.
    const tabCreate = harness.fake.callsMatching('tab', 'create')[0];
    assert.ok(tabCreate, 'expected a tab create');
    const agentsWorkspaceId = flagValue(tabCreate, '--workspace');
    assert.ok(
      agentsWorkspaceId && agentsWorkspaceId !== harness.fake.workspaceId,
      `expected a separate Agents workspace id, got ${agentsWorkspaceId}`,
    );
    assert.equal(flagValue(tabCreate, '--label'), 'Scout');
    assert.ok(tabCreate.includes('--no-focus'));
    assert.equal(harness.fake.callsMatching('pane', 'split').length, 0);
    assert.equal(harness.fake.ratioUpdates.length, 0);

    // Collection closed the agent tab, and the spawn dropped the empty root
    // shell tab the workspace started with; the Orchestrator workspace is
    // untouched, and real Herdr (and the fake) remove a workspace once its
    // last tab closes, so nothing is left behind.
    assert.equal(harness.fake.callsMatching('tab', 'close').length, 2);
    assert.deepEqual(
      harness.fake.panes
        .filter((pane) => pane.workspace_id === harness.fake.workspaceId)
        .map((pane) => pane.pane_id),
      [harness.fake.orchestratorPane.pane_id],
    );
    assert.equal(
      harness.fake.workspaces.find(
        (workspace) => workspace.label === 'subagents',
      ),
      undefined,
    );
    const history = (await harness.readState()).closedHistory;
    assert.equal(history[0]?.layout, 'workspace');
    assert.equal(history[0]?.tabLabel, 'Scout');
  });
});

test('recreates the Agents workspace after the user closed it by hand', async () => {
  await withHarness({ layout: 'workspace' }, async (harness) => {
    // A detached, never-settling spawn keeps the first workspace alive.
    harness.fake.setBehavior(() => ({ neverSettle: true }));
    await harness.callRaw({
      agent: 'scout',
      task: 'stay',
      tabLabel: 'Scout One',
    });
    const first = harness.fake.workspaces.find(
      (workspace) => workspace.label === 'subagents',
    );
    assert.ok(first);
    assert.equal(harness.fake.callsMatching('workspace', 'create').length, 1);

    // The user closes the whole workspace; the next spawn must recover.
    assert.ok(harness.fake.closeWorkspaceById(first.workspace_id));

    await harness.callRaw({
      agent: 'scout',
      task: 'second',
      tabLabel: 'Scout Two',
    });
    assert.equal(harness.fake.callsMatching('workspace', 'create').length, 2);
    const secondWorkspaceId = flagValue(
      harness.fake.callsMatching('tab', 'create').at(-1)!,
      '--workspace',
    );
    assert.ok(secondWorkspaceId);
    assert.notEqual(secondWorkspaceId, first.workspace_id);
    // The recreated workspace holds a live agent this time, so it stays.
    assert.ok(
      harness.fake.workspaces.find(
        (workspace) => workspace.label === 'subagents',
      ),
    );
  });
});

test('delivers an unseen done completion, notifies, and closes the one-shot', async () => {
  await withHarness({ layout: 'workspace' }, async (harness) => {
    // The child settles as `done` — Herdr's marker for background work the
    // user has never seen — instead of `idle`.
    harness.fake.setBehavior(() => ({
      result: 'Background done.',
      settleStatus: 'done',
    }));

    await harness.call({
      agent: 'scout',
      task: 'Background job',
    });

    await harness.waitFor(
      () => harness.messages.length > 0,
      'detached done-status delivery',
    );

    const [message] = harness.messages;
    assert.equal(message?.customType, 'herdr_agent_result');
    assert.match(message?.content ?? '', /Background done\./);
    assert.equal(message?.triggerTurn, true);

    // Unseen completions ping the user through Herdr's own notifications.
    const notify = harness.fake.callsMatching('notification', 'show')[0];
    assert.ok(notify, 'expected a Herdr notification');
    assert.equal(notify[2], 'Pi · Scout finished');
    assert.equal(flagValue(notify, '--body'), 'Background done.');

    // Delivered exactly once, tab closed, state pruned.
    await harness.fire('session_start');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(harness.messages.length, 1);
    // Only the agent's own tab existed; the poller closed it and the emptied
    // workspace vanished with it.
    assert.equal(
      harness.fake.workspaces.find(
        (workspace) => workspace.label === 'subagents',
      ),
      undefined,
    );
    assert.deepEqual((await harness.readState()).agents, {});
  });
});

test('/herdr-agents focuses an Agents-workspace agent via tab focus', async () => {
  await withHarness(
    { layout: 'workspace', dialogInputs: [['\r']] },
    async (harness) => {
      harness.fake.setBehavior(() => ({ neverSettle: true }));
      await harness.callRaw({
        agent: 'scout',
        task: 'stay',
        tabLabel: 'Scout Ws',
      });

      await harness.runCommand('herdr-agents');

      const focus = harness.fake.callsMatching('tab', 'focus')[0];
      assert.ok(
        focus,
        `expected a tab focus, calls: ${JSON.stringify(harness.fake.calls.slice(-4))}`,
      );
      const agentsWorkspace = harness.fake.workspaces.find(
        (workspace) => workspace.label === 'subagents',
      );
      assert.ok(agentsWorkspace);
      assert.ok(
        focus[2]?.startsWith(`${agentsWorkspace.workspace_id}:`),
        `expected a cross-workspace tab id, got ${focus[2]}`,
      );
      assert.match(
        harness.notifications.at(-1)?.message ?? '',
        /Focused Herdr agent "Scout Ws"/,
      );
      // The empty root tab was dropped at spawn; focusing must not close the
      // agent itself.
      assert.equal(
        harness.fake.panes.filter(
          (pane) => pane.workspace_id === agentsWorkspace.workspace_id,
        ).length,
        1,
      );
    },
  );
});

test('serializes parallel workspace spawns into one workspace and unique labels', async () => {
  await withHarness({ layout: 'workspace' }, async (harness) => {
    // Keep all three agents live past the last placement so the assertions
    // describe three simultaneously existing tabs. Delay agent start so it
    // lands after other spawns' cleanup windows — pane.agent is unset until
    // start returns, which is what used to make a sibling spawn close a live
    // agent tab as "empty".
    harness.fake.delayAgentStart(400);
    harness.fake.setBehavior((turn) => ({
      result: `Result from ${turn.agentName}`,
      delayMs: 1200,
    }));

    const results = await Promise.all([
      harness.call({ agent: 'scout', task: 'one' }),
      harness.call({ agent: 'scout', task: 'two' }),
      harness.call({ agent: 'scout', task: 'three' }),
    ]);
    for (const result of results) {
      assert.equal(result.isError, undefined);
      assert.match(result.content[0].text, /started/);
    }
    await harness.waitFor(
      () => harness.messages.length >= 3,
      'three workspace results',
      8000,
    );

    // One shared Agents workspace, created exactly once.
    assert.equal(harness.fake.callsMatching('workspace', 'create').length, 1);
    // Every agent got its own tab there, with a unique label.
    const creates = harness.fake.callsMatching('tab', 'create');
    assert.equal(creates.length, 3);
    assert.deepEqual(creates.map((argv) => flagValue(argv, '--label')).sort(), [
      'Scout',
      'Scout #2',
      'Scout #3',
    ]);
    assert.ok(creates.every((argv) => argv.includes('--no-focus')));
    assert.equal(harness.fake.callsMatching('pane', 'split').length, 0);

    const calls = harness.fake.calls;
    const tabCreateIdx = calls.flatMap((argv, index) =>
      argv[0] === 'tab' && argv[1] === 'create' ? [index] : [],
    );
    const agentStartIdx = calls.flatMap((argv, index) =>
      argv[0] === 'agent' && argv[1] === 'start' ? [index] : [],
    );
    const tabCloseIdx = calls.flatMap((argv, index) =>
      argv[0] === 'tab' && argv[1] === 'close' ? [index] : [],
    );
    assert.equal(tabCreateIdx.length, 3);
    assert.equal(agentStartIdx.length, 3);
    // Root tab once (creating spawn) plus the three agent tabs at collection.
    assert.equal(tabCloseIdx.length, 4);
    const rootCloseId = calls[tabCloseIdx[0]!]![2];
    const collectionCloseIds = tabCloseIdx
      .slice(1)
      .map((index) => calls[index]![2]);
    assert.ok(rootCloseId, 'expected the creating spawn to close the root tab');
    assert.equal(collectionCloseIds.length, 3);
    assert.ok(
      collectionCloseIds.every((id) => id !== rootCloseId),
      'collection must close agent tabs, not the root tab again',
    );
    // Subsequent spawns must not close anything between their tab create and
    // agent start — that window is where the empty-tab heuristic used to
    // kill a sibling whose agent had not started.
    for (let spawn = 1; spawn < 3; spawn++) {
      const createAt = tabCreateIdx[spawn]!;
      const startAt = agentStartIdx[spawn]!;
      const intervening = tabCloseIdx.filter(
        (index) => index > createAt && index < startAt,
      );
      assert.equal(
        intervening.length,
        0,
        `spawn ${spawn + 1} closed a tab between tab create and agent start`,
      );
    }
  });
});

test('status check in workspace mode is a pure lookup and never creates the workspace', async () => {
  await withHarness({ layout: 'workspace' }, async (harness) => {
    const ghost = await harness.call({ agent: 'scout', tabLabel: 'Ghost' });
    assert.equal(ghost.isError, true);
    assert.match(ghost.content[0].text, /No running Herdr agent named "Ghost"/);
    // A missing workspace means "nothing to find", not a fresh workspace.
    assert.equal(harness.fake.callsMatching('workspace', 'create').length, 0);

    // A live detached agent is still findable by label.
    harness.fake.setBehavior(() => ({ neverSettle: true }));
    await harness.call({
      agent: 'scout',
      task: 'stay',
      tabLabel: 'Scout Live',
    });
    const rewait = await harness.call({
      agent: 'scout',
      tabLabel: 'Scout Live',
    });
    assert.match(rewait.content[0].text, /status: /);
    // Still exactly the one workspace the spawn above created — the status check
    // added none.
    assert.equal(harness.fake.callsMatching('workspace', 'create').length, 1);
  });
});

for (const layout of ['tab', 'workspace'] as const) {
  test(`preserves the logical label through renamed ${layout} question, status check and resume`, async () => {
    await withHarness({ layout }, async (harness) => {
      harness.fake.setBehavior((turn) =>
        turn.turn === 1 ? { question: 'Which color?' } : { result: 'green' },
      );
      const asked = await harness.call({ agent: 'scout', task: 'Choose' });
      const tab = harness.fake.tabs.find(
        (item) => item.tab_id === asked.details.tabId,
      );
      assert.ok(tab);
      tab.label = 'pi';
      const question = await harness.collect('Scout');
      assert.match(question.content, /tabLabel "Scout"/);

      const rewaited = await harness.call({
        agent: 'scout',
        tabLabel: 'Scout',
      });
      assert.equal(rewaited.details.tabLabel, 'Scout');
      assert.equal(rewaited.details.status, 'question');

      const answered = await harness.call({
        agent: 'scout',
        tabLabel: 'Scout',
        task: 'Use green',
      });
      assert.equal(answered.details.reused, true);
      assert.equal(answered.details.tabLabel, 'Scout');
      await harness.collect('Scout');
      assert.equal(
        (await harness.readState()).closedHistory[0]?.tabLabel,
        'Scout',
      );

      harness.fake.setBehavior(() => ({ result: 'green remembered' }));
      const resumed = await harness.call({
        agent: 'scout',
        tabLabel: 'Scout',
        task: 'Recall color',
        resumeClosed: true,
      });
      assert.equal(resumed.details.resumed, true);
      assert.equal(resumed.details.tabLabel, 'Scout');
      const remembered = await harness.collect('Scout');
      assert.match(remembered.content, /green remembered/);
    });
  });

  test(`reserves logical labels after a watcher renames ${layout} tabs`, async () => {
    await withHarness({ layout }, async (harness) => {
      harness.fake.setBehavior(() => ({ neverSettle: true }));
      const first = await harness.callRaw({ agent: 'scout', task: 'First' });
      const tab = harness.fake.tabs.find(
        (item) => item.tab_id === first.details.tabId,
      );
      assert.ok(tab);
      tab.label = 'pi';

      const second = await harness.callRaw({ agent: 'scout', task: 'Second' });
      assert.equal(second.details.tabLabel, 'Scout #2');
      assert.deepEqual(
        Object.values((await harness.readState()).agents)
          .map((record) => record.tabLabel)
          .sort(),
        ['Scout', 'Scout #2'],
      );
    });
  });
}

test('continues a closed workspace agent via resumeClosed', async () => {
  await withHarness({ layout: 'workspace' }, async (harness) => {
    const first = await harness.call({
      agent: 'scout',
      task: 'first',
      tabLabel: 'Scout Ws',
    });
    await harness.collect('Scout Ws');
    assert.equal(first.details.reused, false);

    const second = await harness.call({
      agent: 'scout',
      task: 'second',
      tabLabel: 'Scout Ws',
      resumeClosed: true,
    });
    await harness.collect('Scout Ws');
    assert.equal(second.details.resumed, true);
    // The emptied workspace vanished with the first close, so the resume
    // re-created it, and each task spawned its own agent tab.
    assert.equal(harness.fake.callsMatching('workspace', 'create').length, 2);
    assert.equal(harness.fake.callsMatching('tab', 'create').length, 2);
  });
});

test('follow-up spawns perform no extra spawn-phase tab close', async () => {
  await withHarness({ layout: 'workspace' }, async (harness) => {
    harness.fake.setBehavior(() => ({ neverSettle: true }));
    await harness.callRaw({
      agent: 'scout',
      task: 'first',
      tabLabel: 'Scout Ws',
    });
    const closesAfterFirst = harness.fake.callsMatching('tab', 'close').length;
    // Creating spawn closes the workspace root tab; the agent tab stays open.
    assert.equal(closesAfterFirst, 1);

    await harness.callRaw({
      agent: 'scout',
      task: 'second',
      tabLabel: 'Scout Ws 2',
    });
    assert.equal(
      harness.fake.callsMatching('tab', 'close').length,
      closesAfterFirst,
      'spawn must not close tabs beyond workspace creation',
    );
  });
});

test("refuses a workspace.label that matches the Orchestrator's own workspace", async () => {
  await withHarness({ layout: 'workspace' }, async (harness) => {
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    assert.ok(agentDir, 'expected the harness to set PI_CODING_AGENT_DIR');
    await fs.writeFile(
      path.join(agentDir, 'herdr-agents.json'),
      `${JSON.stringify({ layout: 'workspace', workspace: { label: 'main' } })}\n`,
    );

    const result = await harness.call({ agent: 'scout', task: 'nope' });
    assert.equal(result.isError, true);
    assert.match(
      result.content[0].text,
      /workspace\.label matches this Orchestrator's own workspace/,
    );
    assert.match(result.content[0].text, /herdr-agents\.json/);
    assert.equal(harness.fake.callsMatching('tab', 'create').length, 0);
  });
});

test('resumeClosed archives and resumes in workspace mode', async () => {
  await withHarness({ layout: 'workspace' }, async (harness) => {
    const first = await harness.call({
      agent: 'scout',
      task: 'Remember the token ALPHA-42.',
      tabLabel: 'Scout Ws Resume',
    });
    await harness.collect(first.details.tabLabel);
    const history = (await harness.readState()).closedHistory;
    assert.equal(history.length, 1);

    const resumed = await harness.call({
      agent: 'scout',
      task: 'What token did I ask you to remember?',
      tabLabel: 'Scout Ws Resume',
      resumeClosed: true,
    });
    const remembered = await harness.collect('Scout Ws Resume');
    assert.equal(resumed.details.resumed, true);
    assert.match(remembered.content, /Result from scout_/);
  });
});

test('injects Orchestrator instructions, and /run instructions for one turn', async () => {
  await withHarness({}, async (harness) => {
    const base = (await harness.fire('before_agent_start', {
      systemPrompt: 'BASE',
      prompt: 'hi',
      systemPromptOptions: { sections: { unrelated: 'KEEP' } },
    })) as any;
    assert.equal(base.systemPrompt, 'BASE');
    assert.equal(base.systemPromptOptions.sections.unrelated, 'KEEP');
    assert.match(
      base.systemPromptOptions.sections.herdr_agents,
      /^## Herdr agents/,
    );
    assert.doesNotMatch(
      base.systemPromptOptions.sections.herdr_agents,
      /\/run delegation/,
    );

    const run = harness.commands.get('run');
    assert.ok(run, 'expected a /run command');
    await run.handler('scout find the auth flow', {
      isIdle: () => true,
      ui: { notify: () => undefined },
    });
    assert.deepEqual(harness.userMessages, [
      '[via /run → scout] find the auth flow',
    ]);

    const custom = (await harness.fire('before_agent_start', {
      messageType: 'custom',
      message: { customType: 'herdr_agent_result', content: 'finished' },
    })) as any;
    assert.match(
      custom.systemPromptOptions.sections.herdr_agents,
      /## Herdr agents/,
    );
    assert.doesNotMatch(
      custom.systemPromptOptions.sections.herdr_agents,
      /\/run delegation/,
    );

    const delegating = (await harness.fire('before_agent_start', {
      systemPrompt: 'BASE',
      prompt: 'hi',
    })) as any;
    assert.match(
      delegating.systemPromptOptions.sections.herdr_agents,
      /## \/run delegation/,
    );
    assert.match(
      delegating.systemPromptOptions.sections.herdr_agents,
      /agent: "scout"/,
    );

    // The /run authorization is single-turn.
    const after = (await harness.fire('before_agent_start', {
      systemPrompt: 'BASE',
      prompt: 'hi',
    })) as any;
    assert.doesNotMatch(
      after.systemPromptOptions.sections.herdr_agents,
      /\/run delegation/,
    );
  });
});

// The scenarios below come from behaviors that were verified by hand during
// development.

test('targets the pane from HERDR_PANE_ID, not whatever Herdr reports as focused', async () => {
  // Focus can move to something the user clicked while a tool is running.
  await withHarness({}, async (harness) => {
    // Another pane holds focus; the Orchestrator is elsewhere.
    harness.fake.panes.push({
      pane_id: 'w1:decoy',
      tab_id: harness.fake.orchestratorPane.tab_id,
      workspace_id: harness.fake.workspaceId,
      terminal_id: 'term-decoy',
      focused: true,
      agent: 'pi',
      agent_status: 'idle',
      env: {},
    });
    harness.fake.focusedPaneId = 'w1:decoy';

    await harness.call({ agent: 'scout', task: 'Find it' });

    const split = harness.fake.callsMatching('pane', 'split')[0];
    assert.equal(split?.[2], harness.fake.orchestratorPane.pane_id);
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
    assert.match(second.content[0].text, /started/);
    assert.doesNotMatch(second.content[0].text, /Which approach?/);
    const secondDelivery = await harness.collect('Scout');
    assert.match(secondDelivery.content, /SECOND TURN RESULT/);
    assert.doesNotMatch(secondDelivery.content, /Which approach?/);
  });
});

test('collects a child that finishes as done rather than idle', async () => {
  // Completed children can settle as either status.
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({
      result: 'DONE-STATUS RESULT',
      settleStatus: 'done',
    }));

    const result = await harness.call({ agent: 'scout', task: 'Find it' });
    const delivered = await harness.collect(result.details.tabLabel);

    assert.match(delivered.content, /DONE-STATUS RESULT/);
  });
});

test('removes the managed temp directory on close but keeps it while an agent runs', async () => {
  // system.md and result.md share one private temp dir per agent.
  await withHarness(
    { profiles: [{ name: 'scout' }, { name: 'worker' }] },
    async (harness) => {
      // A detached agent that never settles keeps its directory.
      harness.fake.setBehavior((turn) =>
        turn.agentName.startsWith('scout')
          ? { neverSettle: true }
          : { result: 'worker done' },
      );
      await harness.callRaw({ agent: 'scout', task: 'keep me' });
      const detachedRecord = Object.values(
        (await harness.readState()).agents,
      )[0];
      const detachedDir = path.dirname(detachedRecord?.resultFile ?? '');
      assert.ok(detachedRecord?.resultFile);
      // result.md is cleared after spawn and re-created when the child writes.
      assert.deepEqual((await fs.readdir(detachedDir)).sort(), [
        'session.json',
        'system.md',
      ]);

      await harness.call({ agent: 'worker', task: 'close me' });
      await harness.collect('Worker');
      // The closed one-shot's own directory is gone; the running one is kept.
      const dirs = await fs.readdir(path.dirname(detachedDir));
      assert.equal(
        dirs.filter((name) => name.startsWith('herdr-agent-')).length,
        1,
      );
      assert.ok(
        await fs.stat(path.join(detachedDir, 'system.md')).catch(() => null),
      );
    },
  );
});

test('delivers two detached outcomes as one batch with a single turn trigger', async () => {
  // Two agents asking in parallel used to surface a whole turn apart, because
  // triggering on the first message made the rest queue behind that turn.
  await withHarness({ isIdle: false }, async (harness) => {
    harness.fake.setBehavior((turn) => ({
      question: `Question from ${turn.agentName}?`,
    }));

    // Neither child runs until both are spawned, so both settle in the same
    // poller tick — the condition the batching exists for.
    harness.fake.holdChildren();
    await harness.call({
      agent: 'scout',
      task: 'a',
      tabLabel: 'Scout A',
    });
    await harness.call({
      agent: 'scout',
      task: 'b',
      tabLabel: 'Scout B',
    });
    await harness.fake.releaseChildren();

    await harness.waitFor(
      () => harness.messages.length >= 2,
      'both detached questions delivered',
    );

    assert.equal(harness.messages.length, 2);
    assert.deepEqual(
      harness.messages.map((message) => message.customType),
      ['herdr_agent_question', 'herdr_agent_question'],
    );
    // Only the last message starts a turn; both are steered because the
    // Orchestrator is mid-turn.
    assert.deepEqual(
      harness.messages.map((message) => message.triggerTurn),
      [undefined, true],
    );
    assert.deepEqual(
      harness.messages.map((message) => message.deliverAs),
      ['steer', 'steer'],
    );
    assert.deepEqual(
      harness.messages.map((message) => message.details.tabLabel).sort(),
      ['Scout A', 'Scout B'],
    );
  });
});

test('bounds busy-shell retries and leaves the failed startup pane open', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.failEveryStart('agent_pane_busy');

    await assert.rejects(
      () => harness.call({ agent: 'scout', task: 'Find it' }),
      (error: unknown) => {
        assert.match(String(error), /agent_pane_busy/);
        return true;
      },
    );

    assert.ok(harness.fake.callsMatching('agent', 'start').length > 1);
    assert.equal(harness.fake.callsMatching('pane', 'split').length, 1);
    assert.equal(harness.fake.callsMatching('agent', 'prompt').length, 0);
    assert.equal(harness.fake.callsMatching('pane', 'close').length, 0);
    // The split pane is left for inspection, and no agent was recorded.
    assert.deepEqual((await harness.readState()).agents, {});
  });
});

test('/herdr-agents focuses a managed agent', async () => {
  await withHarness(
    // enter selects the single listed agent
    { dialogInputs: [['\r']] },
    async (harness) => {
      harness.fake.setBehavior(() => ({ neverSettle: true }));
      await harness.callRaw({ agent: 'scout', task: 'stay' });

      await harness.runCommand('herdr-agents');

      const focus = harness.fake.callsMatching('agent', 'focus')[0];
      assert.ok(
        focus,
        `expected an agent focus, calls: ${JSON.stringify(harness.fake.calls.slice(-4))}`,
      );
      assert.equal(focus[2], harness.fake.paneByLabel('Scout')?.pane_id);
      assert.match(
        harness.notifications.at(-1)?.message ?? '',
        /Focused Herdr agent "Scout"/,
      );
      // Focusing must not close the agent.
      assert.equal(harness.fake.panes.length, 2);
    },
  );
});

test('/herdr-agents closes a managed agent and cleans up its temp directory', async () => {
  await withHarness(
    // d closes the selected agent, then the reopened list is cancelled
    { dialogInputs: [['d']] },
    async (harness) => {
      // A held child never starts its turn, so the agent is idle and the
      // manager may close it.
      harness.fake.holdChildren();
      await harness.callRaw({ agent: 'scout', task: 'stay' });
      const record = Object.values((await harness.readState()).agents)[0];
      const tempDir = path.dirname(record?.resultFile ?? '');
      assert.ok(record?.resultFile);

      await harness.runCommand('herdr-agents');

      assert.deepEqual(
        harness.fake.panes.map((pane) => pane.pane_id),
        [harness.fake.orchestratorPane.pane_id],
      );
      assert.equal(await fs.stat(tempDir).catch(() => null), null);
      assert.match(
        harness.notifications.at(-1)?.message ?? '',
        /Closed Herdr agent "Scout"/,
      );
    },
  );
});

test('/herdr-agents reports an empty workspace instead of failing', async () => {
  await withHarness({}, async (harness) => {
    await harness.runCommand('herdr-agents');
    assert.deepEqual(harness.notifications, []);
    assert.deepEqual(harness.fake.callsMatching('pane', 'close'), []);
  });
});

test('archives a completed one-shot and resumes it with --session', async () => {
  await withHarness({}, async (harness) => {
    const first = await harness.call({
      agent: 'scout',
      task: 'first slice',
      tabLabel: 'Scout Resume',
    });
    await harness.collect(first.details.tabLabel);
    const history = (await harness.readState()).closedHistory ?? [];
    assert.equal(history.length, 1);
    assert.equal(history[0]?.tabLabel, 'Scout Resume');
    assert.equal(history[0]?.status, 'resumable');
    const sessionFile = history[0]?.childSessionFile;
    assert.ok(sessionFile && path.isAbsolute(sessionFile));

    const resumed = await harness.call({
      agent: 'scout',
      task: 'second slice',
      tabLabel: 'Scout Resume',
      resumeClosed: true,
    });
    await harness.collect('Scout Resume');
    if (resumed.isError) {
      throw new Error(`resume failed: ${resumed.content[0].text}`);
    }
    assert.equal(resumed.details.resumed, true);

    const starts = harness.fake.callsMatching('agent', 'start');
    const resumeStart = starts.at(-1) ?? [];
    const separator = resumeStart.indexOf('--');
    const piArgs = resumeStart.slice(separator + 1);
    assert.equal(flagValue(piArgs, '--session'), sessionFile);
    assert.equal(piArgs.includes('--name'), false);

    const after = (await harness.readState()).closedHistory ?? [];
    assert.equal(after.length, 1);
    assert.equal(after[0]?.id, history[0]?.id);
    assert.equal(after[0]?.status, 'resumable');
  });
});

test('resumeClosed errors when the child JSONL is missing or mismatched', async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: 'scout',
      task: 'first',
      tabLabel: 'Scout Resume',
    });
    await harness.collect('Scout Resume');
    const history = (await harness.readState()).closedHistory ?? [];
    const sessionFile = history[0]?.childSessionFile;
    assert.ok(sessionFile);
    await fs.rm(sessionFile);

    const missing = await harness.call({
      agent: 'scout',
      task: 'again',
      tabLabel: 'Scout Resume',
      resumeClosed: true,
    });
    assert.equal(missing.isError, true);
    assert.match(
      missing.content[0].text,
      /missing, corrupt, or does not match/,
    );
    assert.equal(harness.fake.callsMatching('agent', 'start').length, 1);
  });
});

test('resumeClosed fails closed when placement state pruning fails', async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: 'scout',
      task: 'first',
      tabLabel: 'Scout Resume',
    });
    await harness.collect('Scout Resume');
    await harness.fire('session_shutdown');
    const state = await harness.readState();
    const history = state.closedHistory[0]!;
    await fs.rm(history.childSessionFile);
    state.agents['terminal:gone'] = {
      lifecycle: 'oneshot',
      paneId: 'gone',
      collected: false,
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(harness.statePath, JSON.stringify(state));
    setFailNextStateSaves(1);

    const result = await harness.call({
      agent: 'scout',
      task: 'again',
      tabLabel: 'Scout Resume',
      resumeClosed: true,
    });
    assert.equal(result.isError, true);
    assert.equal(
      result.content[0].text,
      'No closed one-shot Herdr agent named "Scout Resume" is owned by this Orchestrator session.',
    );
    assert.equal(harness.fake.callsMatching('agent', 'start').length, 1);
    assert.equal(harness.fake.callsMatching('pane', 'split').length, 1);
    assert.deepEqual(
      (await harness.readState()).closedHistory,
      state.closedHistory,
    );
  });
});

for (const claimed of [false, true]) {
  test(`resumeClosed preserves ${claimed ? 'claimed' : 'wrong-profile'} history with a missing session`, async () => {
    await withHarness(
      { profiles: [{ name: 'scout' }, { name: 'worker' }] },
      async (harness) => {
        await harness.call({
          agent: 'scout',
          task: 'first',
          tabLabel: 'Scout Resume',
        });
        await harness.collect('Scout Resume');
        await harness.fire('session_shutdown');
        const state = await harness.readState();
        const history = state.closedHistory[0]!;
        await fs.rm(history.childSessionFile);
        if (claimed) {
          history.status = 'claimed';
          history.claimGeneration += 1;
          history.claimedAt = new Date().toISOString();
        }
        await fs.writeFile(harness.statePath, JSON.stringify(state));

        const result = await harness.call({
          agent: 'worker',
          task: 'again',
          tabLabel: 'Scout Resume',
          resumeClosed: true,
        });
        assert.equal(result.isError, true);
        assert.equal(
          result.content[0].text,
          claimed
            ? 'Closed Herdr agent "Scout Resume" is already being resumed.'
            : 'Closed Herdr agent "Scout Resume" was a scout agent, not worker.',
        );
        assert.deepEqual(
          (await harness.readState()).closedHistory,
          state.closedHistory,
        );
        assert.equal(harness.fake.callsMatching('agent', 'start').length, 1);
      },
    );
  });
}

test('resumeClosed releases no claim when invalidation succeeded', async () => {
  await withHarness({}, async (harness) => {
    const state = await seedClosedOneShotWithMissingSession(harness);
    const restore = failStateReadOnce(harness, (raw) =>
      raw.includes('"status": "invalid"'),
    );
    try {
      const result = await harness.call({
        agent: 'scout',
        task: 'again',
        tabLabel: 'Scout Resume',
        resumeClosed: true,
      });
      assert.equal(result.isError, true);
      assert.equal(
        result.content[0].text,
        'Cannot resume "Scout Resume": child session file is missing, corrupt, or does not match the stored session id/cwd.',
      );
    } finally {
      restore();
    }

    const after = await harness.readState();
    assert.equal(after.closedHistory.length, state.closedHistory.length);
    assert.equal(after.closedHistory[0]!.status, 'invalid');
    assert.equal(harness.fake.callsMatching('agent', 'start').length, 1);
  });
});

test('resumeClosed releases the claim again when invalidation failed', async () => {
  await withHarness({}, async (harness) => {
    const state = await seedClosedOneShotWithMissingSession(harness);
    const restore = failStateReadOnce(harness, (raw) =>
      raw.includes('"status": "claimed"'),
    );
    try {
      const result = await harness.call({
        agent: 'scout',
        task: 'again',
        tabLabel: 'Scout Resume',
        resumeClosed: true,
      });
      assert.equal(result.isError, true);
      assert.match(
        result.content[0].text,
        /missing, corrupt, or does not match/,
      );
    } finally {
      restore();
    }

    const after = await harness.readState();
    assert.equal(after.closedHistory[0]!.status, 'resumable');
    assert.equal('claimedAt' in after.closedHistory[0]!, false);
    assert.equal(
      after.closedHistory[0]!.claimGeneration,
      state.closedHistory[0]!.claimGeneration + 1,
    );
  });
});

test("another Orchestrator session cannot resume this session's closed agent", async () => {
  await withHarness({}, async (first) => {
    await first.call({
      agent: 'scout',
      task: 'first',
      tabLabel: 'Scout Resume',
    });
    const state = await first.readState();
    await withHarness({ sessionId: 'other-orch' }, async (second) => {
      await fs.writeFile(
        second.statePath,
        `${JSON.stringify(state, null, 2)}\n`,
      );
      const result = await second.call({
        agent: 'scout',
        task: 'steal',
        tabLabel: 'Scout Resume',
        resumeClosed: true,
      });
      assert.equal(result.isError, true);
      assert.match(
        result.content[0].text,
        /owned by this Orchestrator session/,
      );
    });
  });
});

test('concurrent resumeClosed has a single winner', async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: 'scout',
      task: 'first',
      tabLabel: 'Scout Resume',
    });
    await harness.collect('Scout Resume');
    harness.fake.setBehavior(() => ({
      result: 'resumed',
      delayMs: 400,
    }));
    const results = await Promise.all([
      harness.call({
        agent: 'scout',
        task: 'a',
        tabLabel: 'Scout Resume',
        resumeClosed: true,
      }),
      harness.call({
        agent: 'scout',
        task: 'b',
        tabLabel: 'Scout Resume',
        resumeClosed: true,
      }),
    ]);
    assert.equal(results.filter((item) => !item.isError).length, 1);
    assert.equal(results.filter((item) => item.isError).length, 1);
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

test('detached one-shot completion archives before cleanup', async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: 'scout',
      task: 'background',
      tabLabel: 'Scout Detached Resume',
    });
    await harness.collect('Scout Detached Resume');
    await harness.waitFor(async () => {
      const history = (await harness.readState()).closedHistory ?? [];
      // Wait for the final status: the record is staged first and promoted
      // to resumable after pane cleanup, so a bare length check races.
      return (
        history.length === 1 &&
        history[0]?.status === 'resumable' &&
        harness.fake.panes.length === 1
      );
    }, 'detached one-shot to archive and close');
    const history = (await harness.readState()).closedHistory ?? [];
    assert.equal(history[0]?.tabLabel, 'Scout Detached Resume');
    assert.equal(history[0]?.status, 'resumable');
  });
});

test('spawn failure after claim releases the closed history slot', async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: 'scout',
      task: 'first',
      tabLabel: 'Scout Resume',
    });
    await harness.collect('Scout Resume');
    harness.fake.failEveryStart('agent_start_failed');
    await assert.rejects(() =>
      harness.call({
        agent: 'scout',
        task: 'again',
        tabLabel: 'Scout Resume',
        resumeClosed: true,
      }),
    );
    const history = (await harness.readState()).closedHistory ?? [];
    assert.equal(history[0]?.status, 'resumable');
  });
});

test('malformed target creation after claim rolls the history slot back', async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: 'scout',
      task: 'first',
      tabLabel: 'Scout Resume',
    });
    await harness.collect('Scout Resume');
    harness.fake.malformCommand('pane split', '<html>nope</html>');
    await assert.rejects(() =>
      harness.call({
        agent: 'scout',
        task: 'again',
        tabLabel: 'Scout Resume',
        resumeClosed: true,
      }),
    );
    const history = (await harness.readState()).closedHistory ?? [];
    assert.equal(history[0]?.status, 'resumable');
    assert.equal(harness.fake.panes.length, 1);
  });
});

test('lifecycle write failure after start releases the claim and closes the partial target', async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: 'scout',
      task: 'first',
      tabLabel: 'Scout Resume',
    });
    await harness.collect('Scout Resume');
    setFailNextStateMutation('lifecycle');
    await assert.rejects(() =>
      harness.call({
        agent: 'scout',
        task: 'again',
        tabLabel: 'Scout Resume',
        resumeClosed: true,
      }),
    );
    const history = (await harness.readState()).closedHistory ?? [];
    assert.equal(history[0]?.status, 'resumable');
    assert.equal(harness.fake.panes.length, 1);
  });
});

test('failed resume spawn redacts session and temp paths from the error', async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: 'scout',
      task: 'first',
      tabLabel: 'Scout Resume',
    });
    await harness.collect('Scout Resume');
    const history = (await harness.readState()).closedHistory ?? [];
    const sessionFile = history[0]?.childSessionFile;
    assert.ok(sessionFile);
    harness.fake.failEveryStart('agent_start_failed');
    await assert.rejects(
      () =>
        harness.call({
          agent: 'scout',
          task: 'again',
          tabLabel: 'Scout Resume',
          resumeClosed: true,
        }),
      (error: unknown) => {
        const text = String(error);
        assert.equal(text.includes(sessionFile), false);
        assert.equal(text.includes('herdr-agent-'), false);
        assert.match(text, /agent_start_failed/);
        return true;
      },
    );
  });
});

test('missing continuation metadata does not close or archive a one-shot', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.skipSessionMeta();
    await harness.call({
      agent: 'scout',
      task: 'first',
      tabLabel: 'Scout Missing Meta',
    });
    const delivered = await harness.collect('Scout Missing Meta');
    assert.match(delivered.content, /session metadata is missing/);
    assert.equal(harness.fake.panes.length, 2);
    const history = (await harness.readState()).closedHistory ?? [];
    assert.equal(history.length, 0);
  });
});

test('stage write failure keeps the live one-shot and does not expose resumable history', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.holdChildren();
    await harness.call({
      agent: 'scout',
      task: 'background',
      tabLabel: 'Scout Stage Fail',
    });
    setFailNextStateMutation('stage');
    await harness.fake.releaseChildren();
    await harness.waitFor(async () => {
      const record = Object.values((await harness.readState()).agents)[0];
      return record?.detached !== true;
    }, 'detached claim to settle after failed stage');
    assert.equal(harness.fake.panes.length, 2);
    const history = (await harness.readState()).closedHistory ?? [];
    assert.equal(
      history.filter((item) => item.status === 'resumable').length,
      0,
    );
  });
});

test('close failure after staging keeps the live agent and is not resumable', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({ result: 'PRECIOUS RESULT' }));
    harness.fake.failCommand('pane close', 'pane_close_failed');
    await harness.call({
      agent: 'scout',
      task: 'Find it',
      tabLabel: 'Scout Close Fail',
    });
    const delivered = await harness.collect('Scout Close Fail');
    assert.match(delivered.content, /PRECIOUS RESULT/);
    assert.match(delivered.content, /failed to close/);
    assert.equal(harness.fake.panes.length, 2);
    const state = await harness.readState();
    assert.ok(Object.keys(state.agents).length > 0);
    assert.equal(
      (state.closedHistory ?? []).some((item) => item.status === 'resumable'),
      false,
    );
    assert.equal(state.closedHistory[0]?.status, 'staged');
  });
});

test('/herdr-agents refuses to close a questioned one-shot', async () => {
  await withHarness({ dialogInputs: [['d']] }, async (harness) => {
    harness.fake.setBehavior(() => ({ question: 'Which module?' }));
    await harness.call({
      agent: 'scout',
      task: 'ask',
      tabLabel: 'Scout Question Close',
    });
    await harness.collect('Scout Question Close');
    await harness.runCommand('herdr-agents');
    assert.equal(harness.fake.panes.length, 2);
    assert.match(
      harness.notifications.at(-1)?.message ?? '',
      /Cannot close "Scout Question Close"/,
    );
    const history = (await harness.readState()).closedHistory ?? [];
    assert.equal(history.length, 0);
  });
});

test('/herdr-agents refuses to close an active resumed one-shot', async () => {
  await withHarness({ dialogInputs: [['d']] }, async (harness) => {
    await harness.call({
      agent: 'scout',
      task: 'first',
      tabLabel: 'Scout Resume Close',
    });
    await harness.collect('Scout Resume Close');
    harness.fake.setBehavior(() => ({ question: 'Which module?' }));
    await harness.call({
      agent: 'scout',
      task: 'again',
      tabLabel: 'Scout Resume Close',
      resumeClosed: true,
    });
    const question = await harness.collect('Scout Resume Close');
    assert.equal(question.customType, 'herdr_agent_question');
    await harness.runCommand('herdr-agents');
    assert.equal(harness.fake.panes.length, 2);
    assert.match(
      harness.notifications.at(-1)?.message ?? '',
      /Cannot close "Scout Resume Close"/,
    );
    const history = (await harness.readState()).closedHistory ?? [];
    assert.equal(history[0]?.status, 'claimed');
  });
});

test('aborted resume spawn still cleans up with an independent signal', async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: 'scout',
      task: 'first',
      tabLabel: 'Scout Resume Abort',
    });
    await harness.collect('Scout Resume Abort');
    harness.fake.delayAgentStart(800);
    const controller = new AbortController();
    const pending = harness.call(
      {
        agent: 'scout',
        task: 'again',
        tabLabel: 'Scout Resume Abort',
        resumeClosed: true,
      },
      { signal: controller.signal },
    );
    await harness.waitFor(
      () => harness.fake.callsMatching('agent', 'start').length > 1,
      'resume agent start to begin',
    );
    controller.abort();
    await assert.rejects(() => pending);
    const history = (await harness.readState()).closedHistory ?? [];
    assert.equal(history[0]?.status, 'resumable');
    assert.equal(harness.fake.panes.length, 1);
  });
});

test('unconfirmed rollback close keeps the claim instead of a resumable duplicate', async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: 'scout',
      task: 'first',
      tabLabel: 'Scout Resume CloseFail',
    });
    await harness.collect('Scout Resume CloseFail');
    harness.fake.failEveryStart('agent_start_failed');
    harness.fake.failCommand('pane close', 'pane_close_failed');
    await assert.rejects(() =>
      harness.call({
        agent: 'scout',
        task: 'again',
        tabLabel: 'Scout Resume CloseFail',
        resumeClosed: true,
      }),
    );
    const history = (await harness.readState()).closedHistory ?? [];
    assert.equal(history[0]?.status, 'claimed');
    assert.equal(harness.fake.panes.length, 2);
  });
});

test('prompt failure after a durable resume leaves the live generation recoverable', async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: 'scout',
      task: 'first',
      tabLabel: 'Scout Resume Prompt',
    });
    await harness.collect('Scout Resume Prompt');
    harness.fake.failCommand('agent prompt', 'agent_prompt_failed', {
      times: 1,
    });
    await assert.rejects(() =>
      harness.call({
        agent: 'scout',
        task: 'again',
        tabLabel: 'Scout Resume Prompt',
        resumeClosed: true,
      }),
    );
    const state = await harness.readState();
    assert.equal(state.closedHistory[0]?.status, 'claimed');
    assert.ok(Object.keys(state.agents).length > 0);
    assert.equal(harness.fake.panes.length, 2);
  });
});

test('close success plus finalize failure still lets a later resume succeed', async () => {
  await withHarness({}, async (harness) => {
    setFailNextStateMutation('finalize', 3);
    const first = await harness.call({
      agent: 'scout',
      task: 'first',
      tabLabel: 'Scout Resume Finalize',
    });
    await harness.collect('Scout Resume Finalize');
    assert.equal(first.isError, undefined);
    assert.equal(harness.fake.panes.length, 1);
    const history = (await harness.readState()).closedHistory ?? [];
    assert.equal(history[0]?.status, 'resumable');
    const resumed = await harness.call({
      agent: 'scout',
      task: 'second',
      tabLabel: 'Scout Resume Finalize',
      resumeClosed: true,
    });
    await harness.collect('Scout Resume Finalize');
    assert.equal(resumed.isError, undefined);
    assert.equal(resumed.details.resumed, true);
  });
});

test('resumeClosed does not spawn over a live working agent', async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: 'scout',
      task: 'first',
      tabLabel: 'Scout Live Working',
    });
    await harness.collect('Scout Live Working');
    harness.fake.setBehavior(() => ({ neverSettle: true }));
    await harness.call({
      agent: 'scout',
      task: 'live',
      tabLabel: 'Scout Live Working',
    });
    await harness.waitFor(
      () =>
        harness.fake.panes.some(
          (pane) =>
            pane !== harness.fake.orchestratorPane &&
            pane.agent_status === 'working',
        ),
      'live agent to report working',
    );
    const blocked = await harness.call({
      agent: 'scout',
      task: 'resume anyway',
      tabLabel: 'Scout Live Working',
      resumeClosed: true,
    });
    assert.equal(blocked.isError, true);
    assert.match(blocked.content[0].text, /still working/);
    assert.equal(harness.fake.callsMatching('agent', 'start').length, 2);
  });
});

test('resumeClosed does not spawn over a settled detached live agent', async () => {
  await withHarness({}, async (harness) => {
    // No result artifact: the poller leaves the settled agent detached so a
    // status check can still read the scrollback.
    harness.fake.setBehavior(() => ({ transcript: 'finished talking' }));
    await harness.call({
      agent: 'scout',
      task: 'first',
      tabLabel: 'Scout Live Settled',
    });
    await harness.waitFor(
      () =>
        harness.fake.panes.some(
          (pane) =>
            pane !== harness.fake.orchestratorPane &&
            pane.agent_status === 'idle',
        ),
      'detached live agent to settle',
    );
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const blocked = await harness.call({
      agent: 'scout',
      task: 'resume anyway',
      tabLabel: 'Scout Live Settled',
      resumeClosed: true,
    });
    assert.equal(blocked.isError, true);
    assert.match(blocked.content[0].text, /waiting to be delivered/);
    assert.equal(harness.fake.callsMatching('agent', 'start').length, 1);
    assert.equal(harness.messages.length, 0);
  });
});

test('resumeClosed resolves project skills from the archived cwd', async () => {
  await withHarness(
    { profiles: [{ name: 'scout', skills: ['tdd'] }] },
    async (harness) => {
      const otherDir = path.join(path.dirname(harness.cwd), 'archived project');
      await fs.mkdir(path.join(otherDir, '.pi', 'skills', 'tdd'), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(otherDir, '.pi', 'skills', 'tdd', 'SKILL.md'),
        '---\nname: tdd\ndescription: red green\n---\n\nBODY\n',
      );
      await harness.call({
        agent: 'scout',
        task: 'first',
        tabLabel: 'Scout Cwd',
      });
      await harness.collect('Scout Cwd');
      const statePath = harness.statePath;
      const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
      const record = state.closedHistory[0];
      const sessionFile = record.childSessionFile as string;
      const raw = await fs.readFile(sessionFile, 'utf8');
      const [headerLine, ...rest] = raw.split('\n');
      const header = JSON.parse(headerLine);
      header.cwd = otherDir;
      await fs.writeFile(
        sessionFile,
        [JSON.stringify(header), ...rest].join('\n'),
      );
      record.cwd = otherDir;
      await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

      const resumed = await harness.call({
        agent: 'scout',
        task: 'second',
        tabLabel: 'Scout Cwd',
        resumeClosed: true,
      });
      await harness.collect('Scout Cwd');
      if (resumed.isError) {
        throw new Error(`resume failed: ${resumed.content[0].text}`);
      }
      const starts = harness.fake.callsMatching('agent', 'start');
      const resumeStart = starts.at(-1) ?? [];
      const separator = resumeStart.indexOf('--');
      const piArgs = resumeStart.slice(separator + 1);
      const skill = flagValue(piArgs, '--skill');
      assert.ok(
        skill?.includes(path.join('archived project', '.pi', 'skills', 'tdd')),
      );
      const split = harness.fake.callsMatching('pane', 'split').at(-1) ?? [];
      assert.equal(flagValue(split, '--cwd'), otherDir);
    },
  );
});

test('failed resume spawn redacts session paths that contain whitespace', async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: 'scout',
      task: 'first',
      tabLabel: 'Scout Space Path',
    });
    await harness.collect('Scout Space Path');
    const state = JSON.parse(await fs.readFile(harness.statePath, 'utf8'));
    const sessionFile = state.closedHistory[0].childSessionFile as string;
    const spaced = path.join(path.dirname(sessionFile), 'child session.jsonl');
    await fs.rename(sessionFile, spaced);
    const raw = await fs.readFile(spaced, 'utf8');
    const [headerLine, ...rest] = raw.split('\n');
    await fs.writeFile(spaced, [headerLine, ...rest].join('\n'));
    state.closedHistory[0].childSessionFile = spaced;
    await fs.writeFile(
      harness.statePath,
      `${JSON.stringify(state, null, 2)}\n`,
    );
    harness.fake.failEveryStart('agent_start_failed');
    await assert.rejects(
      () =>
        harness.call({
          agent: 'scout',
          task: 'again',
          tabLabel: 'Scout Space Path',
          resumeClosed: true,
        }),
      (error: unknown) => {
        const text = String(error);
        assert.equal(text.includes(spaced), false);
        assert.equal(text.includes('child session.jsonl'), false);
        assert.match(text, /agent_start_failed/);
        return true;
      },
    );
  });
});
