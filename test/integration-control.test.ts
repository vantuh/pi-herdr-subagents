import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { test, vi } from 'vitest';

import type { Harness } from '../test-support/harness.ts';
import { withHarness } from '../test-support/integration-harness.ts';

/**
 * Control flows against the real poller (docs/plans/done/agent-control.md).
 *
 * Real extension, real timer-driven poller, real claim and close, against
 * FakeHerdr. The only seam is a test-only `fs.promises.readFile` interposition
 * that runs the real read and pauses the read made from the production poller
 * (`src/ui/detached-outcomes.ts`, identified by its call stack) after it
 * returned, so a child-side marker write, or a real control call, can be landed
 * deterministically against a collection already in flight. Nothing in the
 * poller, the marker decision, the claim or the delivery is replaced.
 *
 * Check 6 asserts the behavior the user accepted (D5, option 1 of the plan's
 * [Gate result]): a marker write that loses to a collection tick already in
 * flight does not stop that delivery, and the pane closes. The ordinary-path
 * protection — a marker on disk before the poller's read — still blocks
 * delivery. Check 7 forces the other overlap: a real `agent_stop` call
 * publishes and waits while a collection is held after its marker read, and the
 * collection is released while the tool is still in flight.
 */

const PARTIAL = 'partial text of an interrupted run';

type PausePoint = 'marker-read' | 'result-read';

/** Pauses the poller's read of `interrupted` or `result.md` after it returned. */
function interposeCollectorRead(point: PausePoint) {
  const original = fs.readFile.bind(fs);
  const pauseFile = point === 'marker-read' ? 'interrupted' : 'result.md';
  const observed: Array<{ file: string; outcome: 'value' | 'error' }> = [];
  let reached!: () => void;
  const hit = new Promise<void>((resolve) => (reached = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let paused = false;

  const spy = vi.spyOn(fs, 'readFile').mockImplementation((async (
    file: any,
    ...rest: any[]
  ) => {
    const name = typeof file === 'string' ? path.basename(file) : '';
    const isCollectorRead =
      (name === 'interrupted' || name === 'result.md') &&
      (new Error().stack ?? '').includes('detached-outcomes');
    const settled = await (original as any)(file, ...rest).then(
      (value: unknown) => ({ value }),
      (error: unknown) => ({ error }),
    );
    if (isCollectorRead) {
      observed.push({ file, outcome: 'error' in settled ? 'error' : 'value' });
      if (name === pauseFile && !paused) {
        paused = true;
        reached();
        await gate;
      }
    }
    if ('error' in settled) throw settled.error;
    return settled.value;
  }) as any);

  return {
    observed,
    hit: () =>
      Promise.race([
        hit,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`poller never read ${pauseFile}`)),
            8000,
          ),
        ),
      ]),
    /** Reads seen so far as `[file, outcome]`, for the interception assertion. */
    seen: () =>
      observed.map((item) => [path.basename(item.file), item.outcome]),
    release,
    restore: () => {
      release();
      spy.mockRestore();
    },
  };
}

async function startSettledChild(
  harness: Harness,
  extra: {
    controlAck?: 'queued' | 'idle' | 'none' | 'aborted' | 'requested';
  } = {},
) {
  harness.fake.setBehavior(() => ({ delayMs: 0, result: PARTIAL, ...extra }));
  await harness.call({ agent: 'scout', task: 'Long job' });
  const record = Object.values((await harness.readState()).agents)[0];
  const resultFile = record?.resultFile;
  const paneId = record?.paneId;
  assert.ok(resultFile, 'the record has a result file');
  assert.ok(paneId, 'the record has a pane id');
  return {
    resultFile,
    paneId,
    markerFile: path.join(path.dirname(resultFile), 'interrupted'),
  };
}

function resultMessages(harness: Harness) {
  return harness.messages.filter(
    (message) => message.customType === 'agent_result',
  );
}

