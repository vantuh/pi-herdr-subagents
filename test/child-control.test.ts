import assert from 'node:assert/strict';
import { promises as fs, existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { test, vi } from 'vitest';

import { RESULT_FILE_MARKER } from '../src/artifacts.ts';
import { CONTROL_ABORT_OBSERVE_MS } from '../src/child/control.ts';
import {
  awaitControlAck,
  controlDirFor,
  writeControlRequest,
} from '../src/control.ts';
import type { ControlAck } from '../src/control/schema.ts';
import herdrAgentsExtension from '../src/index.ts';
import {
  applyEnv,
  createMockHost,
  type MockHost,
  waitFor,
} from '../test-support/mock-extension.ts';

/**
 * Child-side control consumer (docs/plans/agent-control.md, §7.3): the real
 * child extension under `HERDR_AGENT_CHILD=1`, driven through its handlers with
 * real transport files and a real `fs.watch`. The mock host only supplies
 * `ctx.isIdle()` and `ctx.abort()`.
 */

const assignment = (resultFile: string) =>
  `Do the job.\n${RESULT_FILE_MARKER} ${resultFile}`;

/**
 * FSEvents can lose a change made inside a freshly installed watcher's startup
 * window: 1 publish in 20 was never read when the write followed `watch()`
 * immediately, and none once the write waited 25 ms. A real Orchestrator
 * publishes well after `before_agent_start`, so this wait only keeps a lost
 * event from being mistaken for a consumer defect.
 */
const WATCH_SETTLE_MS = 100;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs the real `fs[method]` but pauses the first call whose path matches,
 * before it executes, until `release()`. Every other call is untouched, so a
 * test can hold one shutdown-relevant stage open without a lifecycle seam.
 */
function gateFsCall(
  method: 'mkdir' | 'writeFile' | 'readFile',
  match: (file: string) => boolean,
) {
  const original = fs[method].bind(fs);
  let reached!: () => void;
  const hit = new Promise<void>((resolve) => (reached = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let paused = false;
  const spy = vi.spyOn(fs, method).mockImplementation((async (
    file: unknown,
    ...rest: unknown[]
  ) => {
    if (typeof file === 'string' && match(file) && !paused) {
      paused = true;
      reached();
      await gate;
    }
    return (original as any)(file, ...rest);
  }) as any);
  return {
    hit: () => hit,
    release: () => release(),
    restore: () => spy.mockRestore(),
  };
}

/**
 * Open `fs.watch` handles. macOS reports them as `FSEventWrap`; the count is
 * synchronous on install and lands one tick after `close()`. The test that uses
 * it first counts a normal installation, so an unexpected resource name on
 * another platform fails loudly instead of passing vacuously.
 */
function watchHandles(): number {
  return process
    .getActiveResourcesInfo()
    .filter((name) => name === 'FSEventWrap' || name === 'FSWatcher').length;
}

interface ChildFixture {
  host: MockHost;
  tmp: string;
  /** A fresh managed agent temp dir with a `result.md` path in it. */
  resultFile(): Promise<string>;
  controlDir(resultFile: string): string;
  /**
   * Publish a request and wait for its ack. The wait is the last resort, not a
   * fallback: nothing here pokes the consumer.
   */
  publish(
    dir: string,
    request: {
      id: string;
      action: 'steer' | 'interrupt';
      message?: string;
      createdAt?: number;
    },
  ): Promise<ControlAck | undefined>;
}

async function withChildFixture(
  options: { isIdle?: boolean | (() => boolean); onAbort?: () => void },
  body: (fixture: ChildFixture) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'herdr-child-control-'));
  const tmp = path.join(root, 'tmp');
  await fs.mkdir(tmp, { recursive: true });
  const restoreEnv = applyEnv({ TMPDIR: tmp, HERDR_AGENT_CHILD: '1' });
  const host = createMockHost({ cwd: root, ...options });
  herdrAgentsExtension(host.pi);
  try {
    await body({
      host,
      tmp,
      resultFile: async () => {
        const dir = await fs.mkdtemp(path.join(tmp, 'herdr-agent-'));
        return path.join(dir, 'result.md');
      },
      controlDir: (resultFile) => {
        const dir = controlDirFor(resultFile);
        assert.ok(dir, 'expected a managed control directory');
        return dir;
      },
      publish: async (dir, request) => {
        await sleep(WATCH_SETTLE_MS);
        await writeControlRequest(dir, {
          createdAt: Date.now(),
          ...request,
        });
        return awaitControlAck(dir, request.id, 5000);
      },
    });
  } finally {
    // Close the control watcher the way Pi ends a session; removing its
    // directory is not the consumer's cleanup.
    await host.fire('session_shutdown').catch(() => {});
    restoreEnv();
    await fs.rm(root, { recursive: true, force: true });
  }
}

/** The interrupt marker beside the result file. */
function markerFile(resultFile: string): string {
  return path.join(path.dirname(resultFile), 'interrupted');
}

test('a steer into an active, non-idle run is applied synchronously and acked queued', async () => {
  await withChildFixture({ isIdle: () => false }, async (fixture) => {
    const resultFile = await fixture.resultFile();
    const dir = fixture.controlDir(resultFile);
    await fixture.host.fire('before_agent_start', {
      prompt: assignment(resultFile),
    });
    await fixture.host.fire('agent_start');

    const ack = await fixture.publish(dir, {
      id: 'control-steer-1',
      action: 'steer',
      message: 'STEER_TEXT',
    });

    // The ack echoes the id it consumed and lands in its own per-id file.
    assert.equal(ack?.id, 'control-steer-1');
    assert.equal(ack?.action, 'steer');
    assert.equal(ack?.status, 'queued');
    assert.deepEqual(
      (await fs.readdir(dir)).filter((name) => name.startsWith('ack.')),
      ['ack.control-steer-1.json'],
    );

    assert.equal(fixture.host.messages.length, 1);
    const [message] = fixture.host.messages;
    assert.equal(message.customType, 'herdr_agent_steer');
    assert.equal(message.content, 'STEER_TEXT');
    assert.equal(message.deliverAs, 'steer');
    assert.equal(
      message.triggerTurn,
      undefined,
      'a steer never starts a run on its own',
    );
    assert.deepEqual(message.details, { requestId: 'control-steer-1' });

    // The child never removes the request: the parent is its only remover.
    assert.equal(
      await fs.access(path.join(dir, 'request.json')).then(
        () => true,
        () => false,
      ),
      true,
    );
  });
});

test('a steer is refused while Pi is idle even though the run state still reads active', async () => {
  await withChildFixture({ isIdle: () => true }, async (fixture) => {
    const resultFile = await fixture.resultFile();
    const dir = fixture.controlDir(resultFile);
    await fixture.host.fire('before_agent_start', {
      prompt: assignment(resultFile),
    });
    await fixture.host.fire('agent_start');

    const ack = await fixture.publish(dir, {
      id: 'control-idle',
      action: 'steer',
      message: 'STEER_TO_NOWHERE',
    });

    assert.equal(ack?.status, 'idle');
    assert.deepEqual(fixture.host.messages, []);
  });
});

test('a steer is refused during a standalone compaction: no run, but not idle', async () => {
  await withChildFixture({ isIdle: () => false }, async (fixture) => {
    const resultFile = await fixture.resultFile();
    const dir = fixture.controlDir(resultFile);
    await fixture.host.fire('before_agent_start', {
      prompt: assignment(resultFile),
    });

    const ack = await fixture.publish(dir, {
      id: 'control-compacting',
      action: 'steer',
      message: 'STEER_INTO_COMPACTION',
    });

    // `!ctx.isIdle()` alone would look controllable here; the run state says no.
    assert.equal(ack?.status, 'idle');
    assert.deepEqual(fixture.host.messages, []);
  });
});

test('a request older than the run is refused; a same-millisecond one is the heuristic limit', async () => {
  await withChildFixture({ isIdle: () => false }, async (fixture) => {
    const resultFile = await fixture.resultFile();
    const dir = fixture.controlDir(resultFile);
    const started = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(started);
    try {
      await fixture.host.fire('before_agent_start', {
        prompt: assignment(resultFile),
      });
    } finally {
      clock.mockRestore();
    }
    await fixture.host.fire('agent_start');

    const stale = await fixture.publish(dir, {
      id: 'control-stale',
      action: 'steer',
      message: 'STEER_STALE',
      createdAt: started - 1,
    });
    assert.equal(stale?.status, 'idle');
    assert.deepEqual(fixture.host.messages, []);

    // Milliseconds, not run identity: an equal timestamp passes the heuristic.
    const equal = await fixture.publish(dir, {
      id: 'control-equal-ms',
      action: 'steer',
      message: 'STEER_EQUAL_MS',
      createdAt: started,
    });
    assert.equal(equal?.status, 'queued');
    assert.equal(fixture.host.messages.length, 1);
  });
});

test('one publish applies once and acks once, however many watch events it raises', async () => {
  await withChildFixture({ isIdle: () => false }, async (fixture) => {
    const resultFile = await fixture.resultFile();
    const dir = fixture.controlDir(resultFile);
    await fixture.host.fire('before_agent_start', {
      prompt: assignment(resultFile),
    });
    await fixture.host.fire('agent_start');

    const ack = await fixture.publish(dir, {
      id: 'control-once',
      action: 'steer',
      message: 'STEER_ONCE',
    });
    assert.equal(ack?.status, 'queued');

    // Extra watch events force another admission attempt on the consumed id.
    await fs.writeFile(path.join(dir, 'decoy'), 'x');
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(fixture.host.messages.length, 1);
    assert.deepEqual(
      (await fs.readdir(dir)).filter((name) => name.startsWith('ack.')),
      ['ack.control-once.json'],
    );
  });
});

test('a publish inside the watcher startup window is applied once or honestly unknown', async () => {
  await withChildFixture({ isIdle: () => false }, async (fixture) => {
    const resultFile = await fixture.resultFile();
    const dir = fixture.controlDir(resultFile);
    await fixture.host.fire('before_agent_start', {
      prompt: assignment(resultFile),
    });
    await fixture.host.fire('agent_start');

    // No settle wait, unlike every other test here: this publish races the
    // watcher's FSEvents startup. Either outcome is documented; a false ack or a
    // double application is not.
    await writeControlRequest(dir, {
      id: 'control-startup-window',
      action: 'steer',
      message: 'STEER_STARTUP_WINDOW',
      createdAt: Date.now(),
    });
    const ack = await awaitControlAck(dir, 'control-startup-window', 500);
    const acks = (await fs.readdir(dir)).filter((name) =>
      name.startsWith('ack.'),
    );

    if (ack) {
      assert.equal(ack.status, 'queued');
      assert.deepEqual(acks, ['ack.control-startup-window.json']);
      assert.equal(fixture.host.messages.length, 1);
    } else {
      // A lost event is `unknown`: the request stays untouched and nothing is
      // applied or acknowledged.
      assert.deepEqual(acks, []);
      assert.equal(fixture.host.messages.length, 0);
      assert.ok(
        await fs.access(path.join(dir, 'request.json')).then(
          () => true,
          () => false,
        ),
        'the request is on disk and simply unread',
      );
    }
    console.log(
      '[child-control] startup-window publish outcome:',
      ack?.status ?? 'unknown',
    );
  });
});

test('the watcher follows the result-file marker to a new directory', async () => {
  await withChildFixture({ isIdle: () => false }, async (fixture) => {
    const first = await fixture.resultFile();
    const second = await fixture.resultFile();
    const firstDir = fixture.controlDir(first);
    const secondDir = fixture.controlDir(second);
    await fixture.host.fire('before_agent_start', {
      prompt: assignment(first),
    });
    await fixture.host.fire('agent_start');
    await fixture.host.fire('before_agent_start', {
      prompt: assignment(second),
    });

    const ack = await fixture.publish(secondDir, {
      id: 'control-retarget',
      action: 'steer',
      message: 'STEER_NEW_DIR',
    });
    assert.equal(ack?.status, 'queued');
    assert.equal(fixture.host.messages.length, 1);

    // The old directory is no longer watched.
    const orphan = await fixture.publish(firstDir, {
      id: 'control-orphan',
      action: 'steer',
      message: 'STEER_OLD_DIR',
    });
    assert.equal(orphan, undefined);
    assert.equal(fixture.host.messages.length, 1);
  });
});

test('shutdown closes the watcher and an in-flight consume neither acks nor throws', async () => {
  await withChildFixture({ isIdle: () => false }, async (fixture) => {
    const resultFile = await fixture.resultFile();
    const dir = fixture.controlDir(resultFile);
    await fixture.host.fire('before_agent_start', {
      prompt: assignment(resultFile),
    });
    await fixture.host.fire('agent_start');

    // Hold the consumer's admission read open, so the request is in flight
    // when the session shuts down.
    const gate = gateFsCall(
      'readFile',
      (file) => path.basename(file) === 'request.json',
    );
    try {
      await sleep(WATCH_SETTLE_MS);
      await writeControlRequest(dir, {
        id: 'control-inflight',
        action: 'steer',
        message: 'STEER_INFLIGHT',
        createdAt: Date.now(),
      });
      await gate.hit();
      await fixture.host.fire('session_shutdown');
    } finally {
      gate.release();
      gate.restore();
    }

    // Released after shutdown: the consumer must not ack or apply anything.
    await sleep(100);

    assert.deepEqual(
      (await fs.readdir(dir)).filter((name) => name.startsWith('ack.')),
      [],
    );
    assert.deepEqual(fixture.host.messages, []);

    // The watcher is gone too: this publish is never consumed.
    const after = await fixture.publish(dir, {
      id: 'control-after-shutdown',
      action: 'steer',
      message: 'STEER_AFTER_SHUTDOWN',
    });
    assert.equal(after, undefined);
    assert.deepEqual(fixture.host.messages, []);
  });
});

test('shutdown during watcher installation installs no watcher afterwards', async () => {
  await withChildFixture({ isIdle: () => false }, async (fixture) => {
    const resultFile = await fixture.resultFile();
    const dir = fixture.controlDir(resultFile);

    await sleep(WATCH_SETTLE_MS);
    const baseline = watchHandles();
    // Calibrate the counter: a normal installation is visible and shutdown
    // closes it, so an unknown resource name cannot pass the fence silently.
    await fixture.host.fire('before_agent_start', {
      prompt: assignment(resultFile),
    });
    assert.equal(watchHandles(), baseline + 1, 'a live watcher is counted');
    await fixture.host.fire('session_shutdown');
    await sleep(WATCH_SETTLE_MS);
    assert.equal(watchHandles(), baseline, 'shutdown closed the watcher');

    // The fence: shutdown runs while the directory creation is in flight.
    const gate = gateFsCall(
      'mkdir',
      (file) => path.basename(file) === 'control',
    );
    let installing: Promise<unknown> | undefined;
    try {
      installing = fixture.host.fire('before_agent_start', {
        prompt: assignment(resultFile),
      });
      await gate.hit();
      await fixture.host.fire('session_shutdown');
    } finally {
      gate.release();
      gate.restore();
    }
    // Let the resumed installation finish; it must not register a watcher.
    await installing;
    await sleep(WATCH_SETTLE_MS);
    assert.equal(watchHandles(), baseline, 'no watcher after the shutdown');

    await writeControlRequest(dir, {
      id: 'control-install-race',
      action: 'steer',
      message: 'STEER_AFTER_INSTALL_RACE',
      createdAt: Date.now(),
    });
    // A watcher would consume this and either ack or apply; without one, nothing
    // happens and the parent would report `unknown`.
    assert.equal(
      await awaitControlAck(dir, 'control-install-race', 500),
      undefined,
    );
    assert.deepEqual(fixture.host.messages, []);
  });
});

test('shutdown during the interrupt marker write starts no abort', async () => {
  let aborts = 0;
  await withChildFixture(
    {
      isIdle: () => false,
      onAbort: () => {
        aborts += 1;
      },
    },
    async (fixture) => {
      const resultFile = await fixture.resultFile();
      const dir = fixture.controlDir(resultFile);
      await fixture.host.fire('before_agent_start', {
        prompt: assignment(resultFile),
      });
      await fixture.host.fire('agent_start');
      await sleep(WATCH_SETTLE_MS);

      // Hold the consumer's marker write open; the abort follows it.
      const gate = gateFsCall(
        'writeFile',
        (file) => path.basename(file) === 'interrupted',
      );
      try {
        await writeControlRequest(dir, {
          id: 'control-marker-race',
          action: 'interrupt',
          createdAt: Date.now(),
        });
        await gate.hit();
        await fixture.host.fire('session_shutdown');
      } finally {
        gate.release();
        gate.restore();
      }
      await sleep(150);

      assert.equal(aborts, 0, 'no abort after shutdown');
      assert.deepEqual(
        (await fs.readdir(dir)).filter((name) => name.startsWith('ack.')),
        [],
      );
      assert.deepEqual(fixture.host.messages, []);
    },
  );
});

test('shutdown drains an acknowledgement publication that already started', async () => {
  await withChildFixture({ isIdle: () => false }, async (fixture) => {
    const resultFile = await fixture.resultFile();
    const dir = fixture.controlDir(resultFile);
    await fixture.host.fire('before_agent_start', {
      prompt: assignment(resultFile),
    });
    await fixture.host.fire('agent_start');
    await sleep(WATCH_SETTLE_MS);

    // Hold the ack's temporary-file write, so the publication is mid-flight.
    const gate = gateFsCall('writeFile', (file) =>
      path.basename(file).startsWith('.ack.'),
    );
    let shutdownDone = false;
    try {
      await writeControlRequest(dir, {
        id: 'control-ack-drain',
        action: 'steer',
        message: 'STEER_ACK_DRAIN',
        createdAt: Date.now(),
      });
      await gate.hit();
      const shutdown = fixture.host.fire('session_shutdown').then(() => {
        shutdownDone = true;
      });
      await sleep(50);
      assert.equal(
        shutdownDone,
        false,
        'shutdown waits for a publication that already started',
      );
      gate.release();
      await shutdown;
    } finally {
      gate.release();
      gate.restore();
    }

    assert.equal(shutdownDone, true);
    // Drained, not abandoned: the ack renamed before shutdown returned.
    const ack = await awaitControlAck(dir, 'control-ack-drain', 100);
    assert.equal(ack?.status, 'queued');
    assert.deepEqual(
      (await fs.readdir(path.dirname(dir))).filter((name) =>
        name.endsWith('.tmp'),
      ),
      [],
      'the drained publish left no temp file',
    );
  });
});

test('an interrupt marks the result before aborting and acks the observed abort', async () => {
  let abortSeen = false;
  let markerAtAbort: boolean | undefined;
  let resultFile: string | undefined;
  // Assigned in the body: the abort callback needs the host it is registered on.
  let abort: (() => void) | undefined;
  await withChildFixture(
    { isIdle: () => false, onAbort: () => abort?.() },
    async (fixture) => {
      abort = () => {
        abortSeen = true;
        markerAtAbort = existsSync(markerFile(resultFile!));
        void fixture.host.fire('agent_settled', { aborted: true });
      };
      resultFile = await fixture.resultFile();
      const dir = fixture.controlDir(resultFile);
      await fixture.host.fire('before_agent_start', {
        prompt: assignment(resultFile),
      });
      await fixture.host.fire('agent_start');
      // The extension wrote the marker at before_agent_start; clearing it makes
      // the surviving marker the consumer's own write.
      await fs.rm(markerFile(resultFile), { force: true });
      assert.equal(existsSync(markerFile(resultFile)), false);

      const ack = await fixture.publish(dir, {
        id: 'control-interrupt',
        action: 'interrupt',
      });

      assert.equal(ack?.status, 'aborted');
      assert.equal(ack?.action, 'interrupt');
      assert.equal(abortSeen, true);
      assert.equal(markerAtAbort, true, 'the marker lands before the abort');
      // Restored again by the child's own `agent_settled` handler.
      assert.equal(
        existsSync(markerFile(resultFile)),
        true,
        'an aborted settle re-sets the marker',
      );
    },
  );
});

test('an interrupt with no observed settle within the window acks requested', async () => {
  await withChildFixture(
    { isIdle: () => false, onAbort: () => {} },
    async (fixture) => {
      const file = await fixture.resultFile();
      const dir = fixture.controlDir(file);
      await fixture.host.fire('before_agent_start', {
        prompt: assignment(file),
      });
      await fixture.host.fire('agent_start');

      const started = Date.now();
      const ack = await fixture.publish(dir, {
        id: 'control-requested',
        action: 'interrupt',
      });

      assert.equal(ack?.status, 'requested');
      assert.ok(
        Date.now() - started >= CONTROL_ABORT_OBSERVE_MS,
        'the child waits out its own abort-observation window',
      );
      assert.equal(
        existsSync(markerFile(file)),
        true,
        'the marker stays set although no abort was observed',
      );
    },
  );
});

test('a context from a replaced runtime refuses instead of succeeding', async () => {
  let aborts = 0;
  await withChildFixture(
    {
      isIdle: () => {
        throw new Error(
          'This extension ctx is stale after session replacement',
        );
      },
      onAbort: () => {
        aborts += 1;
      },
    },
    async (fixture) => {
      const resultFile = await fixture.resultFile();
      const dir = fixture.controlDir(resultFile);
      await fixture.host.fire('before_agent_start', {
        prompt: assignment(resultFile),
      });
      await fixture.host.fire('agent_start');
      await fs.rm(markerFile(resultFile), { force: true });

      const ack = await fixture.publish(dir, {
        id: 'control-stale-ctx',
        action: 'interrupt',
      });

      assert.equal(ack?.status, 'idle');
      assert.equal(aborts, 0);
      assert.equal(
        existsSync(markerFile(resultFile)),
        false,
        'a refusal writes no marker',
      );
    },
  );
});

test('a failing ack write is contained and the consumer keeps working', async () => {
  await withChildFixture({ isIdle: () => false }, async (fixture) => {
    const resultFile = await fixture.resultFile();
    const dir = fixture.controlDir(resultFile);
    await fixture.host.fire('before_agent_start', {
      prompt: assignment(resultFile),
    });
    await fixture.host.fire('agent_start');

    // The agent's temp dir can be gone by the time the ack lands (`closeOneShot`
    // removes it), which fails the publish's rename.
    const original = fs.rename.bind(fs);
    const spy = vi.spyOn(fs, 'rename').mockImplementation((async (
      from: unknown,
      to: unknown,
    ) => {
      if (typeof to === 'string' && path.basename(to).startsWith('ack.')) {
        const error = new Error('ENOENT: no such file or directory');
        (error as NodeJS.ErrnoException).code = 'ENOENT';
        throw error;
      }
      return (original as any)(from, to);
    }) as any);
    try {
      await sleep(WATCH_SETTLE_MS);
      await writeControlRequest(dir, {
        id: 'control-ack-fails',
        action: 'steer',
        message: 'STEER_WITH_BROKEN_ACK',
        createdAt: Date.now(),
      });
      // The steer is applied; the ack write fails and must not reject the
      // background consume (vitest fails the file on an unhandled rejection).
      await waitFor(() => fixture.host.messages.length === 1, 'the steer');
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.deepEqual(
        (await fs.readdir(dir)).filter((name) => name.startsWith('ack.')),
        [],
      );
    } finally {
      spy.mockRestore();
    }

    const ack = await fixture.publish(dir, {
      id: 'control-after-ack-failure',
      action: 'steer',
      message: 'STEER_AFTER_FAILURE',
    });
    assert.equal(ack?.status, 'queued');
    assert.equal(fixture.host.messages.length, 2);
  });
});
