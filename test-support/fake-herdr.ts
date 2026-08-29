import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import * as path from "node:path";
import { SESSION_META_ENV } from "../utils.ts";

/**
 * In-process Herdr simulator for integration tests.
 *
 * Everything the extension knows about Herdr goes through two channels:
 * the `herdr` CLI (HERDR_BIN_PATH) and the API socket (HERDR_SOCKET_PATH).
 * This class implements both, keeps a real pane/tab/layout tree so split,
 * close and rebalance are observable, and simulates child agents by running a
 * scripted behaviour that writes the same result/question artifacts a real Pi
 * child would write.
 */

export type LayoutNode =
  | { type: "pane"; pane_id: string }
  | {
      type: "split";
      direction: "right" | "down";
      ratio: number;
      first: LayoutNode;
      second: LayoutNode;
    };

export interface FakePane {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  terminal_id: string;
  label?: string;
  focused?: boolean;
  agent?: string;
  agent_status?: string;
  cwd?: string;
  env: Record<string, string>;
}

export interface FakeTab {
  tab_id: string;
  label: string;
  focused?: boolean;
}

export interface FakeAgent {
  name: string;
  paneId: string;
  kind: string;
  status: string;
  stateChangeSeq: number;
  interactiveReady: boolean;
  piArgs: string[];
  transcript: string;
  turns: number;
  /** Result artifact from the most recent prompt. */
  resultFile?: string;
  childSessionId?: string;
  childSessionFile?: string;
}

/** What a simulated child does with one prompt. */
export interface ChildOutcome {
  /** Written to the result artifact. */
  result?: string;
  /** Written to question.md instead of finishing (ask_question). */
  question?: string;
  /** Scrollback returned by `herdr agent read`. */
  transcript?: string;
  /**
   * How long the child stays `working`. The default is long enough that the
   * extension observes `working` and goes through `herdr agent wait`, which is
   * the real path; a very short one would settle before the first poll.
   */
  delayMs?: number;
  /** Prompt text lands in the composer but Enter never fires. */
  stalled?: boolean;
  /** Never leaves `working`, so waits time out or get aborted. */
  neverSettle?: boolean;
  /** Settle as `done` rather than `idle`. Both mean "finished" to Herdr. */
  settleStatus?: "idle" | "done";
  /**
   * Keep reporting the *previous* turn's status and `state_change_seq` for this
   * long after the prompt is submitted, before starting the new turn.
   *
   * Reproduces the reused-agent race: a persistent child still exposes its
   * prior settled state, and a poller that accepts any `idle` would collect the
   * previous turn's output as if it answered the new prompt.
   */
  staleWindowMs?: number;
}

export interface ChildTurn {
  prompt: string;
  resultFile?: string;
  agentName: string;
  paneId: string;
  /** 1 for the first prompt this agent receives. */
  turn: number;
}

export type ChildBehavior = (
  turn: ChildTurn,
) => ChildOutcome | Promise<ChildOutcome>;

interface CliResponse {
  stdout?: string;
  stderr?: string;
  code?: number;
}

const VIEWPORT = { width: 120, height: 40 };

/**
 * Default time a simulated child stays `working`. It has to outlast the
 * extension's first post-submit `agent get` (a real subprocess spawn), so the
 * `working` → `agent wait` path is exercised instead of the fast-settle
 * shortcut.
 */
const DEFAULT_WORKING_MS = 200;

function ok(result: unknown): CliResponse {
  return { stdout: `${JSON.stringify({ result })}\n` };
}

