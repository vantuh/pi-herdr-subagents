import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

import { test } from 'vitest';

import { flagValue, withHarness } from '../test-support/integration-harness.ts';

/**
 * Spawning: target placement, profile argv handoff, busy-shell and
 * kind-mismatch retries, and the early return before a child settles.
 */

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

test('returns before a never-settling agent finishes and leaves it open', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({ neverSettle: true }));
    const started = await harness.call({ agent: 'scout', task: 'Long job' });
    assert.match(started.content[0].text, /started/);
    assert.equal(harness.fake.panes.length, 2);
    assert.equal(harness.fake.callsMatching('agent', 'prompt').length, 1);
    assert.equal(harness.messages.length, 0);
  });
});

test('rejects an unknown agent profile before touching Herdr', async () => {
  await withHarness({}, async (harness) => {
    const result = await harness.call({ agent: 'nope', task: 'anything' });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unknown agent profile: nope/);
    assert.match(result.content[0].text, /scout/);
    assert.equal(harness.fake.calls.length, 0);
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
