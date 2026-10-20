import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { afterAll, test } from 'vitest';

import { isAgentResultInterrupted } from '../src/artifacts.ts';
import herdrAgentsExtension from '../src/index.ts';
import {
  ackFiles,
  awaitControlAck,
  type PrototypeControlAck,
  type PrototypeControlConsumer,
  prototypeControlDirFor,
  publishControlRequest,
  readControlRequest,
  registerPrototypeControlConsumer,
} from '../test-support/control-prototype.ts';
import { applyEnv, waitFor } from '../test-support/mock-extension.ts';
import { MockLlm } from '../test-support/mock-llm.ts';

/**
 * THROWAWAY prototype, slice 1 A (docs/plans/agent-control.md). Real in-process
 * Pi (`createAgentSession` + MockLlm + real files), the real child extension
 * under `HERDR_AGENT_CHILD=1`, and the throwaway consumer in
 * `test-support/control-prototype.ts`. No product control code exists.
 *
 * Checks 1-5 of the plan: before-settle acceptance, refusal after Pi settled
 * despite a stale `active`, a live-run steer reaching the next request but not
 * the result artifact, an in-process abort with the marker kept, and the
 * watcher/ack/reservation behavior with a measured ack latency.
 */

/** Measurements this suite prints at the end, for the plan's D7/D8 numbers. */
const measurements: { ackLatencyMs: number[]; watchEvents: number[] } = {
  ackLatencyMs: [],
  watchEvents: [],
};

afterAll(() => {
  const sorted = [...measurements.ackLatencyMs].sort((a, b) => a - b);
  console.log(
    `[control-prototype] ack latencies ms: ${JSON.stringify(sorted)} (n=${sorted.length})`,
  );
  console.log(
    `[control-prototype] watch events seen: ${JSON.stringify(measurements.watchEvents)}`,
  );
});

const assignment = (resultFile: string) =>
  `Do the job.\n\nHERDR_RESULT_FILE: ${resultFile}`;

interface ControlFixture {
  resultFile: string;
  controlDir: string;
  llm: MockLlm;
  consumer(): PrototypeControlConsumer | undefined;
  launch(
    factories?: Array<(pi: ExtensionAPI) => void>,
  ): Promise<Awaited<ReturnType<typeof createAgentSession>>>;
  /**
   * Publish a request and wait for its ack over the watch path only: a missed
   * watch event ends the wait with no ack, so the test fails (D8).
   */
  publish(request: {
    id: string;
    action: 'steer' | 'interrupt';
    message?: string;
  }): Promise<{ ack: PrototypeControlAck | undefined; latencyMs: number }>;
  dispose(): Promise<void>;
}

async function createControlFixture(): Promise<ControlFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'herdr-pi-control-'));
  const resultDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'herdr-agent-pi-control-'),
  );
  const resultFile = path.join(resultDir, 'result.md');
  const controlDir = prototypeControlDirFor(resultFile);
  const restoreEnv = applyEnv({
    PI_CODING_AGENT_DIR: root,
    HERDR_AGENT_CHILD: '1',
  });
  const llm = new MockLlm();
  await llm.start();
  await fs.writeFile(
    path.join(root, 'models.json'),
    JSON.stringify({
      providers: {
        mock: {
          api: 'openai-completions',
          baseUrl: llm.baseUrl,
          apiKey: 'mock',
          models: [
            {
              id: 'fixture',
              name: 'Fixture',
              input: ['text'],
              contextWindow: 32000,
              maxTokens: 4096,
            },
          ],
        },
      },
    }),
  );

  let consumer: PrototypeControlConsumer | undefined;
  let session: Awaited<ReturnType<typeof createAgentSession>> | undefined;

  return {
    resultFile,
    controlDir,
    llm,
    consumer: () => consumer,
    launch: async (factories = []) => {
      consumer = undefined;
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir: root,
        extensionFactories: [
          herdrAgentsExtension,
          ...factories,
          (pi) => {
            consumer = registerPrototypeControlConsumer(pi);
          },
        ],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await loader.reload();
      const created = await createAgentSession({
        cwd: root,
        agentDir: root,
        resourceLoader: loader,
        settingsManager: SettingsManager.inMemory({
          defaultProvider: 'mock',
          defaultModel: 'fixture',
        }),
        sessionManager: SessionManager.inMemory(root),
      });
      session = created;
      return created;
    },
    publish: async (request) => {
      const started = Date.now();
      const full = { ...request, createdAt: started };
      await publishControlRequest(controlDir, full);
      const ack = await awaitControlAck(controlDir, full.id, 5000);
      const latencyMs = Date.now() - started;
      measurements.ackLatencyMs.push(latencyMs);
      return { ack, latencyMs };
    },
    dispose: async () => {
      session?.session.dispose();
      await llm.stop();
      restoreEnv();
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(resultDir, { recursive: true, force: true });
    },
  };
}

