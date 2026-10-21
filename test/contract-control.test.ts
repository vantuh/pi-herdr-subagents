import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { test, vi } from 'vitest';

import { withHarness } from '../test-support/contract-harness.ts';
import type { ChildControlAck } from '../test-support/fake-herdr/types.ts';
import type { Harness } from '../test-support/harness.ts';

/**
 * `agent_send` (steer) and `agent_stop` contract: guard order and exact texts, `details` keys,
 * every status of both actions, the acknowledgement compatibility rule, and the
 * serialization/timeout discipline. Behavior (a real poller, a real delivery)
 * lives in `integration-control.test.ts`; this file owns the prose.
 */

const LABEL = 'Scout Work';
const RESULT_TEXT = 'the run produced text';

function steerQueuedText(label: string, paneId: string): string {
  return `Message queued for agent ${label} (${paneId}). It enters the run at its next turn boundary; queuing is not proof the agent has read it. Its answer still arrives with the final result — do not re-send it as a task.`;
}

function steerIdleText(label: string, paneId: string): string {
  return `Agent ${label} (${paneId}) did not take the message: it is not in an active run, or the request was already stale. Its result arrives automatically; wait for it. Check it with agent_status only if a decision depends on it.`;
}

function steerUnknownText(label: string, paneId: string): string {
  return `No acknowledgement from agent ${label} (${paneId}) within 2000 ms. The message may or may not be applied; do not retry it. Check its status before deciding what to send next.`;
}

function interruptAbortedText(label: string, paneId: string): string {
  return `Agent ${label} (${paneId}) aborted its run, so no result from that run should normally arrive and the agent stays open. A collection already in flight can still deliver that run's text and close the pane; ignore a result for work you interrupted. A live agent cannot take a new task: continue it manually in its pane, or close it with /herdr-agents and then continue it with agent_send and the same name.`;
}

function interruptRequestedText(label: string, paneId: string): string {
  return `Stop sent to agent ${label} (${paneId}); the child did not report a settled abort within 2000 ms, so the run may have already finished on its own. On the ordinary path expect no result from that run, but a collection already in flight can still deliver its text; ignore a result for work you interrupted. Check its status, then continue it manually in its pane or close it with /herdr-agents and continue it with agent_send.`;
}

function interruptIdleText(label: string, paneId: string): string {
  return `Agent ${label} (${paneId}) is not in an active run, so there was nothing to stop. Check its status; its result may still arrive.`;
}

function interruptUnknownText(label: string, paneId: string): string {
  return `No acknowledgement from agent ${label} (${paneId}) within 3000 ms. The stop may or may not have been applied; do not retry it. Check its status before assuming it stopped.`;
}

/**
 * Pauses the pre-clean's removal of `request.json` so a test can cancel the
 * caller at exactly that await. The call passes through untouched after the gate.
 */
