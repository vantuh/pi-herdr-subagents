import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { test } from 'vitest';

import { withHarness } from '../test-support/integration-harness.ts';

/**
 * The load-time storage migration seen from the extension: a legacy state file
 * stays usable, delivered reports land in the new directory and the reports it
 * moved are still dated.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function reportName(savedAt: Date, slug = 'scout'): string {
  return `${savedAt.toISOString().replace(/[-:.]/g, '')}-${slug}-1a2b3c4d.md`;
}

function reportPathIn(content: string): string | undefined {
  return /Full report saved to (\S+)/.exec(content)?.[1];
}

async function exists(target: string): Promise<boolean> {
  return await fs
    .lstat(target)
    .then(() => true)
    .catch(() => false);
}

test('migrates a legacy closed-history record that stays resumable', async () => {
  await withHarness(
    {
      beforeActivation: async ({ root, cwd, statePath }) => {
        const sessionFile = path.join(root, 'child-session.jsonl');
        await fs.writeFile(
          sessionFile,
          `${JSON.stringify({ type: 'session', id: 'child-legacy', cwd })}\n`,
          'utf8',
        );
        await fs.writeFile(
          path.join(path.dirname(statePath), 'herdr-agents-state.json'),
          JSON.stringify({
            version: 2,
            agents: {},
            closedHistory: [
              {
                id: 'ch_legacy',
                ownerSessionId: 'test-orch-session',
                profileName: 'scout',
                tabLabel: 'Legacy Scout',
                childSessionFile: sessionFile,
                childSessionId: 'child-legacy',
                cwd,
                layout: 'pane',
                lifecycle: 'oneshot',
                status: 'resumable',
                createdAt: new Date(Date.now() - DAY_MS).toISOString(),
                closedAt: new Date(Date.now() - DAY_MS).toISOString(),
                claimGeneration: 0,
              },
            ],
          }),
          'utf8',
        );
      },
    },
    async (harness) => {
      const legacyPath = path.join(
        path.dirname(harness.statePath),
        'herdr-agents-state.json',
      );
      // The rename is part of the load, not of the first tool call.
      await harness.waitFor(
        async () => !(await exists(legacyPath)),
        'the legacy state file to move',
      );

      // The record survived the move and is still offered for a follow-up.
      const state = await harness.readState();
      assert.equal(state.closedHistory?.[0]?.tabLabel, 'Legacy Scout');

      const resumed = await harness.callTool('agent_send', {
        name: 'Legacy Scout',
        message: 'continue',
      });
      assert.equal(resumed.isError, undefined);
      assert.equal(resumed.details.resumed, true);
      assert.equal(harness.fake.callsMatching('agent', 'start').length, 1);
      // Deliver the follow-up so nothing keeps writing under the fixture root.
      await harness.collect('Legacy Scout');
    },
  );
});

test('writes a delivered report into the package-named directory', async () => {
  await withHarness({}, async (harness) => {
    const agentDir = process.env.PI_CODING_AGENT_DIR!;
    const longResult = ['FIRST LINE', 'evidence '.repeat(4000).trim()].join(
      '\n',
    );
    harness.fake.setBehavior(() => ({ result: longResult }));

    await harness.call({ agent: 'scout', task: 'long', name: 'Report Scout' });
    const delivered = await harness.collect('Report Scout');

    const reportPath = reportPathIn(delivered.content);
    assert.ok(reportPath, 'expected a report path line');
    assert.equal(
      path.dirname(reportPath),
      path.join(agentDir, 'pi-herdr-subagents-results'),
    );
    assert.equal(await fs.readFile(reportPath, 'utf8'), longResult);
    assert.equal(
      await exists(path.join(agentDir, 'herdr-agents-results')),
      false,
      'nothing is written under the legacy name',
    );
  });
});

test('prunes the reports it moved from the legacy directory', async () => {
  const stale = reportName(new Date(Date.now() - 40 * DAY_MS));
  const fresh = reportName(new Date(), 'worker');

  await withHarness(
    {
      beforeActivation: async ({ agentDir }) => {
        const legacyDir = path.join(agentDir, 'herdr-agents-results');
        await fs.mkdir(legacyDir, { mode: 0o700 });
        await fs.writeFile(path.join(legacyDir, stale), 'old', 'utf8');
        await fs.writeFile(path.join(legacyDir, fresh), 'new', 'utf8');
      },
    },
    async (harness) => {
      const reportsDir = path.join(agentDirOf(), 'pi-herdr-subagents-results');
      await harness.waitFor(async () => {
        const entries = await fs.readdir(reportsDir).catch(() => undefined);
        return entries !== undefined && !entries.includes(stale);
      }, 'the moved stale report to be pruned');
      assert.deepEqual(await fs.readdir(reportsDir), [fresh]);
    },
  );
});

function agentDirOf(): string {
  return process.env.PI_CODING_AGENT_DIR!;
}