test('control gate 6: a marker on disk before the poller read blocks delivery', async () => {
  await withHarness({}, async (harness) => {
    const reads = interposeCollectorRead('marker-read');
    try {
      const { resultFile, markerFile, paneId } =
        await startSettledChild(harness);
      await fs.writeFile(markerFile, 'interrupted\n', 'utf8');

      await reads.hit();
      reads.release();
      // Several ticks pass; the marker keeps winning.
      await new Promise((resolve) => setTimeout(resolve, 2500));

      // Every marker read by the poller saw the marker, so no tick delivered.
      assert.deepEqual(reads.seen()[0], ['interrupted', 'value']);
      assert.deepEqual(
        new Set(reads.seen().map((entry) => entry.join(':'))),
        new Set(['interrupted:value']),
      );
      assert.deepEqual(resultMessages(harness), []);
      assert.ok(harness.fake.paneById(paneId), 'the pane stays open');
      assert.equal(
        Object.values((await harness.readState()).agents).length,
        1,
        'the live record stays',
      );
      assert.equal(await fs.readFile(resultFile, 'utf8'), PARTIAL);
    } finally {
      reads.restore();
    }
  });
});

for (const point of ['marker-read', 'result-read'] as const) {
  test(`control gate 6 (accepted race): a marker write after the poller's ${point} still delivers the run's text`, async () => {
    await withHarness({}, async (harness) => {
      const reads = interposeCollectorRead(point);
      try {
        const { resultFile, markerFile, paneId } =
          await startSettledChild(harness);

        // The poller is paused inside its own read, after the read returned.
        // The child's marker write lands here and loses to this tick.
        await reads.hit();
        await fs.writeFile(markerFile, 'interrupted\n', 'utf8');
        assert.equal(
          await fs.readFile(markerFile, 'utf8'),
          'interrupted\n',
          'the marker is on disk before the in-flight tick claims',
        );
        reads.release();

        await harness.waitFor(
          () => resultMessages(harness).length > 0,
          'the accepted late delivery',
        );

        // Both reads were made by the production poller, and the marker read
        // saw the marker as absent.
        assert.deepEqual(reads.seen(), [
          ['interrupted', 'error'],
          ['result.md', 'value'],
        ]);

        // Accepted behavior: exactly one delivery, pane closed, record pruned.
        const delivered = resultMessages(harness);
        assert.equal(delivered.length, 1);
        assert.match(
          delivered[0]!.content,
          /partial text of an interrupted run/,
        );
        assert.match(delivered[0]!.content, /finished on its own/);
        assert.equal(harness.fake.paneById(paneId), undefined);
        assert.deepEqual((await harness.readState()).agents, {});
        assert.equal(harness.fake.callsMatching('pane', 'close').length, 1);

        // The close removed the temp directory (and the marker with it), so the
        // accepted race is proven by the ordering above plus the closed pane,
        // not by a surviving marker file.
        await assert.rejects(fs.readFile(markerFile, 'utf8'), /ENOENT/);
        await assert.rejects(fs.readFile(resultFile, 'utf8'), /ENOENT/);

        // No second delivery, and no new pane for the label.
        await new Promise((resolve) => setTimeout(resolve, 2500));
        assert.equal(resultMessages(harness).length, 1);
      } finally {
        reads.restore();
      }
    });
  });
}

/**
 * Slice 4 flows: the parent tool against the real poller and delivery. Behavior
 * only — the exact status texts belong to `contract-control.test.ts`.
 */

async function startWorkingChild(
  harness: Harness,
  options: {
    controlAck: 'queued' | 'aborted';
    delayMs: number;
    result: string;
  },
) {
  harness.fake.setBehavior(() => ({ ...options }));
  await harness.call({ agent: 'scout', task: 'Long job', name: 'Scout Work' });
  const record = Object.values((await harness.readState()).agents)[0];
  assert.ok(record?.resultFile, 'the record has a result file');
  assert.ok(record.paneId, 'the record has a pane id');
  assert.ok(record.automationName, 'the record has a Herdr name');
  return {
    tabLabel: 'Scout Work',
    paneId: record.paneId,
    resultFile: record.resultFile,
    automationName: record.automationName,
  };
}

