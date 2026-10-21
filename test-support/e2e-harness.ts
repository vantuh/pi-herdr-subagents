import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { HerdrSessionSnapshot } from '../src/herdr/schema.ts';
import herdrAgentsExtension from '../src/index.ts';
import type { HerdrAgentsState } from '../src/state/schema.ts';
import {
  type AgentProfileFixture,
  applyEnv,
  createMockHost,
  type EmittedEvent,
  type SentMessage,
  waitFor,
  writeAgentProfiles,
} from './mock-extension.ts';
import { MockLlm } from './mock-llm.ts';

/**
 * End-to-end harness: a real Herdr server, real panes and real Pi children.
 *
 * Only two things are simulated — the model (MockLlm) and the Orchestrator's
 * own Pi process (the extension is driven directly through a mock
 * ExtensionAPI). Everything else is production code: the real `herdr` binary,
 * real pane splits, real `herdr agent start` launching real `pi` processes that
 * load this extension in child mode and write real result/question artifacts.
 *
 * Isolation: the server runs with its own HOME and HERDR_SOCKET_PATH, so it
 * neither sees nor touches the live session. Children inherit the server's env,
 * which is where their hermetic PI_CODING_AGENT_DIR and TMPDIR come from.
 */

const EXTENSION_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

/** Runtime the suites compile against (`package.json`, `AGENTS.md`). */
const PINNED_PI_VERSION = '1.3.0';

export interface E2eVersions {
  /** Actual `pi --version` of the binary the children run. */
  pi: string;
  /** Lockfile version of the SDK the suites compile against. */
  sdk: string;
}

let versions: E2eVersions | undefined;

/** Versions are process-wide facts; capture and report them once per run. */
async function e2eVersions(): Promise<E2eVersions> {
  if (versions) return versions;
  const lock = JSON.parse(
    await fs.readFile(path.join(EXTENSION_DIR, 'package-lock.json'), 'utf8'),
  );
  versions = {
    pi: (await run(['--version'], process.env, 'pi')).stdout.trim(),
    sdk:
      lock?.packages?.['node_modules/@earendil-works/pi-coding-agent']
        ?.version ?? 'unknown',
  };
  // The default reporter hides `console` output of passing tests, and the run
  // itself is where these versions have to be visible.
  process.stdout.write(`[e2e] pi ${versions.pi}, sdk ${versions.sdk}\n`);
  return versions;
}

export interface E2eOptions {
  /** Agent profiles written to the fixture project. Defaults to `scout`. */
  profiles?: AgentProfileFixture[];
  /**
   * Layout written to the fixture's herdr-agents.json. Existing scenarios
   * default to "pane"; "workspace" exercises the extension's real default.
   */
  layout?: 'pane' | 'workspace';
  coldShell?: boolean;
  /** Seconds to wait for the Herdr server socket. */
  serverTimeoutMs?: number;
}

export interface E2eHarness {
  llm: MockLlm;
  cwd: string;
  root: string;
  orchestratorPaneId: string;
  messages: SentMessage[];
  events: EmittedEvent[];
  call(
    params: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<any>;
  /** Alias of `call`. */
  callRaw(
    params: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<any>;
  /** Call any registered tool, e.g. `agent_send`, exactly as Pi would. */
  callTool(
    name: string,
    params: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<any>;
  /** Captured `pi --version` and lockfile SDK version. */
  versions: E2eVersions;
  /** Wait for the next poller-delivered result or question. */
  collect(label?: string, timeoutMs?: number): Promise<SentMessage>;
  fire(event: string, payload?: Record<string, unknown>): Promise<unknown>;
  reload(): Promise<void>;
  /** Live snapshot from the real Herdr server. */
  snapshot(): Promise<HerdrSessionSnapshot>;
  herdr(args: string[]): Promise<string>;
  readState(): Promise<HerdrAgentsState>;
  waitFor(
    predicate: () => boolean | Promise<boolean>,
    label: string,
    timeoutMs?: number,
  ): Promise<void>;
  dispose(): Promise<void>;
}

function isAgentOutcome(message: SentMessage, label?: string): boolean {
  if (
    message.customType !== 'herdr_agent_result' &&
    message.customType !== 'herdr_agent_question'
  ) {
    return false;
  }
  if (!label) return true;
  return message.details.name === label;
}

function run(
  args: string[],
  env: NodeJS.ProcessEnv,
  bin = 'herdr',
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { env, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new Error(`herdr ${args.join(' ')}: ${stderr || error.message}`),
          );
        else resolve({ stdout, stderr });
      },
    );
  });
}

