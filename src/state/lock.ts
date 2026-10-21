import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_STATE_LOCK_WAIT_MS = 60_000;
const STATE_LOCK_WAIT_MS_ENV = 'PI_AGENTS_LOCK_WAIT_MS';

function getStateLockWaitMs(): number {
  return envMs(STATE_LOCK_WAIT_MS_ENV, DEFAULT_STATE_LOCK_WAIT_MS);
}

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// Serializes load-mutate-save cycles per state file path. The in-process
// queue stops parallel agent tool calls in one Pi from clobbering each
// other; the exclusive lock directory stops a second Orchestrator from doing
// the same to claimDetached / record writes.
const stateFileQueues = new Map<string, Promise<unknown>>();

function lockSentinelPath(lockDir: string, token: string): string {
  return path.join(lockDir, `owner.${process.pid}.${token}`);
}

async function releaseLock(
  lockDir: string,
  sentinelPath: string,
): Promise<void> {
  await fs.unlink(sentinelPath).catch(() => {});
  await fs.rmdir(lockDir).catch(() => {});
}

async function tryAcquireExclusiveLock(
  lockPath: string,
  token: string,
): Promise<(() => Promise<void>) | 'locked'> {
  try {
    await fs.mkdir(lockPath);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'EEXIST' || code === 'ENOTDIR') return 'locked';
    throw error;
  }

  const sentinelPath = lockSentinelPath(lockPath, token);
  try {
    await fs.writeFile(
      sentinelPath,
      `${JSON.stringify({
        pid: process.pid,
        token,
        createdAt: Date.now(),
      })}\n`,
      { flag: 'wx', encoding: 'utf8' },
    );
  } catch (error) {
    await releaseLock(lockPath, sentinelPath);
    throw error;
  }

  return async () => {
    await releaseLock(lockPath, sentinelPath);
  };
}

async function acquireExclusiveLock(
  lockPath: string,
  signal?: AbortSignal,
): Promise<() => Promise<void>> {
  const token = randomBytes(16).toString('hex');
  const deadline = Date.now() + getStateLockWaitMs();
  while (true) {
    signal?.throwIfAborted();
    const acquired = await tryAcquireExclusiveLock(lockPath, token);
    if (acquired !== 'locked') return acquired;

    if (Date.now() >= deadline) {
      const retried = await tryAcquireExclusiveLock(lockPath, token);
      if (retried !== 'locked') return retried;
      throw new Error(
        `Timed out waiting for ${lockPath}. Another process still holds this exclusive lock directory (or a legacy lock file occupies that path); do not delete it while that process may be alive. If you are sure no Pi/herdr-agents process is running, remove the lock directory (or leftover lock file) manually and retry.`,
      );
    }
    await sleep(15, undefined, { signal });
  }
}

export async function withStateFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const previous = stateFileQueues.get(filePath) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  stateFileQueues.set(
    filePath,
    previous.then(() => current),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(signal?.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      previous
        .then(() => resolve(), reject)
        .finally(() => signal?.removeEventListener('abort', onAbort));
      if (signal?.aborted) onAbort();
    });
    signal?.throwIfAborted();
    const release = await acquireExclusiveLock(`${filePath}.lock`, signal);
    try {
      signal?.throwIfAborted();
      return await fn();
    } finally {
      await release();
    }
  } finally {
    releaseQueue();
  }
}
