import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { isAgentOwnedBy, paneStateKey, type HerdrAgentsState } from "./state.ts";
import type {
  HerdrAgentInfo,
  HerdrContext,
  HerdrSessionSnapshot,
  PaneInfo,
  ReusableAgentTab,
  TabInfo,
} from "./types.ts";
import { isManagedHerdrTempPath, SESSION_META_ENV } from "./utils.ts";

export class HerdrCliError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly args: readonly string[],
  ) {
    super(message);
    this.name = "HerdrCliError";
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const SENSITIVE_AGENT_START_FLAGS = new Set([
  "--session",
  "--system-prompt",
  "--append-system-prompt",
]);

export function redactHerdrArgs(args: readonly string[]): string[] {
  const redacted = [...args];
  if (
    redacted[0] === "agent" &&
    redacted[1] === "prompt" &&
    redacted.length >= 4
  ) {
    redacted[3] = "<prompt>";
  }
  for (let i = 0; i < redacted.length; i++) {
    const current = redacted[i];
    const next = redacted[i + 1];
    if (SENSITIVE_AGENT_START_FLAGS.has(current) && next !== undefined) {
      redacted[i + 1] = "<redacted>";
      i += 1;
      continue;
    }
    if (current === "--env" && next !== undefined) {
      const eq = next.indexOf("=");
      const key = eq >= 0 ? next.slice(0, eq) : next;
      const value = eq >= 0 ? next.slice(eq + 1) : "";
      if (
        key === SESSION_META_ENV ||
        isSensitivePath(value) ||
        isManagedHerdrTempPath(value)
      ) {
        redacted[i + 1] = `${key}=<redacted>`;
      }
      i += 1;
      continue;
    }
    if (isSensitivePath(current) || isManagedHerdrTempPath(current)) {
      redacted[i] = "<path>";
    }
  }
  return redacted;
}

function isSensitivePath(value: string): boolean {
  if (!value) return false;
  if (
    value.includes(".jsonl") &&
    (value.startsWith("/") || value.includes("\\"))
  ) {
    return true;
  }
  return value.includes("herdr-agent-") || value.includes("herdr-pi-sessions");
}

export function sensitiveArgValues(args: readonly string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const current = args[i];
    const next = args[i + 1];
    if (SENSITIVE_AGENT_START_FLAGS.has(current) && next !== undefined) {
      values.push(next);
      i += 1;
      continue;
    }
    if (current === "--env" && next !== undefined) {
      const eq = next.indexOf("=");
      if (eq >= 0) values.push(next.slice(eq + 1));
      i += 1;
      continue;
    }
    if (isSensitivePath(current) || isManagedHerdrTempPath(current)) {
      values.push(current);
    }
  }
  return [...new Set(values.filter((value) => value.length > 0))].toSorted(
    (a, b) => b.length - a.length,
  );
}

function replacementForSensitiveValue(value: string): string {
  if (value.includes("herdr-agent-")) return "<temp>";
  if (value.includes(".jsonl") || value.includes("herdr-pi-sessions")) {
    return "<session>";
  }
  return "<redacted>";
}

export function sanitizeHerdrOutput(
  text: string,
  sensitiveValues: readonly string[] = [],
): string {
  let result = text;
  for (const value of sensitiveValues) {
    if (!value) continue;
    const replacement = replacementForSensitiveValue(value);
    result = result.split(value).join(replacement);
    const jsonEscaped = JSON.stringify(value).slice(1, -1);
    if (jsonEscaped !== value) {
      result = result.split(jsonEscaped).join(replacement);
    }
  }
  return result;
}

function parseHerdrError(
  stderr: string,
  fallback: string,
): {
  code?: string;
  message: string;
} {
  try {
    const parsed = JSON.parse(stderr) as {
      error?: { code?: string; message?: string };
    };
    if (parsed.error?.message) {
      return { code: parsed.error.code, message: parsed.error.message };
    }
  } catch {
    // Herdr may also emit a human-readable CLI validation error.
  }
  return { message: stderr || fallback };
}

