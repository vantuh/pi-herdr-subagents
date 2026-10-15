import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, test } from 'vitest';

import { withStateFileLock } from '../src/state/lock.ts';
import { createTempStateFixture } from '../test-support/state-fixture.ts';

/**
 * State-file locking: in-process queue cancellation, stale locks, and
 * cross-process exclusion.
 */

const { tempStatePath, cleanup } = createTempStateFixture();

afterAll(cleanup);

test('cancels an in-process state queue wait without running its mutation after release', async () => {
  const filePath = await tempStatePath();
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = withStateFileLock(filePath, async () => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await ready;
  const controller = new AbortController();
  let mutated = false;
  const cancelled = withStateFileLock(
    filePath,
    async () => {
      mutated = true;
    },
    controller.signal,
  );
  controller.abort();
  await assert.rejects(cancelled, /abort/i);
  release();
  await held;
  await withStateFileLock(filePath, async () => {});
  assert.equal(mutated, false);
});

test('a prior lock holder does not remove a replacement lock directory', async () => {
  const filePath = await tempStatePath();
  const lockPath = `${filePath}.lock`;
  const replacementSentinel = 'owner.0.replacement-token';
  await withStateFileLock(filePath, async () => {
    const original = await fs.readdir(lockPath);
    assert.equal(original.length, 1);
    await fs.rm(lockPath, { recursive: true, force: true });
    await fs.mkdir(lockPath);
    await fs.writeFile(
      path.join(lockPath, replacementSentinel),
      `${JSON.stringify({
        pid: 0,
        token: 'replacement-token',
        createdAt: Date.now(),
      })}\n`,
    );
  });
  assert.deepEqual(await fs.readdir(lockPath), [replacementSentinel]);
  assert.match(
    await fs.readFile(path.join(lockPath, replacementSentinel), 'utf8'),
    /replacement-token/,
  );
});

test('a waiter cannot steal a live lock after the old stale threshold', async () => {
  const filePath = await tempStatePath();
  const dir = path.dirname(filePath);
  const lockModule = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../src/state/lock.ts',
  );
  const holderScript = path.join(dir, 'holder.ts');
  const waiterScript = path.join(dir, 'waiter.ts');
  await fs.writeFile(
    holderScript,
    `import { withStateFileLock } from ${JSON.stringify(lockModule)};
import { promises as fs } from 'node:fs';
const filePath = ${JSON.stringify(filePath)};
const dir = ${JSON.stringify(dir)};
await withStateFileLock(filePath, async () => {
  await fs.writeFile(dir + '/holder-entered', String(Date.now()));
  await new Promise((resolve) => setTimeout(resolve, 250));
  await fs.writeFile(dir + '/holder-left', String(Date.now()));
});
`,
  );
  await fs.writeFile(
    waiterScript,
    `import { withStateFileLock } from ${JSON.stringify(lockModule)};
import { promises as fs } from 'node:fs';
const filePath = ${JSON.stringify(filePath)};
const dir = ${JSON.stringify(dir)};
await withStateFileLock(filePath, async () => {
  const holderLeft = await fs.readFile(dir + '/holder-left', 'utf8').catch(() => '');
  await fs.writeFile(dir + '/waiter-entered', holderLeft ? 'after-holder' : 'before-holder');
});
`,
  );

  const env = {
    ...process.env,
    HERDR_AGENTS_LOCK_STALE_MS: '40',
    HERDR_AGENTS_LOCK_WAIT_MS: '2000',
  };
  const holder = spawn(process.execPath, [holderScript], { env });
  await waitForChildFile(dir, 'holder-entered');
  const waiter = spawn(process.execPath, [waiterScript], { env });
  const [holderCode, waiterCode] = await Promise.all([
    waitForExit(holder),
    waitForExit(waiter),
  ]);
  assert.equal(holderCode, 0);
  assert.equal(waiterCode, 0);
  assert.equal(
    await fs.readFile(path.join(dir, 'waiter-entered'), 'utf8'),
    'after-holder',
  );
});

test('two processes cannot occupy the state lock at the same time', async () => {
  const filePath = await tempStatePath();
  const dir = path.dirname(filePath);
  const lockModule = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../src/state/lock.ts',
  );
  const lockerScript = path.join(dir, 'locker.ts');
  await fs.writeFile(
    lockerScript,
    `import { withStateFileLock } from ${JSON.stringify(lockModule)};
import { promises as fs } from 'node:fs';
const filePath = ${JSON.stringify(filePath)};
const marker = process.argv[2];
const dir = ${JSON.stringify(dir)};
await withStateFileLock(filePath, async () => {
  const entered = Date.now();
  await fs.writeFile(dir + '/' + marker + '-entered', String(entered));
  await new Promise((resolve) => setTimeout(resolve, 80));
  await fs.writeFile(dir + '/' + marker + '-left', String(Date.now()));
});
`,
  );
  const env = { ...process.env, HERDR_AGENTS_LOCK_WAIT_MS: '2000' };
  const a = spawn(process.execPath, [lockerScript, 'a'], { env });
  const b = spawn(process.execPath, [lockerScript, 'b'], { env });
  const [aCode, bCode] = await Promise.all([waitForExit(a), waitForExit(b)]);
  assert.equal(aCode, 0);
  assert.equal(bCode, 0);
  const aEntered = Number(
    await fs.readFile(path.join(dir, 'a-entered'), 'utf8'),
  );
  const aLeft = Number(await fs.readFile(path.join(dir, 'a-left'), 'utf8'));
  const bEntered = Number(
    await fs.readFile(path.join(dir, 'b-entered'), 'utf8'),
  );
  const bLeft = Number(await fs.readFile(path.join(dir, 'b-left'), 'utf8'));
  assert.ok(aLeft <= bEntered || bLeft <= aEntered);
});

function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
}

async function waitForChildFile(dir: string, name: string): Promise<void> {
  const deadline = Date.now() + 2000;
  const filePath = path.join(dir, name);
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

test('two waiters observing a legacy lock file never unlink it or both win', async () => {
  const filePath = await tempStatePath();
  const lockPath = `${filePath}.lock`;
  const dir = path.dirname(filePath);
  const stale = 'not-a-lock';
  await fs.writeFile(lockPath, stale);
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(lockPath, old, old);

  const lockModule = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../src/state/lock.ts',
  );
  const waiterScript = path.join(dir, 'stale-waiter.ts');
  await fs.writeFile(
    waiterScript,
    `import { withStateFileLock } from ${JSON.stringify(lockModule)};
const filePath = ${JSON.stringify(filePath)};
try {
  await withStateFileLock(filePath, async () => {});
  process.exit(0);
} catch (error) {
  process.stderr.write(String(error));
  process.exit(2);
}
`,
  );
  const env = { ...process.env, HERDR_AGENTS_LOCK_WAIT_MS: '80' };
  const first = spawn(process.execPath, [waiterScript], { env });
  const second = spawn(process.execPath, [waiterScript], { env });
  const [firstCode, secondCode] = await Promise.all([
    waitForExit(first),
    waitForExit(second),
  ]);
  assert.equal(firstCode, 2);
  assert.equal(secondCode, 2);
  assert.equal(await fs.readFile(lockPath, 'utf8'), stale);
});
