import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import herdrAgentsExtension from "../index.ts";
import type { HerdrAgentsState } from "../state.ts";
import type { HerdrSessionSnapshot } from "../types.ts";
import {
  type AgentProfileFixture,
  applyEnv,
  createMockHost,
  type EmittedEvent,
  type SentMessage,
  waitFor,
  writeAgentProfiles,
} from "./mock-extension.ts";
import { MockLlm } from "./mock-llm.ts";

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
  "..",
);

export interface E2eOptions {
  /** Agent profiles written to the fixture project. Defaults to `scout`. */
  profiles?: AgentProfileFixture[];
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
  fire(event: string, payload?: Record<string, unknown>): Promise<unknown>;
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

function run(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "herdr",
      args,
      { env, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`herdr ${args.join(" ")}: ${stderr || error.message}`));
        else resolve({ stdout, stderr });
      },
    );
  });
}

export async function createE2eHarness(
  options: E2eOptions = {},
): Promise<E2eHarness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-agents-e2e-"));
  const home = path.join(root, "home");
  const tmp = path.join(root, "tmp");
  const agentDir = path.join(root, "pi-agent");
  const cwd = path.join(root, "repo");
  const statePath = path.join(root, "state.json");
  const socketPath = path.join(root, "herdr.sock");
  const serverLog = path.join(root, "herdr-server.log");

  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(tmp, { recursive: true });
  await fs.mkdir(path.join(agentDir, "agents"), { recursive: true });
  await fs.mkdir(path.join(agentDir, "extensions"), { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  await writeAgentProfiles(
    path.join(cwd, ".pi", "agents"),
    options.profiles ?? [{ name: "scout" }],
  );

  // The children load the extension under test from their own config dir.
  await fs.symlink(
    EXTENSION_DIR,
    path.join(agentDir, "extensions", "herdr-agents"),
  );

  const llm = new MockLlm();
  const baseUrl = await llm.start();

  await fs.writeFile(
    path.join(agentDir, "models.json"),
    `${JSON.stringify(
      {
        providers: {
          mock: {
            baseUrl,
            api: "openai-completions",
            apiKey: "mock",
            compat: {
              supportsDeveloperRole: false,
              supportsReasoningEffort: false,
            },
            models: [
              {
                id: "mock-model",
                name: "Mock",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 32000,
                maxTokens: 4096,
              },
            ],
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(agentDir, "settings.json"),
    `${JSON.stringify(
      {
        defaultProvider: "mock",
        defaultModel: "mock-model",
        defaultProjectTrust: "always",
        quietStartup: true,
        enableInstallTelemetry: false,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  // Children inherit this env from the server, so their config dir, temp dir
  // and model provider are the hermetic ones.
  const serverEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    TERM: "xterm-256color",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    HOME: home,
    TMPDIR: tmp,
    PI_CODING_AGENT_DIR: agentDir,
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    HERDR_SOCKET_PATH: socketPath,
  };

  const log = await fs.open(serverLog, "a");
  const server: ChildProcess = spawn("herdr", ["server"], {
    env: serverEnv,
    stdio: ["ignore", log.fd, log.fd],
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
          `Herdr server exited with ${server.exitCode}: ${await fs.readFile(serverLog, "utf8")}`,
        );
      }
      try {
        await herdr(["api", "snapshot"]);
        return true;
      } catch {
        return false;
      }
    },
    "hermetic Herdr server to accept connections",
    options.serverTimeoutMs ?? 20000,
  );

  const created = JSON.parse(
    await herdr([
      "workspace",
      "create",
      "--cwd",
      cwd,
      "--label",
      "e2e",
      "--no-focus",
    ]),
  );
  const orchestratorPaneId = created?.result?.root_pane?.pane_id as string;
  if (!orchestratorPaneId) {
    throw new Error(`Could not create the Orchestrator pane: ${JSON.stringify(created)}`);
  }

  const restoreEnv = applyEnv({
    TMPDIR: tmp,
    HERDR_SOCKET_PATH: socketPath,
    HERDR_PANE_ID: orchestratorPaneId,
    HERDR_AGENTS_STATE_PATH: statePath,
    PI_CODING_AGENT_DIR: agentDir,
    // Use the real binary and the real layout default.
    HERDR_BIN_PATH: undefined,
    HERDR_FAKE_CLI_SOCKET: undefined,
    HERDR_AGENTS_LAYOUT: undefined,
    HERDR_AGENT_CHILD: undefined,
  });

  const host = createMockHost({ cwd });
  await Promise.resolve(herdrAgentsExtension(host.pi));
  const tool = host.tools.get("herdr_agent");
  if (!tool) throw new Error("herdr_agent tool was not registered");

  return {
    llm,
    cwd,
    root,
    orchestratorPaneId,
    messages: host.messages,
    events: host.events,
    call: (params, callOptions) =>
      tool.execute(
        `call-${Math.random().toString(36).slice(2)}`,
        params,
        callOptions?.signal,
        undefined,
        host.ctx,
      ),
    fire: host.fire,
    snapshot: async () =>
      JSON.parse(await herdr(["api", "snapshot"]))?.result?.snapshot,
    herdr,
    readState: async () => {
      try {
        return JSON.parse(await fs.readFile(statePath, "utf8"));
      } catch {
        return { version: 1, agents: {} };
      }
    },
    waitFor,
    dispose: async () => {
      await host.fire("session_shutdown");
      restoreEnv();
      try {
        await run(["server", "stop"], clientEnv);
      } catch {
        // Already gone, or never came up.
      }
      if (server.exitCode === null) {
        await Promise.race([
          new Promise((resolve) => server.once("exit", resolve)),
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
        if (server.exitCode === null) server.kill("SIGKILL");
      }
      await llm.stop();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