async function waitForWatcher(fixture: ControlFixture): Promise<void> {
  await waitFor(
    () => fixture.consumer()?.isWatching() === true,
    'the control-directory watcher',
  );
}

async function withFixture(
  body: (fixture: ControlFixture) => Promise<void>,
): Promise<void> {
  const fixture = await createControlFixture();
  try {
    await body(fixture);
  } finally {
    await fixture.dispose();
  }
}

test('slice 1 A check 1: a steer published in the before-settle window is applied as a continuation', async () => {
  await withFixture(async (fixture) => {
    fixture.llm.setScript((_body, index) =>
      index === 0
        ? { text: 'HERDR_RESULT: first turn', delayMs: 0 }
        : { text: 'SECOND_TURN', delayMs: 0 },
    );
    const published: { id: string; ack?: PrototypeControlAck } = {
      id: 'req-before-settle',
    };
    const { session } = await fixture.launch([
      (pi) => {
        pi.on('agent_before_settle', async (event) => {
          if (event.outcome !== 'completed' || published.ack) return;
          await publishControlRequest(fixture.controlDir, {
            id: published.id,
            action: 'steer',
            message: 'STEER_BEFORE_SETTLE',
            createdAt: Date.now(),
          });
          published.ack = await awaitControlAck(
            fixture.controlDir,
            published.id,
            5000,
          );
        });
      },
    ]);

    await session.prompt(assignment(fixture.resultFile));

    assert.equal(published.ack?.status, 'queued');
    assert.equal(fixture.llm.requests.length, 2, 'the continuation ran');
    assert.match(
      JSON.stringify(fixture.llm.requests[1]?.messages),
      /STEER_BEFORE_SETTLE/,
    );
    const result = await fs.readFile(fixture.resultFile, 'utf8');
    assert.match(result, /first turn/);
    assert.doesNotMatch(result, /STEER_BEFORE_SETTLE/);
    // Ordinary path: the settle boundary cleared the marker again.
    assert.equal(
      await isAgentResultInterrupted(fixture.resultFile),
      false,
      'a completed boundary clears the marker',
    );
  });
});

test('slice 1 A check 2: a steer after Pi settled is refused while `active` still reads true', async () => {
  await withFixture(async (fixture) => {
    fixture.llm.setScript(() => ({
      text: 'HERDR_RESULT: only turn',
      delayMs: 0,
    }));
    const observed: {
      id: string;
      ack?: PrototypeControlAck;
      probe?: { active: boolean; idle: boolean | undefined };
    } = { id: 'req-stale-active' };
    const { session } = await fixture.launch([
      (pi) => {
        pi.on('agent_settled', async () => {
          if (observed.ack) return;
          observed.probe = fixture.consumer()?.probe();
          const started = Date.now();
          await publishControlRequest(fixture.controlDir, {
            id: observed.id,
            action: 'steer',
            message: 'STEER_AFTER_SETTLE',
            createdAt: started,
          });
          observed.ack = await awaitControlAck(
            fixture.controlDir,
            observed.id,
            5000,
          );
          measurements.ackLatencyMs.push(Date.now() - started);
        });
      },
    ]);

    await session.prompt(assignment(fixture.resultFile));

    // The scenario the reviewer flagged: this handler is registered before the
    // consumer's own settle handler, so the child still looks active.
    assert.deepEqual(observed.probe, { active: true, idle: true });
    assert.equal(observed.ack?.status, 'idle');
    assert.deepEqual(fixture.consumer()?.decisions.at(-1), {
      id: observed.id,
      status: 'idle',
      active: true,
      idle: true,
    });
    assert.equal(fixture.llm.requests.length, 1, 'no run was started');
    assert.deepEqual(fixture.consumer()?.applications, []);
    assert.doesNotMatch(
      await fs.readFile(fixture.resultFile, 'utf8'),
      /STEER_AFTER_SETTLE/,
    );
    // Pi's idle branch appends the message with no run, which is the false
    // `queued` the reviewer flagged: the transcript must not contain it.
    assert.doesNotMatch(
      JSON.stringify(session.sessionManager.getEntries()),
      /STEER_AFTER_SETTLE/,
    );
  });
});

