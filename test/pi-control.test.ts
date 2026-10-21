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
import { test } from 'vitest';

import { isAgentResultInterrupted } from '../src/artifacts.ts';
import {
  awaitControlAck,
  controlDirFor,
  writeControlRequest,
} from '../src/control.ts';
import type { ControlAck } from '../src/control/schema.ts';
import herdrAgentsExtension from '../src/index.ts';
import { applyEnv, waitFor } from '../test-support/mock-extension.ts';
import { MockLlm } from '../test-support/mock-llm.ts';

/**
 * Child control against real in-process Pi: the real extension in child mode as
 * the consumer, `createAgentSession` + MockLlm as the run, and real transport
 * files in a managed temp directory.
 *
 * Owns the behavior the guard depends on (docs/plans/agent-control.md §10): the
 * before-settle steer window, refusal once Pi settled while the child's run
 * state still reads active, a live-run steer reaching the next provider request
 * but never the result artifact, an in-process abort with the marker kept, and
 * the watcher/ack/reservation path.
 *
 * Test handlers are registered *before* the extension's own, so a settle
 * handler can hold the child's `agent_settled` chain open: Pi has already
 * cleared `_isAgentRunActive` while the child's `active` flag is still true.
 */

const assignment = (resultFile: string) =>
  `Do the job.\n\nAGENT_RESULT_FILE: ${resultFile}`;

interface ControlFixture {
  resultFile: string;
  controlDir: string;
  llm: MockLlm;
  /** Extra extension factories, registered before the extension under test. */
  launch(
    factories?: Array<(pi: ExtensionAPI) => void>,
  ): Promise<Awaited<ReturnType<typeof createAgentSession>>>;
  /**
   * Publish a request and wait for its ack over the watch path only: a missed
   * watch event ends the wait with no ack, so the test fails.
   */
  publish(request: {
    id: string;
    action: 'steer' | 'interrupt';
    message?: string;
  }): Promise<{ ack: ControlAck | undefined; latencyMs: number }>;
  dispose(): Promise<void>;
}