function pauseRequestCleanup(controlDir: string) {
  const target = path.join(controlDir, 'request.json');
  const original = fs.rm.bind(fs);
  let reached!: () => void;
  const hit = new Promise<void>((resolve) => (reached = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let paused = false;
  const spy = vi.spyOn(fs, 'rm').mockImplementation((async (
    from: any,
    options: any,
  ) => {
    if (String(from) === target && !paused) {
      paused = true;
      reached();
      await gate;
    }
    return await (original as any)(from, options);
  }) as any);
  return {
    hit: () => hit,
    release,
    restore: () => {
      release();
      spy.mockRestore();
    },
  };
}

/**
 * Pauses the Nth acknowledgement file the simulated child writes, so a test can
 * hold one control operation inside its ack wait while it already owns the
 * per-directory queue entry.
 */
function pauseNthAckWrite(n: number) {
  const original = fs.writeFile.bind(fs);
  let writes = 0;
  let reached!: () => void;
  const hit = new Promise<void>((resolve) => (reached = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let paused = false;
  const spy = vi.spyOn(fs, 'writeFile').mockImplementation((async (
    target: any,
    ...rest: any[]
  ) => {
    const name = path.basename(String(target));
    if (name.startsWith('ack.') && name.endsWith('.json')) {
      writes += 1;
      if (writes === n && !paused) {
        paused = true;
        reached();
        await gate;
      }
    }
    return await (original as any)(target, ...rest);
  }) as any);
  return {
    hit: () => hit,
    release,
    restore: () => {
      release();
      spy.mockRestore();
    },
  };
}

function requestFile(controlDir: string): string {
  return path.join(controlDir, 'request.json');
}

/**
 * Replace the state file atomically. A plain write can be read mid-truncation by
 * a poller tick, which quarantines the file as unreadable and leaves the next
 * caller with no state at all.
 */
async function writeState(harness: Harness, state: unknown): Promise<void> {
  const tempPath = `${harness.statePath}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(state)}\n`, 'utf8');
  await fs.rename(tempPath, harness.statePath);
}

async function requestWritten(controlDir: string): Promise<boolean> {
  try {
    await fs.access(requestFile(controlDir));
    return true;
  } catch {
    return false;
  }
}

interface StartedChild {
  tabLabel: string;
  paneId: string;
  resultFile: string;
  controlDir: string;
  automationName: string;
}

/**
 * Spawn a child through the real tool. `neverSettle` keeps it live and working
 * (no delivery, no close), which is the state the control tool acts on.
 */
async function startChild(
  harness: Harness,
  options: { tabLabel?: string; controlAck?: ChildControlAck } = {},
): Promise<StartedChild> {
  const tabLabel = options.tabLabel ?? LABEL;
  harness.fake.setBehavior(() => ({
    neverSettle: true,
    controlAck: options.controlAck ?? 'idle',
  }));
  const started = await harness.call({
    agent: 'scout',
    task: 'Long job',
    name: tabLabel,
  });
  assert.equal(started.isError, undefined);
  const record = Object.values((await harness.readState()).agents)[0];
  assert.ok(record?.resultFile, 'the child record has a result file');
  assert.ok(record.paneId, 'the child record has a pane id');
  assert.ok(record.automationName, 'the child record has a Herdr name');
  return {
    tabLabel,
    paneId: record.paneId,
    resultFile: record.resultFile,
    controlDir: path.join(path.dirname(record.resultFile), 'control'),
    automationName: record.automationName,
  };
}

function assertAttempt(
  result: any,
  expected: {
    tabLabel: string;
    paneId: string;
    action: string;
    status: string;
  },
): void {
  assert.equal(result.isError, undefined);
  assert.equal(
    result.content.length,
    1,
    'an attempted operation returns one text part',
  );
  assert.deepEqual(Object.keys(result.details).sort(), [
    'action',
    'name',
    'paneId',
    'requestId',
    'status',
  ]);
  assert.equal(result.details.name, expected.tabLabel);
  assert.equal(result.details.paneId, expected.paneId);
  assert.equal(result.details.action, expected.action);
  assert.equal(result.details.status, expected.status);
  assert.match(result.details.requestId, /^[0-9a-f-]{36}$/);
}

function assertGuardFailure(
  result: any,
  expected: { tabLabel: string; action?: string; text: string },
): void {
  assert.equal(result.isError, true);
  assert.deepEqual(result.details, {
    name: expected.tabLabel,
    ...(expected.action ? { action: expected.action } : {}),
  });
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].text, expected.text);
}

/**
 * Records the control transport's publishes and removals, so a test can assert
 * the ordering the parent's per-directory queue guarantees. The calls pass
 * through untouched.
 */
function recordControlTraffic() {
  const events: string[] = [];
  const rename = fs.rename.bind(fs);
  const rm = fs.rm.bind(fs);
  const inControlDir = (target: string) =>
    target.includes(`${path.sep}control${path.sep}`);
  const renameSpy = vi.spyOn(fs, 'rename').mockImplementation((async (
    from: any,
    to: any,
  ) => {
    const target = String(to);
    if (inControlDir(target)) events.push(`publish:${path.basename(target)}`);
    return await rename(from, to);
  }) as any);
  const rmSpy = vi.spyOn(fs, 'rm').mockImplementation((async (
    target: any,
    options: any,
  ) => {
    const name = String(target);
    if (inControlDir(name)) events.push(`remove:${path.basename(name)}`);
    return await rm(target, options);
  }) as any);
  return {
    events,
    restore: () => {
      renameSpy.mockRestore();
      rmSpy.mockRestore();
    },
  };
}

test('guard 1: a blank name is rejected by both tools', async () => {
  await withHarness({}, async (harness) => {
    const send = await harness.callTool('agent_send', {
      name: '  ',
      message: 'adjust',
    });
    assert.equal(send.isError, true);
    assert.deepEqual(send.details, {});
    assert.equal(send.content[0].text, 'name is required.');

    const stop = await harness.callTool('agent_stop', { name: '  ' });
    assertGuardFailure(stop, {
      tabLabel: '',
      action: 'interrupt',
      text: 'name is required.',
    });
  });
});

test('guard 2: agent_send without a message is rejected', async () => {
  await withHarness({}, async (harness) => {
    const result = await harness.callTool('agent_send', {
      name: LABEL,
      message: '   ',
    });

    assert.equal(result.isError, true);
    assert.deepEqual(result.details, { name: LABEL });
    assert.equal(result.content[0].text, 'message is required.');
    assert.deepEqual(harness.fake.calls, [], 'no Herdr call was made');
  });
});

test('guard 4: a non-TUI session is rejected before any Herdr call', async () => {
  await withHarness({ mode: 'print' }, async (harness) => {
    const send = await harness.callTool('agent_send', {
      name: LABEL,
      message: 'adjust',
    });
    assert.equal(send.isError, true);
    assert.equal(
      send.content[0].text,
      'agent_send requires TUI mode. Non-TUI sessions have no widget poller to deliver the result.',
    );

    const stop = await harness.callTool('agent_stop', { name: LABEL });
    assertGuardFailure(stop, {
      tabLabel: LABEL,
      action: 'interrupt',
      text: 'agent_stop requires TUI mode.',
    });
    assert.deepEqual(harness.fake.calls, [], 'no Herdr call was made');
  });
});

test('guard 5: an unknown name is rejected and writes no request', async () => {
  await withHarness({}, async (harness) => {
    const child = await startChild(harness);

    const send = await harness.callTool('agent_send', {
      name: 'Other Agent',
      message: 'adjust',
    });
    assert.equal(send.isError, true);
    assert.deepEqual(send.details, { name: 'Other Agent' });
    assert.equal(
      send.content[0].text,
      'No agent named "Other Agent" found for this session. Use agent_spawn to start one.',
    );

    const stop = await harness.callTool('agent_stop', { name: 'Other Agent' });
    assertGuardFailure(stop, {
      tabLabel: 'Other Agent',
      action: 'interrupt',
      text: `No running agent named "Other Agent" found for this session. Pass its exact name.`,
    });
    assert.equal(await requestWritten(child.controlDir), false);
  });
});

test('guard 6: a child owned by another session is rejected and writes no request', async () => {
  await withHarness({}, async (harness) => {
    const child = await startChild(harness);
    const state = await harness.readState();
    const [key] = Object.keys(state.agents);
    // Same owner terminal, different Pi session: the terminal-scoped managed
    // list still finds the child, so only the session check can reject it.
    state.agents[key!]!.ownerSessionId = 'another-orchestrator-session';
    await writeState(harness, state);

    const result = await harness.callTool('agent_stop', {
      name: child.tabLabel,
    });

    assertGuardFailure(result, {
      tabLabel: child.tabLabel,
      action: 'interrupt',
      text: `Agent "${child.tabLabel}" is not owned by this Orchestrator session, so it cannot be controlled.`,
    });
    assert.equal(await requestWritten(child.controlDir), false);
  });
});

test('guard 7: a live child without a recorded control channel is rejected and writes no request', async () => {
  await withHarness({}, async (harness) => {
    const child = await startChild(harness);
    const state = await harness.readState();
    const [key] = Object.keys(state.agents);
    delete state.agents[key!]!.resultFile;
    await writeState(harness, state);

    const result = await harness.callTool('agent_send', {
      name: child.tabLabel,
      message: 'adjust',
    });

    assertGuardFailure(result, {
      tabLabel: child.tabLabel,
      action: 'steer',
      text: `Agent "${child.tabLabel}" has no control channel recorded. Check its status before retrying.`,
    });
    assert.equal(await requestWritten(child.controlDir), false);
  });
});

test('steer reports queued with its exact text', async () => {
  await withHarness({}, async (harness) => {
    const child = await startChild(harness, { controlAck: 'queued' });

    const result = await harness.callTool('agent_send', {
      name: child.tabLabel,
      message: 'use the cache layer',
    });

    assertAttempt(result, {
      tabLabel: child.tabLabel,
      paneId: child.paneId,
      action: 'steer',
      status: 'queued',
    });
    assert.equal(
      result.content[0].text,
      steerQueuedText(child.tabLabel, child.paneId),
    );
    // A successful ack removes the request and only its own acknowledgement.
    assert.equal(await requestWritten(child.controlDir), false);
  });
});

test('steer reports idle with its exact text', async () => {
  await withHarness({}, async (harness) => {
    const child = await startChild(harness, { controlAck: 'idle' });

    const result = await harness.callTool('agent_send', {
      name: child.tabLabel,
      message: 'use the cache layer',
    });

    assertAttempt(result, {
      tabLabel: child.tabLabel,
      paneId: child.paneId,
      action: 'steer',
      status: 'idle',
    });
    assert.equal(
      result.content[0].text,
      steerIdleText(child.tabLabel, child.paneId),
    );
  });
});

test('steer reports unknown on a missing ack, keeps the request and never retries', async () => {
  await withHarness({}, async (harness) => {
    const child = await startChild(harness, { controlAck: 'none' });
    const traffic = recordControlTraffic();
    try {
      const result = await harness.callTool('agent_send', {
        name: child.tabLabel,
        message: 'use the cache layer',
      });

      assertAttempt(result, {
        tabLabel: child.tabLabel,
        paneId: child.paneId,
        action: 'steer',
        status: 'unknown',
      });
      assert.equal(
        result.content[0].text,
        steerUnknownText(child.tabLabel, child.paneId),
      );

      // The request stays for the next operation's pre-clean, and nothing runs
      // after the call: no second publish, no ack, no timer.
      assert.deepEqual(await fs.readdir(child.controlDir), ['request.json']);
      const request = JSON.parse(
        await fs.readFile(requestFile(child.controlDir), 'utf8'),
      );
      assert.equal(request.id, result.details.requestId);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.deepEqual(await fs.readdir(child.controlDir), ['request.json']);
      assert.equal(
        traffic.events.filter((event) => event === 'publish:request.json')
          .length,
        1,
      );
    } finally {
      traffic.restore();
    }
  });
});

test('interrupt reports aborted with its exact text', async () => {
  await withHarness({}, async (harness) => {
    const child = await startChild(harness, { controlAck: 'aborted' });

    const result = await harness.callTool('agent_stop', {
      name: child.tabLabel,
    });

    assertAttempt(result, {
      tabLabel: child.tabLabel,
      paneId: child.paneId,
      action: 'interrupt',
      status: 'aborted',
    });
    assert.equal(
      result.content[0].text,
      interruptAbortedText(child.tabLabel, child.paneId),
    );
  });
});

test('interrupt reports requested with its exact text', async () => {
  await withHarness({}, async (harness) => {
    const child = await startChild(harness, { controlAck: 'requested' });

    const result = await harness.callTool('agent_stop', {
      name: child.tabLabel,
    });

    assertAttempt(result, {
      tabLabel: child.tabLabel,
      paneId: child.paneId,
      action: 'interrupt',
      status: 'requested',
    });
    assert.equal(
      result.content[0].text,
      interruptRequestedText(child.tabLabel, child.paneId),
    );
  });
});

test('interrupt reports idle with its exact text', async () => {
  await withHarness({}, async (harness) => {
    const child = await startChild(harness, { controlAck: 'idle' });

    const result = await harness.callTool('agent_stop', {
      name: child.tabLabel,
    });

    assertAttempt(result, {
      tabLabel: child.tabLabel,
      paneId: child.paneId,
      action: 'interrupt',
      status: 'idle',
    });
    assert.equal(
      result.content[0].text,
      interruptIdleText(child.tabLabel, child.paneId),
    );
  });
});

test('interrupt reports unknown on a missing ack and keeps the request', async () => {
  await withHarness({}, async (harness) => {
    const child = await startChild(harness, { controlAck: 'none' });

    const result = await harness.callTool('agent_stop', {
      name: child.tabLabel,
    });

    assertAttempt(result, {
      tabLabel: child.tabLabel,
      paneId: child.paneId,
      action: 'interrupt',
      status: 'unknown',
    });
    assert.equal(
      result.content[0].text,
      interruptUnknownText(child.tabLabel, child.paneId),
    );
    assert.deepEqual(await fs.readdir(child.controlDir), ['request.json']);
  });
});

test('an ack for the other action is reported as unknown, not as success', async () => {
  await withHarness({}, async (harness) => {
    // `queued` is a steer outcome; reading it as an interrupt result would
    // claim an abort that nobody observed.
    const child = await startChild(harness, { controlAck: 'queued' });

    const result = await harness.callTool('agent_stop', {
      name: child.tabLabel,
    });

    assertAttempt(result, {
      tabLabel: child.tabLabel,
      paneId: child.paneId,
      action: 'interrupt',
      status: 'unknown',
    });
    assert.equal(
      result.content[0].text,
      interruptUnknownText(child.tabLabel, child.paneId),
    );
    // Not trusted, so nothing is removed for the next operation to miss.
    assert.deepEqual((await fs.readdir(child.controlDir)).sort(), [
      `ack.${result.details.requestId}.json`,
      'request.json',
    ]);
  });
});

test('two parallel operations on one child are serialized', async () => {
  await withHarness({}, async (harness) => {
    const child = await startChild(harness, { controlAck: 'queued' });
    const traffic = recordControlTraffic();
    try {
      const [first, second] = await Promise.all([
        harness.callTool('agent_send', {
          name: child.tabLabel,
          message: 'first correction',
        }),
        harness.callTool('agent_send', {
          name: child.tabLabel,
          message: 'second correction',
        }),
      ]);

      assert.equal(first.details.status, 'queued');
      assert.equal(second.details.status, 'queued');
      assert.notEqual(first.details.requestId, second.details.requestId);

      // Each operation published its own request and acked it: no request was
      // overwritten while another operation was waiting for its ack.
      // Queue order follows whichever call finished its lookup first, so only
      // the ordering of the transport events is asserted, not call order.
      const publishes = traffic.events
        .map((event, index) => ({ event, index }))
        .filter((item) => item.event === 'publish:request.json');
      assert.equal(publishes.length, 2);
      const removedAcks = traffic.events
        .slice(publishes[0]!.index + 1, publishes[1]!.index)
        .filter((event) => event.startsWith('remove:ack.'));
      assert.equal(
        removedAcks.length,
        1,
        'the first operation finished its own cleanup before the second published',
      );
      const requestIds = [first.details.requestId, second.details.requestId];
      assert.ok(
        requestIds.includes(
          removedAcks[0]!.slice('remove:ack.'.length, -'.json'.length),
        ),
        'the removed acknowledgement belongs to one of the two operations',
      );
      assert.deepEqual(await fs.readdir(child.controlDir), []);
    } finally {
      traffic.restore();
    }
  });
});

test('cancellation during the pre-clean publishes nothing and releases the queue', async () => {
  await withHarness({}, async (harness) => {
    const child = await startChild(harness, { controlAck: 'queued' });
    const gate = pauseRequestCleanup(child.controlDir);
    const controller = new AbortController();
    try {
      const pending = harness.callTool(
        'agent_send',
        { name: child.tabLabel, message: 'cancelled' },
        { signal: controller.signal },
      );
      await gate.hit();
      controller.abort(new Error('cancelled during the pre-clean'));
      gate.release();

      await assert.rejects(pending, /cancelled during the pre-clean/);
      assert.equal(
        await requestWritten(child.controlDir),
        false,
        'a cancelled call publishes no request',
      );

      // The queue released in the cancelled operation's `finally`, so the next
      // call runs immediately instead of waiting for a dead entry.
      const next = await harness.callTool('agent_send', {
        name: child.tabLabel,
        message: 'next',
      });
      assert.equal(next.details.status, 'queued');
      assert.equal(await requestWritten(child.controlDir), false);
    } finally {
      gate.restore();
    }
  });
});

test('a finished operation drops only its own queue entry, so a third call stays behind a queued one', async () => {
  await withHarness({}, async (harness) => {
    const child = await startChild(harness, { controlAck: 'queued' });
    const traffic = recordControlTraffic();
    // The second acknowledgement belongs to the operation still in flight after
    // the first one resolves; holding it makes the next call's queue entry
    // observable.
    const heldAck = pauseNthAckWrite(2);
    try {
      const first = harness.callTool('agent_send', {
        name: child.tabLabel,
        message: 'one',
      });
      const second = harness.callTool('agent_send', {
        name: child.tabLabel,
        message: 'two',
      });
      const settled = await Promise.race([first, second]);
      assert.equal(settled.details.status, 'queued');
      await heldAck.hit();

      // The remaining operation owns the map entry. A third call must queue
      // behind it; dropping the entry at the first operation's end would let it
      // publish now and clean the in-flight request away.
      const third = harness.callTool('agent_send', {
        name: child.tabLabel,
        message: 'three',
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(
        traffic.events.filter((event) => event === 'publish:request.json')
          .length,
        2,
        'the third call waits for the in-flight operation',
      );

      heldAck.release();
      const results = await Promise.all([first, second, third]);
      assert.deepEqual(
        results.map((result) => result.details.status),
        ['queued', 'queued', 'queued'],
      );
      assert.deepEqual(await fs.readdir(child.controlDir), []);
    } finally {
      heldAck.restore();
      traffic.restore();
    }
  });
});

test('a control call leaves a pending outcome untouched and cannot duplicate its delivery', async () => {
  await withHarness({}, async (harness) => {
    const child = await startChild(harness, { controlAck: 'queued' });
    const markerFile = path.join(path.dirname(child.resultFile), 'interrupted');
    await fs.writeFile(child.resultFile, RESULT_TEXT, 'utf8');
    await fs.writeFile(markerFile, 'interrupted\n', 'utf8');
    await harness.fake.completeAgent(child.automationName, RESULT_TEXT);

    // The ordinary-path marker protection blocks delivery, so a collection is
    // pending exactly the way a control call could disturb it.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const results = () =>
      harness.messages.filter(
        (message) => message.customType === 'herdr_agent_result',
      );
    assert.deepEqual(results(), []);

    const before = harness.fake.calls.length;
    const control = await harness.callTool('agent_send', {
      name: child.tabLabel,
      message: 'adjust',
    });
    assert.equal(control.details.status, 'queued');

    const afterControl = harness.fake.calls.slice(before);
    assert.deepEqual(
      afterControl.filter((argv) =>
        ['prompt', 'wait', 'close', 'read'].includes(argv[1] ?? ''),
      ),
      [],
      'a control call issues no agent prompt, wait, close or read',
    );
    assert.deepEqual(results(), []);
    assert.equal(harness.fake.callsMatching('pane', 'close').length, 0);
    assert.ok(harness.fake.paneById(child.paneId), 'the pane stays open');
    assert.equal(
      Object.keys((await harness.readState()).agents).length,
      1,
      'the live record stays',
    );
    assert.equal(await fs.readFile(child.resultFile, 'utf8'), RESULT_TEXT);

    // Once the marker is gone, the outcome is delivered exactly once. A second
    // control call cannot produce another delivery.
    await fs.rm(markerFile, { force: true });
    await harness.collect(child.tabLabel, 8000);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(results().length, 1);

    const afterDelivery = await harness.callTool('agent_stop', {
      name: child.tabLabel,
    });
    assert.equal(afterDelivery.isError, true);
    assert.equal(results().length, 1);
  });
});