function fail(code: string, message: string): CliResponse {
  return { stderr: `${JSON.stringify({ error: { code, message } })}\n`, code: 1 };
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function flags(argv: string[], name: string): string[] {
  const values: string[] = [];
  argv.forEach((value, index) => {
    if (value === name && argv[index + 1] !== undefined) {
      values.push(argv[index + 1] as string);
    }
  });
  return values;
}

function parseEnv(argv: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of flags(argv, "--env")) {
    const eq = entry.indexOf("=");
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

function defaultBehavior(turn: ChildTurn): ChildOutcome {
  return {
    result: `Result from ${turn.agentName} (turn ${turn.turn}).`,
    transcript: `scrollback for ${turn.agentName}`,
  };
}

export class FakeHerdr {
  readonly workspaceId = "w1";
  readonly panes: FakePane[] = [];
  readonly tabs: FakeTab[] = [];
  /** Every CLI invocation, in order, as argv arrays. */
  readonly calls: string[][] = [];
  /** Ratios applied through `layout.set_split_ratio`. */
  readonly ratioUpdates: Array<{
    tabId: string;
    path: boolean[];
    ratio: number;
  }> = [];

  private readonly layouts = new Map<string, LayoutNode>();
  private readonly agents = new Map<string, FakeAgent>();
  private readonly startFailures: string[] = [];
  /** Fail every `agent start` with this code, ignoring the queue. */
  private alwaysFailStartWith?: string;
  /** Pane Herdr reports as focused; the extension should prefer HERDR_PANE_ID. */
  focusedPaneId = "";
  private childrenHeld = false;
  private readonly heldTurns: Array<() => Promise<void>> = [];
  private readonly commandFailures = new Map<
    string,
    { code: string; times: number }
  >();
  private readonly commandMalformed = new Map<string, string>();
  private omitTabIdOnCreate = false;
  private omitSessionMeta = false;
  private agentStartDelayMs = 0;
  /** Prompts whose Enter never fired, keyed by agent name. */
  private readonly stalledPrompts = new Map<string, () => Promise<void>>();
  private behavior: ChildBehavior = defaultBehavior;
  private cliServer?: Server;
  private apiServer?: Server;
  private nextPane = 1;
  private nextTab = 1;
  private nextTerminal = 1;
  /** Prompts still being simulated; awaited on stop to avoid stray writes. */
  private readonly inFlight = new Set<Promise<void>>();

  readonly orchestratorPane: FakePane;

  constructor() {
    const tab: FakeTab = { tab_id: this.makeTabId(), label: "main", focused: true };
    this.tabs.push(tab);
    this.orchestratorPane = {
      pane_id: this.makePaneId(),
      tab_id: tab.tab_id,
      workspace_id: this.workspaceId,
      terminal_id: this.makeTerminalId(),
      focused: true,
      agent: "pi",
      agent_status: "working",
      cwd: process.cwd(),
      env: {},
    };
    this.panes.push(this.orchestratorPane);
    this.focusedPaneId = this.orchestratorPane.pane_id;
    this.layouts.set(tab.tab_id, {
      type: "pane",
      pane_id: this.orchestratorPane.pane_id,
    });
  }

  /** Keep failing `agent start` with this code until cleared. */
  failEveryStart(code: string | undefined): void {
    this.alwaysFailStartWith = code;
  }

  /** Delay `agent start` so tests can abort mid-resume spawn. */
  delayAgentStart(ms: number): void {
    this.agentStartDelayMs = ms;
  }

  /**
   * Accept prompts but do not start the simulated turns yet.
   *
   * Lets a test make several children settle at the same moment, which is the
   * only way to land two detached outcomes in one poller tick.
   */
  holdChildren(): void {
    this.childrenHeld = true;
  }

  /** Fail a `herdr <group> <command>` with a Herdr error code. */
  failCommand(
    prefix: string,
    code: string,
    options: { times?: number } = {},
  ): void {
    this.commandFailures.set(prefix, {
      code,
      times: options.times ?? Number.POSITIVE_INFINITY,
    });
  }

  /** Return unparseable (or wrongly shaped) stdout for a command. */
  malformCommand(prefix: string, payload = "this is not json"): void {
    this.commandMalformed.set(prefix, payload);
  }

  /**
   * Create tabs for real but leave `tab_id` out of the response, which is what
   * the extension's `tab list` lookup by label exists to recover from.
   */
  omitCreatedTabId(): void {
    this.omitTabIdOnCreate = true;
  }

  /** Do not write child session.json metadata, so archive/stage cannot proceed. */
  skipSessionMeta(): void {
    this.omitSessionMeta = true;
  }

  /** Run every held turn to completion, so all of them are settled on return. */
  async releaseChildren(): Promise<void> {
    this.childrenHeld = false;
    const held = this.heldTurns.splice(0);
    await Promise.all(held.map((run) => run()));
  }

  setBehavior(behavior: ChildBehavior): void {
    this.behavior = behavior;
  }

  /** Make the next `agent start` calls fail with these Herdr error codes. */
  queueStartFailures(...codes: string[]): void {
    this.startFailures.push(...codes);
  }

  agentByName(name: string): FakeAgent | undefined {
    return this.agents.get(name);
  }

  /**
   * Finish an agent that was left `working` (`neverSettle`), as a real child
   * would once it recovers. Used to test the re-wait path after a timeout.
   */
  async completeAgent(target: string, result: string): Promise<void> {
    const agent = this.resolveAgent(target);
    if (!agent) throw new Error(`unknown agent ${target}`);
    if (agent.resultFile) await fs.writeFile(agent.resultFile, result, "utf8");
    this.setStatus(agent, "idle");
  }

  paneById(paneId: string): FakePane | undefined {
    return this.panes.find((pane) => pane.pane_id === paneId);
  }

  paneByLabel(label: string): FakePane | undefined {
    return this.panes.find((pane) => pane.label === label);
  }

  layoutFor(tabId: string): LayoutNode | undefined {
    return this.layouts.get(tabId);
  }

  /** CLI calls matching a `herdr <a> <b>` prefix. */
  callsMatching(...prefix: string[]): string[][] {
    return this.calls.filter((argv) =>
      prefix.every((part, index) => argv[index] === part),
    );
  }

  async start(
    dir: string,
  ): Promise<{ cliSocketPath: string; apiSocketPath: string }> {
    const cliSocketPath = path.join(dir, "cli.sock");
    const apiSocketPath = path.join(dir, "api.sock");

    this.cliServer = createServer((socket) =>
      this.handleLineSocket(socket, async (message) => {
        const argv = (message as { argv?: string[] }).argv ?? [];
        this.calls.push(argv);
        return await this.handleCli(argv);
      }),
    );
    this.apiServer = createServer((socket) =>
      this.handleLineSocket(socket, async (message) => this.handleApi(message)),
    );

    await Promise.all([
      new Promise<void>((resolve) =>
        this.cliServer?.listen(cliSocketPath, resolve),
      ),
      new Promise<void>((resolve) =>
        this.apiServer?.listen(apiSocketPath, resolve),
      ),
    ]);
    return { cliSocketPath, apiSocketPath };
  }

  async stop(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
    await Promise.all(
      [this.cliServer, this.apiServer].map(
        (server) =>
          new Promise<void>((resolve) => {
            if (!server) return resolve();
            server.close(() => resolve());
          }),
      ),
    );
  }

  private makePaneId(): string {
    return `${this.workspaceId}:p${this.nextPane++}`;
  }

  private makeTabId(): string {
    return `${this.workspaceId}:t${this.nextTab++}`;
  }

  private makeTerminalId(): string {
    return `term${this.nextTerminal++}`;
  }

  private handleLineSocket(
    socket: Socket,
    handle: (message: unknown) => Promise<CliResponse | unknown>,
  ): void {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        void (async () => {
          const message = JSON.parse(line);
          const response = await handle(message);
          socket.write(`${JSON.stringify(response)}\n`);
        })();
      }
    });
  }

  private async handleApi(message: unknown): Promise<unknown> {
    const { id, method, params } = message as {
      id: string;
      method: string;
      params: Record<string, unknown>;
    };

    if (method === "layout.export") {
      const pane = this.paneById(String(params.pane_id));
      const root = pane ? this.layouts.get(pane.tab_id) : undefined;
      if (!pane || !root) {
        return { id, error: { message: `unknown pane ${params.pane_id}` } };
      }
      return { id, result: { layout: { tab_id: pane.tab_id, root } } };
    }

    if (method === "layout.set_split_ratio") {
      const tabId = String(params.tab_id);
      const nodePath = (params.path as boolean[]) ?? [];
      const ratio = Number(params.ratio);
      const root = this.layouts.get(tabId);
      if (!root) return { id, error: { message: `unknown tab ${tabId}` } };

      let node: LayoutNode | undefined = root;
      for (const goSecond of nodePath) {
        if (node?.type !== "split") {
          node = undefined;
          break;
        }
        node = goSecond ? node.second : node.first;
      }
      if (node?.type !== "split") {
        return { id, error: { message: "path does not point at a split" } };
      }
      node.ratio = ratio;
      this.ratioUpdates.push({ tabId, path: nodePath, ratio });
      return { id, result: {} };
    }

    return { id, error: { message: `unknown method ${method}` } };
  }

  private async handleCli(argv: string[]): Promise<CliResponse> {
    const [group, command] = argv;

    const key = `${group} ${command}`;
    const malformed = this.commandMalformed.get(key);
    if (malformed !== undefined) return { stdout: malformed };
    const failure = this.commandFailures.get(key);
    if (failure) {
      failure.times -= 1;
      if (failure.times <= 0) this.commandFailures.delete(key);
      return fail(failure.code, `injected ${failure.code} for ${key}`);
    }

    if (group === "api" && command === "snapshot") {
      return ok({
        snapshot: {
          panes: this.panes.map(({ env: _env, ...pane }) => pane),
          tabs: this.tabs,
          focused_pane_id: this.focusedPaneId,
          focused_tab_id: this.orchestratorPane.tab_id,
          focused_workspace_id: this.workspaceId,
        },
      });
    }

    if (group === "tab") return this.handleTab(argv);
    if (group === "pane") return this.handlePane(argv);
    if (group === "agent") return await this.handleAgent(argv);
    return fail("unknown_command", `unknown command: ${argv.join(" ")}`);
  }

  private handleTab(argv: string[]): CliResponse {
    const [, command, target] = argv;

    if (command === "list") {
      return ok({ tabs: this.tabs });
    }

    if (command === "rename") {
      const tab = this.tabs.find((item) => item.tab_id === target);
      if (!tab) return fail("tab_not_found", `unknown tab ${target}`);
      tab.label = argv[3] ?? tab.label;
      return ok({ tab });
    }

    if (command === "create") {
      const tab: FakeTab = {
        tab_id: this.makeTabId(),
        label: flag(argv, "--label") ?? "tab",
      };
      this.tabs.push(tab);
      const pane: FakePane = {
        pane_id: this.makePaneId(),
        tab_id: tab.tab_id,
        workspace_id: this.workspaceId,
        terminal_id: this.makeTerminalId(),
        label: tab.label,
        cwd: flag(argv, "--cwd"),
        env: parseEnv(argv),
      };
      this.panes.push(pane);
      this.layouts.set(tab.tab_id, { type: "pane", pane_id: pane.pane_id });
      return ok({
        root_pane: {
          ...pane,
          env: undefined,
          ...(this.omitTabIdOnCreate ? { tab_id: undefined } : {}),
        },
      });
    }

    if (command === "close") {
      const tabIndex = this.tabs.findIndex((item) => item.tab_id === target);
      if (tabIndex < 0) return fail("tab_not_found", `unknown tab ${target}`);
      this.tabs.splice(tabIndex, 1);
      for (const pane of this.panes.filter((item) => item.tab_id === target)) {
        this.removePane(pane.pane_id);
      }
      this.layouts.delete(String(target));
      return ok({ closed: target });
    }

    if (command === "focus") {
      for (const tab of this.tabs) tab.focused = tab.tab_id === target;
      return ok({ focused: target });
    }

    return fail("unknown_command", `unknown tab command: ${command}`);
  }

  private handlePane(argv: string[]): CliResponse {
    const [, command, target] = argv;

    if (command === "layout") {
      const paneId = flag(argv, "--pane") ?? this.orchestratorPane.pane_id;
      const pane = this.paneById(paneId);
      const root = pane ? this.layouts.get(pane.tab_id) : undefined;
      if (!root) return fail("pane_not_found", `unknown pane ${paneId}`);
      return ok({ layout: { panes: this.computeRects(root) } });
    }

    if (command === "split") {
      const parent = this.paneById(String(target));
      if (!parent) return fail("pane_not_found", `unknown pane ${target}`);
      const root = this.layouts.get(parent.tab_id);
      if (!root) return fail("pane_not_found", `unknown tab for ${target}`);

      const pane: FakePane = {
        pane_id: this.makePaneId(),
        tab_id: parent.tab_id,
        workspace_id: parent.workspace_id,
        terminal_id: this.makeTerminalId(),
        cwd: flag(argv, "--cwd"),
        env: parseEnv(argv),
      };
      this.panes.push(pane);
      this.layouts.set(
        parent.tab_id,
        this.splitNode(root, parent.pane_id, {
          direction: (flag(argv, "--direction") as "right" | "down") ?? "right",
          ratio: Number(flag(argv, "--ratio") ?? 0.5),
          newPaneId: pane.pane_id,
        }),
      );
      return ok({ pane: { ...pane, env: undefined } });
    }

    if (command === "rename") {
      const pane = this.paneById(String(target));
      if (!pane) return fail("pane_not_found", `unknown pane ${target}`);
      pane.label = argv[3];
      return ok({ pane: { ...pane, env: undefined } });
    }

    if (command === "close") {
      if (!this.paneById(String(target))) {
        return fail("pane_not_found", `unknown pane ${target}`);
      }
      this.removePane(String(target));
      return ok({ closed: target });
    }

    return fail("unknown_command", `unknown pane command: ${command}`);
  }

  private async handleAgent(argv: string[]): Promise<CliResponse> {
    const [, command, target] = argv;

    if (command === "start") {
      const paneId = flag(argv, "--pane");
      const pane = paneId ? this.paneById(paneId) : undefined;
      if (!pane) return fail("pane_not_found", `unknown pane ${paneId}`);

      const separator = argv.indexOf("--");
      const piArgs = separator >= 0 ? argv.slice(separator + 1) : [];
      const failure = this.alwaysFailStartWith ?? this.startFailures.shift();
      if (this.agentStartDelayMs > 0) {
        await this.delay(this.agentStartDelayMs);
      }

      if (failure === "agent_kind_mismatch") {
        // A provider child can briefly own the pane before Pi claims it. The
        // launch already happened, so the agent exists — under the wrong kind.
        const agent: FakeAgent = {
          name: `provider-${pane.pane_id}`,
          paneId: pane.pane_id,
          kind: "kiro",
          status: "working",
          stateChangeSeq: 1,
          interactiveReady: false,
          piArgs,
          transcript: "",
          turns: 0,
        };
        this.agents.set(agent.name, agent);
        pane.agent = "kiro";
        pane.agent_status = "working";
        this.track(
          this.delay(20).then(() => {
            agent.kind = "pi";
            agent.status = "idle";
            agent.interactiveReady = true;
            agent.stateChangeSeq += 1;
            pane.agent = "pi";
            pane.agent_status = "idle";
          }),
        );
        return fail("agent_kind_mismatch", "pane is running kiro, not pi");
      }
      if (failure) {
        return fail(
          failure,
          `${failure} for pane ${pane.pane_id}: ${piArgs.join(" ")}`,
        );
      }

      const agent: FakeAgent = {
        name: String(target),
        paneId: pane.pane_id,
        kind: flag(argv, "--kind") ?? "pi",
        status: "idle",
        stateChangeSeq: 1,
        interactiveReady: true,
        piArgs,
        transcript: "",
        turns: 0,
        ...(flag(piArgs, "--session")
          ? { childSessionFile: flag(piArgs, "--session") }
          : {}),
      };
      this.agents.set(agent.name, agent);
      pane.agent = agent.kind;
      pane.agent_status = agent.status;
      await this.captureChildSession(agent);
      return ok({ agent: this.agentJson(agent) });
    }

    const agent = this.resolveAgent(String(target));

    if (command === "rename") {
      if (!agent) return fail("agent_not_found", `unknown agent ${target}`);
      this.agents.delete(agent.name);
      agent.name = String(argv[3]);
      this.agents.set(agent.name, agent);
      return ok({ agent: this.agentJson(agent) });
    }

    if (command === "get") {
      if (!agent) return fail("agent_not_found", `unknown agent ${target}`);
      return ok({ agent: this.agentJson(agent) });
    }

    if (command === "prompt") {
      if (!agent) return fail("agent_not_found", `unknown agent ${target}`);
      this.track(this.runPrompt(agent, String(argv[3])));
      return ok({ submitted: true });
    }

    if (command === "send-keys") {
      if (!agent) return fail("agent_not_found", `unknown agent ${target}`);
      const pending = this.stalledPrompts.get(agent.name);
      if (pending && argv[3] === "enter") {
        this.stalledPrompts.delete(agent.name);
        this.track(pending());
      }
      return ok({ sent: argv.slice(3) });
    }

    if (command === "wait") {
      if (!agent) return fail("agent_not_found", `unknown agent ${target}`);
      return this.waitForAgent(agent, Number(flag(argv, "--timeout") ?? 30000));
    }

    if (command === "read") {
      if (!agent) return fail("agent_not_found", `unknown agent ${target}`);
      return { stdout: agent.transcript };
    }

    if (command === "focus") {
      for (const pane of this.panes) {
        pane.focused = pane.pane_id === target;
      }
      return ok({ focused: target });
    }

    return fail("unknown_command", `unknown agent command: ${command}`);
  }

  private async runPrompt(agent: FakeAgent, prompt: string): Promise<void> {
    agent.turns += 1;
    const turn: ChildTurn = {
      prompt,
      resultFile: /^HERDR_RESULT_FILE:\s*(.+)$/m.exec(prompt)?.[1]?.trim(),
      agentName: agent.name,
      paneId: agent.paneId,
      turn: agent.turns,
    };
    const outcome = await this.behavior(turn);
    agent.resultFile = turn.resultFile;

    const run = async () => {
      // Hold the previous turn's status and seq so the extension cannot mistake
      // them for acceptance of this prompt.
      if (outcome.staleWindowMs) await this.delay(outcome.staleWindowMs);
      this.setStatus(agent, "working");
      await this.delay(outcome.delayMs ?? DEFAULT_WORKING_MS);
      if (outcome.neverSettle) return;

      if (turn.resultFile) {
        if (outcome.question !== undefined) {
          await fs.writeFile(
            path.join(path.dirname(turn.resultFile), "question.md"),
            outcome.question,
            "utf8",
          );
        }
        if (outcome.result !== undefined) {
          await fs.writeFile(turn.resultFile, outcome.result, "utf8");
        }
        await this.captureChildSession(agent);
      }
      agent.transcript = outcome.transcript ?? agent.transcript;
      this.setStatus(agent, outcome.settleStatus ?? "idle");
    };

    if (outcome.stalled) {
      // Text is in the composer but the agent never left idle: the extension
      // must notice and send one Enter, which releases this.
      this.stalledPrompts.set(agent.name, run);
      return;
    }
    if (this.childrenHeld) {
      this.heldTurns.push(run);
      return;
    }
    await run();
  }

  private async captureChildSession(agent: FakeAgent): Promise<void> {
    if (this.omitSessionMeta) return;
    const pane = this.paneById(agent.paneId);
    const metaPath = pane?.env[SESSION_META_ENV];
    if (!metaPath) return;
    const cwd = pane.cwd || process.cwd();
    let sessionFile = agent.childSessionFile;
    let sessionId = agent.childSessionId;
    if (sessionFile && !sessionId) {
      try {
        const first = (await fs.readFile(sessionFile, "utf8")).split("\n")[0];
        const parsed = JSON.parse(first) as { id?: unknown };
        if (typeof parsed.id === "string") sessionId = parsed.id;
      } catch {
        // Fall through and create a header below.
      }
    }
    sessionId ??= randomUUID();
    sessionFile ??= path.join(
      path.dirname(path.dirname(metaPath)),
      "herdr-pi-sessions",
      `${sessionId}.jsonl`,
    );
    agent.childSessionId = sessionId;
    agent.childSessionFile = sessionFile;
    try {
      await fs.access(sessionFile);
    } catch {
      await fs.mkdir(path.dirname(sessionFile), { recursive: true });
      await fs.writeFile(
        sessionFile,
        `${JSON.stringify({
          type: "session",
          version: 3,
          id: sessionId,
          timestamp: new Date().toISOString(),
          cwd,
        })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    }
    await fs.mkdir(path.dirname(metaPath), { recursive: true });
    await fs.writeFile(
      metaPath,
      `${JSON.stringify({
        sessionId,
        sessionFile,
        cwd,
        updatedAt: new Date().toISOString(),
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }

  private async waitForAgent(
    agent: FakeAgent,
    timeoutMs: number,
  ): Promise<CliResponse> {
    const deadline = Date.now() + timeoutMs;
    while (agent.status !== "idle" && agent.status !== "done") {
      if (Date.now() >= deadline) {
        return fail("timeout", `agent ${agent.name} did not settle`);
      }
      await this.delay(5);
    }
    return ok({ agent: this.agentJson(agent) });
  }

  private setStatus(agent: FakeAgent, status: string): void {
    agent.status = status;
    agent.stateChangeSeq += 1;
    const pane = this.paneById(agent.paneId);
    if (pane) pane.agent_status = status;
  }

  private agentJson(agent: FakeAgent): Record<string, unknown> {
    return {
      name: agent.name,
      agent: agent.kind,
      agent_status: agent.status,
      state_change_seq: agent.stateChangeSeq,
      interactive_ready: agent.interactiveReady,
      pane_id: agent.paneId,
    };
  }

  private resolveAgent(target: string): FakeAgent | undefined {
    return (
      this.agents.get(target) ??
      [...this.agents.values()].find((agent) => agent.paneId === target)
    );
  }

  private removePane(paneId: string): void {
    const pane = this.paneById(paneId);
    if (!pane) return;
    this.panes.splice(this.panes.indexOf(pane), 1);
    for (const [name, agent] of this.agents) {
      if (agent.paneId === paneId) this.agents.delete(name);
    }
    const root = this.layouts.get(pane.tab_id);
    if (!root) return;
    const pruned = this.removeFromNode(root, paneId);
    if (pruned) this.layouts.set(pane.tab_id, pruned);
    else this.layouts.delete(pane.tab_id);
  }

  private splitNode(
    node: LayoutNode,
    targetPaneId: string,
    split: {
      direction: "right" | "down";
      ratio: number;
      newPaneId: string;
    },
  ): LayoutNode {
    if (node.type === "pane") {
      if (node.pane_id !== targetPaneId) return node;
      return {
        type: "split",
        direction: split.direction,
        ratio: split.ratio,
        first: node,
        second: { type: "pane", pane_id: split.newPaneId },
      };
    }
    return {
      ...node,
      first: this.splitNode(node.first, targetPaneId, split),
      second: this.splitNode(node.second, targetPaneId, split),
    };
  }

  private removeFromNode(
    node: LayoutNode,
    paneId: string,
  ): LayoutNode | undefined {
    if (node.type === "pane") {
      return node.pane_id === paneId ? undefined : node;
    }
    const first = this.removeFromNode(node.first, paneId);
    const second = this.removeFromNode(node.second, paneId);
    if (!first) return second;
    if (!second) return first;
    return { ...node, first, second };
  }

  private computeRects(
    node: LayoutNode,
    rect = { x: 0, y: 0, ...VIEWPORT },
  ): Array<{ pane_id: string; rect: typeof rect }> {
    if (node.type === "pane") return [{ pane_id: node.pane_id, rect }];

    if (node.direction === "right") {
      const width = Math.round(rect.width * node.ratio);
      return [
        ...this.computeRects(node.first, { ...rect, width }),
        ...this.computeRects(node.second, {
          ...rect,
          x: rect.x + width,
          width: rect.width - width,
        }),
      ];
    }
    const height = Math.round(rect.height * node.ratio);
    return [
      ...this.computeRects(node.first, { ...rect, height }),
      ...this.computeRects(node.second, {
        ...rect,
        y: rect.y + height,
        height: rect.height - height,
      }),
    ];
  }

  private track(promise: Promise<void>): void {
    const tracked = promise.catch(() => undefined);
    this.inFlight.add(tracked);
    void tracked.then(() => this.inFlight.delete(tracked));
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }
}
