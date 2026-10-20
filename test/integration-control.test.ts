import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { test, vi } from 'vitest';

import type { Harness } from '../test-support/harness.ts';
import { withHarness } from '../test-support/integration-harness.ts';

/**
 * THROWAWAY prototype gate (docs/plans/agent-control.md, slice 1 B, checks 6/7).
 *
 * Real extension, real timer-driven poller, real claim and close, against
 * FakeHerdr. The only seam is a test-only `fs.promises.readFile` interposition
 * that runs the real read and pauses the read made from the production poller
 * (`src/ui/detached-outcomes.ts`, identified by its call stack) after it
 * returned, so a child-side marker write can be landed deterministically after
 * that read. Nothing in the poller, the marker decision, the claim or the
 * delivery is replaced.
 *
 * Check 6 asserts the behavior the user accepted (D5, option 1 of the plan's
 * [Gate result]): a marker write that loses to a collection tick already in
 * flight does not stop that delivery, and the pane closes. The ordinary-path
 * protection — a marker on disk before the poller's read — still blocks
 * delivery.
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

async function startSettledChild(harness: Harness) {
  harness.fake.setBehavior(() => ({ delayMs: 0, result: PARTIAL }));
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
    (message) => message.customType === 'herdr_agent_result',
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
