import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { test } from 'vitest';

import {
  clearAgentResult,
  isAgentResultInterrupted,
  RESULT_FILE_MARKER,
  SESSION_META_ENV,
} from '../src/artifacts.ts';
import herdrAgentsExtension from '../src/index.ts';
import { applyEnv, createMockHost } from '../test-support/mock-extension.ts';

/**
 * Child-mode contract: with `HERDR_AGENT_CHILD=1` the extension must not offer
 * delegation or inject Orchestrator guidance, but must still capture the
 * child's final answer and expose the question channel.
 */

async function withChildHost(
  body: (host: ReturnType<typeof createMockHost>, tmp: string) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'herdr-agents-child-'));
  const tmp = path.join(root, 'tmp');
  await fs.mkdir(tmp, { recursive: true });
  const restoreEnv = applyEnv({ TMPDIR: tmp, HERDR_AGENT_CHILD: '1' });
  try {
    const host = createMockHost({ cwd: root });
    herdrAgentsExtension(host.pi);
    await body(host, tmp);
  } finally {
    restoreEnv();
    await fs.rm(root, { recursive: true, force: true });
  }
}

/** A managed artifact path, as the Orchestrator would create it. */
async function managedResultFile(tmp: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmp, 'herdr-agent-'));
  return path.join(dir, 'result.md');
}

test('a child registers the question channel but never delegation', async () => {
  await withChildHost(async (host) => {
    assert.deepEqual([...host.tools.keys()], ['ask_question']);
    assert.equal(host.tools.has('herdr_agent'), false);
    // No Orchestrator commands, renderers or instruction injection either.
    assert.deepEqual([...host.commands.keys()], []);
    assert.deepEqual([...host.renderers.keys()], []);
    const result = await host.fire('before_agent_start', {
      systemPrompt: 'BASE',
      prompt: 'hi',
    });
    assert.deepEqual((result as any).systemPromptOptions.sections, {});
  });
});

test('a child appends every assistant message to the result artifact', async () => {
  await withChildHost(async (host, tmp) => {
    const resultFile = await managedResultFile(tmp);
    await host.fire('before_agent_start', {
      systemPrompt: 'BASE',
      prompt: `Do the thing.\n${RESULT_FILE_MARKER} ${resultFile}`,
    });

    await host.fire('message_end', {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'HERDR_RESULT:\n- status: done' }],
      },
    });
    assert.equal(
      await fs.readFile(resultFile, 'utf8'),
      'HERDR_RESULT:\n- status: done',
    );

    // A report followed by a separate summary message must keep both.
    await host.fire('message_end', {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'final' }],
      },
    });
    const both = 'HERDR_RESULT:\n- status: done\n\nfinal';
    assert.equal(await fs.readFile(resultFile, 'utf8'), both);

    // A user message and a blank answer must not touch the artifact.
    await host.fire('message_end', {
      message: { role: 'user', content: [{ type: 'text', text: 'ignored' }] },
    });
    await host.fire('message_end', {
      message: { role: 'assistant', content: [{ type: 'text', text: '   ' }] },
    });
    assert.equal(await fs.readFile(resultFile, 'utf8'), both);
  });
});

test('a custom-message run retains the child result channel', async () => {
  await withChildHost(async (host, tmp) => {
    const resultFile = await managedResultFile(tmp);
    await host.fire('before_agent_start', {
      messageType: 'user',
      prompt: `Task\n${RESULT_FILE_MARKER} ${resultFile}`,
    });
    await host.fire('before_agent_start', {
      messageType: 'custom',
      prompt: undefined,
      message: { customType: 'notification', content: 'Continue' },
    });
    await host.fire('message_end', {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'continued' }],
      },
    });
    assert.equal(await fs.readFile(resultFile, 'utf8'), 'continued');
  });
});

test('user continuations retain the child result and question channels', async () => {
  await withChildHost(async (host, tmp) => {
    const resultFile = await managedResultFile(tmp);
    await host.fire('before_agent_start', {
      prompt: `Task\n${RESULT_FILE_MARKER} ${resultFile}`,
    });
    await host.fire('before_agent_start', { prompt: 'continue' });
    await host.fire('message_end', {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'continued with another model' }],
      },
    });
    assert.equal(
      await fs.readFile(resultFile, 'utf8'),
      'continued with another model',
    );
    const question = await host.tools.get('ask_question').execute('call-1', {
      question: 'Which file next?',
    });
    assert.equal(question.details.delivered, true);
    assert.equal(
      await fs.readFile(
        path.join(path.dirname(resultFile), 'question.md'),
        'utf8',
      ),
      'Which file next?',
    );
  });
});

test('a new managed task replaces the child result channel', async () => {
  await withChildHost(async (host, tmp) => {
    const first = await managedResultFile(tmp);
    const second = await managedResultFile(tmp);
    for (const [resultFile, text] of [
      [first, 'first'],
      [second, 'second'],
    ]) {
      await host.fire('before_agent_start', {
        prompt: `Task\n${RESULT_FILE_MARKER} ${resultFile}`,
      });
      await host.fire('message_end', {
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      });
    }
    assert.equal(await fs.readFile(first, 'utf8'), 'first');
    assert.equal(await fs.readFile(second, 'utf8'), 'second');
  });
});

