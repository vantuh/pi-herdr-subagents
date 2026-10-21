import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { test } from 'vitest';

import {
  createAgentTempFiles,
  readAgentSessionMeta,
  removeAgentTempFiles,
  SESSION_META_ENV,
  sessionMetaFileFor,
  writeAgentSessionMeta,
} from '../src/artifacts.ts';
import {
  readPiSessionHeader,
  validateResumableSessionFile,
} from '../src/artifacts/sessions.ts';

/**
 * Child session metadata and native Pi session validation.
 */

test('round-trips child session metadata next to the result file', async () => {
  const files = await createAgentTempFiles('system');
  const written = await writeAgentSessionMeta(files.sessionMetaFile, {
    sessionId: 'child-1',
    sessionFile: path.join(
      path.dirname(files.resultFile),
      'child-session.jsonl',
    ),
    cwd: '/tmp/repo',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(written, files.sessionMetaFile);
  assert.equal(sessionMetaFileFor(files.resultFile), files.sessionMetaFile);

  const meta = await readAgentSessionMeta(files.resultFile);
  assert.equal(meta?.sessionId, 'child-1');
  assert.equal(meta?.cwd, '/tmp/repo');
  const stats = await fs.stat(files.sessionMetaFile);
  assert.equal(stats.mode & 0o777, 0o600);

  await removeAgentTempFiles(files.resultFile);
});

test('round-trips a published context sample, keeping unknown and zero distinct', async () => {
  const files = await createAgentTempFiles('system');
  await writeAgentSessionMeta(files.sessionMetaFile, {
    sessionId: 'child-1',
    cwd: '/tmp/repo',
    context: { tokens: 38_000, contextWindow: 200_000 },
  });
  assert.deepEqual((await readAgentSessionMeta(files.resultFile))?.context, {
    tokens: 38_000,
    contextWindow: 200_000,
  });

  // `null` tokens is a known window with an unknown count, not a missing sample.
  await writeAgentSessionMeta(files.sessionMetaFile, {
    sessionId: 'child-1',
    cwd: '/tmp/repo',
    context: { tokens: null, contextWindow: 200_000 },
  });
  assert.deepEqual((await readAgentSessionMeta(files.resultFile))?.context, {
    tokens: null,
    contextWindow: 200_000,
  });

  // A measured zero stays a zero; only `null` means unknown.
  await writeAgentSessionMeta(files.sessionMetaFile, {
    sessionId: 'child-1',
    cwd: '/tmp/repo',
    context: { tokens: 0, contextWindow: 128_000 },
  });
  assert.deepEqual((await readAgentSessionMeta(files.resultFile))?.context, {
    tokens: 0,
    contextWindow: 128_000,
  });

  await writeAgentSessionMeta(files.sessionMetaFile, {
    sessionId: 'child-1',
    cwd: '/tmp/repo',
  });
  assert.equal(
    (await readAgentSessionMeta(files.resultFile))?.context,
    undefined,
  );

  await removeAgentTempFiles(files.resultFile);
});

test('a bad context sample does not discard the session identity', async () => {
  const files = await createAgentTempFiles('system');
  for (const context of [
    { tokens: 'many', contextWindow: 200_000 },
    { tokens: 1, contextWindow: null },
    { tokens: -1, contextWindow: 200_000 },
    { tokens: 1, contextWindow: 0 },
    { tokens: null, contextWindow: -1 },
  ]) {
    await fs.writeFile(
      files.sessionMetaFile,
      `${JSON.stringify({
        sessionId: 'child-1',
        sessionFile: '/tmp/repo/child.jsonl',
        cwd: '/tmp/repo',
        context,
      })}\n`,
      'utf8',
    );
    const meta = await readAgentSessionMeta(files.resultFile);
    const label = JSON.stringify(context);
    assert.equal(meta?.sessionId, 'child-1', label);
    assert.equal(meta?.cwd, '/tmp/repo', label);
    assert.equal(meta?.sessionFile, '/tmp/repo/child.jsonl', label);
    assert.equal(meta?.context, undefined, label);
  }

  await removeAgentTempFiles(files.resultFile);
});

test('round-trips a recorded session cost, keeping unknown and zero distinct', async () => {
  const files = await createAgentTempFiles('system');
  await writeAgentSessionMeta(files.sessionMetaFile, {
    sessionId: 'child-1',
    cwd: '/tmp/repo',
    sessionCost: 0.024,
  });
  assert.equal(
    (await readAgentSessionMeta(files.resultFile))?.sessionCost,
    0.024,
  );

  // A recorded zero is a measurement, unlike a child that published none.
  await writeAgentSessionMeta(files.sessionMetaFile, {
    sessionId: 'child-1',
    cwd: '/tmp/repo',
    sessionCost: 0,
  });
  assert.equal((await readAgentSessionMeta(files.resultFile))?.sessionCost, 0);

  await writeAgentSessionMeta(files.sessionMetaFile, {
    sessionId: 'child-1',
    cwd: '/tmp/repo',
  });
  assert.equal(
    (await readAgentSessionMeta(files.resultFile))?.sessionCost,
    undefined,
  );

  await removeAgentTempFiles(files.resultFile);
});

test('a bad cost sample does not discard the session identity', async () => {
  const files = await createAgentTempFiles('system');
  for (const sessionCost of [
    'free',
    -1,
    Number.POSITIVE_INFINITY,
    Number.NaN,
    null,
    { total: 1 },
  ]) {
    await fs.writeFile(
      files.sessionMetaFile,
      `${JSON.stringify({
        sessionId: 'child-1',
        sessionFile: '/tmp/repo/child.jsonl',
        cwd: '/tmp/repo',
        context: { tokens: 5_000, contextWindow: 200_000 },
        sessionCost,
      })}\n`,
      'utf8',
    );
    const meta = await readAgentSessionMeta(files.resultFile);
    const label = JSON.stringify(sessionCost);
    assert.equal(meta?.sessionId, 'child-1', label);
    assert.equal(meta?.sessionFile, '/tmp/repo/child.jsonl', label);
    assert.equal(meta?.cwd, '/tmp/repo', label);
    assert.equal(meta?.context?.tokens, 5_000, label);
    assert.equal(meta?.sessionCost, undefined, label);
  }

  await removeAgentTempFiles(files.resultFile);
});

test('validates a Pi session JSONL header against stored metadata', async () => {
  const dir = await fs.mkdtemp(path.join(path.sep, 'tmp', 'herdr-session-'));
  const sessionFile = path.join(dir, 'session.jsonl');
  await fs.writeFile(
    sessionFile,
    `${JSON.stringify({
      type: 'session',
      version: 3,
      id: 'sid-1',
      cwd: '/tmp/repo',
    })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );

  assert.deepEqual(await readPiSessionHeader(sessionFile), {
    type: 'session',
    id: 'sid-1',
    cwd: '/tmp/repo',
  });
  assert.ok(
    await validateResumableSessionFile(sessionFile, {
      sessionId: 'sid-1',
      cwd: '/tmp/repo',
    }),
  );
  assert.equal(
    await validateResumableSessionFile(sessionFile, {
      sessionId: 'other',
      cwd: '/tmp/repo',
    }),
    undefined,
  );
  await fs.writeFile(sessionFile, 'not-json\n');
  assert.equal(await readPiSessionHeader(sessionFile), undefined);
  await fs.rm(dir, { recursive: true, force: true });
});

test('does not expose the session meta env as a result-file marker', () => {
  assert.equal(SESSION_META_ENV, 'PI_AGENT_SESSION_META');
});
