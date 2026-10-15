import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  parseFrontmatter,
  type Theme,
  type ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import { getKeybindings, type TUI } from '@earendil-works/pi-tui';
import { afterEach, test, vi } from 'vitest';

import type { AgentProfile } from '../src/agents/types.ts';
import { showAgentModelPicker } from '../src/ui/agent-models/command.ts';
import {
  AgentModelPicker,
  type PickerData,
  type PickerResult,
} from '../src/ui/agent-models/picker.ts';
import { setProfileModel } from '../src/ui/agent-models/write.ts';
import { applyEnv } from '../test-support/mock-extension.ts';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function profile(content: string): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'herdr-agent-models-'),
  );
  directories.push(directory);
  const filePath = path.join(directory, 'scout.md');
  await fs.writeFile(filePath, content);
  return filePath;
}

const original =
  '---\nname: scout\nmodel: old/model\nthinking: high\nnested:\n  model: nested/model\n---\n\nmodel: body/model\n';

test('set replaces only the top-level model and reads the profile fresh', async () => {
  const filePath = await profile(original);
  await fs.appendFile(filePath, 'New body text\n');
  assert.equal(await setProfileModel(filePath, 'provider/new-model'), null);
  assert.equal(
    await fs.readFile(filePath, 'utf8'),
    original.replace('model: old/model', 'model: "provider/new-model"') +
      'New body text\n',
  );
});

test('set inserts immediately after the opening delimiter, clear removes only that line', async () => {
  const content = original.replace('model: old/model\n', '');
  const filePath = await profile(content);
  assert.equal(await setProfileModel(filePath, 'provider/model'), null);
  assert.equal(
    await fs.readFile(filePath, 'utf8'),
    content.replace('---\n', '---\nmodel: "provider/model"\n'),
  );
  assert.equal(await setProfileModel(filePath, null), null);
  assert.equal(await fs.readFile(filePath, 'utf8'), content);
  const before = await fs.stat(filePath);
  assert.equal(await setProfileModel(filePath, null), null);
  assert.equal((await fs.stat(filePath)).ino, before.ino);
});

test('clear leaves thinking, nested model and body untouched', async () => {
  const filePath = await profile(original);
  assert.equal(await setProfileModel(filePath, null), null);
  assert.equal(
    await fs.readFile(filePath, 'utf8'),
    original.replace('model: old/model\n', ''),
  );
});

test('duplicate models and missing frontmatter return errors without writing', async () => {
  for (const content of [
    original.replace('thinking: high', 'model: duplicate'),
    'name: scout\n---\nBODY\n',
    '---\nname: scout\n',
  ]) {
    const filePath = await profile(content);
    for (const model of ['provider/model', null]) {
      assert.equal(typeof (await setProfileModel(filePath, model)), 'string');
      assert.equal(await fs.readFile(filePath, 'utf8'), content);
    }
  }
});

test('CRLF, missing final newline and file permissions survive a write', async () => {
  const content = original.trimEnd().replaceAll('\n', '\r\n');
  const filePath = await profile(content);
  await fs.chmod(filePath, 0o640);
  assert.equal(await setProfileModel(filePath, 'new/model'), null);
  assert.equal(
    await fs.readFile(filePath, 'utf8'),
    content.replace('old/model', '"new/model"'),
  );
  assert.equal((await fs.stat(filePath)).mode & 0o777, 0o640);
});

test('a symlink stays a symlink and its target changes', async () => {
  const filePath = await profile(original);
  const link = path.join(path.dirname(filePath), 'link.md');
  await fs.symlink('scout.md', link);
  assert.equal(await setProfileModel(link, 'new/model'), null);
  assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
  assert.equal(await fs.readlink(link), 'scout.md');
  assert.equal(
    await fs.readFile(filePath, 'utf8'),
    original.replace('old/model', '"new/model"'),
  );
});

test('model values are quoted and round-trip through Pi frontmatter parsing', async () => {
  const filePath = await profile(original);
  for (const model of [
    'provider/model:with spaces # comment',
    'provider/model:',
    'provider/"quoted"\\model',
    'provider/model\nnext-line',
    '@local/model',
    'true',
    '123',
    '-invalid/model',
  ]) {
    assert.equal(await setProfileModel(filePath, model), null);
    const content = await fs.readFile(filePath, 'utf8');
    assert.ok(content.includes(`model: ${JSON.stringify(model)}\n`));
    assert.equal(parseFrontmatter(content).frontmatter.model, model);
  }
});