export async function createE2eHarness(
  options: E2eOptions = {},
): Promise<E2eHarness> {
  // Before the first resource exists: a thrown harness factory cannot be
  // disposed by the caller, so this gate may not run after a server or temp root
  // is allocated. The children run the installed `pi`, so a mismatch with the
  // pinned SDK invalidates the run.
  const captured = await e2eVersions();
  if (captured.pi !== PINNED_PI_VERSION || captured.sdk !== PINNED_PI_VERSION) {
    throw new Error(
      `E2E requires Pi ${PINNED_PI_VERSION}: pi --version says ${captured.pi}, the lockfile pins SDK ${captured.sdk}.`,
    );
  }

  // Handoff appends a socket suffix; macOS TMPDIR can exceed SUN_LEN with it.
  const root = await fs.mkdtemp(
    path.join(
      process.platform === 'darwin' ? '/tmp' : os.tmpdir(),
      'herdr-agents-e2e-',
    ),
  );
  const home = path.join(root, 'home');
  const tmp = path.join(root, 'tmp');
  const agentDir = path.join(home, '.pi', 'agent');
  const cwd = path.join(root, 'repo');
  const statePath = path.join(root, 'state.json');
  const socketPath = path.join(root, 'herdr.sock');
  const serverLog = path.join(root, 'herdr-server.log');

  await fs.mkdir(home, { recursive: true });
  if (options.coldShell)
    await fs.writeFile(path.join(home, '.zshenv'), 'sleep 0.5\n');
  await fs.mkdir(tmp, { recursive: true });
  await fs.mkdir(path.join(agentDir, 'agents'), { recursive: true });
  await fs.mkdir(path.join(agentDir, 'extensions'), { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  await writeAgentProfiles(
    path.join(cwd, '.pi', 'agents'),
    options.profiles ?? [{ name: 'scout' }],
  );
  // Layout config lives in the agent dir (herdr-agents.json), not in env.
  await fs.writeFile(
    path.join(agentDir, 'herdr-agents.json'),
    `${JSON.stringify({ layout: options.layout ?? 'pane' })}\n`,
    'utf8',
  );

  // The children load the extension under test from their own config dir.
  await fs.symlink(
    EXTENSION_DIR,
    path.join(agentDir, 'extensions', 'herdr-agents'),
  );

  const llm = new MockLlm();
  const baseUrl = await llm.start();

  await fs.writeFile(
    path.join(agentDir, 'models.json'),
    `${JSON.stringify(
      {
        providers: {
          mock: {
            baseUrl,
            api: 'openai-completions',
            apiKey: 'mock',
            compat: {
              supportsDeveloperRole: false,
              supportsReasoningEffort: false,
            },
            models: [
              { id: 'mock-model', name: 'Mock' },
              { id: 'recovery-model', name: 'Mock recovery' },
            ].map((model) => ({
              ...model,
              reasoning: false,
              input: ['text'],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32000,
              maxTokens: 4096,
            })),
          },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await fs.writeFile(
    path.join(agentDir, 'settings.json'),
    `${JSON.stringify(
      {
        defaultProvider: 'mock',
        defaultModel: 'mock-model',
        defaultProjectTrust: 'always',
        quietStartup: true,
        enableInstallTelemetry: false,
        // Error assertions must observe final settlement, not retry backoff.
        retry: { enabled: false },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  // Children inherit this env from the server, so their config dir, temp dir
  // and model provider are the hermetic ones.
  const serverEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    TERM: 'xterm-256color',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    HOME: home,
    ...(options.coldShell ? { SHELL: '/bin/zsh', ZDOTDIR: home } : {}),
    TMPDIR: tmp,
    PI_CODING_AGENT_DIR: agentDir,
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    HERDR_SOCKET_PATH: socketPath,
  };

  const log = await fs.open(serverLog, 'a');
  const server: ChildProcess = spawn('herdr', ['server'], {
    env: serverEnv,
    stdio: ['ignore', log.fd, log.fd],
  });
  await log.close();

  const clientEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HERDR_SOCKET_PATH: socketPath,
  };
  const herdr = async (args: string[]) => (await run(args, clientEnv)).stdout;

  await waitFor(
    async () => {
      if (server.exitCode !== null) {
        throw new Error(
          `Herdr server exited with ${server.exitCode}: ${await fs.readFile(serverLog, 'utf8')}`,
        );
      }
      try {
        await herdr(['api', 'snapshot']);
        return true;
      } catch {
        return false;
      }
    },
    'hermetic Herdr server to accept connections',
    options.serverTimeoutMs ?? 20000,
  );

  await run(['integration', 'install', 'pi'], serverEnv);
  const integration = await fs.readFile(
    path.join(agentDir, 'extensions', 'herdr-agent-state.ts'),
    'utf8',
  );
  if (!integration.includes('HERDR_INTEGRATION_VERSION=9')) {
    throw new Error('E2E requires Herdr Pi integration v9.');
  }

  const created = JSON.parse(
    await herdr([
      'workspace',
      'create',
      '--cwd',
      cwd,
      '--label',
      'e2e',
      '--no-focus',
    ]),
  );
  const orchestratorPaneId = created?.result?.root_pane?.pane_id as string;
  if (!orchestratorPaneId) {
    throw new Error(
      `Could not create the Orchestrator pane: ${JSON.stringify(created)}`,
    );
  }

  const restoreEnv = applyEnv({
    TMPDIR: tmp,
    HERDR_SOCKET_PATH: socketPath,
    HERDR_PANE_ID: orchestratorPaneId,
    HERDR_AGENTS_STATE_PATH: statePath,
    PI_CODING_AGENT_DIR: agentDir,
    // Use the real binary; layout comes from the fixture's herdr-agents.json.
    HERDR_BIN_PATH: undefined,
    HERDR_FAKE_CLI_SOCKET: undefined,
    HERDR_AGENTS_LAYOUT: undefined,
    HERDR_AGENTS_WORKSPACE_LABEL: undefined,
    HERDR_AGENT_CHILD: undefined,
  });

  const host = createMockHost({ cwd });
  await Promise.resolve(herdrAgentsExtension(host.pi));
  for (const name of [
    'agent_spawn',
    'agent_send',
    'agent_stop',
    'agent_status',
  ]) {
    if (!host.tools.get(name))
      throw new Error(`${name} tool was not registered`);
  }

  // Resolved per call: `/reload` re-registers the tools on the same host.
  const executeTool = (
    name: string,
    params: Record<string, unknown>,
    callOptions?: { signal?: AbortSignal },
  ) => {
    const registered = host.tools.get(name);
    if (!registered) throw new Error(`${name} tool was not registered`);
    return registered.execute(
      `call-${Math.random().toString(36).slice(2)}`,
      params,
      callOptions?.signal,
      undefined,
      host.ctx,
    );
  };

  return {
    llm,
    cwd,
    root,
    orchestratorPaneId,
    versions: captured,
    messages: host.messages,
    events: host.events,
    call: (params, callOptions) =>
      executeTool('agent_spawn', params, callOptions),
    callRaw: (params, callOptions) =>
      executeTool('agent_spawn', params, callOptions),
    callTool: executeTool,
    collect: (label, timeoutMs) => {
      const start = host.messages.length;
      return waitFor(
        () =>
          host.messages
            .slice(start)
            .some((message) => isAgentOutcome(message, label)),
        label ? `outcome for ${label}` : 'herdr agent outcome',
        timeoutMs ?? 20_000,
      ).then(() => {
        const message = host.messages
          .slice(start)
          .find((item) => isAgentOutcome(item, label));
        if (!message) throw new Error('missing herdr agent outcome');
        return message;
      });
    },
    fire: host.fire,
    reload: async () => {
      await host.fire('session_shutdown');
      herdrAgentsExtension(host.pi);
      await host.fire('session_start');
    },
    snapshot: async () =>
      JSON.parse(await herdr(['api', 'snapshot']))?.result?.snapshot,
    herdr,
    readState: async () => {
      try {
        return JSON.parse(await fs.readFile(statePath, 'utf8'));
      } catch {
        return { version: 1, agents: {} };
      }
    },
    waitFor,
    dispose: async () => {
      await host.fire('session_shutdown');
      restoreEnv();
      try {
        await run(['server', 'stop'], clientEnv);
      } catch {
        // Already gone, or never came up.
      }
      if (server.exitCode === null) {
        await Promise.race([
          new Promise((resolve) => server.once('exit', resolve)),
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
        if (server.exitCode === null) server.kill('SIGKILL');
      }
      await llm.stop();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
