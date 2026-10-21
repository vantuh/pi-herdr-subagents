import assert from 'node:assert/strict';

import { test } from 'vitest';

import herdrAgentsExtension from '../src/index.ts';
import {
  AGENT_QUESTION_MESSAGE_TYPE,
  AGENT_RESULT_MESSAGE_TYPE,
} from '../src/ui/renderers.ts';
import { withHarness } from '../test-support/contract-harness.ts';
import { applyEnv, createMockHost } from '../test-support/mock-extension.ts';

/**
 * Commands and renderers: /run, /herdr-agents, and the result/question
 * message blocks.
 */

test('/herdr-agent-models is registered only in parent mode', async () => {
  await withHarness({}, async (harness) => {
    assert.ok(harness.commands.has('herdr-agent-models'));
    const restore = applyEnv({ PI_AGENT_CHILD: '1' });
    try {
      const child = createMockHost({ cwd: harness.cwd });
      herdrAgentsExtension(child.pi);
      assert.equal(child.commands.has('herdr-agent-models'), false);
    } finally {
      restore();
    }
  });
});

test('/herdr-agent-models requires TUI mode before discovering profiles or accessing the model registry', async () => {
  await withHarness({}, async (harness) => {
    const command = harness.commands.get('herdr-agent-models');
    assert.ok(command);
    await command.handler('', {
      mode: 'rpc',
      ui: {
        notify: (message: string, level?: string) =>
          harness.notifications.push({ message, level }),
      },
    });
    assert.equal(
      harness.notifications.at(-1)?.message,
      '/herdr-agent-models requires TUI mode',
    );
    assert.equal(harness.fake.callsMatching('agent', 'start').length, 0);
  });
});

test('/herdr-agent-models reports an empty roster without opening the overlay', async () => {
  await withHarness({ profiles: [] }, async (harness) => {
    const command = harness.commands.get('herdr-agent-models');
    assert.ok(command);
    await command.handler('', {
      mode: 'tui',
      cwd: harness.cwd,
      scopedModels: [],
      modelRegistry: { getAvailable: () => [] },
      ui: {
        notify: (message: string, level?: string) =>
          harness.notifications.push({ message, level }),
        custom: () => assert.fail('No profiles should not open the overlay'),
      },
    });
    assert.equal(
      harness.notifications.at(-1)?.message,
      'No agent profiles found',
    );
  });
});

test('/run refuses to delegate while a turn is in flight', async () => {
  await withHarness({ isIdle: false }, async (harness) => {
    await harness.runCommand('run', 'scout find the auth flow');

    assert.deepEqual(harness.userMessages, []);
    assert.match(harness.notifications.at(-1)?.message ?? '', /Agent is busy/);
  });
});

test('/run explains itself when given no task', async () => {
  await withHarness({}, async (harness) => {
    await harness.runCommand('run', '   ');
    assert.deepEqual(harness.userMessages, []);
    assert.match(
      harness.notifications.at(-1)?.message ?? '',
      /Usage: \/run \[agent\] <task>/,
    );

    // A bare profile name with no task is also not a delegation.
    await harness.fire('session_start');
    await harness.runCommand('run', 'scout');
    assert.deepEqual(harness.userMessages, []);
  });
});

test('/run completes discovered agent names, then stops offering completions', async () => {
  await withHarness(
    {
      profiles: [
        { name: 'scout', body: 'BODY' },
        { name: 'oracle', body: 'BODY' },
        { name: 'Oracle-Lite', disableModelInvocation: true, body: 'BODY' },
      ],
    },
    async (harness) => {
      const command = harness.commands.get('run') as {
        getArgumentCompletions?: (
          prefix: string,
        ) => Array<{ value: string }> | null;
      };
      assert.ok(command.getArgumentCompletions);
      const names = (prefix: string) =>
        (command.getArgumentCompletions?.(prefix) ?? [])
          .map((item) => item.value.trim())
          .sort();

      // Nothing is offered before discovery.
      assert.equal(command.getArgumentCompletions(''), null);

      await harness.fire('session_start');
      // /run is an explicit user choice, so hidden profiles are offered too.
      assert.deepEqual(names(''), ['Oracle-Lite', 'oracle', 'scout']);
      assert.deepEqual(names('or'), ['Oracle-Lite', 'oracle']);
      // Once a task is being typed there is nothing to complete.
      assert.equal(command.getArgumentCompletions('scout find the '), null);
      assert.equal(command.getArgumentCompletions('nonsense'), null);

      await harness.runCommand('run', 'ORACLE map the auth flow');
      assert.deepEqual(harness.userMessages, [
        '[via /run \u2192 oracle] map the auth flow',
      ]);
    },
  );
});

test('/herdr-agents needs TUI mode', async () => {
  await withHarness({}, async (harness) => {
    const command = harness.commands.get('herdr-agents');
    assert.ok(command);
    await command.handler('', {
      mode: 'print',
      ui: {
        notify: (message: string, level?: string) =>
          harness.notifications.push({ message, level }),
      },
    });

    assert.match(
      harness.notifications.at(-1)?.message ?? '',
      /requires TUI mode/,
    );
  });
});

test('/herdr-agents surfaces a Herdr failure as a notification', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.failCommand('api snapshot', 'server_not_running');

    await harness.runCommand('herdr-agents');

    assert.match(
      harness.notifications.at(-1)?.message ?? '',
      /Failed to load agents/,
    );
  });
});

test('renders delivered results and questions as their own blocks', async () => {
  await withHarness({}, async (harness) => {
    for (const customType of [
      AGENT_RESULT_MESSAGE_TYPE,
      AGENT_QUESTION_MESSAGE_TYPE,
    ]) {
      const renderer = harness.renderers.get(customType) as (
        message: unknown,
        options: unknown,
        theme: unknown,
      ) => { render: (width: number) => string[] };
      assert.ok(renderer, `${customType} needs a renderer`);

      const component = renderer(
        {
          content: 'inline attribution the model reads',
          details: {
            name: 'Scout',
            agent: 'scout',
            result: 'BODY TEXT',
            question: 'BODY TEXT',
          },
        },
        { expanded: false, outputPad: 1 },
        {
          fg: (_c: string, t: string) => t,
          bg: (_c: string, t: string) => t,
          bold: (t: string) => t,
        },
      );

      const rendered = component.render(80).join('\n');
      assert.match(rendered, /Agent Scout · scout/);
      assert.match(rendered, /BODY TEXT/);
      // The header carries the attribution, so the inline copy is not repeated.
      assert.doesNotMatch(rendered, /inline attribution/);
    }
  });
});

test('renders block content by keeping its text and dropping image blocks', async () => {
  await withHarness({}, async (harness) => {
    const renderer = harness.renderers.get(AGENT_RESULT_MESSAGE_TYPE) as (
      message: unknown,
      options: unknown,
      theme: unknown,
    ) => { render: (width: number) => string[] };

    // A custom message may carry blocks instead of a string; the image has no
    // text representation, so only the text block reaches the body.
    const component = renderer(
      {
        content: [
          { type: 'text', text: 'BLOCK BODY TEXT' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        ],
        details: { tabLabel: 'Scout', agent: 'scout' },
      },
      { expanded: false, outputPad: 1 },
      {
        fg: (_c: string, t: string) => t,
        bg: (_c: string, t: string) => t,
        bold: (t: string) => t,
      },
    );

    const rendered = component.render(80).join('\n');
    assert.match(rendered, /BLOCK BODY TEXT/);
    assert.doesNotMatch(rendered, /AAAA|image\/png/);
  });
});