test('quoted model keys and multiline values cannot corrupt the profile', async () => {
  for (const line of [
    '"model": old/model',
    "'model': old/model",
    'model: |-\n  old/model',
    'model: >-\n  old/model',
    'model:\n  old/model',
    'model: old/model\n  continued',
    'model:\n  nested: value',
  ]) {
    const content = original.replace('model: old/model', line);
    const filePath = await profile(content);
    const before = parseFrontmatter(content).frontmatter;
    for (const model of ['new/model', null]) {
      assert.equal(typeof (await setProfileModel(filePath, model)), 'string');
      assert.equal(await fs.readFile(filePath, 'utf8'), content);
      assert.deepEqual(
        parseFrontmatter(await fs.readFile(filePath, 'utf8')).frontmatter,
        before,
      );
    }
  }
});

test('a failed rename leaves the profile intact and removes the owned temporary file', async () => {
  const filePath = await profile(original);
  const rename = vi
    .spyOn(fs, 'rename')
    .mockRejectedValueOnce(new Error('Rename failed'));
  try {
    assert.equal(await setProfileModel(filePath, 'new/model'), 'Rename failed');
    assert.equal(await fs.readFile(filePath, 'utf8'), original);
    assert.deepEqual(await fs.readdir(path.dirname(filePath)), ['scout.md']);
  } finally {
    rename.mockRestore();
  }
});

test('a partial temporary-file write is cleaned up and does not block the next save', async () => {
  const filePath = await profile(original);
  const open = fs.open.bind(fs);
  const injected = vi
    .spyOn(fs, 'open')
    .mockImplementationOnce(async (...args) => {
      const file = await open(...args);
      vi.spyOn(file, 'writeFile').mockImplementationOnce(async () => {
        await file.write('partial');
        throw new Error('Write failed');
      });
      return file;
    });
  try {
    assert.equal(await setProfileModel(filePath, 'new/model'), 'Write failed');
    assert.equal(await fs.readFile(filePath, 'utf8'), original);
    assert.deepEqual(await fs.readdir(path.dirname(filePath)), ['scout.md']);
    assert.equal(await setProfileModel(filePath, 'new/model'), null);
  } finally {
    injected.mockRestore();
  }
});

test('write errors leave the target and an existing temporary file untouched', async () => {
  const filePath = await profile(original);
  const temporary = `${filePath}.herdr-agent-models.tmp`;
  await fs.writeFile(temporary, 'other writer');
  assert.equal(typeof (await setProfileModel(filePath, 'new/model')), 'string');
  assert.equal(await fs.readFile(filePath, 'utf8'), original);
  assert.equal(await fs.readFile(temporary, 'utf8'), 'other writer');
  assert.equal(
    typeof (await setProfileModel(`${filePath}.missing`, 'new/model')),
    'string',
  );
});

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;
const tui = { requestRender: () => {} } as TUI;
const agent: AgentProfile = {
  name: 'scout',
  description: 'Scout',
  source: 'user',
  filePath: '/profiles/scout.md',
  systemPrompt: 'BODY',
  model: 'old/model',
};
const pickerData: PickerData = {
  agents: [
    agent,
    {
      ...agent,
      name: 'worker',
      model: undefined,
      source: 'project',
      disableModelInvocation: true,
    },
  ],
  modelItems: [{ value: 'provider/new-model', label: 'provider/new-model' }],
};

function createPicker(
  apply?: (result: PickerResult) => Promise<PickerData | string>,
) {
  const applied: PickerResult[] = [];
  let closed = false;
  const picker = new AgentModelPicker(
    tui,
    theme,
    getKeybindings(),
    pickerData,
    async (result) => {
      applied.push(result);
      return apply
        ? await apply(result)
        : {
            ...pickerData,
            agents: pickerData.agents.map((profile) =>
              profile.name === result.agent.name
                ? { ...profile, model: result.model ?? undefined }
                : profile,
            ),
          };
    },
    () => {
      closed = true;
    },
  );
  return {
    picker,
    applied,
    closed: () => closed,
    text: () => picker.render(160).join('\n'),
  };
}

test('picker filters agents, goes back on Escape and closes only from the agent step', () => {
  const h = createPicker();
  h.picker.focused = true;
  assert.match(
    h.text(),
    /Pi default · project · disable-model-invocation: true/,
  );
  h.picker.handleInput('work');
  assert.doesNotMatch(h.text(), /scout/);
  h.picker.handleInput('\r');
  assert.match(h.text(), /model for worker/);
  assert.doesNotMatch(h.text(), /clear model/);
  assert.equal(h.picker.focused, true);
  h.picker.handleInput('\x1b');
  assert.match(h.text(), /Herdr agent model · agent/);
  assert.equal(h.closed(), false);
  h.picker.handleInput('\x1b');
  assert.equal(h.closed(), true);
  assert.deepEqual(h.applied, []);
});

