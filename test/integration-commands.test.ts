import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { test } from 'vitest';

import { flagValue, withHarness } from '../test-support/integration-harness.ts';

/**
 * Orchestrator instructions and the /herdr-agents manager.
 */

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

    await harness.fire('session_start');
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

test('/herdr-agents lists and reopens a closed one-shot of this session without a task', async () => {
  // enter opens the closed row; the second run closes the reopened agent
  await withHarness({ dialogInputs: [['\r'], ['d']] }, async (harness) => {
    await harness.call({
      agent: 'scout',
      task: 'first',
      tabLabel: 'Scout Read',
    });
    await harness.collect('Scout Read');
    const state = await harness.readState();
    const archived = state.closedHistory[0]!;
    state.closedHistory.push({
      ...archived,
      id: 'ch_foreign',
      ownerSessionId: 'another-session',
      tabLabel: 'Foreign',
    });
    await fs.writeFile(harness.statePath, JSON.stringify(state));
    const prompts = harness.fake.callsMatching('agent', 'prompt').length;
    const messages = harness.messages.length;

    await harness.runCommand('herdr-agents');

    const start = harness.fake.callsMatching('agent', 'start').at(-1) ?? [];
    const piArgs = start.slice(start.indexOf('--') + 1);
    assert.equal(flagValue(piArgs, '--session'), archived.childSessionFile);
    assert.equal(harness.fake.callsMatching('agent', 'prompt').length, prompts);
    assert.match(
      harness.notifications.at(-1)?.message ?? '',
      /Opened Herdr agent "Scout Read"/,
    );
    const opened = await harness.readState();
    const live = Object.values(opened.agents)[0];
    assert.equal(live?.closedHistoryId, archived.id);
    assert.equal(live?.detached, false);
    assert.equal(
      opened.closedHistory.find((item) => item.id === archived.id)?.status,
      'claimed',
    );

    // Two poller ticks must neither deliver nor close the reopened agent.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    assert.equal(harness.messages.length, messages);
    assert.equal(harness.fake.panes.length, 2);

    await harness.runCommand('herdr-agents');

    assert.equal(harness.fake.panes.length, 1);
    const closed = (await harness.readState()).closedHistory;
    assert.equal(
      closed.find((item) => item.id === archived.id)?.status,
      'resumable',
    );
    assert.equal(
      closed.find((item) => item.id === 'ch_foreign')?.status,
      'resumable',
    );
  });
});

test('/herdr-agents does not list closed one-shots of another session', async () => {
  // enter would open a listed closed row
  await withHarness({ dialogInputs: [['\r']] }, async (harness) => {
    await harness.call({
      agent: 'scout',
      task: 'first',
      tabLabel: 'Scout Read',
    });
    await harness.collect('Scout Read');
    const state = await harness.readState();
    state.closedHistory[0]!.ownerSessionId = 'another-session';
    await fs.writeFile(harness.statePath, JSON.stringify(state));

    await harness.runCommand('herdr-agents');

    // No rows: the empty-list dialog is shown and nothing is started.
    assert.equal(harness.fake.callsMatching('agent', 'start').length, 1);
    assert.deepEqual(harness.notifications, []);
  });
});

test('/herdr-agents reports a closed one-shot whose session file is gone', async () => {
  await withHarness({ dialogInputs: [['\r']] }, async (harness) => {
    await harness.call({
      agent: 'scout',
      task: 'first',
      tabLabel: 'Scout Read',
    });
    await harness.collect('Scout Read');
    const archived = (await harness.readState()).closedHistory[0]!;
    await fs.rm(archived.childSessionFile);

    await harness.runCommand('herdr-agents');

    assert.match(
      harness.notifications.at(-1)?.message ?? '',
      /Could not open Herdr agent "Scout Read": .*missing, corrupt/,
    );
    assert.equal(harness.fake.callsMatching('agent', 'start').length, 1);
    assert.equal(harness.fake.panes.length, 1);
    assert.equal(
      (await harness.readState()).closedHistory[0]?.status,
      'invalid',
    );
  });
});
