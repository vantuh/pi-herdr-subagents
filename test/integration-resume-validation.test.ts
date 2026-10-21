import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { test } from 'vitest';

import { flagValue, withHarness } from '../test-support/integration-harness.ts';

/**
 * Resume validation: session-file checks, ownership across Orchestrator
 * sessions and archived profile policy.
 */

test('agent_send errors when the child JSONL is missing or mismatched', async () => {
  await withHarness({}, async (harness) => {
    await harness.call({ agent: 'scout', task: 'first', name: 'Scout Resume' });
    await harness.collect('Scout Resume');
    const history = (await harness.readState()).closedHistory ?? [];
    const sessionFile = history[0]?.childSessionFile;
    assert.ok(sessionFile);
    await fs.rm(sessionFile);

    const missing = await harness.callTool('agent_send', {
      message: 'again',
      name: 'Scout Resume',
    });
    assert.equal(missing.isError, true);
    assert.match(
      missing.content[0].text,
      /missing, corrupt, or does not match/,
    );
    assert.equal(harness.fake.callsMatching('agent', 'start').length, 1);
  });
});

test('agent_send preserves claimed history with a missing session', async () => {
  await withHarness(
    { profiles: [{ name: 'scout' }, { name: 'worker' }] },
    async (harness) => {
      await harness.call({
        agent: 'scout',
        task: 'first',
        name: 'Scout Resume',
      });
      await harness.collect('Scout Resume');
      await harness.fire('session_shutdown');
      const state = await harness.readState();
      await fs.rm(state.closedHistory[0]!.childSessionFile);
      await harness.updateState((current) => {
        const history = current.closedHistory[0]!;
        history.status = 'claimed';
        history.claimGeneration += 1;
        history.claimedAt = new Date().toISOString();
      });
      const seeded = await harness.readState();

      const result = await harness.callTool('agent_send', {
        message: 'again',
        name: 'Scout Resume',
      });
      assert.equal(result.isError, true);
      assert.equal(
        result.content[0].text,
        'Closed agent "Scout Resume" is already being resumed.',
      );
      assert.deepEqual(
        (await harness.readState()).closedHistory,
        seeded.closedHistory,
      );
      assert.equal(harness.fake.callsMatching('agent', 'start').length, 1);
    },
  );
});

test("another Orchestrator session cannot resume this session's closed agent", async () => {
  await withHarness({}, async (first) => {
    await first.call({ agent: 'scout', task: 'first', name: 'Scout Resume' });
    const state = await first.readState();
    await withHarness({ sessionId: 'other-orch' }, async (second) => {
      await second.updateState((current) => {
        current.agents = state.agents;
        current.closedHistory = state.closedHistory;
      });
      const result = await second.callTool('agent_send', {
        message: 'steal',
        name: 'Scout Resume',
      });
      assert.equal(result.isError, true);
      assert.equal(
        result.content[0].text,
        'No agent named "Scout Resume" found for this session. Use agent_spawn to start one.',
      );
      assert.equal(second.fake.callsMatching('agent', 'start').length, 0);
    });
  });
});

test('agent_send resolves project skills from the archived cwd', async () => {
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
      await harness.call({ agent: 'scout', task: 'first', name: 'Scout Cwd' });
      await harness.collect('Scout Cwd');
      const state = await harness.readState();
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
      await harness.updateState((current) => {
        current.closedHistory[0]!.cwd = otherDir;
      });

      const resumed = await harness.callTool('agent_send', {
        message: 'second',
        name: 'Scout Cwd',
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
