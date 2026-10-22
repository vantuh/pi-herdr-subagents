import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, test } from 'vitest';

import { withStateFileLock } from '../src/state/lock.ts';
import { createTempStateFixture } from '../test-support/state-fixture.ts';

const { tempDir, cleanup } = createTempStateFixture();
afterAll(cleanup);

const run = promisify(execFile);

test('profile-local state writes do not wait for another profile lock', async () => {
  const dir = await tempDir();
  const personal = path.join(dir, 'personal');
  const work = path.join(dir, 'work');
  await fs.mkdir(personal);
  await fs.mkdir(work);
  const filename = 'pi-herdr-subagents-state.json';
  const personalState = path.join(personal, filename);
  const workState = path.join(work, filename);
  const override = path.join(dir, 'override.json');
  const storeModule = fileURLToPath(
    new URL('../src/state/store.ts', import.meta.url),
  );
  const script = path.join(dir, 'profile-state.ts');
  await fs.writeFile(
    script,
    `import assert from 'node:assert/strict';
import { getHerdrAgentsStatePath, mutateHerdrAgentsState } from ${JSON.stringify(storeModule)};
assert.equal(getHerdrAgentsStatePath(), ${JSON.stringify(personalState)});
process.env.PI_CODING_AGENT_DIR = ${JSON.stringify(work)};
assert.equal(getHerdrAgentsStatePath(), ${JSON.stringify(workState)});
process.env.PI_AGENTS_STATE_PATH = ${JSON.stringify(override)};
assert.equal(getHerdrAgentsStatePath(), ${JSON.stringify(override)});
delete process.env.PI_AGENTS_STATE_PATH;
await mutateHerdrAgentsState(getHerdrAgentsStatePath(), {}, () => ({ save: true, value: undefined }));
`,
  );
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: personal,
    PI_AGENTS_LOCK_WAIT_MS: '0',
  };
  delete env.PI_AGENTS_STATE_PATH;

  await withStateFileLock(personalState, async () => {
    await run(process.execPath, [script], { env, timeout: 10_000 });
    assert.equal((await fs.readdir(`${personalState}.lock`)).length, 1);
    assert.deepEqual(JSON.parse(await fs.readFile(workState, 'utf8')), {
      version: 2,
      agents: {},
      closedHistory: [],
    });
    assert.equal(
      await fs.stat(personalState).catch(() => undefined),
      undefined,
    );
  });
  assert.equal(
    await fs.stat(`${workState}.lock`).catch(() => undefined),
    undefined,
  );
  assert.equal(
    await fs.stat(`${personalState}.lock`).catch(() => undefined),
    undefined,
  );
});
