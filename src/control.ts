import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { Value } from 'typebox/value';

import {
  isManagedHerdrTempPath,
  isManagedResultFile,
  readIfExists,
} from './artifacts.ts';
import { ControlAck, ControlId, ControlRequest } from './control/schema.ts';
import { parseJson } from './json.ts';

const CONTROL_DIR_NAME = 'control';
const REQUEST_FILE_NAME = 'request.json';
const ACK_FILE_PREFIX = 'ack.';
const ACK_FILE_SUFFIX = '.json';
const ACK_POLL_MS = 25;

/** `<agent temp dir>/control` beside `result.md`; undefined without the guard. */
export function controlDirFor(
  resultFile: string | undefined,
): string | undefined {
  if (!resultFile || !isManagedResultFile(resultFile)) return undefined;
  return path.join(path.dirname(path.resolve(resultFile)), CONTROL_DIR_NAME);
}

function isManagedControlDir(dir: string): boolean {
  // Shared managed-temp policy; it also admits nested `herdr-agent-X/sub/control`.
  const resolved = path.resolve(dir);
  return (
    isManagedHerdrTempPath(resolved) &&
    path.basename(resolved) === CONTROL_DIR_NAME
  );
}

function requestFile(dir: string): string {
  return path.join(dir, REQUEST_FILE_NAME);
}

function ackFileName(id: string): string {
  return `${ACK_FILE_PREFIX}${id}${ACK_FILE_SUFFIX}`;
}

// Keep temp files outside the watched directory: FSEvents can coalesce their
// writes with rename and hide publication of the request.
async function publishPrivateFile(
  dir: string,
  name: string,
  text: string,
): Promise<void> {
  const tempPath = path.join(
    path.dirname(path.resolve(dir)),
    `.${name}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  );
  const filePath = path.join(dir, name);
  try {
    await fs.writeFile(tempPath, text, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tempPath, filePath);
  } catch (error) {
    // Best-effort temp cleanup; rethrow the original error.
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function writeControlRequest(
  dir: string,
  request: ControlRequest,
): Promise<void> {
  if (!isManagedControlDir(dir)) {
    throw new Error(
      `Refusing to publish a control request outside a managed agent control directory: ${dir}`,
    );
  }
  if (!Value.Check(ControlRequest, request)) {
    throw new Error('Refusing to publish a malformed control request.');
  }
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await publishPrivateFile(
    dir,
    REQUEST_FILE_NAME,
    `${JSON.stringify(request)}\n`,
  );
}

export async function readControlRequest(
  dir: string,
): Promise<ControlRequest | undefined> {
  if (!isManagedControlDir(dir)) return undefined;
  const raw = await readIfExists(requestFile(dir));
  return raw === undefined ? undefined : parseJson(ControlRequest, raw);
}

export async function writeControlAck(
  dir: string,
  ack: ControlAck,
): Promise<void> {
  if (!isManagedControlDir(dir)) {
    throw new Error(
      `Refusing to write a control acknowledgement outside a managed agent control directory: ${dir}`,
    );
  }
  if (!Value.Check(ControlAck, ack)) {
    throw new Error('Refusing to write a malformed control acknowledgement.');
  }
  // No mkdir: a missing directory means a closed agent, so fail instead of
  // recreating an orphan.
  await publishPrivateFile(
    dir,
    ackFileName(ack.id),
    `${JSON.stringify(ack)}\n`,
  );
}

async function readAck(
  dir: string,
  id: string,
): Promise<ControlAck | undefined> {
  const raw = await readIfExists(path.join(dir, ackFileName(id)));
  if (raw === undefined) return undefined;
  const ack = parseJson(ControlAck, raw);
  // Only an ack naming this id counts; anything else is no acknowledgement.
  return ack?.id === id ? ack : undefined;
}

export async function awaitControlAck(
  dir: string,
  id: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ControlAck | undefined> {
  if (!isManagedControlDir(dir) || !Value.Check(ControlId, id))
    return undefined;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    signal?.throwIfAborted();
    const ack = await readAck(dir, id);
    if (ack) return ack;
    if (Date.now() >= deadline) return undefined;
    await sleep(ACK_POLL_MS, undefined, { signal });
  }
}

async function ackFileNames(dir: string): Promise<string[]> {
  const names = await fs.readdir(dir).catch(() => []);
  return names.filter(
    (name) =>
      name.startsWith(ACK_FILE_PREFIX) && name.endsWith(ACK_FILE_SUFFIX),
  );
}

/** Without `id`: pre-operation clean of the request and every ack. With `id`: the request and that ack only. */
export async function removeControlArtifacts(
  dir: string,
  id?: string,
): Promise<void> {
  if (!isManagedControlDir(dir)) return;
  await fs.rm(requestFile(dir), { force: true });
  if (id === undefined) {
    for (const name of await ackFileNames(dir)) {
      await fs.rm(path.join(dir, name), { force: true });
    }
    return;
  }
  if (!Value.Check(ControlId, id)) return;
  await fs.rm(path.join(dir, ackFileName(id)), { force: true });
}

// Serializes control operations per directory; a queued caller checks its own
// signal before publishing.
const controlDirQueues = new Map<string, Promise<unknown>>();

export async function withControlDirQueue<T>(
  dir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(dir);
  const previous = controlDirQueues.get(key) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  // `tail` always resolves, so a failure never rejects queued operations.
  const tail = previous.then(() => current);
  controlDirQueues.set(key, tail);
  try {
    await previous;
    return await fn();
  } finally {
    releaseQueue();
    // Preserve newer queue entries when releasing this operation.
    if (controlDirQueues.get(key) === tail) controlDirQueues.delete(key);
  }
}
