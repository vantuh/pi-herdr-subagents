import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { visibleWidth } from '@earendil-works/pi-tui';
import { test } from 'vitest';

import type { Harness } from '../test-support/harness.ts';
import { flagValue, withHarness } from '../test-support/integration-harness.ts';

/**
 * Orchestrator instructions and the /agents manager.
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
    assert.match(base.systemPromptOptions.sections.agents, /^## Agents/);
    assert.doesNotMatch(
      base.systemPromptOptions.sections.agents,
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
      message: { customType: 'agent_result', content: 'finished' },
    })) as any;
    assert.match(custom.systemPromptOptions.sections.agents, /## Agents/);
    assert.doesNotMatch(
      custom.systemPromptOptions.sections.agents,
      /\/run delegation/,
    );

    const delegating = (await harness.fire('before_agent_start', {
      systemPrompt: 'BASE',
      prompt: 'hi',
    })) as any;
    assert.match(
      delegating.systemPromptOptions.sections.agents,
      /## \/run delegation/,
    );
    assert.match(
      delegating.systemPromptOptions.sections.agents,
      /agent: "scout"/,
    );

    // The /run authorization is single-turn.
    const after = (await harness.fire('before_agent_start', {
      systemPrompt: 'BASE',
      prompt: 'hi',
    })) as any;
    assert.doesNotMatch(
      after.systemPromptOptions.sections.agents,
      /\/run delegation/,
    );
  });
});

test('/agents focuses a managed agent', async () => {
  await withHarness(
    // enter selects the single listed agent
    { dialogInputs: [['\r']] },
    async (harness) => {
      harness.fake.setBehavior(() => ({ neverSettle: true }));
      await harness.callRaw({ agent: 'scout', task: 'stay' });

      await harness.runCommand('agents');

      const focus = harness.fake.callsMatching('agent', 'focus')[0];
      assert.ok(
        focus,
        `expected an agent focus, calls: ${JSON.stringify(harness.fake.calls.slice(-4))}`,
      );
      assert.equal(focus[2], harness.fake.paneByLabel('Scout')?.pane_id);
      assert.match(
        harness.notifications.at(-1)?.message ?? '',
        /Focused agent "Scout"/,
      );
      // Focusing must not close the agent.
      assert.equal(harness.fake.panes.length, 2);
    },
  );
});

test('/agents closes a managed agent and cleans up its temp directory', async () => {
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

      await harness.runCommand('agents');

      assert.deepEqual(
        harness.fake.panes.map((pane) => pane.pane_id),
        [harness.fake.orchestratorPane.pane_id],
      );
      assert.equal(await fs.stat(tempDir).catch(() => null), null);
      assert.match(
        harness.notifications.at(-1)?.message ?? '',
        /Closed agent "Scout"/,
      );
    },
  );
});

test('/agents reports an empty workspace instead of failing', async () => {
  await withHarness({}, async (harness) => {
    await harness.runCommand('agents');
    assert.deepEqual(harness.notifications, []);
    assert.deepEqual(harness.fake.callsMatching('pane', 'close'), []);
  });
});

test('/agents refuses to close a questioned one-shot', async () => {
  await withHarness({ dialogInputs: [['d']] }, async (harness) => {
    harness.fake.setBehavior(() => ({ question: 'Which module?' }));
    await harness.call({
      agent: 'scout',
      task: 'ask',
      name: 'Scout Question Close',
    });
    await harness.collect('Scout Question Close');
    await harness.runCommand('agents');
    assert.equal(harness.fake.panes.length, 2);
    assert.match(
      harness.notifications.at(-1)?.message ?? '',
      /Cannot close "Scout Question Close"/,
    );
    const history = (await harness.readState()).closedHistory ?? [];
    assert.equal(history.length, 0);
  });
});

test('/agents refuses to close an active resumed one-shot', async () => {
  await withHarness({ dialogInputs: [['d']] }, async (harness) => {
    await harness.call({
      agent: 'scout',
      task: 'first',
      name: 'Scout Resume Close',
    });
    await harness.collect('Scout Resume Close');
    harness.fake.setBehavior(() => ({ question: 'Which module?' }));
    await harness.callTool('agent_send', {
      message: 'again',
      name: 'Scout Resume Close',
    });
    const question = await harness.collect('Scout Resume Close');
    assert.equal(question.customType, 'agent_question');
    await harness.runCommand('agents');
    assert.equal(harness.fake.panes.length, 2);
    assert.match(
      harness.notifications.at(-1)?.message ?? '',
      /Cannot close "Scout Resume Close"/,
    );
    const history = (await harness.readState()).closedHistory ?? [];
    assert.equal(history[0]?.status, 'claimed');
  });
});

test('/agents lists and reopens a closed one-shot of this session without a task', async () => {
  // enter opens the closed row; the second run closes the reopened agent
  await withHarness({ dialogInputs: [['\r'], ['d']] }, async (harness) => {
    await harness.call({ agent: 'scout', task: 'first', name: 'Scout Read' });
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

    await harness.runCommand('agents');

    const start = harness.fake.callsMatching('agent', 'start').at(-1) ?? [];
    const piArgs = start.slice(start.indexOf('--') + 1);
    assert.equal(flagValue(piArgs, '--session'), archived.childSessionFile);
    assert.equal(harness.fake.callsMatching('agent', 'prompt').length, prompts);
    assert.match(
      harness.notifications.at(-1)?.message ?? '',
      /Opened agent "Scout Read"/,
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

    await harness.runCommand('agents');

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

test('/agents does not list closed one-shots of another session', async () => {
  // enter would open a listed closed row
  await withHarness({ dialogInputs: [['\r']] }, async (harness) => {
    await harness.call({ agent: 'scout', task: 'first', name: 'Scout Read' });
    await harness.collect('Scout Read');
    const state = await harness.readState();
    state.closedHistory[0]!.ownerSessionId = 'another-session';
    await fs.writeFile(harness.statePath, JSON.stringify(state));

    await harness.runCommand('agents');

    // No rows: the empty-list dialog is shown and nothing is started.
    assert.equal(harness.fake.callsMatching('agent', 'start').length, 1);
    assert.deepEqual(harness.notifications, []);
  });
});

/**
 * Draws the real manager overlay at `width` without a TUI, so the test reads
 * the same rows the terminal would.
 */