test('slice 1 A check 3: a live-run steer reaches the next request and stays out of the result', async () => {
  await withFixture(async (fixture) => {
    fixture.llm.setScript((_body, index) =>
      index === 0
        ? { text: 'FIRST_ANSWER', delayMs: 700 }
        : { text: 'SECOND_ANSWER', delayMs: 0 },
    );
    const { session } = await fixture.launch();
    const run = session.prompt(assignment(fixture.resultFile)).catch(() => {});

    await waitFor(() => session.isStreaming, 'the first run to start');
    await waitForWatcher(fixture);
    const { ack } = await fixture.publish({
      id: 'req-live',
      action: 'steer',
      message: 'STEER_LIVE_RUN',
    });
    assert.equal(ack?.status, 'queued');

    await run;
    await waitFor(() => !session.isStreaming, 'the run to settle');

    assert.equal(fixture.llm.requests.length, 2);
    assert.match(
      JSON.stringify(fixture.llm.requests[1]?.messages),
      /STEER_LIVE_RUN/,
    );
    const result = await fs.readFile(fixture.resultFile, 'utf8');
    assert.match(result, /FIRST_ANSWER/);
    assert.match(result, /SECOND_ANSWER/);
    assert.doesNotMatch(result, /STEER_LIVE_RUN/);
  });
});

test('slice 1 A check 4: an interrupt aborts the run, re-sets the marker, and acks aborted', async () => {
  await withFixture(async (fixture) => {
    fixture.llm.setScript(() => ({ text: 'LONG_TURN', delayMs: 1500 }));
    const { session } = await fixture.launch();
    const run = session.prompt(assignment(fixture.resultFile)).catch(() => {});

    await waitFor(() => session.isStreaming, 'the run to start');
    await waitForWatcher(fixture);
    const steer = await fixture.publish({
      id: 'req-steer-before-abort',
      action: 'steer',
      message: 'STEER_BEFORE_ABORT',
    });
    assert.equal(steer.ack?.status, 'queued');

    // The child extension writes the marker at `before_agent_start`, so remove
    // it first: the assertion below then proves the *consumer's* write (D5).
    const markerFile = path.join(
      path.dirname(fixture.resultFile),
      'interrupted',
    );
    await fs.rm(markerFile, { force: true });
    assert.equal(await isAgentResultInterrupted(fixture.resultFile), false);

    const interrupt = await fixture.publish({
      id: 'req-interrupt',
      action: 'interrupt',
    });
    assert.equal(interrupt.ack?.status, 'aborted');
    assert.equal(fixture.consumer()?.settles.at(-1)?.aborted, true);
    assert.equal(
      await isAgentResultInterrupted(fixture.resultFile),
      true,
      'the consumer re-set the interrupted marker for the aborted run',
    );
    await waitFor(() => !session.isStreaming, 'the aborted settle');
    assert.equal(session.isIdle, true, 'Pi reports idle after the abort');
    await run;
  });
});

