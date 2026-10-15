import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { test } from 'vitest';

import { withHarness } from '../test-support/integration-harness.ts';

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