test('new, resumed and forked sessions do not inherit the child result channel', async () => {
  for (const reason of ['new', 'resume', 'fork']) {
    await withChildHost(async (host, tmp) => {
      const resultFile = await managedResultFile(tmp);
      await host.fire('before_agent_start', {
        prompt: `Task\n${RESULT_FILE_MARKER} ${resultFile}`,
      });
      await host.fire('session_start', { reason });
      await host.fire('before_agent_start', { prompt: 'unrelated task' });
      await host.fire('message_end', {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'unrelated' }],
        },
      });
      assert.equal(await fs.stat(resultFile).catch(() => null), null);
      const question = await host.tools.get('ask_question').execute('call-1', {
        question: 'Unrelated question?',
      });
      assert.equal(question.isError, true);
    });
  }
});

test('failed and aborted turns preserve partial text until a successful continuation', async () => {
  for (const outcome of ['error', 'aborted']) {
    await withChildHost(async (host, tmp) => {
      const resultFile = await managedResultFile(tmp);
      await host.fire('before_agent_start', {
        prompt: `Task\n${RESULT_FILE_MARKER} ${resultFile}`,
      });
      await host.fire('message_end', {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'partial' }],
        },
      });
      if (outcome === 'error') {
        await host.fire('agent_before_settle', { outcome });
      }
      await host.fire('agent_settled', { aborted: outcome === 'aborted' });
      assert.equal(await isAgentResultInterrupted(resultFile), true);
      assert.equal(await fs.readFile(resultFile, 'utf8'), 'partial');

      await host.fire('before_agent_start', { prompt: 'continue' });
      await host.fire('message_end', {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'final' }],
        },
      });
      await host.fire('agent_before_settle', { outcome: 'completed' });
      assert.equal(await isAgentResultInterrupted(resultFile), false);
      assert.equal(await fs.readFile(resultFile, 'utf8'), 'partial\n\nfinal');

      await host.fire('before_agent_start', { prompt: 'retry' });
      assert.equal(await isAgentResultInterrupted(resultFile), true);
      await clearAgentResult(resultFile);
      assert.equal(await isAgentResultInterrupted(resultFile), false);
      assert.equal(await fs.stat(resultFile).catch(() => null), null);
    });
  }
});

test('a child writes nothing when the prompt carries no result channel', async () => {
  await withChildHost(async (host, tmp) => {
    await host.fire('before_agent_start', {
      systemPrompt: 'BASE',
      prompt: 'Do the thing with no marker.',
    });
    await host.fire('message_end', {
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    });

    const entries = await fs.readdir(tmp);
    assert.deepEqual(entries, []);
  });
});

test('ask_question writes the question beside the result file', async () => {
  await withChildHost(async (host, tmp) => {
    const resultFile = await managedResultFile(tmp);
    await host.fire('before_agent_start', {
      systemPrompt: 'BASE',
      prompt: `Task\n${RESULT_FILE_MARKER} ${resultFile}`,
    });

    const tool = host.tools.get('ask_question');
    const result = await tool.execute('call-1', {
      question: 'Cookie or JWT?',
    });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /Question sent to the Orchestrator/);
    const questionFile = path.join(path.dirname(resultFile), 'question.md');
    assert.equal(result.details.questionFile, undefined);
    assert.equal(result.details.delivered, true);
    assert.equal(result.terminate, true);
    assert.equal(await fs.readFile(questionFile, 'utf8'), 'Cookie or JWT?');
    // Asking is not answering: the result artifact stays absent.
    assert.equal(await fs.stat(resultFile).catch(() => null), null);
  });
});

test('ask_question fails loudly instead of stranding the child', async () => {
  await withChildHost(async (host) => {
    // No before_agent_start marker at all: there is no channel back.
    const tool = host.tools.get('ask_question');
    const noChannel = await tool.execute('call-1', { question: 'Anything?' });
    assert.equal(noChannel.isError, true);
    assert.equal(noChannel.terminate, undefined);
    assert.match(noChannel.content[0].text, /No Orchestrator channel/);
    assert.match(noChannel.content[0].text, /Decide yourself/);

    const empty = await tool.execute('call-2', { question: '   ' });
    assert.equal(empty.isError, true);
    assert.equal(empty.terminate, undefined);
    assert.match(empty.content[0].text, /must not be empty/);
  });
});

test('child session_start writes session metadata to the env artifact', async () => {
  await withChildHost(async (host, tmp) => {
    const resultFile = await managedResultFile(tmp);
    const metaFile = path.join(path.dirname(resultFile), 'session.json');
    process.env[SESSION_META_ENV] = metaFile;

    await host.fire('session_start');

    const raw = JSON.parse(await fs.readFile(metaFile, 'utf8'));
    assert.equal(raw.sessionId, 'test-orch-session');
    assert.equal(raw.cwd, host.ctx.cwd);
    assert.ok(path.isAbsolute(raw.sessionFile));
    const stats = await fs.stat(metaFile);
    assert.equal(stats.mode & 0o777, 0o600);
    delete process.env[SESSION_META_ENV];
  });
});

test('child refreshes session metadata after a finalized result', async () => {
  await withChildHost(async (host, tmp) => {
    const resultFile = await managedResultFile(tmp);
    const metaFile = path.join(path.dirname(resultFile), 'session.json');
    process.env[SESSION_META_ENV] = metaFile;
    await host.fire('before_agent_start', {
      systemPrompt: 'BASE',
      prompt: `Do the thing.\n${RESULT_FILE_MARKER} ${resultFile}`,
    });
    await host.fire('message_end', {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
      },
    });
    const raw = JSON.parse(await fs.readFile(metaFile, 'utf8'));
    assert.equal(raw.sessionId, 'test-orch-session');
    delete process.env[SESSION_META_ENV];
  });
});
