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
  // The shared managed-temp policy, as for every sibling artifact: the first
  // segment under `os.tmpdir()` starts with `herdr-agent-`, which also admits
  // nested paths such as `<tmp>/herdr-agent-X/sub/control`.
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

/** `tmp + rename`, so a reader never sees a half-written transport file. */
async function publishPrivateFile(
  filePath: string,
  text: string,
): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tempPath, text, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tempPath, filePath);
  } catch (error) {
    // Best effort, so a failed publish does not leave a temp file for cleanup
    // that only matches `request.json` / `ack.*.json`; the original error is
    // what the caller has to see.
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
  await publishPrivateFile(requestFile(dir), `${JSON.stringify(request)}\n`);
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
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, ackFileName(ack.id));
  await publishPrivateFile(filePath, `${JSON.stringify(ack)}\n`);
}

async function readAck(
  dir: string,
  id: string,
): Promise<ControlAck | undefined> {
  const raw = await readIfExists(path.join(dir, ackFileName(id)));
  if (raw === undefined) return undefined;
  const ack = parseJson(ControlAck, raw);
  // Only an ack naming the published id counts: a file for another id, a torn
  // write or a payload id mismatch means "no acknowledgement", never an error.
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

/**
 * The parent is the sole remover of transport files. Without `id` this is the
 * pre-operation clean (the request and every ack); with `id` it removes the
 * request and only that operation's own ack.
 */
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
  // An id that cannot name an ack file is never turned into a path.
  if (!Value.Check(ControlId, id)) return;
  await fs.rm(path.join(dir, ackFileName(id)), { force: true });
}

// Serializes control operations per child directory, so two parallel calls
// cannot publish competing requests or clean each other's acknowledgement.
// The in-process half of `withStateFileLock`, without the lock directory and
// without a signal: a queued operation is cancelled by its own caller checking
// its signal before it publishes, not while it waits.
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
  // Every mapped entry resolves, so a failed operation cannot reject the
  // operations queued behind it.
  controlDirQueues.set(
    key,
    previous.then(() => current),
  );
  try {
    await previous;
    return await fn();
  } finally {
    releaseQueue();
  }
}
