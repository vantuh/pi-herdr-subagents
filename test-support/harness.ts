import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import herdrAgentsExtension from "../index.ts";
import type { HerdrAgentsState } from "../state.ts";
import { FakeHerdr } from "./fake-herdr.ts";
import {
  type AgentProfileFixture,
  applyEnv,
  createMockHost,
  type EmittedEvent,
  type SentMessage,
  waitFor,
  writeAgentProfiles,
} from "./mock-extension.ts";

/**
 * Boots the real extension with a mock ExtensionAPI against a FakeHerdr, so a
 * test can call `herdr_agent` exactly as Pi would and then assert on the Herdr
 * commands, the pane layout, the state file and the messages the extension
 * pushed back into the session.
 *
 * Everything is redirected into a per-test temp dir — including TMPDIR, which
 * is where result/question artifacts live — so tests never touch the real
 * session, the real state file or a real Herdr server.
 */

const SHIM_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "herdr-shim.mjs",
);

export interface HarnessOptions {
  /** Agent profiles written to the fixture project. Defaults to `scout`. */
  profiles?: AgentProfileFixture[];
  /** "tab" sets HERDR_AGENTS_LAYOUT; defaults to the pane layout. */
  layout?: "pane" | "tab";
  hasUI?: boolean;
  isIdle?: boolean;
  /** Keystrokes per `ctx.ui.custom` overlay, for the `/herdr-agents` manager. */
  dialogInputs?: string[][];
  /** Orchestrator pane id reported in HERDR_PANE_ID; defaults to the real one. */
  paneIdEnv?: string;
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
  /** Call the registered `herdr_agent` tool. */
  call(
    params: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<any>;
  /** Fire an extension lifecycle event (e.g. `session_start`). */
  fire(event: string, payload?: Record<string, unknown>): Promise<unknown>;
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-agents-test-"));
  const cwd = path.join(root, "repo");
  const agentDir = path.join(root, "pi-agent-dir");
  const statePath = path.join(root, "state.json");
  const tmp = path.join(root, "tmp");

  await fs.mkdir(path.join(agentDir, "agents"), { recursive: true });
  await fs.mkdir(tmp, { recursive: true });
  await writeAgentProfiles(
    path.join(cwd, ".pi", "agents"),
    options.profiles ?? [{ name: "scout" }],
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
    HERDR_AGENTS_STATE_PATH: statePath,
    PI_CODING_AGENT_DIR: agentDir,
    HERDR_AGENTS_LAYOUT: options.layout === "tab" ? "tab" : undefined,
    HERDR_AGENT_CHILD: undefined,
  });

  const host = createMockHost({
    cwd,
    hasUI: options.hasUI,
    isIdle: options.isIdle,
    dialogInputs: options.dialogInputs,
  });
  herdrAgentsExtension(host.pi);

  const tool = host.tools.get("herdr_agent");
  if (!tool) throw new Error("herdr_agent tool was not registered");

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
    call: (params, callOptions) =>
      tool.execute(
        `call-${Math.random().toString(36).slice(2)}`,
        params,
        callOptions?.signal,
        undefined,
        host.ctx,
      ),
    fire: host.fire,
    runCommand: async (name, args = "") => {
      const command = host.commands.get(name);
      if (!command) throw new Error(`command /${name} is not registered`);
      await command.handler(args, host.ctx);
    },
    readState: async () => {
      try {
        return JSON.parse(await fs.readFile(statePath, "utf8"));
      } catch {
        return { version: 1, agents: {} };
      }
    },
    waitFor,
    dispose: async () => {
      // Stops the widget interval this extension instance started.
      await host.fire("session_shutdown");
      await fake.stop();
      restoreEnv();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
