import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ExtensionMode } from '@earendil-works/pi-coding-agent';

import herdrAgentsExtension from '../src/index.ts';
import type { HerdrAgentsState } from '../src/state/schema.ts';
import { FakeHerdr } from './fake-herdr.ts';
import {
  type AgentProfileFixture,
  applyEnv,
  createMockHost,
  type EmittedEvent,
  type HeldDialog,
  type SentMessage,
  waitFor,
  writeAgentProfiles,
} from './mock-extension.ts';

/**
 * Boots the real extension with a mock ExtensionAPI against a FakeHerdr, so a
 * test can call the agent tools exactly as Pi would and then assert on the Herdr
 * commands, the pane layout, the state file and the messages the extension
 * pushed back into the session.
 *
 * Everything is redirected into a per-test temp dir — including TMPDIR, which
 * is where result/question artifacts live — so tests never touch the real
 * session, the real state file or a real Herdr server.
 */

function isAgentOutcome(message: SentMessage, label?: string): boolean {
  if (
    message.customType !== 'agent_result' &&
    message.customType !== 'agent_question'
  ) {
    return false;
  }
  if (!label) return true;
  return message.details.name === label;
}

const SHIM_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'herdr-shim.mjs',
);

export interface HarnessOptions {
  /** Agent profiles written to the fixture project. Defaults to `scout`. */
  profiles?: AgentProfileFixture[];
  /**
   * Layout written to the fixture's herdr-agents.json. Existing tests default
   * to "pane"; "workspace" exercises the extension's real default explicitly.
   */
  layout?: 'pane' | 'tab' | 'workspace';
  /**
   * Full herdr-agents.json content, written before activation. Overrides
   * `layout` when present.
   */
  config?: Record<string, unknown>;
  hasUI?: boolean;
  mode?: ExtensionMode;
  isIdle?: boolean;
  /** Keystrokes per `ctx.ui.custom` overlay, for the `/agents` manager. */
  dialogInputs?: string[][];
  /**
   * Takes over each `ctx.ui.custom` overlay, so a test can drive a modal that
   * must stay open while it inspects the extension's behavior.
   */
  onDialog?: (dialog: HeldDialog) => void;
  /** Orchestrator pane id reported in HERDR_PANE_ID; defaults to the real one. */
  paneIdEnv?: string;
  sessionId?: string;
  sessionFile?: string;
}