test('a steer keeps the child working and its text arrives in the single result', async () => {
  await withHarness({}, async (harness) => {
    const child = await startWorkingChild(harness, {
      controlAck: 'queued',
      delayMs: 1500,
      result: 'work done',
    });

    const steer = await harness.callTool('agent_send', {
      name: child.tabLabel,
      message: 'use the cache layer',
    });
    assert.equal(steer.details.status, 'queued');
    assert.equal(
      harness.fake.agentByName(child.automationName)?.status,
      'working',
      'the steer does not settle the child',
    );

    const delivered = await harness.collect(child.tabLabel, 8000);
    assert.match(delivered.content, /work done/);
    assert.match(delivered.content, /use the cache layer/);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(
      resultMessages(harness).length,
      1,
      'one delivered result for the run',
    );
  });
});

test('an interrupt leaves the run undelivered and the agent open', async () => {
  await withHarness({}, async (harness) => {
    const child = await startWorkingChild(harness, {
      controlAck: 'aborted',
      delayMs: 2500,
      result: 'text of an interrupted run',
    });

    const interrupt = await harness.callTool('agent_stop', {
      name: child.tabLabel,
    });
    assert.equal(interrupt.details.status, 'aborted');

    // Several poller ticks after the interrupt, and past the simulated settle.
    await new Promise((resolve) => setTimeout(resolve, 3500));
    assert.deepEqual(resultMessages(harness), []);
    assert.ok(harness.fake.paneById(child.paneId), 'the pane stays open');
    assert.equal(
      Object.keys((await harness.readState()).agents).length,
      1,
      'the live record stays',
    );
    assert.equal(harness.fake.callsMatching('pane', 'close').length, 0);
  });
});

test('a question written before an interrupt is still delivered', async () => {
  await withHarness({}, async (harness) => {
    const child = await startWorkingChild(harness, {
      controlAck: 'aborted',
      delayMs: 2500,
      result: 'text of an interrupted run',
    });
    await fs.writeFile(
      path.join(path.dirname(child.resultFile), 'question.md'),
      'Which database should I target?\n',
      'utf8',
    );

    const interrupt = await harness.callTool('agent_stop', {
      name: child.tabLabel,
    });
    assert.equal(interrupt.details.status, 'aborted');

    const delivered = await harness.collect(child.tabLabel, 8000);
    assert.equal(delivered.customType, 'agent_question');
    assert.match(delivered.content, /Which database should I target\?/);
    assert.deepEqual(resultMessages(harness), []);
  });
});

/**
 * Pauses the first `fs.writeFile` to `target` before it runs, so a test can
 * remove the directory under a simulated child's write.
 */
function pauseFileWrite(target: string) {
  const original = fs.writeFile.bind(fs);
  let reached!: () => void;
  const hit = new Promise<void>((resolve) => (reached = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let paused = false;
  const spy = vi.spyOn(fs, 'writeFile').mockImplementation((async (
    file: any,
    ...rest: any[]
  ) => {
    if (String(file) === target && !paused) {
      paused = true;
      reached();
      await gate;
    }
    return await (original as any)(file, ...rest);
  }) as any);
  return {
    hit: () =>
      Promise.race([
        hit,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`nothing wrote ${target}`)), 8000),
        ),
      ]),
    release,
    restore: () => {
      release();
      spy.mockRestore();
    },
  };
}

