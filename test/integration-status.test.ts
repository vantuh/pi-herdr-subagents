import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

import { test } from 'vitest';

import { withHarness } from '../test-support/integration-harness.ts';

/**
 * Status checks: what a status call reports, pane/terminal ownership
 * across a live handoff, and widget shutdown.
 */

test('status check reports a settled child without a result and reads no pane', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({}));

    await harness.call({ agent: 'scout', task: 'Look around' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const result = await harness.call({ agent: 'scout', tabLabel: 'Scout' });

    assert.match(result.content[0].text, /finished without a result/);
    assert.doesNotMatch(result.content[0].text, /preview/);
    assert.equal(result.details.status, 'idle');
    assert.equal(harness.messages.length, 0);
    assert.deepEqual(harness.fake.callsMatching('agent', 'read'), []);
  });
});

test('status check previews the child assistant text without reading the pane', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({ neverSettle: true }));

    await harness.call({ agent: 'scout', task: 'Look around' });
    const record = Object.values((await harness.readState()).agents)[0];
    assert.ok(record?.resultFile);
    // The child writes its assistant text before it finishes the turn.
    await fs.writeFile(
      record.resultFile,
      [
        'I will run the requested sleep.',
        '',
        '• keep this bullet',
        '────',
        'repeated',
        'repeated',
        'HERDR_RESULT_FILE: literal content, not a boundary',
      ].join('\n'),
    );

    const result = await harness.call({ agent: 'scout', tabLabel: 'Scout' });

    assert.equal(result.details.status, 'working');
    assert.match(result.content[0].text, /status: working/);
    assert.match(
      result.content[0].text,
      /Latest assistant text \(preview; not a completion\):/,
    );
    assert.match(result.content[0].text, /I will run the requested sleep\./);
    assert.match(result.content[0].text, /• keep this bullet/);
    assert.match(result.content[0].text, /────/);
    assert.match(result.content[0].text, /repeated\nrepeated/);
    assert.match(
      result.content[0].text,
      /HERDR_RESULT_FILE: literal content, not a boundary/,
    );
    assert.doesNotMatch(result.content[0].text, /\[Extensions\]|v1\.2\.0/);
    assert.deepEqual(harness.fake.callsMatching('agent', 'read'), []);
  });
});

test('status check never prompts, waits, claims, or closes', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({ neverSettle: true }));

    await harness.call({ agent: 'scout', task: 'Look around' });
    const result = await harness.call({ agent: 'scout', tabLabel: 'Scout' });

    assert.equal(result.isError, undefined);
    assert.equal(result.details.status, 'working');

    const record = Object.values((await harness.readState()).agents)[0];
    assert.ok(record?.automationName);
    assert.deepEqual(harness.fake.callsMatching('agent', 'read'), []);

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

test('status check resolves the profile from the label when agent is omitted', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({ neverSettle: true }));

    await harness.call({ agent: 'scout', task: 'Look around' });
    const result = await harness.call({ tabLabel: 'Scout' });

    assert.equal(result.isError, undefined);
    assert.equal(result.details.status, 'working');
    assert.equal(result.details.agent.name, 'scout');
    assert.equal(result.details.tabLabel, 'Scout');
    assert.equal(harness.fake.callsMatching('agent', 'prompt').length, 1);
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
