import assert from 'node:assert/strict';

import { test } from 'vitest';

import { flagValue, withHarness } from '../test-support/integration-harness.ts';

/**
 * Agents-workspace placement: workspace creation, recovery after a manual
 * close, and tab cleanup.
 */

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
    await harness.callRaw({ agent: 'scout', task: 'stay', name: 'Scout One' });
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
      name: 'Scout Two',
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

test('/herdr-agents focuses an Agents-workspace agent via tab focus', async () => {
  await withHarness(
    { layout: 'workspace', dialogInputs: [['\r']] },
    async (harness) => {
      harness.fake.setBehavior(() => ({ neverSettle: true }));
      await harness.callRaw({ agent: 'scout', task: 'stay', name: 'Scout Ws' });

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
    const ghost = await harness.callTool('agent_status', { name: 'Ghost' });
    assert.equal(ghost.isError, true);
    assert.match(ghost.content[0].text, /No running agent named "Ghost"/);
    // A missing workspace means "nothing to find", not a fresh workspace.
    assert.equal(harness.fake.callsMatching('workspace', 'create').length, 0);

    // A live detached agent is still findable by label.
    harness.fake.setBehavior(() => ({ neverSettle: true }));
    await harness.call({ agent: 'scout', task: 'stay', name: 'Scout Live' });
    const rewait = await harness.callTool('agent_status', {
      name: 'Scout Live',
    });
    assert.match(rewait.content[0].text, /status: /);
    // Still exactly the one workspace the spawn above created — the status check
    // added none.
    assert.equal(harness.fake.callsMatching('workspace', 'create').length, 1);
  });
});

test('follow-up spawns perform no extra spawn-phase tab close', async () => {
  await withHarness({ layout: 'workspace' }, async (harness) => {
    harness.fake.setBehavior(() => ({ neverSettle: true }));
    await harness.callRaw({ agent: 'scout', task: 'first', name: 'Scout Ws' });
    const closesAfterFirst = harness.fake.callsMatching('tab', 'close').length;
    // Creating spawn closes the workspace root tab; the agent tab stays open.
    assert.equal(closesAfterFirst, 1);

    await harness.callRaw({
      agent: 'scout',
      task: 'second',
      name: 'Scout Ws 2',
    });
    assert.equal(
      harness.fake.callsMatching('tab', 'close').length,
      closesAfterFirst,
      'spawn must not close tabs beyond workspace creation',
    );
  });
});

test("refuses a workspace.label that matches the Orchestrator's own workspace", async () => {
  await withHarness(
    { config: { layout: 'workspace', workspace: { label: 'main' } } },
    async (harness) => {
      const result = await harness.call({ agent: 'scout', task: 'nope' });
      assert.equal(result.isError, true);
      assert.match(
        result.content[0].text,
        /workspace\.label matches this Orchestrator's own workspace/,
      );
      assert.match(result.content[0].text, /herdr-agents\.json/);
      assert.equal(harness.fake.callsMatching('tab', 'create').length, 0);
    },
  );
});
