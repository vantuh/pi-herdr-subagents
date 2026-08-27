import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  HerdrAgentLayout,
  HerdrAgentLifecycle,
  PaneInfo,
} from "./types.ts";

export interface HerdrAgentStateRecord {
  lifecycle: HerdrAgentLifecycle;
  tabLabel?: string;
  agent?: string;
  automationName?: string;
  resultFile?: string;
  layout?: HerdrAgentLayout;
  /**
   * Spawned with `wait: false` and not yet collected. Lives in the state file
   * rather than memory so a pending delivery survives `/reload`.
   */
  detached?: boolean;
  updatedAt: string;
}

export interface HerdrAgentsState {
  version: 1;
  agents: Record<string, HerdrAgentStateRecord>;
}

const STATE_PATH_ENV = "HERDR_AGENTS_STATE_PATH";

// Serializes load-mutate-save cycles per state file path so same-process
// concurrent callers (e.g. parallel herdr_agent invocations) don't race on
// a read-modify-write of the shared JSON file and clobber each other's
// writes. This only protects against in-process concurrency; it does not
// guard against concurrent writers in other processes. State is best-effort
// (used for lifecycle bookkeeping, not correctness-critical data), so a lost
// update from a cross-process race is acceptable, but losing entries within
// the same process would be an avoidable bug.
const stateFileQueues = new Map<string, Promise<unknown>>();

function withStateFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = stateFileQueues.get(filePath) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  stateFileQueues.set(
    filePath,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

export function getHerdrAgentsStatePath(): string {
  return (
    process.env[STATE_PATH_ENV] ??
    path.join(os.homedir(), ".pi", "agent", "herdr-agents-state.json")
  );
}

export function emptyHerdrAgentsState(): HerdrAgentsState {
  return { version: 1, agents: {} };
}

function isLifecycle(value: unknown): value is HerdrAgentLifecycle {
  return value === "oneshot" || value === "persistent";
}

function isLayout(value: unknown): value is HerdrAgentLayout {
  return value === "pane" || value === "tab";
}

// terminal_id is used as the durable state key (rather than pane_id/tab_id)
// because Herdr can recreate panes/tabs with new ids while keeping the same
// underlying terminal, and we want lifecycle state to survive that.
export function paneStateKey(
  pane: Pick<PaneInfo, "terminal_id">,
): string | undefined {
  return pane.terminal_id ? `terminal:${pane.terminal_id}` : undefined;
}

export async function loadHerdrAgentsState(
  filePath = getHerdrAgentsStatePath(),
): Promise<HerdrAgentsState> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return emptyHerdrAgentsState();
    }
    throw error;
  }

  let parsed: Partial<HerdrAgentsState>;
  try {
    parsed = JSON.parse(raw) as Partial<HerdrAgentsState>;
  } catch {
    return emptyHerdrAgentsState();
  }

  const state = emptyHerdrAgentsState();
  if (!parsed.agents || typeof parsed.agents !== "object") return state;

  for (const [key, record] of Object.entries(parsed.agents)) {
    if (!record || typeof record !== "object") continue;
    if (!isLifecycle(record.lifecycle)) continue;

    state.agents[key] = {
      lifecycle: record.lifecycle,
      ...(typeof record.tabLabel === "string"
        ? { tabLabel: record.tabLabel }
        : {}),
      ...(typeof record.agent === "string" ? { agent: record.agent } : {}),
      ...(typeof record.automationName === "string"
        ? { automationName: record.automationName }
        : {}),
      ...(typeof record.resultFile === "string"
        ? { resultFile: record.resultFile }
        : {}),
      ...(isLayout(record.layout) ? { layout: record.layout } : {}),
      ...(record.detached === true ? { detached: true } : {}),
      updatedAt:
        typeof record.updatedAt === "string"
          ? record.updatedAt
          : new Date(0).toISOString(),
    };
  }

  return state;
}

export async function saveHerdrAgentsState(
  state: HerdrAgentsState,
  filePath = getHerdrAgentsStatePath(),
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(tempPath, filePath);
}

export function getKnownAgentLifecyclesByTabId(
  panes: PaneInfo[],
  state: HerdrAgentsState,
): Map<string, HerdrAgentLifecycle> {
  const lifecycles = new Map<string, HerdrAgentLifecycle>();

  for (const pane of panes) {
    const key = paneStateKey(pane);
    const record = key ? state.agents[key] : undefined;
    if (record) lifecycles.set(pane.tab_id, record.lifecycle);
  }

  return lifecycles;
}

export function pruneHerdrAgentsState(
  state: HerdrAgentsState,
  panes: PaneInfo[],
): boolean {
  const liveKeys = new Set(
    panes
      .map((pane) => paneStateKey(pane))
      .filter((key): key is string => !!key),
  );

  let changed = false;
  for (const key of Object.keys(state.agents)) {
    if (liveKeys.has(key)) continue;
    delete state.agents[key];
    changed = true;
  }

  return changed;
}

export async function recordAgentLifecycle(
  pane: PaneInfo,
  lifecycle: HerdrAgentLifecycle,
  metadata: {
    tabLabel?: string;
    agent?: string;
    automationName?: string;
    resultFile?: string;
    layout?: HerdrAgentLayout;
    detached?: boolean;
  } = {},
  filePath = getHerdrAgentsStatePath(),
): Promise<void> {
  const key = paneStateKey(pane);
  if (!key) return;

  await withStateFileLock(filePath, async () => {
    const state = await loadHerdrAgentsState(filePath);
    state.agents[key] = {
      lifecycle,
      ...metadata,
      updatedAt: new Date().toISOString(),
    };
    await saveHerdrAgentsState(state, filePath);
  });
}

export async function deleteAgentLifecycle(
  pane: PaneInfo,
  filePath = getHerdrAgentsStatePath(),
): Promise<void> {
  const key = paneStateKey(pane);
  if (!key) return;

  await withStateFileLock(filePath, async () => {
    const state = await loadHerdrAgentsState(filePath);
    if (!state.agents[key]) return;
    delete state.agents[key];
    await saveHerdrAgentsState(state, filePath);
  });
}

/**
 * Atomically take ownership of a pending async delivery.
 *
 * Returns true exactly once per detached agent: the flag is read and cleared
 * inside a single locked read-modify-write, so overlapping poller ticks cannot
 * both deliver, and because the flag lives in the state file the claim also
 * holds across `/reload`.
 *
 * Claiming before delivering means a failed delivery drops the notification
 * rather than risking a duplicate — the result artifact still exists and stays
 * reachable by an explicit re-wait.
 */
export async function claimDetachedAgent(
  pane: Pick<PaneInfo, "terminal_id">,
  filePath = getHerdrAgentsStatePath(),
): Promise<boolean> {
  const key = paneStateKey(pane);
  if (!key) return false;

  return withStateFileLock(filePath, async () => {
    const state = await loadHerdrAgentsState(filePath);
    const record = state.agents[key];
    if (!record?.detached) return false;
    delete record.detached;
    await saveHerdrAgentsState(state, filePath);
    return true;
  });
}