export interface Harness {
  fake: FakeHerdr;
  cwd: string;
  statePath: string;
  messages: SentMessage[];
  userMessages: string[];
  events: EmittedEvent[];
  notifications: Array<{ message: string; level?: string }>;
  widgets: Map<string, unknown>;
  commands: Map<string, { handler: (args: string, ctx: unknown) => unknown }>;
  renderers: Map<string, unknown>;
  /** Rendered lines of each `ctx.ui.custom` overlay, before its keys ran. */
  dialogLines: string[][];
  /** Call the registered `agent_spawn` tool. Returns once the prompt is submitted. */
  call(
    params: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<any>;
  /** Alias of `call`. */
  callRaw(
    params: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<any>;
  /** Call any other registered tool, e.g. `agent_send`. */
  callTool(
    name: string,
    params: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<any>;

  /** Wait for the next poller-delivered result or question. */
  collect(label?: string, timeoutMs?: number): Promise<SentMessage>;
  /** Fire an extension lifecycle event (e.g. `session_start`). */
  fire(event: string, payload?: Record<string, unknown>): Promise<unknown>;
  /** The currently registered tool — re-registration replaces it by name. */
  getTool(name: string): unknown;
  /** Run a registered slash command with the mock command context. */
  runCommand(name: string, args?: string): Promise<void>;
  readState(): Promise<HerdrAgentsState>;
  waitFor(
    predicate: () => boolean | Promise<boolean>,
    label: string,
    timeoutMs?: number,
  ): Promise<void>;
  dispose(): Promise<void>;
}

export async function createHarness(
  options: HarnessOptions = {},
): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hat-'));
  const cwd = path.join(root, 'repo');
  const agentDir = path.join(root, 'pi-agent-dir');
  const statePath = path.join(root, 'state.json');
  const tmp = path.join(root, 'tmp');

  await fs.mkdir(path.join(agentDir, 'agents'), { recursive: true });
  await fs.mkdir(tmp, { recursive: true });
  await writeAgentProfiles(
    path.join(cwd, '.pi', 'agents'),
    options.profiles ?? [{ name: 'scout' }],
  );
  // Layout config lives in the agent dir (herdr-agents.json), not in env.
  await fs.writeFile(
    path.join(agentDir, 'herdr-agents.json'),
    `${JSON.stringify(options.config ?? { layout: options.layout ?? 'pane' })}\n`,
    'utf8',
  );

  const fake = new FakeHerdr();
  const { cliSocketPath, apiSocketPath } = await fake.start(root);

  const restoreEnv = applyEnv({
    // Artifacts are only accepted under os.tmpdir()/herdr-agent-*, so TMPDIR
    // has to move for the temp dir to be both managed and disposable.
    TMPDIR: tmp,
    HERDR_BIN_PATH: SHIM_PATH,
    HERDR_FAKE_CLI_SOCKET: cliSocketPath,
    HERDR_SOCKET_PATH: apiSocketPath,
    HERDR_PANE_ID: options.paneIdEnv ?? fake.orchestratorPane.pane_id,
    PI_AGENTS_STATE_PATH: statePath,
    PI_CODING_AGENT_DIR: agentDir,
    // Neutralize any stale live-session env: layout comes from the config file.
    HERDR_AGENTS_LAYOUT: undefined,
    HERDR_AGENTS_WORKSPACE_LABEL: undefined,
    PI_AGENT_CHILD: undefined,
  });

  const host = createMockHost({
    cwd,
    hasUI: options.hasUI,
    mode: options.mode,
    isIdle: options.isIdle,
    dialogInputs: options.dialogInputs,
    onDialog: options.onDialog,
    sessionId: options.sessionId,
    sessionFile: options.sessionFile,
  });
  await Promise.resolve(herdrAgentsExtension(host.pi));

  for (const name of [
    'agent_spawn',
    'agent_send',
    'agent_stop',
    'agent_status',
  ]) {
    if (!host.tools.has(name))
      throw new Error(`${name} tool was not registered`);
  }

  const callTool = (
    name: string,
    params: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ) => {
    const registered = host.tools.get(name);
    if (!registered) throw new Error(`${name} tool was not registered`);
    return registered.execute(
      `call-${Math.random().toString(36).slice(2)}`,
      params,
      options?.signal,
      undefined,
      host.ctx,
    );
  };

  return {
    fake,
    cwd,
    statePath,
    messages: host.messages,
    userMessages: host.userMessages,
    events: host.events,
    notifications: host.notifications,
    widgets: host.widgets,
    commands: host.commands,
    renderers: host.renderers,
    dialogLines: host.dialogLines,
    call: (params, callOptions) => callTool('agent_spawn', params, callOptions),
    callRaw: (params, callOptions) =>
      callTool('agent_spawn', params, callOptions),
    callTool,
    collect: (label, timeoutMs) => {
      const start = host.messages.length;
      return waitFor(
        () =>
          host.messages
            .slice(start)
            .some((message) => isAgentOutcome(message, label)),
        label ? `outcome for ${label}` : 'herdr agent outcome',
        timeoutMs,
      ).then(() => {
        const message = host.messages
          .slice(start)
          .find((item) => isAgentOutcome(item, label));
        if (!message) throw new Error('missing herdr agent outcome');
        return message;
      });
    },
    fire: host.fire,
    getTool: (name) => host.tools.get(name),
    runCommand: async (name, args = '') => {
      const command = host.commands.get(name);
      if (!command) throw new Error(`command /${name} is not registered`);
      await command.handler(args, host.ctx);
    },
    readState: async () => {
      try {
        return JSON.parse(await fs.readFile(statePath, 'utf8'));
      } catch {
        return { version: 1, agents: {} };
      }
    },
    waitFor,
    dispose: async () => {
      // Stops the widget interval this extension instance started.
      await host.fire('session_shutdown');
      await fake.stop();
      restoreEnv();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
