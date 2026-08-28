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
  /** Spawn-time profile values Pi ignored; retained for detached/re-wait output. */
  spawnWarnings?: string[];
  /**
   * Spawned with `wait: false` and not yet collected. Lives in the state file
   * rather than memory so a pending delivery survives `/reload`.
   */
  detached?: boolean;
  /**
   * Orchestrator pane `terminal_id` that spawned this agent. Widget, reuse,
   * and detached delivery all key off this so two Orchestrators in one
   * workspace do not claim each other's children.
   */
  ownerTerminalId?: string;
  updatedAt: string;
}

export interface HerdrAgentsState {
  version: 1;
  agents: Record<string, HerdrAgentStateRecord>;
}

const STATE_PATH_ENV = "HERDR_AGENTS_STATE_PATH";
const STATE_LOCK_STALE_MS = 8_000;

// Serializes load-mutate-save cycles per state file path. The in-process
// queue stops parallel herdr_agent calls in one Pi from clobbering each
// other; the exclusive lock file stops a second Orchestrator from doing
// the same to claimDetached / record writes.
const stateFileQueues = new Map<string, Promise<unknown>>();

async function tryAcquireExclusiveLock(
  lockPath: string,
): Promise<(() => Promise<void>) | "locked"> {
  try {
    const handle = await fs.open(lockPath, "wx");
    return async () => {
      await handle.close();
      await fs.unlink(lockPath).catch(() => {});
    };
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") throw error;
    return "locked";
  }
}

async function acquireExclusiveLock(
  lockPath: string,
): Promise<() => Promise<void>> {
  const deadline = Date.now() + STATE_LOCK_STALE_MS;
  while (true) {
    const acquired = await tryAcquireExclusiveLock(lockPath);
    if (acquired !== "locked") return acquired;

    let stale = Date.now() >= deadline;
    if (!stale) {
      try {
        const stat = await fs.stat(lockPath);
        stale = Date.now() - stat.mtimeMs >= STATE_LOCK_STALE_MS;
      } catch {
        continue;
      }
    }
    if (stale) {
      await fs.unlink(lockPath).catch(() => {});
      const retried = await tryAcquireExclusiveLock(lockPath);
      if (retried !== "locked") return retried;
      throw new Error(`Timed out waiting for ${lockPath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

function withStateFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = stateFileQueues.get(filePath) ?? Promise.resolve();
  const next = previous.then(
    () => runWithExclusiveLock(filePath, fn),
    () => runWithExclusiveLock(filePath, fn),
  );
  stateFileQueues.set(
    filePath,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

async function runWithExclusiveLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const release = await acquireExclusiveLock(`${filePath}.lock`);
  try {
    return await fn();
  } finally {
    await release();
  }
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
      ...(Array.isArray(record.spawnWarnings)
        ? {
            spawnWarnings: record.spawnWarnings.filter(
              (warning): warning is string => typeof warning === "string",
            ),
          }
        : {}),
      ...(record.detached === true ? { detached: true } : {}),
      ...(typeof record.ownerTerminalId === "string"
        ? { ownerTerminalId: record.ownerTerminalId }
        : {}),
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

/**
 * Whether this Orchestrator should list, reuse, or collect the record.
 *
 * Stamped records match `ownerTerminalId` to this pane's terminal. Legacy
 * records without an owner stay visible in pane layout only when they live
 * in the current tab; tab-layout leftovers stay visible until restamped so
 * persistent agents keep working across `/reload` of this change.
 */
export function isAgentOwnedBy(
  record: HerdrAgentStateRecord,
  ownerTerminalId: string | undefined,
  paneTabId: string,
  currentTab: string,
): boolean {
  if (record.ownerTerminalId) {
    return !!ownerTerminalId && record.ownerTerminalId === ownerTerminalId;
  }
  if (record.layout === "tab") return true;
  return paneTabId === currentTab;
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
    spawnWarnings?: string[];
    detached?: boolean;
    ownerTerminalId?: string;
  } = {},
  filePath = getHerdrAgentsStatePath(),
): Promise<void> {
  const key = paneStateKey(pane);
  if (!key) return;

  await withStateFileLock(filePath, async () => {
    const state = await loadHerdrAgentsState(filePath);
    const existing = state.agents[key];
    state.agents[key] = {
      lifecycle,
      ...metadata,
      ...(!metadata.ownerTerminalId && existing?.ownerTerminalId
        ? { ownerTerminalId: existing.ownerTerminalId }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    await saveHerdrAgentsState(state, filePath);
  });
}

/**
 * Spawn warnings belong on the first collection only. Later re-waits and
 * reused tasks rewrite the record without them; this drops them after a
 * successful collect so they are not reprinted.
 */
export async function clearAgentSpawnWarnings(
  pane: Pick<PaneInfo, "terminal_id">,
  filePath = getHerdrAgentsStatePath(),
): Promise<void> {
  const key = paneStateKey(pane);
  if (!key) return;

  await withStateFileLock(filePath, async () => {
    const state = await loadHerdrAgentsState(filePath);
    const record = state.agents[key];
    if (!record?.spawnWarnings?.length) return;
    const { spawnWarnings: _dropped, ...rest } = record;
    state.agents[key] = rest;
    await saveHerdrAgentsState(state, filePath);
  });
}

export async function deleteAgentLifecycle(
  pane: Pick<PaneInfo, "terminal_id">,
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
 * inside a locked read-modify-write (in-process queue plus an exclusive lock
 * file), so overlapping poller ticks — including a second Orchestrator —
 * cannot both deliver, and because the flag lives in the state file the claim
 * also holds across `/reload`.
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
