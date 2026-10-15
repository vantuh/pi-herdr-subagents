import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { test } from 'vitest';

import { flagValue, withHarness } from '../test-support/integration-harness.ts';

/**
 * Resume validation: session-file checks, ownership across Orchestrator
 * sessions and archived profile policy.
 */

test('resumeClosed errors when the child JSONL is missing or mismatched', async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: 'scout',
      task: 'first',
      tabLabel: 'Scout Resume',
    });
    await harness.collect('Scout Resume');
    const history = (await harness.readState()).closedHistory ?? [];
    const sessionFile = history[0]?.childSessionFile;
    assert.ok(sessionFile);
    await fs.rm(sessionFile);

    const missing = await harness.call({
      agent: 'scout',
      task: 'again',
      tabLabel: 'Scout Resume',
      resumeClosed: true,
    });
    assert.equal(missing.isError, true);
    assert.match(
      missing.content[0].text,
      /missing, corrupt, or does not match/,
    );
    assert.equal(harness.fake.callsMatching('agent', 'start').length, 1);
  });
});

for (const claimed of [false, true]) {
  test(`resumeClosed preserves ${claimed ? 'claimed' : 'wrong-profile'} history with a missing session`, async () => {
    await withHarness(
      { profiles: [{ name: 'scout' }, { name: 'worker' }] },
      async (harness) => {
        await harness.call({
          agent: 'scout',
          task: 'first',
          tabLabel: 'Scout Resume',
        });
        await harness.collect('Scout Resume');
        await harness.fire('session_shutdown');
        const state = await harness.readState();
        const history = state.closedHistory[0]!;
        await fs.rm(history.childSessionFile);
        if (claimed) {
          history.status = 'claimed';
          history.claimGeneration += 1;
          history.claimedAt = new Date().toISOString();
        }
        await fs.writeFile(harness.statePath, JSON.stringify(state));

        const result = await harness.call({
          agent: 'worker',
          task: 'again',
          tabLabel: 'Scout Resume',
          resumeClosed: true,
        });
        assert.equal(result.isError, true);
        assert.equal(
          result.content[0].text,
          claimed
            ? 'Closed Herdr agent "Scout Resume" is already being resumed.'
            : 'Closed Herdr agent "Scout Resume" was a scout agent, not worker.',
        );
        assert.deepEqual(
          (await harness.readState()).closedHistory,
          state.closedHistory,
        );
        assert.equal(harness.fake.callsMatching('agent', 'start').length, 1);
      },
    );
  });
}

test("another Orchestrator session cannot resume this session's closed agent", async () => {
  await withHarness({}, async (first) => {
    await first.call({
      agent: 'scout',
      task: 'first',
      tabLabel: 'Scout Resume',
    });
    const state = await first.readState();
    await withHarness({ sessionId: 'other-orch' }, async (second) => {
      await fs.writeFile(
        second.statePath,
        `${JSON.stringify(state, null, 2)}\n`,
      );
      const result = await second.call({
        agent: 'scout',
        task: 'steal',
        tabLabel: 'Scout Resume',
        resumeClosed: true,
      });
      assert.equal(result.isError, true);
      assert.match(
        result.content[0].text,
        /owned by this Orchestrator session/,
      );
    });
  });
});

test('resumeClosed resolves project skills from the archived cwd', async () => {
  await withHarness(
    { profiles: [{ name: 'scout', skills: ['tdd'] }] },
    async (harness) => {
      const otherDir = path.join(path.dirname(harness.cwd), 'archived project');
      await fs.mkdir(path.join(otherDir, '.pi', 'skills', 'tdd'), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(otherDir, '.pi', 'skills', 'tdd', 'SKILL.md'),
        '---\nname: tdd\ndescription: red green\n---\n\nBODY\n',
      );
      await harness.call({
        agent: 'scout',
        task: 'first',
        tabLabel: 'Scout Cwd',
      });
      await harness.collect('Scout Cwd');
      const statePath = harness.statePath;
      const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
      const record = state.closedHistory[0];
      const sessionFile = record.childSessionFile as string;
      const raw = await fs.readFile(sessionFile, 'utf8');
      const [headerLine, ...rest] = raw.split('\n');
      const header = JSON.parse(headerLine);
      header.cwd = otherDir;
      await fs.writeFile(
        sessionFile,
        [JSON.stringify(header), ...rest].join('\n'),
      );
      record.cwd = otherDir;
      await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

      const resumed = await harness.call({
        agent: 'scout',
        task: 'second',
        tabLabel: 'Scout Cwd',
        resumeClosed: true,
      });
      await harness.collect('Scout Cwd');
      if (resumed.isError) {
        throw new Error(`resume failed: ${resumed.content[0].text}`);
      }
      const starts = harness.fake.callsMatching('agent', 'start');
      const resumeStart = starts.at(-1) ?? [];
      const separator = resumeStart.indexOf('--');
      const piArgs = resumeStart.slice(separator + 1);
      const skill = flagValue(piArgs, '--skill');
      assert.ok(
        skill?.includes(path.join('archived project', '.pi', 'skills', 'tdd')),
      );
      const split = harness.fake.callsMatching('pane', 'split').at(-1) ?? [];
      assert.equal(flagValue(split, '--cwd'), otherDir);
    },
  );
});
