import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, test } from 'vitest';

import {
  awaitControlAck,
  controlDirFor,
  readControlRequest,
  removeControlArtifacts,
  withControlDirQueue,
  writeControlAck,
  writeControlRequest,
} from '../src/control.ts';
import {
  ControlRequest as ControlRequestSchema,
  type ControlRequest,
} from '../src/control/schema.ts';
import { parseJson } from '../src/json.ts';

/**
 * Control transport: the `control/` directory beside a managed `result.md`,
 * atomic publish, per-id acknowledgements, id validation and the per-directory
 * queue.
 */

const createdDirs: string[] = [];

afterAll(async () => {
  for (const dir of createdDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function managedAgentDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'herdr-agent-'));
  createdDirs.push(dir);
  return dir;
}

/** The control directory of a managed agent temp dir; it does not exist. */
async function managedControlDir(): Promise<string> {
  const dir = controlDirFor(path.join(await managedAgentDir(), 'result.md'));
  assert.ok(dir, 'expected a managed control directory');
  return dir;
}

/** Leftover transport temp files; they are written beside the control directory. */
async function agentTempFiles(controlDir: string): Promise<string[]> {
  const names = await fs.readdir(path.dirname(controlDir));
  return names.filter((name) => name.endsWith('.tmp'));
}

async function otherTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'control-test-'));
  createdDirs.push(dir);
  return dir;
}

function steerRequest(overrides: Partial<ControlRequest> = {}): ControlRequest {
  return {
    id: randomUUID(),
    action: 'steer',
    message: 'correct the course',
    createdAt: Date.now(),
    ...overrides,
  };
}

test('derives the control directory only from a managed result file', async () => {
  const agentDir = await managedAgentDir();
  const resultFile = path.join(agentDir, 'result.md');

  assert.equal(controlDirFor(resultFile), path.join(agentDir, 'control'));
  assert.equal(controlDirFor(undefined), undefined);
  assert.equal(controlDirFor(''), undefined);
  assert.equal(controlDirFor('/etc/passwd'), undefined);
  assert.equal(controlDirFor(path.join(os.tmpdir(), 'result.md')), undefined);
  assert.equal(
    controlDirFor(path.join(os.tmpdir(), 'other-agent', 'result.md')),
    undefined,
  );
  assert.equal(controlDirFor(path.join(agentDir, 'question.md')), undefined);
  assert.equal(
    controlDirFor(path.join(agentDir, '..', '..', 'result.md')),
    undefined,
  );
});

test('round-trips a request and ignores a missing or malformed one', async () => {
  const dir = await managedControlDir();
  assert.equal(await readControlRequest(dir), undefined);

  const request = steerRequest();
  await writeControlRequest(dir, request);
  assert.deepEqual(await readControlRequest(dir), request);

  const requestPath = path.join(dir, 'request.json');
  await fs.writeFile(requestPath, '{"id": "');
  assert.equal(await readControlRequest(dir), undefined);

  await fs.writeFile(
    requestPath,
    JSON.stringify({ id: randomUUID(), action: 'steer', createdAt: 'now' }),
  );
  assert.equal(await readControlRequest(dir), undefined);
});

test('rejects ids that could name a path outside the control directory', async () => {
  const dir = await managedControlDir();
  // `ack.` + `/../../evil` normalizes to `<agent temp dir>/evil.json`.
  const escaped = path.join(dir, '..', 'evil.json');

  await assert.rejects(
    writeControlRequest(dir, steerRequest({ id: '/../../evil' })),
    /malformed control request/,
  );
  await assert.rejects(
    writeControlAck(dir, {
      id: '/../../evil',
      action: 'steer',
      status: 'queued',
      at: Date.now(),
    }),
    /malformed control acknowledgement/,
  );
  await assert.rejects(fs.access(escaped), { code: 'ENOENT' });
  await assert.rejects(fs.access(dir), { code: 'ENOENT' });

  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const requestPath = path.join(dir, 'request.json');
  await fs.writeFile(
    requestPath,
    JSON.stringify({ id: '/../../evil', action: 'steer', createdAt: 1 }),
  );
  assert.equal(await readControlRequest(dir), undefined);

  const victim = path.join(dir, '..', 'victim.json');
  await fs.writeFile(victim, 'keep');
  await writeControlRequest(dir, steerRequest());
  await removeControlArtifacts(dir, '/../../victim');
  assert.equal(await fs.readFile(victim, 'utf8'), 'keep');
  assert.equal(await readControlRequest(dir), undefined);
});

test('refuses to write transport files outside a managed control directory', async () => {
  const plainDir = await otherTempDir();
  await assert.rejects(
    writeControlRequest(plainDir, steerRequest()),
    /managed agent control directory/,
  );
  await assert.rejects(
    writeControlAck(path.join(plainDir, 'control'), {
      id: randomUUID(),
      action: 'interrupt',
      status: 'aborted',
      at: Date.now(),
    }),
    /managed agent control directory/,
  );
  assert.deepEqual(await fs.readdir(plainDir), []);
  assert.equal(await awaitControlAck(plainDir, randomUUID(), 50), undefined);
});