async function createControlFixture(): Promise<ControlFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'herdr-pi-control-'));
  const resultDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'herdr-agent-pi-control-'),
  );
  const resultFile = path.join(resultDir, 'result.md');
  const dir = controlDirFor(resultFile);
  assert.ok(dir, 'expected a managed control directory');
  const restoreEnv = applyEnv({
    PI_CODING_AGENT_DIR: root,
    PI_AGENT_CHILD: '1',
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

  let session: Awaited<ReturnType<typeof createAgentSession>> | undefined;

  return {
    resultFile,
    controlDir: dir,
    llm,
    launch: async (factories = []) => {
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir: root,
        extensionFactories: [...factories, herdrAgentsExtension],
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
      await writeControlRequest(dir, { ...request, createdAt: started });
      const ack = await awaitControlAck(dir, request.id, 5000);
      return { ack, latencyMs: Date.now() - started };
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

function acknowledgeNames(names: string[]): string[] {
  return names.filter((name) => name.startsWith('ack.')).sort();
}

/** Request ids of the steers Pi actually appended to the child's session. */
function appendedSteerIds(
  messages: readonly unknown[],
): (string | undefined)[] {
  return messages.flatMap((message) => {
    const custom = message as {
      role?: string;
      customType?: string;
      details?: { requestId?: string };
    };
    return custom.role === 'custom' && custom.customType === 'agent_steer'
      ? [custom.details?.requestId]
      : [];
  });
}

test('check 1: a steer published in the before-settle window is applied as a continuation', async () => {
  await withFixture(async (fixture) => {
    fixture.llm.setScript((_body, index) =>
      index === 0
        ? { text: 'AGENT_RESULT: first turn', delayMs: 0 }
        : { text: 'SECOND_TURN', delayMs: 0 },
    );
    const published: { id: string; ack?: ControlAck } = {
      id: 'req-before-settle',
    };
    const { session } = await fixture.launch([
      (pi) => {
        pi.on('agent_before_settle', async (event) => {
          if (event.outcome !== 'completed' || published.ack) return;
          await writeControlRequest(fixture.controlDir, {
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

test('check 2: a steer after Pi settled is refused while the run state still reads active', async () => {
  await withFixture(async (fixture) => {
    fixture.llm.setScript(() => ({
      text: 'AGENT_RESULT: only turn',
      delayMs: 0,
    }));
    const observed: { id: string; ack?: ControlAck } = {
      id: 'req-stale-active',
    };
    const { session } = await fixture.launch([
      (pi) => {
        // Registered before the child extension's own settle handler, so this
        // handler runs while `active` is still true and Pi already reports idle.
        pi.on('agent_settled', async () => {
          if (observed.ack) return;
          await writeControlRequest(fixture.controlDir, {
            id: observed.id,
            action: 'steer',
            message: 'STEER_AFTER_SETTLE',
            createdAt: Date.now(),
          });
          observed.ack = await awaitControlAck(
            fixture.controlDir,
            observed.id,
            5000,
          );
        });
      },
    ]);

    await session.prompt(assignment(fixture.resultFile));

    assert.equal(observed.ack?.status, 'idle');
    assert.equal(fixture.llm.requests.length, 1, 'no run was started');
    assert.doesNotMatch(
      await fs.readFile(fixture.resultFile, 'utf8'),
      /STEER_AFTER_SETTLE/,
    );
    // Pi's idle branch would append the message with no run, which is the false
    // `queued` the double guard prevents: the transcript must not contain it.
    assert.doesNotMatch(
      JSON.stringify(session.sessionManager.getEntries()),
      /STEER_AFTER_SETTLE/,
    );
  });
});

test('check 3: a live-run steer reaches the next request and stays out of the result', async () => {
  await withFixture(async (fixture) => {
    fixture.llm.setScript((_body, index) =>
      index === 0
        ? { text: 'FIRST_ANSWER', delayMs: 700 }
        : { text: 'SECOND_ANSWER', delayMs: 0 },
    );
    const { session } = await fixture.launch();
    const run = session.prompt(assignment(fixture.resultFile)).catch(() => {});

    await waitFor(() => session.isStreaming, 'the first run to start');
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

test('check 4: an interrupt aborts the run, re-sets the marker, and acks aborted', async () => {
  await withFixture(async (fixture) => {
    fixture.llm.setScript(() => ({ text: 'LONG_TURN', delayMs: 1500 }));
    const { session } = await fixture.launch();
    const run = session.prompt(assignment(fixture.resultFile)).catch(() => {});

    await waitFor(() => session.isStreaming, 'the run to start');
    const steer = await fixture.publish({
      id: 'req-steer-before-abort',
      action: 'steer',
      message: 'STEER_BEFORE_ABORT',
    });
    assert.equal(steer.ack?.status, 'queued');

    // The child extension writes the marker at `before_agent_start`, so remove
    // it first: the assertion below then proves the consumer's own write (D5).
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
    assert.equal(
      await isAgentResultInterrupted(fixture.resultFile),
      true,
      'the consumer re-set the interrupted marker for the aborted run',
    );
    await waitFor(() => !session.isStreaming, 'the aborted settle');
    assert.equal(session.isIdle, true, 'Pi reports idle after the abort');
    await run;
    // In-process `abort()` does not clear the queues; the TUI binding's discard
    // is asserted in the e2e interrupt scenario (slice 5).
  });
});

test('check 5b: repeated atomic publishes are each consumed once by the watcher', async () => {
  await withFixture(async (fixture) => {
    fixture.llm.setScript((_body, index) =>
      index === 0
        ? { text: 'HOLD_TURN', delayMs: 1500 }
        : { text: 'AFTER_STEERS', delayMs: 0 },
    );
    const { session } = await fixture.launch();
    const run = session.prompt(assignment(fixture.resultFile)).catch(() => {});
    await waitFor(() => session.isStreaming, 'the run to start');

    const ids = [
      'req-repeat-1',
      'req-repeat-2',
      'req-repeat-3',
      'req-repeat-4',
    ];
    for (const id of ids) {
      const { ack } = await fixture.publish({
        id,
        action: 'steer',
        message: `STEER_${id}`,
      });
      assert.equal(ack?.status, 'queued', `ack for ${id}`);
    }

    assert.deepEqual(
      acknowledgeNames(await fs.readdir(fixture.controlDir)),
      ids.map((id) => `ack.${id}.json`).sort(),
    );
    assert.deepEqual(
      (await fs.readdir(path.dirname(fixture.resultFile))).filter((name) =>
        name.endsWith('.tmp'),
      ),
      [],
      'the atomic publish left no temp file beside the control directory',
    );
    assert.ok(
      await fs.access(path.join(fixture.controlDir, 'request.json')).then(
        () => true,
        () => false,
      ),
      'the child never removes request.json',
    );

    await run;
    await waitFor(() => !session.isStreaming, 'the run to settle');
    // Each id was appended to the run exactly once, in publish order.
    assert.deepEqual(appendedSteerIds(session.messages), ids);
    const body = JSON.stringify(fixture.llm.requests.slice(1));
    for (const id of ids) {
      assert.match(body, new RegExp(`STEER_${id}`), `${id} reached the model`);
    }
  });
});

test('check 5: the watcher consumes one atomic publish once, and a re-read cannot re-apply it', async () => {
  await withFixture(async (fixture) => {
    fixture.llm.setScript((_body, index) =>
      index === 0
        ? { text: 'HOLD_TURN', delayMs: 1200 }
        : { text: 'AFTER_STEER', delayMs: 0 },
    );
    const { session } = await fixture.launch();
    const run = session.prompt(assignment(fixture.resultFile)).catch(() => {});
    await waitFor(() => session.isStreaming, 'the run to start');

    const { ack, latencyMs } = await fixture.publish({
      id: 'req-watch',
      action: 'steer',
      message: 'STEER_WATCHER',
    });
    assert.equal(ack?.status, 'queued');
    assert.ok(latencyMs < 1000, `bounded ack latency (${latencyMs} ms)`);
    assert.deepEqual(acknowledgeNames(await fs.readdir(fixture.controlDir)), [
      'ack.req-watch.json',
    ]);

    // Extra watch events force another admission attempt on the consumed id.
    await fs.writeFile(path.join(fixture.controlDir, 'decoy'), 'x');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(acknowledgeNames(await fs.readdir(fixture.controlDir)), [
      'ack.req-watch.json',
    ]);

    await run;
    await waitFor(() => !session.isStreaming, 'the run to settle');
    assert.equal(fixture.llm.requests.length, 2);
    assert.deepEqual(
      appendedSteerIds(
        (session as { messages?: readonly unknown[] }).messages ?? [],
      ),
      ['req-watch'],
      'the reservation kept the re-read from applying it twice',
    );
    assert.match(
      JSON.stringify(fixture.llm.requests[1]?.messages),
      /STEER_WATCHER/,
    );
    assert.doesNotMatch(
      await fs.readFile(fixture.resultFile, 'utf8'),
      /STEER_WATCHER/,
    );
  });
});
