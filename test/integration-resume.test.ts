import assert from 'node:assert/strict';
import * as path from 'node:path';

import { test } from 'vitest';

import { flagValue, withHarness } from '../test-support/integration-harness.ts';

/**
 * Basic resume: live-label protection, logical labels, and resumeClosed
 * spawns in every layout.
 */

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

test('resumeClosed resolves the profile from the closed history when agent is omitted', async () => {
  await withHarness({}, async (harness) => {
    const first = await harness.call({
      agent: 'scout',
      task: 'first slice',
      tabLabel: 'Scout Label Resume',
    });
    await harness.collect(first.details.tabLabel);

    const resumed = await harness.call({
      task: 'second slice',
      tabLabel: 'Scout Label Resume',
      resumeClosed: true,
    });

    assert.equal(resumed.isError, undefined);
    assert.equal(resumed.details.resumed, true);
    assert.equal(resumed.details.agent.name, 'scout');
    await harness.collect('Scout Label Resume');
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
    // No result artifact: the poller leaves the settled agent detached.
    harness.fake.setBehavior(() => ({}));
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
