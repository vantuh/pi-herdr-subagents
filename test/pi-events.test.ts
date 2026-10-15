import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { test } from 'vitest';

import herdrAgentsExtension from '../src/index.ts';
import { applyEnv, waitFor } from '../test-support/mock-extension.ts';
import { MockLlm } from '../test-support/mock-llm.ts';

test('real Pi batches custom outcomes into one run with Herdr guidance', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'herdr-pi-events-'));
  const restore = applyEnv({
    PI_CODING_AGENT_DIR: root,
    HERDR_AGENT_CHILD: undefined,
  });
  const llm = new MockLlm();
  await llm.start();
  llm.setScript(() => ({ text: 'Both outcomes received.', delayMs: 0 }));
  let session:
    | Awaited<ReturnType<typeof createAgentSession>>['session']
    | undefined;
  try {
    await fs.writeFile(
      path.join(root, 'models.json'),
      JSON.stringify({
        providers: {
          mock: {
            api: 'openai-completions',
            baseUrl: llm.baseUrl,
            apiKey: 'mock',
            models: [
              {
                id: 'fixture',
                name: 'Fixture',
                input: ['text'],
                contextWindow: 32000,
                maxTokens: 4096,
              },
            ],
          },
        },
      }),
    );
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      extensionFactories: [herdrAgentsExtension],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd: root,
      agentDir: root,
      resourceLoader: loader,
      settingsManager: SettingsManager.inMemory({
        defaultProvider: 'mock',
        defaultModel: 'fixture',
      }),
      sessionManager: SessionManager.inMemory(root),
    }));
    await session.sendCustomMessage(
      {
        customType: 'herdr_agent_result',
        content: 'SCOUT_BATCH_RESULT',
        display: true,
      },
      {},
    );
    await session.sendCustomMessage(
      {
        customType: 'herdr_agent_question',
        content: 'WORKER_BATCH_QUESTION',
        display: true,
      },
      { triggerTurn: true },
    );
    await waitFor(
      () => llm.requests.length > 0 && !session!.isStreaming,
      'custom run to settle',
    );
    assert.equal(llm.requests.length, 1);
    const messages = JSON.stringify(llm.requests[0]?.messages);
    assert.match(messages, /SCOUT_BATCH_RESULT/);
    assert.match(messages, /WORKER_BATCH_QUESTION/);
    assert.match(messages, /You are the Orchestrator/);
    assert.match(messages, /herdr_agent/);
  } finally {
    session?.dispose();
    await llm.stop();
    restore();
    await fs.rm(root, { recursive: true, force: true });
  }
});