test('removes nothing outside a managed control directory', async () => {
  const plainDir = await otherTempDir();
  const decoy = path.join(plainDir, 'request.json');
  await fs.writeFile(decoy, '{}');

  await removeControlArtifacts(plainDir);
  await removeControlArtifacts(path.join(plainDir, 'control'), randomUUID());

  assert.equal(await fs.readFile(decoy, 'utf8'), '{}');
});

test('publishes atomically: no torn read and no leftover temp file', async () => {
  const dir = await managedControlDir();
  const message = 'y'.repeat(32_000);
  let observing = true;
  let reads = 0;
  let torn = 0;

  const observer = (async () => {
    while (observing) {
      const raw = await fs
        .readFile(path.join(dir, 'request.json'), 'utf8')
        .catch(() => undefined);
      if (raw === undefined) continue;
      reads += 1;
      if (!parseJson(ControlRequestSchema, raw)) torn += 1;
    }
  })();

  for (let index = 0; index < 40; index += 1) {
    await writeControlRequest(dir, steerRequest({ message, createdAt: index }));
  }
  observing = false;
  await observer;

  assert.ok(reads > 0, 'the observer never saw a published request');
  assert.equal(torn, 0);
  assert.deepEqual(await agentTempFiles(dir), []);
  assert.deepEqual(await fs.readdir(dir), ['request.json']);
});

test('accepts an ack only for the published id', async () => {
  const dir = await managedControlDir();
  const request = steerRequest();
  await writeControlRequest(dir, request);

  assert.equal(await awaitControlAck(dir, request.id, 60), undefined);

  const otherId = randomUUID();
  await writeControlAck(dir, {
    id: otherId,
    action: 'steer',
    status: 'queued',
    at: Date.now(),
  });
  assert.equal(await awaitControlAck(dir, request.id, 60), undefined);

  const ackPath = path.join(dir, `ack.${request.id}.json`);
  await fs.writeFile(
    ackPath,
    JSON.stringify({
      id: otherId,
      action: 'steer',
      status: 'queued',
      at: Date.now(),
    }),
  );
  assert.equal(await awaitControlAck(dir, request.id, 60), undefined);

  await fs.writeFile(ackPath, '{"id":');
  assert.equal(await awaitControlAck(dir, request.id, 60), undefined);

  const ack = {
    id: request.id,
    action: 'steer' as const,
    status: 'queued' as const,
    at: Date.now(),
  };
  await writeControlAck(dir, ack);
  assert.deepEqual(await awaitControlAck(dir, request.id, 250), ack);
});

test('returns the ack that lands while the parent waits', async () => {
  const dir = await managedControlDir();
  const request = steerRequest();
  await writeControlRequest(dir, request);
  const ack = {
    id: request.id,
    action: 'interrupt' as const,
    status: 'requested' as const,
    at: Date.now(),
  };
  setTimeout(() => void writeControlAck(dir, ack), 40);

  assert.deepEqual(await awaitControlAck(dir, request.id, 2000), ack);
});

test('a late ack for an old id neither satisfies nor overwrites a newer operation', async () => {
  const dir = await managedControlDir();
  const oldRequest = steerRequest();
  await writeControlRequest(dir, oldRequest);
  assert.equal(await awaitControlAck(dir, oldRequest.id, 60), undefined);

  const newRequest = steerRequest({ message: 'the newer correction' });
  await removeControlArtifacts(dir);
  await writeControlRequest(dir, newRequest);
  const newAck = {
    id: newRequest.id,
    action: 'steer' as const,
    status: 'queued' as const,
    at: Date.now(),
  };
  await writeControlAck(dir, newAck);

  await writeControlAck(dir, {
    id: oldRequest.id,
    action: 'steer',
    status: 'idle',
    at: Date.now(),
  });

  assert.deepEqual(await awaitControlAck(dir, newRequest.id, 60), newAck);
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(path.join(dir, `ack.${newRequest.id}.json`), 'utf8'),
    ),
    newAck,
  );

  await removeControlArtifacts(dir, newRequest.id);
  assert.equal(await readControlRequest(dir), undefined);
  assert.deepEqual(await fs.readdir(dir), [`ack.${oldRequest.id}.json`]);
});

test('preclean removes every ack; own-id cleanup leaves the other acks', async () => {
  const dir = await managedControlDir();
  const request = steerRequest();
  const strangerId = randomUUID();
  await writeControlRequest(dir, request);
  await writeControlAck(dir, {
    id: request.id,
    action: 'steer',
    status: 'queued',
    at: Date.now(),
  });
  await writeControlAck(dir, {
    id: strangerId,
    action: 'steer',
    status: 'queued',
    at: Date.now(),
  });
  assert.equal((await fs.readdir(dir)).length, 3);

  await removeControlArtifacts(dir, request.id);
  assert.deepEqual(await fs.readdir(dir), [`ack.${strangerId}.json`]);

  await removeControlArtifacts(dir);
  assert.deepEqual(await fs.readdir(dir), []);

  await removeControlArtifacts(dir);
});

