import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { test } from 'vitest';

import { setProfileModel } from '../src/ui/agent-models/write.ts';
import { flagValue, withHarness } from '../test-support/contract-harness.ts';

/**
 * Profile frontmatter to spawn argv: the exact flags each profile shape
 * produces.
 */

async function writeSkill(dir: string, name: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, 'SKILL.md');
  await fs.writeFile(
    filePath,
    `---\nname: ${name}\ndescription: ${name} test skill\n---\n\nBODY\n`,
  );
  return filePath;
}

test('a profile pin reaches the next child argv and clearing it omits --model without reload', async () => {
  await withHarness({}, async (harness) => {
    const filePath = path.join(harness.cwd, '.pi', 'agents', 'scout.md');
    assert.equal(
      await setProfileModel(filePath, 'provider/pinned-model'),
      null,
    );
    const pinned = await harness.call({ agent: 'scout', task: 'Use the pin' });
    assert.equal(pinned.isError, undefined);
    const first = harness.fake.callsMatching('agent', 'start')[0];
    assert.ok(first);
    assert.equal(flagValue(first, '--model'), 'provider/pinned-model');

    assert.equal(await setProfileModel(filePath, null), null);
    const cleared = await harness.call({
      agent: 'scout',
      task: 'Use Pi default',
    });
    assert.equal(cleared.isError, undefined);
    const second = harness.fake.callsMatching('agent', 'start')[1];
    assert.ok(second);
    assert.equal(second.includes('--model'), false);
  });
});

test('a profile without the optional frontmatter fields produces the minimal spawn argv', async () => {
  await withHarness({}, async (harness) => {
    await harness.call({ agent: 'scout', task: 'Find it' });

    const start = harness.fake.callsMatching('agent', 'start')[0];
    assert.ok(start);
    const separator = start.indexOf('--');
    const piArgs = start.slice(separator + 1);
    const systemFile = flagValue(piArgs, '--append-system-prompt');
    assert.ok(systemFile);
    assert.deepEqual(piArgs, [
      '--session-dir',
      path.join(process.env.PI_CODING_AGENT_DIR!, 'herdr-agent-sessions'),
      '--name',
      'Scout',
      '--append-system-prompt',
      systemFile,
    ]);
  });
});

