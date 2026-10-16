import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { test } from 'vitest';

import {
  herdrAgentReportsDir,
  pruneExpiredReports,
  saveAgentReport,
  setFailNextReportWrites,
} from '../src/reports.ts';
import { applyEnv } from '../test-support/mock-extension.ts';

/**
 * Durable reports: naming, permissions, directory policy, the create-once write
 * protocol, TTL pruning and the failure-injection hook.
 *
 * Every case passes an explicit `reportsDir` except the capture case, which pins
 * that a startup sweep keeps the agent dir it resolved at load. The state-path
 * guard does not cover this directory, so no case may touch the real agent dir.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Name shape an own report carries; the stamp is what prune parses back. */
function isReportName(name: string): boolean {
  return (
    /^\d{8}T\d{9}Z-[a-z0-9_-]+-[0-9a-f]{8}\.md$/.test(name) &&
    !name.includes('..')
  );
}

async function withTempRoot(
  rootName: string,
  body: (root: string) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `hat-${rootName}-`));
  try {
    await body(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('writes the full result once and returns its absolute path', async () => {
  await withTempRoot('write', async (root) => {
    const reportsDir = path.join(root, 'results');
    const text = 'Findings\n\n• one\n• two\n';
    const written = await saveAgentReport({
      text,
      tabLabel: 'Scout',
      reportsDir,
    });

    assert.equal(path.dirname(written), reportsDir);
    assert.ok(isReportName(path.basename(written)));
    assert.equal(await fs.readFile(written, 'utf8'), text);
  });
});

test('creates a 0700 directory and a 0600 report', async () => {
  await withTempRoot('modes', async (root) => {
    const reportsDir = path.join(root, 'results');
    const written = await saveAgentReport({
      text: 'mode check',
      tabLabel: 'Scout',
      reportsDir,
    });

    assert.equal((await fs.stat(reportsDir)).mode & 0o777, 0o700);
    assert.equal(
      (await fs.stat(written)).mode & 0o777,
      0o600,
      `report mode, got ${(await fs.stat(written)).mode & 0o777}`,
    );
  });
});

test('repairs a loose pre-existing directory but never follows a symlink leaf', async () => {
  await withTempRoot('policy', async (root) => {
    const loose = path.join(root, 'loose');
    await fs.mkdir(loose);
    await fs.chmod(loose, 0o755);
    const written = await saveAgentReport({
      text: 'repaired',
      tabLabel: 'Scout',
      reportsDir: loose,
    });
    assert.equal((await fs.stat(loose)).mode & 0o777, 0o700);
    assert.equal(await fs.readFile(written, 'utf8'), 'repaired');

    const target = path.join(root, 'target');
    await fs.mkdir(target);
    await fs.chmod(target, 0o755);
    const link = path.join(root, 'results');
    await fs.symlink(target, link);
    await assert.rejects(
      () =>
        saveAgentReport({
          text: 'leak',
          tabLabel: 'Scout',
          reportsDir: link,
        }),
      (error: unknown) => {
        assert.match(String(error), /symlink/);
        return true;
      },
    );
    assert.equal((await fs.stat(target)).mode & 0o777, 0o755);
    assert.deepEqual(await fs.readdir(target), []);

    const fileLeaf = path.join(root, 'a-file');
    await fs.writeFile(fileLeaf, 'not a directory');
    await assert.rejects(
      () =>
        saveAgentReport({
          text: 'leak',
          tabLabel: 'Scout',
          reportsDir: fileLeaf,
        }),
      (error: unknown) => {
        assert.match(String(error), /(EEXIST|ENOTDIR|not a directory)/);
        return true;
      },
    );
    assert.equal(await fs.readFile(fileLeaf, 'utf8'), 'not a directory');
  });
});

test('derives the name from the injected clock and suffix, never from the label', async () => {
  await withTempRoot('naming', async (root) => {
    const reportsDir = path.join(root, 'results');
    const now = new Date(Date.UTC(2026, 1, 14, 9, 31, 5, 123));
    const written = await saveAgentReport({
      text: 'named',
      tabLabel: '../../etc/passwd',
      now,
      reportsDir,
      suffix: () => '1a2b3c4d',
    });

    assert.equal(
      path.basename(written),
      '20260214T093105123Z-etc-passwd-1a2b3c4d.md',
    );
    assert.equal(path.dirname(written), reportsDir);
  });
});

test('retries a taken name with a new suffix and keeps the collision file', async () => {
  await withTempRoot('collision', async (root) => {
    const reportsDir = path.join(root, 'results');
    const now = new Date(Date.UTC(2026, 1, 14, 9, 31, 5, 123));
    const taken = path.join(
      reportsDir,
      '20260214T093105123Z-scout-aaaaaaaa.md',
    );
    await fs.mkdir(reportsDir, { mode: 0o700 });
    await fs.writeFile(taken, 'OTHER REPORT', { mode: 0o600 });

    const suffixes = ['aaaaaaaa', 'bbbbbbbb'];
    const written = await saveAgentReport({
      text: 'mine',
      tabLabel: 'Scout',
      now,
      reportsDir,
      suffix: () => suffixes.shift() ?? 'cccccccc',
    });

    assert.equal(
      path.basename(written),
      '20260214T093105123Z-scout-bbbbbbbb.md',
    );
    assert.equal(await fs.readFile(taken, 'utf8'), 'OTHER REPORT');
  });
});

test('gives up after three taken names without touching the taken file', async () => {
  await withTempRoot('exhausted', async (root) => {
    const reportsDir = path.join(root, 'results');
    const now = new Date(Date.UTC(2026, 1, 14, 9, 31, 5, 123));
    const taken = path.join(
      reportsDir,
      '20260214T093105123Z-scout-aaaaaaaa.md',
    );
    await fs.mkdir(reportsDir, { mode: 0o700 });
    await fs.writeFile(taken, 'OTHER REPORT', { mode: 0o600 });

    let attempts = 0;
    await assert.rejects(() =>
      saveAgentReport({
        text: 'mine',
        tabLabel: 'Scout',
        now,
        reportsDir,
        suffix: () => {
          attempts += 1;
          return 'aaaaaaaa';
        },
      }),
    );
    assert.equal(attempts, 3);
    assert.equal(await fs.readFile(taken, 'utf8'), 'OTHER REPORT');
    assert.deepEqual(await fs.readdir(reportsDir), [
      '20260214T093105123Z-scout-aaaaaaaa.md',
    ]);

    const dirName = path.join(
      reportsDir,
      '20260214T093105123Z-scout-bbbbbbbb.md',
    );
    await fs.mkdir(dirName);
    await assert.rejects(() =>
      saveAgentReport({
        text: 'mine',
        tabLabel: 'Scout',
        now,
        reportsDir,
        suffix: () => 'bbbbbbbb',
      }),
    );
    assert.ok(
      await fs.stat(dirName).then(
        () => true,
        () => false,
      ),
    );
  });
});

test('removes only the partial file its own write failed to finish', async () => {
  await withTempRoot('partial', async (root) => {
    const reportsDir = path.join(root, 'results');
    const now = new Date(Date.UTC(2026, 1, 14, 9, 31, 5, 123));
    const seeded = path.join(
      reportsDir,
      '20260214T093105123Z-scout-aaaaaaaa.md',
    );
    await fs.mkdir(reportsDir, { mode: 0o700 });
    await fs.writeFile(seeded, 'OTHER REPORT', { mode: 0o600 });

    setFailNextReportWrites(1);
    await assert.rejects(() =>
      saveAgentReport({
        text: 'lost',
        tabLabel: 'Scout',
        now,
        reportsDir,
        suffix: () => 'bbbbbbbb',
      }),
    );
    assert.deepEqual(await fs.readdir(reportsDir), [
      '20260214T093105123Z-scout-aaaaaaaa.md',
    ]);
    assert.equal(await fs.readFile(seeded, 'utf8'), 'OTHER REPORT');

    const retried = await saveAgentReport({
      text: 'kept',
      tabLabel: 'Scout',
      now,
      reportsDir,
      suffix: () => 'cccccccc',
    });
    assert.equal(await fs.readFile(retried, 'utf8'), 'kept');
  });
});

test('prunes by the stamp in the name at the TTL edge from both sides', async () => {
  await withTempRoot('ttl', async (root) => {
    const reportsDir = path.join(root, 'results');
    const now = new Date(Date.UTC(2026, 1, 14, 9, 31, 5, 123));
    const seeds = [
      ['expired', 31 * DAY_MS],
      ['edgeRemoved', 30 * DAY_MS],
      ['edgeKept', 30 * DAY_MS - 1],
      ['fresh', 29 * DAY_MS],
    ];
    const saved: Record<string, string> = {};
    for (let index = 0; index < seeds.length; index += 1) {
      const [name, ageMs] = seeds[index];
      saved[name] = await saveAgentReport({
        text: name,
        tabLabel: 'Scout',
        now: new Date(now.getTime() - ageMs),
        reportsDir,
        suffix: () => `0000000${index}`,
      });
    }

    const removed = await pruneExpiredReports({ reportsDir, now });
    const kept = await fs.readdir(reportsDir);
    assert.equal(
      removed,
      2,
      `expected the 31-day and exactly-30-day reports to go, kept: ${JSON.stringify(kept)}`,
    );
    assert.ok(!kept.includes(path.basename(saved.expired)));
    assert.ok(!kept.includes(path.basename(saved.edgeRemoved)));
    assert.ok(kept.includes(path.basename(saved.edgeKept)));
    assert.ok(kept.includes(path.basename(saved.fresh)));
  });
});

test('leaves foreign entries and undatable names alone', async () => {
  await withTempRoot('foreign', async (root) => {
    const reportsDir = path.join(root, 'results');
    await fs.mkdir(reportsDir, { mode: 0o700 });
    for (const name of [
      'notes.md',
      '20260214T093105123Z.md',
      '20261314T093105123Z-scout-1a2b3c4d.md',
      '20200101T006000000Z-scout-1a2b3c4d.md',
    ]) {
      await fs.writeFile(path.join(reportsDir, name), 'foreign', {
        mode: 0o600,
      });
    }
    await fs.mkdir(
      path.join(reportsDir, '20200101T000000000Z-scout-1a2b3c4d.md'),
    );

    assert.equal(
      await pruneExpiredReports({
        reportsDir,
        now: new Date(Date.UTC(2026, 1, 14)),
      }),
      0,
    );
    assert.deepEqual((await fs.readdir(reportsDir)).sort(), [
      '20200101T000000000Z-scout-1a2b3c4d.md',
      '20200101T006000000Z-scout-1a2b3c4d.md',
      '20260214T093105123Z.md',
      '20261314T093105123Z-scout-1a2b3c4d.md',
      'notes.md',
    ]);
  });
});

test('prunes a missing, symlinked or non-directory leaf without creating one', async () => {
  await withTempRoot('absent', async (root) => {
    const missing = path.join(root, 'missing');
    assert.equal(await pruneExpiredReports({ reportsDir: missing }), 0);
    assert.equal(
      await fs.stat(missing).then(
        () => true,
        () => false,
      ),
      false,
      'prune must not create the reports directory',
    );

    const target = path.join(root, 'target');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'kept.md'), 'kept', { mode: 0o600 });
    const link = path.join(root, 'results');
    await fs.symlink(target, link);
    assert.equal(await pruneExpiredReports({ reportsDir: link }), 0);
    assert.deepEqual(await fs.readdir(target), ['kept.md']);

    const fileLeaf = path.join(root, 'a-file');
    await fs.writeFile(fileLeaf, 'not a directory');
    assert.equal(await pruneExpiredReports({ reportsDir: fileLeaf }), 0);
  });
});

