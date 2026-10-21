import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import * as path from 'node:path';

import { SESSION_META_ENV } from '../src/artifacts.ts';
import {
  computeRects,
  removeFromNode,
  splitNode,
} from './fake-herdr/layout.ts';
import type {
  ChildBehavior,
  ChildOutcome,
  ChildTurn,
  CliResponse,
  FakeAgent,
  FakePane,
  FakeTab,
  FakeWorkspace,
  LayoutNode,
} from './fake-herdr/types.ts';

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

/**
 * Default time a simulated child stays `working`. It has to outlast the
 * extension's first post-submit `agent get` (a real subprocess spawn), so the
 * `working` → `agent wait` path is exercised instead of the fast-settle
 * shortcut.
 */
const DEFAULT_WORKING_MS = 200;

/** How often the simulated child looks at its control directory. */
const CONTROL_POLL_MS = 20;

function ok(result: unknown): CliResponse {
  return { stdout: `${JSON.stringify({ result })}\n` };
}

function fail(code: string, message: string): CliResponse {
  return {
    stderr: `${JSON.stringify({ error: { code, message } })}\n`,
    code: 1,
  };
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
  for (const entry of flags(argv, '--env')) {
    const eq = entry.indexOf('=');
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

function defaultBehavior(turn: ChildTurn): ChildOutcome {
  return {
    result: `Result from ${turn.agentName} (turn ${turn.turn}).`,
  };
}

export class FakeHerdr {
  readonly workspaceId = 'w1';
  readonly workspaces: FakeWorkspace[] = [
    { workspace_id: 'w1', label: 'main', focused: true },
  ];
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
  focusedPaneId = '';
  private childrenHeld = false;
  private readonly heldTurns: Array<() => Promise<void>> = [];
  private readonly commandFailures = new Map<
    string,
    { code: string; times: number; stderr?: string }
  >();
  private readonly commandMalformed = new Map<string, string>();
  /** `herdr <group> <command>` keys whose calls block until released. */
  private readonly heldCommands = new Set<string>();
  /** API socket methods whose calls block until released. */
  private readonly heldApiMethods = new Set<string>();
  private readonly commandWaiters: Array<() => void> = [];
  private omitTabIdOnCreate = false;
  private createdTabLabel?: string;
  private omitSessionMeta = false;
  private agentStartDelayMs = 0;
  /** Caps the --timeout the extension passes to `agent wait` (tests). */
  waitTimeoutCapMs = Number.POSITIVE_INFINITY;
  private behavior: ChildBehavior = defaultBehavior;
  private cliServer?: Server;
  private apiServer?: Server;
  private nextPane = 1;
  private nextTab = 1;
  private nextWorkspace = 2;
  private nextTerminal = 1;
  /** Prompts still being simulated; awaited on stop to avoid stray writes. */
  private readonly inFlight = new Set<Promise<void>>();
  /** Simulated child control consumers, keyed by their control directory. */
  private readonly controlConsumers = new Map<
    string,
    {
      timer?: ReturnType<typeof setInterval>;
      handled: Set<string>;
      closed: boolean;
    }
  >();

  readonly orchestratorPane: FakePane;

  constructor() {
    const tab: FakeTab = {
      tab_id: this.makeTabId(),
      label: 'main',
      focused: true,
    };
    this.tabs.push(tab);
    this.orchestratorPane = {
      pane_id: this.makePaneId(),
      tab_id: tab.tab_id,
      workspace_id: this.workspaceId,
      terminal_id: this.makeTerminalId(),
      focused: true,
      agent: 'pi',
      agent_status: 'working',
      cwd: process.cwd(),
      env: {},
    };
    this.panes.push(this.orchestratorPane);
    this.focusedPaneId = this.orchestratorPane.pane_id;
    this.layouts.set(tab.tab_id, {
      type: 'pane',
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
   * Accept prompts and hold the simulated turns.
   *
   * Lets a test make several children settle at the same moment, which is the
   * only way to land two detached outcomes in one poller tick.
   */
  holdChildren(): void {
    this.childrenHeld = true;
  }

  /**
   * Block `herdr <group> <command>` calls until `releaseCommands()`, so a test
   * can hold a widget tick inside a Herdr call and assert on it.
   */
  simulateLiveHandoff(): void {
    for (const pane of this.panes) pane.terminal_id = this.makeTerminalId();
    for (const agent of this.agents.values()) {
      agent.stateChangeSeq = 0;
      agent.completionSeq = undefined;
    }
  }

  holdCommand(prefix: string): void {
    this.heldCommands.add(prefix);
  }

  /** Block API socket methods until `releaseCommands()`. */
  holdApi(method: string): void {
    this.heldApiMethods.add(method);
  }

  /** Let every held command and API method through; new calls are not held. */
  releaseCommands(): void {
    this.heldCommands.clear();
    this.heldApiMethods.clear();
    const waiters = this.commandWaiters.splice(0);
    for (const wake of waiters) wake();
  }

  /** Fail a `herdr <group> <command>` with a Herdr error code. */
  failCommand(
    prefix: string,
    code: string,
    options: { times?: number; stderr?: string } = {},
  ): void {
    this.commandFailures.set(prefix, {
      code,
      times: options.times ?? Number.POSITIVE_INFINITY,
      stderr: options.stderr,
    });
  }

  /** Return unparseable (or wrongly shaped) stdout for a command. */
  malformCommand(prefix: string, payload = 'this is not json'): void {
    this.commandMalformed.set(prefix, payload);
  }

  /**
   * Create tabs for real but omit `tab_id` from the response, exercising
   * the extension's snapshot lookup by the created pane id.
   */
  omitCreatedTabId(): void {
    this.omitTabIdOnCreate = true;
  }

  renameCreatedTabs(label: string): void {
    this.createdTabLabel = label;
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
   * would once it recovers. Used to settle an agent the poller has not delivered.
   */
  async completeAgent(target: string, result: string): Promise<void> {
    const agent = this.resolveAgent(target);
    if (!agent) throw new Error(`unknown agent ${target}`);
    if (agent.resultFile) await fs.writeFile(agent.resultFile, result, 'utf8');
    this.setStatus(agent, 'idle');
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
    const cliSocketPath = path.join(dir, 'cli.sock');
    const apiSocketPath = path.join(dir, 'api.sock');

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
    for (const dir of [...this.controlConsumers.keys()]) {
      this.stopControlConsumer(dir);
    }
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

  private makePaneId(workspaceId = this.workspaceId): string {
    return `${workspaceId}:p${this.nextPane++}`;
  }

  private makeTabId(workspaceId = this.workspaceId): string {
    return `${workspaceId}:t${this.nextTab++}`;
  }

  private makeTerminalId(): string {
    return `term${this.nextTerminal++}`;
  }

  private handleLineSocket(
    socket: Socket,
    handle: (message: unknown) => Promise<CliResponse | unknown>,
  ): void {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
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

    if (this.heldApiMethods.has(method)) {
      await new Promise<void>((resolve) => this.commandWaiters.push(resolve));
    }

    if (method === 'layout.export') {
      const pane = this.paneById(String(params.pane_id));
      const root = pane ? this.layouts.get(pane.tab_id) : undefined;
      if (!pane || !root) {
        return { id, error: { message: `unknown pane ${params.pane_id}` } };
      }
      return { id, result: { layout: { tab_id: pane.tab_id, root } } };
    }

    if (method === 'layout.set_split_ratio') {
      const tabId = String(params.tab_id);
      const nodePath = (params.path as boolean[]) ?? [];
      const ratio = Number(params.ratio);
      const root = this.layouts.get(tabId);
      if (!root) return { id, error: { message: `unknown tab ${tabId}` } };

      let node: LayoutNode | undefined = root;
      for (const goSecond of nodePath) {
        if (node?.type !== 'split') {
          node = undefined;
          break;
        }
        node = goSecond ? node.second : node.first;
      }
      if (node?.type !== 'split') {
        return { id, error: { message: 'path does not point at a split' } };
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
    if (this.heldCommands.has(key)) {
      await new Promise<void>((resolve) => this.commandWaiters.push(resolve));
    }
    const malformed = this.commandMalformed.get(key);
    if (malformed !== undefined) return { stdout: malformed };
    const failure = this.commandFailures.get(key);
    if (failure) {
      failure.times -= 1;
      if (failure.times <= 0) this.commandFailures.delete(key);
      if (failure.stderr) return { stderr: failure.stderr, code: 1 };
      return fail(failure.code, `injected ${failure.code} for ${key}`);
    }

    if (group === 'api' && command === 'snapshot') {
      return ok({
        snapshot: {
          panes: this.panes.map(({ env: _env, ...pane }) => pane),
          agents: [...this.agents.values()].map((agent) =>
            this.agentJson(agent),
          ),
          tabs: this.tabs,
          focused_pane_id: this.focusedPaneId,
          focused_tab_id: this.orchestratorPane.tab_id,
          focused_workspace_id: this.workspaceId,
        },
      });
    }

    if (group === 'workspace') return this.handleWorkspace(argv);
    if (group === 'notification') {
      return ok({ shown: argv.slice(2) });
    }
    if (group === 'tab') return this.handleTab(argv);
    if (group === 'pane') return this.handlePane(argv);
    if (group === 'agent') return await this.handleAgent(argv);
    return fail('unknown_command', `unknown command: ${argv.join(' ')}`);
  }

  private handleWorkspace(argv: string[]): CliResponse {
    const [, command] = argv;

    if (command === 'list') {
      return ok({
        workspaces: this.workspaces.map((workspace) => ({
          ...workspace,
          active_tab_id: this.tabs.find((tab) =>
            tab.tab_id.startsWith(`${workspace.workspace_id}:`),
          )?.tab_id,
          tab_count: this.tabs.filter((tab) =>
            tab.tab_id.startsWith(`${workspace.workspace_id}:`),
          ).length,
        })),
      });
    }

    if (command === 'create') {
      const workspaceId = `w${this.nextWorkspace++}`;
      const workspace: FakeWorkspace = {
        workspace_id: workspaceId,
        label: flag(argv, '--label'),
        focused: false,
      };
      this.workspaces.push(workspace);
      // Like the real server: a workspace starts with one root tab + pane.
      const tab: FakeTab = {
        tab_id: this.makeTabId(workspaceId),
        label: 'tab',
      };
      this.tabs.push(tab);
      const pane: FakePane = {
        pane_id: this.makePaneId(workspaceId),
        tab_id: tab.tab_id,
        workspace_id: workspaceId,
        terminal_id: this.makeTerminalId(),
        label: tab.label,
        cwd: flag(argv, '--cwd'),
        env: parseEnv(argv),
      };
      this.panes.push(pane);
      this.layouts.set(tab.tab_id, { type: 'pane', pane_id: pane.pane_id });
      return ok({
        workspace,
        tab,
        root_pane: { ...pane, env: undefined },
      });
    }

    if (command === 'focus') {
      for (const workspace of this.workspaces) {
        workspace.focused = workspace.workspace_id === argv[2];
      }
      return ok({ focused: argv[2] });
    }

    if (command === 'close') {
      if (!this.closeWorkspaceById(String(argv[2]))) {
        return fail('workspace_not_found', `unknown workspace ${argv[2]}`);
      }
      return ok({ closed: argv[2] });
    }

    return fail('unknown_command', `unknown workspace command: ${command}`);
  }

  /** Close a workspace the way a user's manual close would. */
  closeWorkspaceById(workspaceId: string): boolean {
    const index = this.workspaces.findIndex(
      (workspace) => workspace.workspace_id === workspaceId,
    );
    if (index < 0) return false;
    const [removed] = this.workspaces.splice(index, 1);
    for (const tab of this.tabs.filter((tab) =>
      tab.tab_id.startsWith(`${removed.workspace_id}:`),
    )) {
      this.tabs.splice(this.tabs.indexOf(tab), 1);
      for (const pane of this.panes.filter(
        (pane) => pane.tab_id === tab.tab_id,
      )) {
        this.removePane(pane.pane_id);
      }
      this.layouts.delete(tab.tab_id);
    }
    return true;
  }

  /** Workspaces vanish once their last tab is gone (real Herdr behavior). */
  private pruneEmptyWorkspaces(): void {
    for (const workspace of [...this.workspaces]) {
      const hasTabs = this.tabs.some((tab) =>
        tab.tab_id.startsWith(`${workspace.workspace_id}:`),
      );
      if (!hasTabs) {
        this.workspaces.splice(this.workspaces.indexOf(workspace), 1);
      }
    }
  }

  private handleTab(argv: string[]): CliResponse {
    const [, command, target] = argv;
    const workspaceId = flag(argv, '--workspace') ?? this.workspaceId;

    if (command === 'list') {
      return ok({
        tabs: this.tabs.filter((tab) =>
          tab.tab_id.startsWith(`${workspaceId}:`),
        ),
      });
    }

    if (command === 'rename') {
      const tab = this.tabs.find((item) => item.tab_id === target);
      if (!tab) return fail('tab_not_found', `unknown tab ${target}`);
      tab.label = argv[3] ?? tab.label;
      return ok({ tab });
    }

    if (command === 'create') {
      const tab: FakeTab = {
        tab_id: this.makeTabId(workspaceId),
        label: flag(argv, '--label') ?? 'tab',
      };
      this.tabs.push(tab);
      const pane: FakePane = {
        pane_id: this.makePaneId(workspaceId),
        tab_id: tab.tab_id,
        workspace_id: workspaceId,
        terminal_id: this.makeTerminalId(),
        label: tab.label,
        cwd: flag(argv, '--cwd'),
        env: parseEnv(argv),
      };
      this.panes.push(pane);
      this.layouts.set(tab.tab_id, { type: 'pane', pane_id: pane.pane_id });
      if (this.createdTabLabel !== undefined) tab.label = this.createdTabLabel;
      return ok({
        root_pane: {
          ...pane,
          env: undefined,
          ...(this.omitTabIdOnCreate ? { tab_id: undefined } : {}),
        },
      });
    }

    if (command === 'close') {
      const tabIndex = this.tabs.findIndex((item) => item.tab_id === target);
      if (tabIndex < 0) return fail('tab_not_found', `unknown tab ${target}`);
      this.tabs.splice(tabIndex, 1);
      for (const pane of this.panes.filter((item) => item.tab_id === target)) {
        this.removePane(pane.pane_id);
      }
      this.layouts.delete(String(target));
      // Like the real server: a workspace disappears once its last tab closes.
      this.pruneEmptyWorkspaces();
      return ok({ closed: target });
    }

    if (command === 'focus') {
      for (const tab of this.tabs) tab.focused = tab.tab_id === target;
      return ok({ focused: target });
    }

    return fail('unknown_command', `unknown tab command: ${command}`);
  }

  private handlePane(argv: string[]): CliResponse {
    const [, command, target] = argv;

    if (command === 'layout') {
      const paneId = flag(argv, '--pane') ?? this.orchestratorPane.pane_id;
      const pane = this.paneById(paneId);
      const root = pane ? this.layouts.get(pane.tab_id) : undefined;
      if (!root) return fail('pane_not_found', `unknown pane ${paneId}`);
      return ok({ layout: { panes: computeRects(root) } });
    }

    if (command === 'split') {
      const parent = this.paneById(String(target));
      if (!parent) return fail('pane_not_found', `unknown pane ${target}`);
      const root = this.layouts.get(parent.tab_id);
      if (!root) return fail('pane_not_found', `unknown tab for ${target}`);

      const pane: FakePane = {
        pane_id: this.makePaneId(),
        tab_id: parent.tab_id,
        workspace_id: parent.workspace_id,
        terminal_id: this.makeTerminalId(),
        cwd: flag(argv, '--cwd'),
        env: parseEnv(argv),
      };
      this.panes.push(pane);
      this.layouts.set(
        parent.tab_id,
        splitNode(root, parent.pane_id, {
          direction: (flag(argv, '--direction') as 'right' | 'down') ?? 'right',
          ratio: Number(flag(argv, '--ratio') ?? 0.5),
          newPaneId: pane.pane_id,
        }),
      );
      return ok({ pane: { ...pane, env: undefined } });
    }

    if (command === 'rename') {
      const pane = this.paneById(String(target));
      if (!pane) return fail('pane_not_found', `unknown pane ${target}`);
      pane.label = argv[3];
      return ok({ pane: { ...pane, env: undefined } });
    }

    if (command === 'close') {
      const pane = this.paneById(String(target));
      if (!pane) {
        return fail('pane_not_found', `unknown pane ${target}`);
      }
      const tabId = pane.tab_id;
      this.removePane(String(target));
      // Real herdr drops a tab whose last pane closes, then drops an emptied
      // workspace.
      if (!this.panes.some((item) => item.tab_id === tabId)) {
        const tabIndex = this.tabs.findIndex((item) => item.tab_id === tabId);
        if (tabIndex >= 0) this.tabs.splice(tabIndex, 1);
        this.layouts.delete(tabId);
      }
      this.pruneEmptyWorkspaces();
      return ok({ closed: target });
    }

    return fail('unknown_command', `unknown pane command: ${command}`);
  }

  private async handleAgent(argv: string[]): Promise<CliResponse> {
    const [, command, target] = argv;

    if (command === 'start') {
      const paneId = flag(argv, '--pane');
      const pane = paneId ? this.paneById(paneId) : undefined;
      if (!pane) return fail('pane_not_found', `unknown pane ${paneId}`);

      const separator = argv.indexOf('--');
      const piArgs = separator >= 0 ? argv.slice(separator + 1) : [];
      const failure = this.alwaysFailStartWith ?? this.startFailures.shift();
      if (this.agentStartDelayMs > 0) {
        await this.delay(this.agentStartDelayMs);
      }

      if (failure === 'agent_kind_mismatch') {
        // A provider child can briefly own the pane before Pi claims it. The
        // launch already happened, so the agent exists — under the wrong kind.
        const agent: FakeAgent = {
          name: `provider-${pane.pane_id}`,
          paneId: pane.pane_id,
          kind: 'kiro',
          status: 'working',
          stateChangeSeq: 1,
          interactiveReady: false,
          piArgs,
          turns: 0,
        };
        this.agents.set(agent.name, agent);
        pane.agent = 'kiro';
        pane.agent_status = 'working';
        this.track(
          this.delay(20).then(() => {
            agent.kind = 'pi';
            agent.status = 'idle';
            agent.interactiveReady = true;
            agent.stateChangeSeq += 1;
            pane.agent = 'pi';
            pane.agent_status = 'idle';
          }),
        );
        return fail('agent_kind_mismatch', 'pane is running kiro, not pi');
      }
      if (failure) {
        return fail(
          failure,
          `${failure} for pane ${pane.pane_id}: ${piArgs.join(' ')}`,
        );
      }

      const agent: FakeAgent = {
        name: String(target),
        paneId: pane.pane_id,
        kind: flag(argv, '--kind') ?? 'pi',
        status: 'idle',
        stateChangeSeq: 1,
        interactiveReady: true,
        piArgs,
        turns: 0,
        ...(flag(piArgs, '--session')
          ? { childSessionFile: flag(piArgs, '--session') }
          : {}),
      };
      this.agents.set(agent.name, agent);
      pane.agent = agent.kind;
      pane.agent_status = agent.status;
      await this.captureChildSession(agent);
      return ok({ agent: this.agentJson(agent) });
    }

    const agent = this.resolveAgent(String(target));

    if (command === 'rename') {
      if (!agent) return fail('agent_not_found', `unknown agent ${target}`);
      this.agents.delete(agent.name);
      agent.name = String(argv[3]);
      this.agents.set(agent.name, agent);
      return ok({ agent: this.agentJson(agent) });
    }

    if (command === 'get') {
      if (!agent) return fail('agent_not_found', `unknown agent ${target}`);
      return ok({ agent: this.agentJson(agent) });
    }

    if (command === 'prompt') {
      if (!agent) return fail('agent_not_found', `unknown agent ${target}`);
      this.track(this.runPrompt(agent, String(argv[3])));
      return ok({ submitted: true });
    }

    if (command === 'send-keys') {
      if (!agent) return fail('agent_not_found', `unknown agent ${target}`);
      return ok({ sent: argv.slice(3) });
    }

    if (command === 'wait') {
      if (!agent) return fail('agent_not_found', `unknown agent ${target}`);
      const requested = Number(flag(argv, '--timeout') ?? 30000);
      return this.waitForAgent(
        agent,
        Math.min(requested, this.waitTimeoutCapMs),
      );
    }

    if (command === 'read') {
      if (!agent) return fail('agent_not_found', `unknown agent ${target}`);
      return { stdout: '' };
    }

    if (command === 'focus') {
      const pane = this.paneById(String(target));
      for (const item of this.panes) {
        item.focused = item.pane_id === pane?.pane_id;
      }
      return ok({ focused: target });
    }

    return fail('unknown_command', `unknown agent command: ${command}`);
  }

  private async runPrompt(agent: FakeAgent, prompt: string): Promise<void> {
    agent.turns += 1;
    const turn: ChildTurn = {
      prompt,
      resultFile: /^AGENT_RESULT_FILE:\s*(.+)$/m.exec(prompt)?.[1]?.trim(),
      agentName: agent.name,
      paneId: agent.paneId,
      turn: agent.turns,
    };
    const outcome = await this.behavior(turn);
    agent.resultFile = turn.resultFile;
    // A new assignment replaces the previous turn's sample, as the child clears
    // it at `before_agent_start`.
    agent.childContext = outcome.context;
    agent.childCost = outcome.cost;
    agent.controlAck = outcome.controlAck;
    agent.steerTexts = [];
    this.ensureControlConsumer(agent);

    const run = async () => {
      // Hold the previous turn's status and seq so the extension cannot mistake
      // them for acceptance of this prompt.
      if (outcome.staleWindowMs) await this.delay(outcome.staleWindowMs);
      this.setStatus(agent, 'working');
      await this.delay(outcome.delayMs ?? DEFAULT_WORKING_MS);
      if (outcome.neverSettle) return;

      if (turn.resultFile) {
        if (outcome.question !== undefined) {
          await fs.writeFile(
            path.join(path.dirname(turn.resultFile), 'question.md'),
            outcome.question,
            'utf8',
          );
        }
        if (outcome.result !== undefined) {
          // A queued steer enters the run at its next turn boundary, so its text
          // belongs to what the child reports at the end of the run.
          const parts = [outcome.result, ...(agent.steerTexts ?? [])];
          await fs.writeFile(turn.resultFile, parts.join('\n\n'), 'utf8');
        }
        await this.captureChildSession(agent);
      }
      this.setStatus(agent, outcome.settleStatus ?? 'idle');
      agent.completionSeq = agent.stateChangeSeq;
    };

    if (outcome.stalled) {
      return;
    }
    if (this.childrenHeld) {
      this.heldTurns.push(run);
      return;
    }
    await run();
  }

  /**
   * The simulated child consumes `control/request.json` the way the real
   * `src/child/control.ts` does: read the request, apply it once per id, and
   * answer with `ack.<id>.json`. It lives as long as the agent, including after
   * the run settles, which is what lets an idle child answer `idle`.
   */
  private ensureControlConsumer(agent: FakeAgent): void {
    if (!agent.resultFile) return;
    const dir = path.join(path.dirname(agent.resultFile), 'control');
    if (agent.controlDir && agent.controlDir !== dir) {
      this.stopControlConsumer(agent.controlDir);
    }
    agent.controlDir = dir;
    if (this.controlConsumers.has(dir)) return;
    const consumer: {
      timer?: ReturnType<typeof setInterval>;
      handled: Set<string>;
      closed: boolean;
    } = { handled: new Set<string>(), closed: false };
    consumer.timer = setInterval(() => {
      // Tracked like every other simulated child task, so `stop()` drains a
      // consume that is already running instead of letting it write after
      // teardown, and a write that loses to a close stays contained.
      this.track(this.consumeControl(agent, dir, consumer));
    }, CONTROL_POLL_MS);
    consumer.timer.unref?.();
    this.controlConsumers.set(dir, consumer);
  }

  private stopControlConsumer(dir: string): void {
    const consumer = this.controlConsumers.get(dir);
    if (!consumer) return;
    // Fence first: a callback that runs after this point must not write.
    consumer.closed = true;
    clearInterval(consumer.timer);
    this.controlConsumers.delete(dir);
  }

  private async consumeControl(
    agent: FakeAgent,
    dir: string,
    consumer: { handled: Set<string>; closed: boolean },
  ): Promise<void> {
    const { handled } = consumer;
    let raw: string;
    try {
      raw = await fs.readFile(path.join(dir, 'request.json'), 'utf8');
    } catch {
      return;
    }
    let request: { id?: unknown; action?: unknown; message?: unknown };
    try {
      request = JSON.parse(raw);
    } catch {
      // A torn request is ignored, as in the real consumer.
      return;
    }
    if (typeof request.id !== 'string' || handled.has(request.id)) return;
    // Reserved after the read, so repeated polls apply a request once.
    handled.add(request.id);
    const ack = agent.controlAck ?? 'none';
    if (ack === 'none') return;
    if (request.action !== 'steer' && request.action !== 'interrupt') return;
    // A close that landed while the request was being read has removed the
    // agent's directory; writing then would recreate it.
    if (consumer.closed) return;

    if (
      request.action === 'steer' &&
      ack === 'queued' &&
      typeof request.message === 'string'
    ) {
      agent.steerTexts = [...(agent.steerTexts ?? []), request.message];
    }
    if (
      request.action === 'interrupt' &&
      (ack === 'aborted' || ack === 'requested')
    ) {
      // The marker lands before the run can reach a completed boundary; only an
      // observed settle counts as an abort.
      await fs.writeFile(
        path.join(path.dirname(dir), 'interrupted'),
        'interrupted\n',
        'utf8',
      );
      if (ack === 'aborted') this.setStatus(agent, 'idle');
      // Same fence as the real consumer after the marker write: a consumer
      // stopped meanwhile must not publish its acknowledgement.
      if (consumer.closed) return;
    }
    await fs.writeFile(
      path.join(dir, `ack.${request.id}.json`),
      `${JSON.stringify({
        id: request.id,
        action: request.action,
        status: ack,
        at: Date.now(),
      })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
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
        const first = (await fs.readFile(sessionFile, 'utf8')).split('\n')[0];
        const parsed = JSON.parse(first) as { id?: unknown };
        if (typeof parsed.id === 'string') sessionId = parsed.id;
      } catch {
        // Fall through and create a header below.
      }
    }
    sessionId ??= randomUUID();
    sessionFile ??= path.join(
      path.dirname(path.dirname(metaPath)),
      'herdr-pi-sessions',
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
          type: 'session',
          version: 3,
          id: sessionId,
          timestamp: new Date().toISOString(),
          cwd,
        })}\n`,
        { encoding: 'utf8', mode: 0o600 },
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
        ...(agent.childContext ? { context: agent.childContext } : {}),
        ...(agent.childCost !== undefined
          ? { sessionCost: agent.childCost }
          : {}),
      })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  }

  private async waitForAgent(
    agent: FakeAgent,
    timeoutMs: number,
  ): Promise<CliResponse> {
    const deadline = Date.now() + timeoutMs;
    while (agent.status !== 'idle' && agent.status !== 'done') {
      if (Date.now() >= deadline) {
        return fail('timeout', `agent ${agent.name} did not settle`);
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
      completion_seq: agent.completionSeq,
      interactive_ready: agent.interactiveReady,
      pane_id: agent.paneId,
      terminal_id: this.paneById(agent.paneId)?.terminal_id,
      tab_id: this.paneById(agent.paneId)?.tab_id,
      workspace_id: this.paneById(agent.paneId)?.workspace_id,
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
      if (agent.paneId !== paneId) continue;
      if (agent.controlDir) this.stopControlConsumer(agent.controlDir);
      this.agents.delete(name);
    }
    const root = this.layouts.get(pane.tab_id);
    if (!root) return;
    const pruned = removeFromNode(root, paneId);
    if (pruned) this.layouts.set(pane.tab_id, pruned);
    else this.layouts.delete(pane.tab_id);
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