test('a profile with every optional frontmatter field drives the exact spawn argv', async () => {
  await withHarness(
    {
      profiles: [
        {
          name: 'worker',
          tools: ['read'],
          model: 'sonnet',
          thinking: 'high',
          skills: ['probe-skill'],
          systemPromptMode: 'replace',
          body: 'WORKER BODY',
        },
      ],
    },
    async (harness) => {
      // The skill lives in the harness agent dir, where pi's default
      // discovery (loadSkills includeDefaults) finds it.
      const agentDir = process.env.PI_CODING_AGENT_DIR!;
      const skillPath = await writeSkill(
        path.join(agentDir, 'skills', 'probe-skill'),
        'probe-skill',
      );

      // Detached keeps the temp dir alive so the system file is readable.
      const result = await harness.callRaw({
        agent: 'worker',
        task: 'Slice',
      });
      assert.equal(result.isError, undefined);

      const start = harness.fake.callsMatching('agent', 'start')[0];
      assert.ok(start);
      const piArgs = start.slice(start.indexOf('--') + 1);
      const systemFile = flagValue(piArgs, '--system-prompt');
      assert.ok(systemFile);
      assert.deepEqual(piArgs, [
        '--session-dir',
        path.join(process.env.PI_CODING_AGENT_DIR!, 'herdr-agent-sessions'),
        '--name',
        'Worker',
        '--model',
        'sonnet',
        '--thinking',
        'high',
        '--no-skills',
        '--skill',
        skillPath,
        '--tools',
        'read,ask_question',
        '--exclude-tools',
        'mcp__*',
        '--system-prompt',
        systemFile,
      ]);

      // replace swaps the flag; the child protocol still rides along.
      const systemPrompt = await fs.readFile(systemFile, 'utf8');
      assert.match(systemPrompt, /WORKER BODY/);
      assert.match(systemPrompt, /## Herdr agent protocol/);
    },
  );
});

test('unknown thinking level and missing skills are ignored with a warning', async () => {
  await withHarness(
    {
      profiles: [
        {
          name: 'worker',
          thinking: 'sideways',
          skills: ['ghost-skill'],
          body: 'BODY',
        },
      ],
    },
    async (harness) => {
      const result = await harness.call({ agent: 'worker', task: 'Go' });

      const start = harness.fake.callsMatching('agent', 'start')[0];
      assert.ok(start);
      const piArgs = start.slice(start.indexOf('--') + 1);
      // The spawn itself is not blocked: no --thinking, --no-skills still set.
      assert.equal(flagValue(piArgs, '--thinking'), undefined);
      assert.ok(piArgs.includes('--no-skills'));
      assert.equal(piArgs.includes('--skill'), false);

      assert.deepEqual(result.details.spawnWarnings, [
        'Unknown thinking level "sideways" ignored.',
        'Skills not found: ghost-skill.',
      ]);
      assert.match(result.content[0].text, /Spawn warnings:/);
      assert.match(result.content[0].text, /Unknown thinking level "sideways"/);
      assert.match(result.content[0].text, /Skills not found: ghost-skill/);
    },
  );
});

test('disable-model-invocation profiles spawn by name but stay unlisted', async () => {
  await withHarness(
    {
      profiles: [
        { name: 'scout', body: 'BODY' },
        { name: 'secret', disableModelInvocation: true, body: 'SECRET' },
      ],
    },
    async (harness) => {
      const miss = await harness.call({ agent: 'nobody', task: 'x' });
      assert.equal(miss.isError, true);
      assert.match(miss.content[0].text, /Available: scout/);
      assert.doesNotMatch(miss.content[0].text, /secret/);
      assert.deepEqual(
        miss.details.availableAgents.map((a: { name: string }) => a.name),
        ['scout'],
      );

      // Still spawnable by exact name.
      const hit = await harness.call({ agent: 'secret', task: 'Go' });
      assert.equal(hit.isError, undefined);
      const start = harness.fake.callsMatching('agent', 'start')[0];
      assert.ok(start);
      assert.equal(flagValue(start, '--name'), 'Secret');
    },
  );
});

test('skills: none spawns with --no-skills and no --skill entries', async () => {
  await withHarness(
    { profiles: [{ name: 'worker', skills: [], body: 'BODY' }] },
    async (harness) => {
      await harness.call({ agent: 'worker', task: 'Go' });

      const start = harness.fake.callsMatching('agent', 'start')[0];
      assert.ok(start);
      const piArgs = start.slice(start.indexOf('--') + 1);
      assert.ok(piArgs.includes('--no-skills'));
      assert.equal(piArgs.includes('--skill'), false);
    },
  );
});

test('session_start refreshes the agent listing in the schema description', async () => {
  await withHarness(
    {
      profiles: [
        { name: 'scout', body: 'BODY' },
        { name: 'secret', disableModelInvocation: true, body: 'SECRET' },
      ],
    },
    async (harness) => {
      await harness.fire('session_start');

      const tool = harness.getTool('herdr_agent') as
        | { parameters: { properties: Record<string, any> } }
        | undefined;
      assert.ok(tool);
      const description = (
        tool.parameters.properties.agent as { description?: string }
      ).description;
      assert.match(
        description ?? '',
        /Available: scout \(scout test profile\)\./,
      );
      assert.doesNotMatch(description ?? '', /secret/);
    },
  );
});

test('session_start with no profiles still refreshes the agent listing', async () => {
  await withHarness({ profiles: [] }, async (harness) => {
    await harness.fire('session_start');

    const tool = harness.getTool('herdr_agent') as
      | { parameters: { properties: Record<string, any> } }
      | undefined;
    assert.ok(tool);
    const description = (
      tool.parameters.properties.agent as { description?: string }
    ).description;
    assert.match(description ?? '', /Agent profile name/);
    assert.doesNotMatch(description ?? '', /Available:/);
  });
});

test('session_start reload reason refreshes the agent listing', async () => {
  await withHarness(
    {
      profiles: [
        { name: 'scout', body: 'BODY' },
        { name: 'secret', disableModelInvocation: true, body: 'SECRET' },
      ],
    },
    async (harness) => {
      await harness.fire('session_start', { reason: 'reload' });

      const tool = harness.getTool('herdr_agent') as
        | { parameters: { properties: Record<string, any> } }
        | undefined;
      assert.ok(tool);
      const description = (
        tool.parameters.properties.agent as { description?: string }
      ).description;
      assert.match(
        description ?? '',
        /Available: scout \(scout test profile\)\./,
      );
      assert.doesNotMatch(description ?? '', /secret/);
    },
  );
});

test('boolean thinking in a profile does not fail the spawn', async () => {
  await withHarness({ profiles: [] }, async (harness) => {
    await fs.writeFile(
      path.join(harness.cwd, '.pi', 'agents', 'worker.md'),
      '---\nname: worker\ndescription: yaml bool thinking\nthinking: true\n---\n\nBODY\n',
    );

    const result = await harness.call({ agent: 'worker', task: 'Go' });
    assert.equal(result.isError, undefined);
    const start = harness.fake.callsMatching('agent', 'start')[0];
    assert.ok(start);
    const piArgs = start.slice(start.indexOf('--') + 1);
    assert.equal(flagValue(piArgs, '--thinking'), undefined);
  });
});