test('slice 1 A check 5b (D8): repeated atomic publishes are all consumed by the watcher, with no missed event', async () => {
  await withFixture(async (fixture) => {
    fixture.llm.setScript(() => ({ text: 'HOLD_TURN', delayMs: 1500 }));
    const { session } = await fixture.launch();
    const run = session.prompt(assignment(fixture.resultFile)).catch(() => {});
    await waitFor(() => session.isStreaming, 'the run to start');
    await waitForWatcher(fixture);

    const ids = [
      'req-repeat-1',
      'req-repeat-2',
      'req-repeat-3',
      'req-repeat-4',
    ];
    for (const id of ids) {
      const started = Date.now();
      await publishControlRequest(fixture.controlDir, {
        id,
        action: 'steer',
        message: `STEER_${id}`,
        createdAt: started,
      });
      // Watch-event path only: a miss would end this wait without an ack.
      const ack = await awaitControlAck(fixture.controlDir, id, 3000);
      assert.equal(ack?.status, 'queued', `ack for ${id}`);
      measurements.ackLatencyMs.push(Date.now() - started);
    }

    const consumer = fixture.consumer();
    assert.ok(consumer);
    // One publish produces several watch events; the reservation absorbs the
    // repeats, so each id is applied once and gets exactly one ack.
    assert.deepEqual(consumer.applications, ids);
    assert.deepEqual(
      (await ackFiles(fixture.controlDir)).sort(),
      ids.map((id) => `ack.${id}.json`).sort(),
    );
    assert.ok(
      consumer.duplicateReads > 0,
      'repeated events re-read the same id',
    );
    assert.ok(consumer.watchEvents >= ids.length);
    console.log(
      '[control-prototype] duplicate watch reads absorbed:',
      consumer.duplicateReads,
    );
    measurements.watchEvents.push(consumer.watchEvents);
    assert.deepEqual(
      (await fs.readdir(fixture.controlDir)).filter((name) =>
        name.endsWith('.tmp'),
      ),
      [],
    );
    await run;
  });
});

test('slice 1 A check 5: the watcher consumes one atomic publish once, and a re-read cannot re-apply it', async () => {
  await withFixture(async (fixture) => {
    fixture.llm.setScript((_body, index) =>
      index === 0
        ? { text: 'HOLD_TURN', delayMs: 1200 }
        : { text: 'AFTER_STEER', delayMs: 0 },
    );
    const { session } = await fixture.launch();
    const run = session.prompt(assignment(fixture.resultFile)).catch(() => {});
    await waitFor(() => session.isStreaming, 'the run to start');
    await waitForWatcher(fixture);

    const started = Date.now();
    await publishControlRequest(fixture.controlDir, {
      id: 'req-watch',
      action: 'steer',
      message: 'STEER_WATCHER',
      createdAt: started,
    });
    // Watch-event path only: no poke here, so a miss fails loudly (D8).
    const ack = await awaitControlAck(fixture.controlDir, 'req-watch', 3000);
    const latencyMs = Date.now() - started;
    measurements.ackLatencyMs.push(latencyMs);

    assert.equal(ack?.status, 'queued');
    const consumer = fixture.consumer();
    assert.ok(consumer);
    assert.ok(consumer.watchEvents >= 1, 'the watcher reported the publish');
    measurements.watchEvents.push(consumer.watchEvents);
    assert.deepEqual(
      (await fs.readdir(fixture.controlDir)).filter((name) =>
        name.endsWith('.tmp'),
      ),
      [],
      'the atomic publish left no temp file',
    );
    assert.deepEqual(await ackFiles(fixture.controlDir), [
      'ack.req-watch.json',
    ]);
    const recorded = consumer.acks[0];
    assert.ok(recorded);
    assert.ok(
      recorded.latencyMs >= 0 && recorded.latencyMs < 1000,
      `the ack records a bounded publish-to-ack latency (${recorded.latencyMs} ms)`,
    );
    console.log('[control-prototype] check 5 ack latency ms:', latencyMs);

    // Duplicate watch callbacks and a re-read must not apply it twice.
    await Promise.all([consumer.consume(), consumer.consume()]);
    assert.ok(consumer.duplicateReads >= 1, 'the duplicate was rejected by id');
    assert.deepEqual(consumer.applications, ['req-watch']);
    assert.deepEqual(await ackFiles(fixture.controlDir), [
      'ack.req-watch.json',
    ]);
    assert.ok(
      await readControlRequest(fixture.controlDir),
      'the child never deletes request.json',
    );

    await run;
    assert.equal(fixture.llm.requests.length, 2);
    assert.doesNotMatch(
      await fs.readFile(fixture.resultFile, 'utf8'),
      /STEER_WATCHER/,
    );
  });
});