async function renderAgentRows(
  harness: Harness,
  width: number,
): Promise<string[]> {
  const command = harness.commands.get('agents');
  if (!command) throw new Error('expected a /agents command');
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  let rows: string[] = [];
  const ctx = {
    mode: 'tui',
    cwd: harness.cwd,
    sessionManager: {
      getSessionId: () => 'test-orch-session',
      getSessionFile: () => path.join(harness.cwd, 'orchestrator.jsonl'),
      getCwd: () => harness.cwd,
    },
    ui: {
      theme,
      notify: () => undefined,
      custom: (factory: any) => {
        const component = factory(
          { requestRender: () => undefined },
          theme,
          {},
          () => undefined,
        );
        rows = component.render(width);
        return Promise.resolve(null);
      },
    },
  };

  await command.handler('', ctx);
  return rows;
}

test('/agents shows a label longer than the default name column', async () => {
  await withHarness({}, async (harness) => {
    // A held child keeps the agent listed and its row single-line.
    harness.fake.holdChildren();
    await harness.callRaw({
      agent: 'scout',
      name: 'release-audit-specialist',
      task: 'stay',
    });

    const rows = await renderAgentRows(harness, 120);

    const row = rows.find((line) =>
      line.includes('release-audit-specialist (scout)'),
    );
    assert.ok(row, `the name column clipped the label:\n${rows.join('\n')}`);
    // The description keeps its own column instead of being pushed out; the
    // status and cost cells pad to the listing's widest so the separators stay
    // aligned and the price stays inside the overlay.
    assert.match(row, /[a-z]+ +• cost — • ctx/);
    assert.doesNotMatch(row, /status:/);
    for (const line of rows) {
      assert.ok(
        visibleWidth(line) <= 120,
        `row overflows 120 columns: ${JSON.stringify(line)}`,
      );
    }
  });
});

test('/agents rows stay inside a narrow terminal', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.holdChildren();
    await harness.callRaw({
      agent: 'scout',
      name: 'release-audit-specialist',
      task: 'stay',
    });

    const rows = await renderAgentRows(harness, 40);

    assert.ok(rows.length > 0);
    for (const line of rows) {
      assert.ok(
        visibleWidth(line) <= 40,
        `row overflows 40 columns: ${JSON.stringify(line)}`,
      );
    }
  });
});

test('/agents reports a closed one-shot whose session file is gone', async () => {
  await withHarness({ dialogInputs: [['\r']] }, async (harness) => {
    await harness.call({ agent: 'scout', task: 'first', name: 'Scout Read' });
    await harness.collect('Scout Read');
    const archived = (await harness.readState()).closedHistory[0]!;
    await fs.rm(archived.childSessionFile);

    await harness.runCommand('agents');

    assert.match(
      harness.notifications.at(-1)?.message ?? '',
      /Could not open agent "Scout Read": .*missing, corrupt/,
    );
    assert.equal(harness.fake.callsMatching('agent', 'start').length, 1);
    assert.equal(harness.fake.panes.length, 1);
    assert.equal(
      (await harness.readState()).closedHistory[0]?.status,
      'invalid',
    );
  });
});