test('creates the control directory 0700 and transport files 0600', async () => {
  const dir = await managedControlDir();
  const request = steerRequest();
  await writeControlRequest(dir, request);
  await writeControlAck(dir, {
    id: request.id,
    action: 'steer',
    status: 'queued',
    at: Date.now(),
  });

  assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
  assert.equal(
    (await fs.stat(path.join(dir, 'request.json'))).mode & 0o777,
    0o600,
  );
  assert.equal(
    (await fs.stat(path.join(dir, `ack.${request.id}.json`))).mode & 0o777,
    0o600,
  );
});

test('serializes overlapping operations on one control directory', async () => {
  const dir = await managedControlDir();
  const otherDir = await managedControlDir();
  const order: string[] = [];
  let releaseFirst!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = withControlDirQueue(dir, async () => {
    order.push('first:start');
    await gate;
    order.push('first:end');
  });
  const second = withControlDirQueue(dir, async () => {
    order.push('second');
  });

  await withControlDirQueue(otherDir, async () => {
    order.push('other-dir');
  });
  assert.deepEqual(order, ['first:start', 'other-dir']);

  releaseFirst();
  await first;
  await second;
  assert.deepEqual(order, ['first:start', 'other-dir', 'first:end', 'second']);
});

test('serializes the same directory spelled with a trailing separator', async () => {
  const dir = await managedControlDir();
  const order: string[] = [];
  let releaseFirst!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = withControlDirQueue(dir, async () => {
    order.push('first:start');
    await gate;
    order.push('first:end');
  });
  const second = withControlDirQueue(`${dir}${path.sep}`, async () => {
    order.push('second');
  });

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(order, ['first:start']);

  releaseFirst();
  await first;
  await second;
  assert.deepEqual(order, ['first:start', 'first:end', 'second']);
});

test('a failed publish removes its own temp file and keeps the original error', async () => {
  const dir = await managedControlDir();
  const requestPath = path.join(dir, 'request.json');
  // `rename` onto a directory fails after the temp file exists.
  await fs.mkdir(requestPath, { recursive: true, mode: 0o700 });

  await assert.rejects(
    writeControlRequest(dir, steerRequest()),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const code = (error as { code?: string }).code;
      assert.ok(
        code === 'EISDIR' || code === 'ENOTDIR',
        `unexpected error code ${code}`,
      );
      return true;
    },
  );

  assert.deepEqual(await agentTempFiles(dir), []);
  assert.deepEqual(await fs.readdir(requestPath), []);
});

test('an acknowledgement never recreates a removed control directory', async () => {
  const dir = await managedControlDir();

  // The parent removes the agent's temp directory on close, so an ack that
  // arrives afterwards has nowhere to land.
  await assert.rejects(
    writeControlAck(dir, {
      id: randomUUID(),
      action: 'steer',
      status: 'queued',
      at: Date.now(),
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'ENOENT');
      return true;
    },
  );

  await assert.rejects(fs.access(dir), { code: 'ENOENT' });
  assert.deepEqual(await agentTempFiles(dir), []);
});

test('rejects a pre-aborted signal and removes nothing', async () => {
  const dir = await managedControlDir();
  const request = steerRequest();
  await writeControlRequest(dir, request);

  const reason = new Error('control wait aborted');
  const controller = new AbortController();
  controller.abort(reason);

  await assert.rejects(
    awaitControlAck(dir, request.id, 10_000, controller.signal),
    (error: unknown) => error === reason,
  );
  assert.deepEqual(await readControlRequest(dir), request);
});

test('rejects a signal aborted while waiting and leaves the request in place', async () => {
  const dir = await managedControlDir();
  const request = steerRequest();
  await writeControlRequest(dir, request);

  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('control wait aborted')), 20);

  await assert.rejects(
    awaitControlAck(dir, request.id, 10_000, controller.signal),
    /abort/i,
  );
  assert.deepEqual(await readControlRequest(dir), request);
});

test('releases the queue after a failed operation', async () => {
  const dir = await managedControlDir();
  await assert.rejects(
    withControlDirQueue(dir, async () => {
      await writeControlRequest(dir, steerRequest());
      throw new Error('control operation failed');
    }),
    /control operation failed/,
  );

  // The failed operation left its request behind; the next one still runs.
  assert.equal(
    await withControlDirQueue(dir, async () => {
      await removeControlArtifacts(dir);
      await writeControlRequest(dir, steerRequest({ message: 'after it' }));
      return (await readControlRequest(dir))?.message;
    }),
    'after it',
  );
});