export function execHerdr(
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let onAbort: (() => void) | undefined;
    const cleanup = () => {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    };

    const proc = execFile(
      process.env.HERDR_BIN_PATH || "herdr",
      args,
      { signal, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        cleanup();
        if (error) {
          const parsed = parseHerdrError(stderr?.trim(), error.message);
          const sensitive = sensitiveArgValues(args);
          const safeArgs = redactHerdrArgs(args);
          const code = parsed.code ? ` [${parsed.code}]` : "";
          const safeMessage = sanitizeHerdrOutput(parsed.message, sensitive);
          reject(
            new HerdrCliError(
              sanitizeHerdrOutput(
                `herdr ${safeArgs.join(" ")} failed${code}: ${safeMessage}`,
                sensitive,
              ),
              parsed.code,
              safeArgs,
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );

    if (signal) {
      onAbort = () => {
        proc.kill("SIGTERM");
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export function execHerdrApi(
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socketPath = process.env.HERDR_SOCKET_PATH;
    if (!socketPath) {
      reject(new Error("HERDR_SOCKET_PATH is not set."));
      return;
    }

    const requestId = `herdr-agents:${process.pid}:${Date.now()}:${Math.random()}`;
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;

    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => finish(new Error("Aborted"));

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;

      let response: {
        id?: string;
        result?: unknown;
        error?: { message?: string };
      };
      try {
        response = JSON.parse(buffer.slice(0, newline));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (response.id !== requestId) return;
      if (response.error) {
        finish(new Error(response.error.message ?? `${method} failed`));
        return;
      }
      finish(undefined, response.result);
    });
    socket.on("error", (error) => finish(error));
    socket.on("end", () =>
      finish(new Error(`Herdr socket closed during ${method}.`)),
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export async function getSessionSnapshot(
  signal?: AbortSignal,
): Promise<HerdrSessionSnapshot> {
  const output = await execHerdr(["api", "snapshot"], signal);
  const snapshot = JSON.parse(output)?.result?.snapshot as
    HerdrSessionSnapshot | undefined;
  if (
    !snapshot ||
    !Array.isArray(snapshot.panes) ||
    !Array.isArray(snapshot.tabs)
  ) {
    throw new Error("Malformed Herdr api snapshot response.");
  }
  return snapshot;
}

export async function listPanes(signal?: AbortSignal): Promise<PaneInfo[]> {
  return (await getSessionSnapshot(signal)).panes;
}

export async function getCurrentContext(
  signal?: AbortSignal,
): Promise<HerdrContext> {
  const snapshot = await getSessionSnapshot(signal);
  const panes = snapshot.panes;
  const envPaneId = process.env.HERDR_PANE_ID;
  const currentPane =
    (envPaneId
      ? panes.find((pane) => pane.pane_id === envPaneId)
      : undefined) ??
    (snapshot.focused_pane_id
      ? panes.find((pane) => pane.pane_id === snapshot.focused_pane_id)
      : undefined) ??
    panes.find((pane) => pane.focused);
  if (!currentPane) throw new Error("Could not find current Herdr pane.");
  return {
    panes,
    currentPane,
    workspaceId: currentPane.workspace_id,
    currentTab: currentPane.tab_id,
  };
}

export async function listTabs(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<TabInfo[]> {
  const output = await execHerdr(
    ["tab", "list", "--workspace", workspaceId],
    signal,
  );
  return JSON.parse(output).result.tabs as TabInfo[];
}

export function uniqueLabel(baseLabel: string, tabs: TabInfo[]): string {
  const labels = new Set(tabs.map((tab) => tab.label));
  if (!labels.has(baseLabel)) return baseLabel;

  for (let i = 2; ; i++) {
    const candidate = `${baseLabel} #${i}`;
    if (!labels.has(candidate)) return candidate;
  }
}

export function choosePaneForTab(
  panes: PaneInfo[],
  tabId: string,
): PaneInfo | undefined {
  const tabPanes = panes.filter((pane) => pane.tab_id === tabId);
  return tabPanes.find((pane) => pane.agent === "pi") ?? tabPanes[0];
}

export function findReusableAgentTab(
  context: HerdrContext,
  tabs: TabInfo[],
  baseLabel: string,
  state: HerdrAgentsState,
): ReusableAgentTab | undefined {
  const tab = tabs.find(
    (item) => item.label === baseLabel && item.tab_id !== context.currentTab,
  );
  if (!tab) return undefined;

  const pane = choosePaneForTab(context.panes, tab.tab_id);
  if (!pane || pane.agent !== "pi") return undefined;
  const key = paneStateKey(pane);
  const record = key ? state.agents[key] : undefined;
  if (
    !record ||
    !isAgentOwnedBy(
      record,
      context.currentPane.terminal_id,
      pane.tab_id,
      context.currentTab,
    )
  ) {
    return undefined;
  }

  return { tab, pane };
}

export function findReusableAgentPane(
  context: HerdrContext,
  state: HerdrAgentsState,
  label: string,
): PaneInfo | undefined {
  return context.panes.find((pane) => {
    if (pane.workspace_id !== context.workspaceId) return false;
    if (pane.tab_id !== context.currentTab) return false;
    if (pane.pane_id === context.currentPane.pane_id || pane.agent !== "pi") {
      return false;
    }
    const key = paneStateKey(pane);
    const record = key ? state.agents[key] : undefined;
    if (
      !record ||
      !isAgentOwnedBy(
        record,
        context.currentPane.terminal_id,
        pane.tab_id,
        context.currentTab,
      )
    ) {
      return false;
    }
    return (
      (record.layout === "pane" || record.layout === undefined) &&
      record.tabLabel === label
    );
  });
}

export function listManagedWorkspaceAgents(
  context: HerdrContext,
  state: HerdrAgentsState,
): HerdrAgentInfo[] {
  const agents: HerdrAgentInfo[] = [];

  for (const pane of context.panes) {
    if (pane.workspace_id !== context.workspaceId) continue;
    if (pane.pane_id === context.currentPane.pane_id) continue;

    const key = paneStateKey(pane);
    const record = key ? state.agents[key] : undefined;
    if (!record) continue;
    if (
      !isAgentOwnedBy(
        record,
        context.currentPane.terminal_id,
        pane.tab_id,
        context.currentTab,
      )
    ) {
      continue;
    }

    agents.push({
      tabId: pane.tab_id,
      tabLabel: record.tabLabel ?? pane.label ?? record.agent ?? "Agent",
      paneId: pane.pane_id,
      agent: record.agent ?? pane.agent ?? "pi",
      ...(record.automationName
        ? { automationName: record.automationName }
        : {}),
      ...(record.resultFile ? { resultFile: record.resultFile } : {}),
      status: pane.agent_status ?? "unknown",
      lifecycle: record.lifecycle,
      layout:
        record.layout ?? (pane.tab_id === context.currentTab ? "pane" : "tab"),
      cwd: pane.foreground_cwd ?? pane.cwd,
      ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
      ...(record.spawnWarnings?.length
        ? { spawnWarnings: record.spawnWarnings }
        : {}),
      ...(record.detached ? { detached: true } : {}),
      ...(pane.terminal_id ? { terminalId: pane.terminal_id } : {}),
      ...(record.ownerSessionId
        ? { ownerSessionId: record.ownerSessionId }
        : {}),
      ...(record.ownerSessionFile
        ? { ownerSessionFile: record.ownerSessionFile }
        : {}),
      ...(record.closedHistoryId
        ? { closedHistoryId: record.closedHistoryId }
        : {}),
      ...(record.closedHistoryGeneration
        ? { closedHistoryGeneration: record.closedHistoryGeneration }
        : {}),
    });
  }

  return agents.sort((a, b) => a.tabLabel.localeCompare(b.tabLabel));
}

export type PortableLayoutNode =
  | { type: "pane"; pane_id?: string }
  | {
      type: "split";
      direction: "right" | "down";
      ratio: number;
      first: PortableLayoutNode;
      second: PortableLayoutNode;
    };

export interface SplitRatioUpdate {
  path: boolean[];
  ratio: number;
}

function countManagedPanes(
  node: PortableLayoutNode,
  managedPaneIds: ReadonlySet<string>,
): number {
  if (node.type === "pane") {
    return node.pane_id && managedPaneIds.has(node.pane_id) ? 1 : 0;
  }
  return (
    countManagedPanes(node.first, managedPaneIds) +
    countManagedPanes(node.second, managedPaneIds)
  );
}

export function buildEqualAgentSplitRatios(
  root: PortableLayoutNode,
  managedPaneIds: ReadonlySet<string>,
): SplitRatioUpdate[] {
  const updates: SplitRatioUpdate[] = [];

  const visit = (node: PortableLayoutNode, path: boolean[]) => {
    if (node.type === "pane") return;

    const firstCount = countManagedPanes(node.first, managedPaneIds);
    const secondCount = countManagedPanes(node.second, managedPaneIds);
    const total = firstCount + secondCount;

    if (node.direction === "down" && firstCount > 0 && secondCount > 0) {
      updates.push({ path, ratio: firstCount / total });
    }
    if (firstCount > 0) visit(node.first, [...path, false]);
    if (secondCount > 0) visit(node.second, [...path, true]);
  };

  visit(root, []);
  return updates;
}

export async function exportPaneLayout(
  paneId: string,
  signal?: AbortSignal,
): Promise<{ tab_id: string; root: PortableLayoutNode }> {
  const result = (await execHerdrApi(
    "layout.export",
    { pane_id: paneId },
    signal,
  )) as { layout?: { tab_id?: string; root?: PortableLayoutNode } };
  if (!result.layout?.tab_id || !result.layout.root) {
    throw new Error("Malformed Herdr layout.export response.");
  }
  return { tab_id: result.layout.tab_id, root: result.layout.root };
}

export async function setLayoutSplitRatio(
  tabId: string,
  path: boolean[],
  ratio: number,
  signal?: AbortSignal,
): Promise<void> {
  await execHerdrApi(
    "layout.set_split_ratio",
    { tab_id: tabId, path, ratio },
    signal,
  );
}

interface PaneLayout {
  panes?: Array<{
    pane_id: string;
    rect?: { height?: number; width?: number };
  }>;
}

export function chooseAgentColumnSplitTarget(
  panes: PaneInfo[],
  layout?: PaneLayout,
): PaneInfo | undefined {
  const areaByPaneId = new Map(
    (layout?.panes ?? []).map((pane) => [
      pane.pane_id,
      (pane.rect?.height ?? 0) * (pane.rect?.width ?? 0),
    ]),
  );
  return [...panes].sort(
    (a, b) =>
      (areaByPaneId.get(b.pane_id) ?? 0) - (areaByPaneId.get(a.pane_id) ?? 0),
  )[0];
}

type StartedAgentSnapshot = {
  agent: string;
  status: string;
};

type ParsedAgentGet = {
  agent?: string;
  status?: string;
  stateChangeSeq?: number;
  interactiveReady: boolean;
};

function parseAgentGetOutput(output: string): ParsedAgentGet {
  let parsed: {
    result?: {
      agent?: {
        agent?: unknown;
        agent_status?: unknown;
        state_change_seq?: unknown;
        interactive_ready?: unknown;
      };
    };
  };
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Malformed herdr agent get output: ${message}`);
  }

  const raw = parsed.result?.agent;
  return {
    agent: typeof raw?.agent === "string" ? raw.agent : undefined,
    status:
      typeof raw?.agent_status === "string" ? raw.agent_status : undefined,
    stateChangeSeq:
      typeof raw?.state_change_seq === "number"
        ? raw.state_change_seq
        : undefined,
    interactiveReady: raw?.interactive_ready === true,
  };
}

export function parseStartedAgentSnapshot(
  output: string,
): StartedAgentSnapshot {
  const parsed = parseAgentGetOutput(output);
  if (typeof parsed.agent !== "string" || typeof parsed.status !== "string") {
    throw new Error(
      "Malformed herdr agent get output: expected result.agent.agent and agent_status.",
    );
  }
  return { agent: parsed.agent, status: parsed.status };
}

export function buildAgentRenameArgs(target: string, name: string): string[] {
  return ["agent", "rename", target, name];
}

export function startedAgentReady(
  snapshot: StartedAgentSnapshot,
  expectedAgent: string,
): boolean {
  return (
    snapshot.agent === expectedAgent &&
    (snapshot.status === "idle" || snapshot.status === "done")
  );
}

async function waitForStartedAgent(
  paneId: string,
  expectedAgent: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const snapshot = parseStartedAgentSnapshot(
        await execHerdr(["agent", "get", paneId], signal),
      );
      if (startedAgentReady(snapshot, expectedAgent)) return;
    } catch (error) {
      if (signal?.aborted) throw error;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Herdr did not settle on ${expectedAgent} in pane ${paneId} within ${timeoutMs}ms.`,
      );
    }
    await delay(100, signal);
  }
}

export async function startAgent(
  name: string,
  paneId: string,
  piArgs: string[],
  signal?: AbortSignal,
): Promise<void> {
  const args = [
    "agent",
    "start",
    name,
    "--kind",
    "pi",
    "--pane",
    paneId,
    "--timeout",
    "30000",
    "--",
    ...piArgs,
  ];
  const shellReadyDeadline = Date.now() + 5000;

  while (true) {
    try {
      await execHerdr(args, signal);
      return;
    } catch (error) {
      if (
        error instanceof HerdrCliError &&
        error.code === "agent_kind_mismatch"
      ) {
        // Pi using a Kiro ACP model can briefly expose its provider child as
        // the foreground agent before Pi's lifecycle hook claims the pane.
        // The launch already happened, so wait for Pi instead of starting it twice.
        try {
          await waitForStartedAgent(paneId, "pi", 30_000, signal);
          // The failed start does not assign its requested automation name.
          await execHerdr(buildAgentRenameArgs(paneId, name), signal);
          return;
        } catch (settleError) {
          if (signal?.aborted) throw settleError;
          throw error;
        }
      }
      if (
        !(error instanceof HerdrCliError) ||
        error.code !== "agent_pane_busy" ||
        Date.now() >= shellReadyDeadline
      ) {
        throw error;
      }
      await delay(100, signal);
    }
  }
}

/** Herdr hardcodes a 5s lifecycle gate on `agent prompt --wait`. */
const PROMPT_ACCEPT_TIMEOUT_MS = 30_000;
const PROMPT_ACCEPT_POLL_MS = 100;
const PROMPT_ENTER_RETRY_AT = 5_000;

export type HerdrAgentSnapshot = {
  status: string;
  stateChangeSeq: number;
  interactiveReady: boolean;
};

export function buildAgentPromptArgs(target: string, prompt: string): string[] {
  return ["agent", "prompt", target, prompt];
}

export function buildAgentWaitArgs(
  target: string,
  timeoutMs: number,
  until: readonly string[],
): string[] {
  const args = ["agent", "wait", target];
  for (const status of until) {
    args.push("--until", status);
  }
  args.push("--timeout", String(timeoutMs));
  return args;
}

export function parseAgentSnapshot(output: string): HerdrAgentSnapshot {
  const parsed = parseAgentGetOutput(output);
  if (
    typeof parsed.status !== "string" ||
    typeof parsed.stateChangeSeq !== "number"
  ) {
    throw new Error(
      "Malformed herdr agent get output: expected result.agent.agent_status and state_change_seq.",
    );
  }
  return {
    status: parsed.status,
    stateChangeSeq: parsed.stateChangeSeq,
    interactiveReady: parsed.interactiveReady,
  };
}

/** True when a post-submit snapshot proves the prompt was accepted. */
export function promptAcceptanceObserved(
  before: HerdrAgentSnapshot,
  current: HerdrAgentSnapshot,
): "working" | "settled" | null {
  // Require a newer seq so a reused agent still working from a prior turn
  // is not mistaken for acceptance of the just-submitted prompt.
  if (current.stateChangeSeq <= before.stateChangeSeq) {
    return null;
  }
  if (current.status === "working" || current.status === "blocked") {
    return "working";
  }
  if (current.status === "idle" || current.status === "done") {
    // Finished so quickly that `working` was never observed.
    return "settled";
  }
  return null;
}

export async function getAgentSnapshot(
  target: string,
  signal?: AbortSignal,
): Promise<HerdrAgentSnapshot> {
  return parseAgentSnapshot(await execHerdr(["agent", "get", target], signal));
}

async function waitForPromptAcceptance(
  target: string,
  before: HerdrAgentSnapshot,
  signal?: AbortSignal,
): Promise<"working" | "settled"> {
  const startedAt = Date.now();
  const deadline = startedAt + PROMPT_ACCEPT_TIMEOUT_MS;
  let enterSent = false;

  while (true) {
    const current = await getAgentSnapshot(target, signal);
    const observed = promptAcceptanceObserved(before, current);
    if (observed) return observed;

    const now = Date.now();
    if (
      !enterSent &&
      now - startedAt >= PROMPT_ENTER_RETRY_AT &&
      current.status === "idle" &&
      current.interactiveReady
    ) {
      // Text often lands in the composer while Enter does not. Nudge once,
      // but only while the composer is still accepting input — never into a
      // live turn or approval UI that lifecycle detection has not yet shown.
      await execHerdr(["agent", "send-keys", target, "enter"], signal);
      enterSent = true;
    }

    if (now >= deadline) {
      throw new HerdrCliError(
        `herdr agent prompt ${target} <prompt> failed [agent_prompt_stalled]: no lifecycle change within ${PROMPT_ACCEPT_TIMEOUT_MS}ms after submit`,
        "agent_prompt_stalled",
        ["agent", "prompt", target, "<prompt>"],
      );
    }

    await delay(PROMPT_ACCEPT_POLL_MS, signal);
  }
}

/** Remap Herdr 0.8.2 `agent_blocked` into an actionable Orchestrator error. */
export function mapPromptError(error: unknown, target: string): never {
  if (error instanceof HerdrCliError && error.code === "agent_blocked") {
    throw new HerdrCliError(
      `persistent agent "${target}" is waiting at an approval/question dialog; attach with \`herdr agent attach ${target}\` and resolve it before re-prompting`,
      "agent_blocked",
      ["agent", "prompt", target, "<prompt>"],
    );
  }
  throw error;
}

export async function promptAgent(
  target: string,
  prompt: string,
  options: { wait: boolean; timeoutMs: number },
  signal?: AbortSignal,
): Promise<void> {
  // Avoid `agent prompt --wait`: Herdr's hardcoded 5s post-submit lifecycle
  // gate returns agent_prompt_stalled when Pi is slow to leave idle, which
  // looks like "text pasted, Enter never pressed". Submit atomically, then
  // wait for working ourselves (with one Enter recovery) before completion.
  const before = await getAgentSnapshot(target, signal);
  try {
    await execHerdr(buildAgentPromptArgs(target, prompt), signal);
  } catch (error) {
    mapPromptError(error, target);
  }

  if (!options.wait) return;

  const acceptance = await waitForPromptAcceptance(target, before, signal);
  if (acceptance === "settled") return;

  await waitForAgent(target, options.timeoutMs, signal);
}

export async function waitForAgent(
  target: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  await execHerdr(
    buildAgentWaitArgs(target, timeoutMs, ["idle", "done"]),
    signal,
  );
}

export function readAgent(
  target: string,
  signal?: AbortSignal,
): Promise<string> {
  return execHerdr(
    ["agent", "read", target, "--source", "recent-unwrapped", "--lines", "180"],
    signal,
  );
}