test('saving returns to agents with the refreshed model, file path and clear row', async () => {
  const h = createPicker();
  h.picker.handleInput('\r');
  assert.match(h.text(), /clear model/);
  h.picker.handleInput('new-model');
  assert.doesNotMatch(h.text(), /clear model/);
  h.picker.handleInput('\r');
  assert.match(h.text(), /saving…/);
  await vi.waitFor(() =>
    assert.match(
      h.text(),
      /saved scout → provider\/new-model \(\/profiles\/scout.md\)/,
    ),
  );
  assert.match(h.text(), /Herdr agent model · agent/);
  assert.match(h.text(), /provider\/new-model · user/);
  assert.deepEqual(h.applied, [{ agent, model: 'provider/new-model' }]);
  assert.equal(h.closed(), false);
});

test('clear saves null and removes the clear row from the refreshed picker', async () => {
  const h = createPicker();
  h.picker.handleInput('\r');
  h.picker.handleInput('\x1b[B');
  h.picker.handleInput('\r');
  await vi.waitFor(() => assert.match(h.text(), /saved scout → Pi default/));
  assert.deepEqual(h.applied, [{ agent, model: null }]);
  assert.match(h.text(), /Pi default · user/);
  h.picker.handleInput('\r');
  assert.doesNotMatch(h.text(), /clear model/);
});

test('write errors stay visible without replacing the snapshot, including thrown errors', async () => {
  for (const apply of [
    async () => 'Write failed',
    async () => {
      throw new Error('Write failed');
    },
  ]) {
    const h = createPicker(apply);
    h.picker.handleInput('\r');
    h.picker.handleInput('\r');
    await vi.waitFor(() => assert.match(h.text(), /Write failed/));
    assert.match(h.text(), /old\/model · user/);
    assert.equal(h.closed(), false);
  }
});

test('input during an asynchronous save cannot close the picker or submit a second write', async () => {
  let finish!: (data: PickerData) => void;
  const h = createPicker(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  h.picker.handleInput('\r');
  h.picker.handleInput('\r');
  h.picker.handleInput('\x1b');
  h.picker.handleInput('\r');
  assert.equal(h.closed(), false);
  assert.equal(h.applied.length, 1);
  finish(pickerData);
  await vi.waitFor(() => assert.match(h.text(), /saved scout/));
});

test('command orders scoped models first, edits the winning profile and refreshes discovery without reload', async () => {
  const filePath = await profile(
    '---\nname: scout\ndescription: test\n---\nBODY\n',
  );
  const root = path.dirname(filePath);
  const projectDir = path.join(root, '.pi', 'agents');
  const userDir = path.join(root, 'user', 'agents');
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(userDir, { recursive: true });
  const userPath = path.join(userDir, 'scout.md');
  const projectPath = path.join(projectDir, 'scout.md');
  const content = await fs.readFile(filePath, 'utf8');
  await fs.writeFile(userPath, content);
  await fs.writeFile(projectPath, content);
  const restore = applyEnv({ PI_CODING_AGENT_DIR: path.dirname(userDir) });
  const scoped = { provider: 'z', id: 'scoped', name: 'Scoped model' };
  const models = [
    scoped,
    { provider: 'b', id: 'last', name: 'Last model' },
    { provider: 'a', id: 'first', name: 'First model' },
  ];
  let reloaded = false;
  try {
    await showAgentModelPicker({
      mode: 'tui',
      cwd: root,
      scopedModels: [{ model: scoped }],
      modelRegistry: {
        getAvailable: () => models,
        hasConfiguredAuth: (model) => model !== scoped,
      },
      reload: async () => {
        reloaded = true;
      },
      ui: {
        notify: (message) => assert.fail(message),
        custom: async (factory) => {
          const picker = factory(tui, theme, getKeybindings(), () => {});
          picker.handleInput('\r');
          const text = picker.render(160).join('\n');
          assert.ok(text.indexOf('z/scoped') < text.indexOf('a/first'));
          assert.ok(text.indexOf('a/first') < text.indexOf('b/last'));
          assert.match(text, /scoped · Scoped model · no auth/);
          assert.equal((text.match(/z\/scoped/g) ?? []).length, 1);
          picker.handleInput('\r');
          await vi.waitFor(() =>
            assert.match(picker.render(160).join('\n'), /z\/scoped · project/),
          );
          assert.match(
            picker.render(160).join('\n'),
            new RegExp(projectPath.replaceAll('.', '\\.')),
          );
        },
      },
    } as unknown as ExtensionCommandContext);
    assert.equal(
      parseFrontmatter(await fs.readFile(projectPath, 'utf8')).frontmatter
        .model,
      'z/scoped',
    );
    assert.equal(await fs.readFile(userPath, 'utf8'), content);
    assert.equal(reloaded, false);
  } finally {
    restore();
  }
});