test('control gate 7: a control call never claims, collects or closes a collection it overlaps', async () => {
  await withHarness({}, async (harness) => {
    const reads = interposeCollectorRead('marker-read');
    try {
      // This child answers no control request, so the tool stays in its ack
      // wait for its full deadline while the collection overlaps it.
      const { resultFile, paneId } = await startSettledChild(harness, {
        controlAck: 'none',
      });
      const agentDir = path.dirname(resultFile);
      const tabLabel =
        Object.values((await harness.readState()).agents)[0]?.tabLabel ?? '';

      // The production poller is inside its own read, after the marker read
      // returned ENOENT: a delivery is in flight.
      await reads.hit();
      assert.deepEqual(resultMessages(harness), []);

      // Baselines: the spawn itself prompted the child.
      const agentCalls = () =>
        ['prompt', 'read', 'wait'].map(
          (command) => harness.fake.callsMatching('agent', command).length,
        );
      const agentCallsBefore = agentCalls();
      let controlSettled = false;
      const control = harness
        .callTool('agent_stop', { name: tabLabel })
        .then((result) => {
          controlSettled = true;
          return result;
        });
      // The request lands while that collection is still held.
      await harness.waitFor(async () => {
        try {
          await fs.access(path.join(agentDir, 'control', 'request.json'));
          return true;
        } catch {
          return false;
        }
      }, 'the control request is published');
      assert.deepEqual(
        resultMessages(harness),
        [],
        'the collection is still held when the control call publishes',
      );

      // Release the collection while the control call is in flight.
      reads.release();
      await harness.waitFor(
        () => resultMessages(harness).length > 0,
        'the poller delivery',
      );
      assert.equal(
        controlSettled,
        false,
        'the collection was released while the control call was still in flight',
      );

      // Exactly one delivery and one close, both the poller's: the control call
      // added neither. It issues no prompt, read or wait for a live child.
      assert.equal(resultMessages(harness).length, 1);
      assert.match(resultMessages(harness)[0]!.content, /finished on its own/);
      assert.match(resultMessages(harness)[0]!.content, new RegExp(PARTIAL));
      assert.equal(harness.fake.callsMatching('pane', 'close').length, 1);
      assert.deepEqual(
        agentCalls(),
        agentCallsBefore,
        'the control call issues no agent prompt, read or wait',
      );

      // The tool reports the honest outcome of a channel whose agent is gone.
      const settled = await control;
      assert.equal(settled.isError, undefined);
      assert.equal(settled.details.status, 'unknown');

      // The close removed the agent temp directory; the control call must not
      // have recreated it (or anything inside it) while finishing.
      await assert.rejects(fs.access(agentDir), /ENOENT/);
      assert.equal(harness.fake.paneById(paneId), undefined);
      assert.deepEqual((await harness.readState()).agents, {});
      await new Promise((resolve) => setTimeout(resolve, 1200));
      assert.equal(
        resultMessages(harness).length,
        1,
        'the overlap delivers exactly once',
      );
    } finally {
      reads.restore();
    }
  });
});

test('a simulated control write that loses to a close stays contained and fenced', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({
      neverSettle: true,
      controlAck: 'aborted',
    }));
    await harness.call({
      agent: 'scout',
      task: 'Long job',
      name: 'Scout Work',
    });
    const record = Object.values((await harness.readState()).agents)[0];
    assert.ok(record?.resultFile, 'the record has a result file');
    const agentDir = path.dirname(record.resultFile);
    const markerFile = path.join(agentDir, 'interrupted');
    const gate = pauseFileWrite(markerFile);
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await fs.mkdir(path.join(agentDir, 'control'), { recursive: true });
      await fs.writeFile(
        path.join(agentDir, 'control', 'request.json'),
        `${JSON.stringify({
          id: 'close-race-1',
          action: 'interrupt',
          createdAt: Date.now(),
        })}\n`,
        'utf8',
      );

      // The simulated child is mid-marker-write when the close removes the
      // whole agent temp directory, exactly as `closeOneShot` does.
      await gate.hit();
      await fs.rm(agentDir, { recursive: true, force: true });
      gate.release();

      // Several polls pass: the failing write is contained, the missing
      // directory is not recreated, and nothing rejects unhandled.
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.deepEqual(rejections, []);
      await assert.rejects(fs.access(agentDir), /ENOENT/);
      await assert.rejects(fs.access(markerFile), /ENOENT/);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      gate.restore();
    }
  });
});