test('prunes with the save clock, not the wall clock', async () => {
  await withTempRoot('clock', async (root) => {
    const reportsDir = path.join(root, 'results');
    const wall = Date.now();
    const saved = await saveAgentReport({
      text: 'seed',
      tabLabel: 'Scout',
      reportsDir,
    });
    // The save is dated 40 days back, so its sweep must not use wall time.
    const now = new Date(wall - 40 * DAY_MS);
    const fresh = await saveAgentReport({
      text: 'fresh',
      tabLabel: 'Scout',
      now,
      reportsDir,
      suffix: () => '00000001',
    });
    const older = await saveAgentReport({
      text: 'older',
      tabLabel: 'Scout',
      now: new Date(now.getTime() - 31 * DAY_MS),
      reportsDir,
      suffix: () => '00000002',
    });

    const delivered = await saveAgentReport({
      text: 'delivered',
      tabLabel: 'Scout',
      now,
      reportsDir,
      suffix: () => '00000003',
    });

    const kept = await fs.readdir(reportsDir);
    assert.ok(!kept.includes(path.basename(older)));
    assert.ok(kept.includes(path.basename(fresh)));
    assert.ok(kept.includes(path.basename(saved)));
    assert.ok(kept.includes(path.basename(delivered)));
  });
});

test('keeps the reports dir of the agent dir captured at load', async () => {
  const loadRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'hat-load-capture-'),
  );
  const restoredRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'hat-load-restored-'),
  );
  // applyEnv stands in for the harness restoring PI_CODING_AGENT_DIR: a temp
  // dir both before and after, so the case never touches the real agent dir.
  let restoreRestored: () => void = () => undefined;
  try {
    const restoreLoad = applyEnv({
      PI_CODING_AGENT_DIR: path.join(loadRoot, 'agent'),
    });
    const reportsDir = herdrAgentReportsDir();
    restoreLoad();
    restoreRestored = applyEnv({
      PI_CODING_AGENT_DIR: path.join(restoredRoot, 'agent'),
    });
    assert.notEqual(herdrAgentReportsDir(), reportsDir);

    const expired = await saveAgentReport({
      text: 'expired',
      tabLabel: 'Scout',
      now: new Date(Date.now() - 31 * DAY_MS),
      reportsDir,
    });
    const other = await saveAgentReport({
      text: 'other',
      tabLabel: 'Scout',
      now: new Date(Date.now() - 31 * DAY_MS),
      reportsDir: herdrAgentReportsDir(),
    });

    assert.equal(await pruneExpiredReports({ reportsDir }), 1);
    assert.equal(
      await fs.stat(expired).then(
        () => true,
        () => false,
      ),
      false,
    );
    assert.equal(await fs.readFile(other, 'utf8'), 'other');
    assert.equal(
      path.dirname(other),
      herdrAgentReportsDir(),
      'the restored environment keeps its own reports',
    );
  } finally {
    // The original environment comes back before the fixtures are deleted, so
    // no subsequent default-directory call resolves a removed reports path.
    restoreRestored();
    await Promise.all([
      fs.rm(loadRoot, { recursive: true, force: true }),
      fs.rm(restoredRoot, { recursive: true, force: true }),
    ]);
  }
});
