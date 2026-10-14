import { randomBytes } from "node:crypto";
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
  /** Orchestrator Pi session UUID that spawned this agent. */
  ownerSessionId?: string;
  ownerSessionFile?: string;
  /** Closed-history slot this live agent is continuing, if any. */
  closedHistoryId?: string;
  closedHistoryGeneration?: number;
  updatedAt: string;
}

export type ClosedHistoryStatus =
  "resumable" | "claimed" | "invalid" | "staged";

export interface ClosedAgentHistoryRecord {
  id: string;
  ownerSessionId: string;
  ownerSessionFile?: string;
  profileName: string;
  tabLabel: string;
  childSessionFile: string;
  childSessionId: string;
  cwd: string;
  layout: HerdrAgentLayout;
  lifecycle: "oneshot";
  createdAt: string;
  closedAt: string;
  status: ClosedHistoryStatus;
  claimGeneration: number;
  claimedAt?: string;
}

export interface HerdrAgentsState {
  version: 2;
  agents: Record<string, HerdrAgentStateRecord>;
  closedHistory: ClosedAgentHistoryRecord[];
}

export const CLOSED_HISTORY_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const CLOSED_HISTORY_MAX_PER_OWNER = 32;
export const CLOSED_HISTORY_MAX_GLOBAL = 256;
export const DEFAULT_STATE_LOCK_WAIT_MS = 60_000;
export const DEFAULT_CLOSED_CLAIM_LEASE_MS = 60_000;

const STATE_PATH_ENV = "HERDR_AGENTS_STATE_PATH";
const STATE_LOCK_WAIT_MS_ENV = "HERDR_AGENTS_LOCK_WAIT_MS";
const CLAIM_LEASE_MS_ENV = "HERDR_AGENTS_CLAIM_LEASE_MS";

export type StateMutationKind = "lifecycle" | "stage" | "finalize" | "detached";

let failNextStateSaves = 0;
const failNextMutations: Record<StateMutationKind, number> = {
  lifecycle: 0,
  stage: 0,
  finalize: 0,
  detached: 0,
};

export function setFailNextStateSaves(count: number): void {
  failNextStateSaves = Math.max(0, count);
}

export function setFailNextStateMutation(
  kind: StateMutationKind,
  count = 1,
): void {
  failNextMutations[kind] = Math.max(0, count);
}

export function clearStateSaveFailures(): void {
  failNextStateSaves = 0;
  failNextMutations.lifecycle = 0;
  failNextMutations.stage = 0;
  failNextMutations.finalize = 0;
  failNextMutations.detached = 0;
}

function throwIfInjectedMutation(kind: StateMutationKind): void {
  if (failNextMutations[kind] <= 0) return;
  failNextMutations[kind] -= 1;
  throw new Error(`injected ${kind} state save failure`);
}

export function getStateLockWaitMs(): number {
  return envMs(STATE_LOCK_WAIT_MS_ENV, DEFAULT_STATE_LOCK_WAIT_MS);
}

export function getClosedClaimLeaseMs(): number {
  return envMs(CLAIM_LEASE_MS_ENV, DEFAULT_CLOSED_CLAIM_LEASE_MS);
}

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// Serializes load-mutate-save cycles per state file path. The in-process
// queue stops parallel herdr_agent calls in one Pi from clobbering each
// other; the exclusive lock directory stops a second Orchestrator from doing
// the same to claimDetached / record writes.
const stateFileQueues = new Map<string, Promise<unknown>>();

function lockSentinelPath(lockDir: string, token: string): string {
  return path.join(lockDir, `owner.${process.pid}.${token}`);
}

async function releaseExclusiveLock(
  lockDir: string,
  sentinelPath: string,
): Promise<void> {
  try {
    await fs.unlink(sentinelPath);
  } catch {
    return;
  }
  await fs.rmdir(lockDir).catch(() => {});
}

async function abandonPartialLock(
  lockDir: string,
  sentinelPath: string,
): Promise<void> {
  await fs.unlink(sentinelPath).catch(() => {});
  await fs.rmdir(lockDir).catch(() => {});
}

async function tryAcquireExclusiveLock(
  lockPath: string,
  token: string,
): Promise<(() => Promise<void>) | "locked"> {
  try {
    await fs.mkdir(lockPath);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "EEXIST" || code === "ENOTDIR") return "locked";
    throw error;
  }

  const sentinelPath = lockSentinelPath(lockPath, token);
  try {
    await fs.writeFile(
      sentinelPath,
      `${JSON.stringify({
        pid: process.pid,
        token,
        createdAt: Date.now(),
      })}\n`,
      { flag: "wx", encoding: "utf8" },
    );
  } catch (error) {
    await abandonPartialLock(lockPath, sentinelPath);
    throw error;
  }

  return async () => {
    await releaseExclusiveLock(lockPath, sentinelPath);
  };
}

async function acquireExclusiveLock(
  lockPath: string,
): Promise<() => Promise<void>> {
  const token = randomBytes(16).toString("hex");
  const deadline = Date.now() + getStateLockWaitMs();
  while (true) {
    const acquired = await tryAcquireExclusiveLock(lockPath, token);
    if (acquired !== "locked") return acquired;

    if (Date.now() >= deadline) {
      const retried = await tryAcquireExclusiveLock(lockPath, token);
      if (retried !== "locked") return retried;
      throw new Error(
        `Timed out waiting for ${lockPath}. Another process still holds this exclusive lock directory (or a legacy lock file occupies that path); do not delete it while that process may be alive. If you are sure no Pi/herdr-agents process is running, remove the lock directory (or leftover lock file) manually and retry.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

export function withHerdrAgentsStateLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withStateFileLock(filePath, fn);
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
  return { version: 2, agents: {}, closedHistory: [] };
}

function isLifecycle(value: unknown): value is HerdrAgentLifecycle {
  return value === "oneshot" || value === "persistent";
}

function isLayout(value: unknown): value is HerdrAgentLayout {
  return value === "pane" || value === "tab" || value === "workspace";
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

  let parsed: {
    version?: unknown;
    agents?: unknown;
    closedHistory?: unknown;
  };
  try {
    parsed = JSON.parse(raw) as {
      version?: unknown;
      agents?: unknown;
      closedHistory?: unknown;
    };
  } catch {
    await quarantineStateFile(filePath, "json");
    return emptyHerdrAgentsState();
  }

  if (!isExactStateVersion(parsed.version)) {
    await quarantineStateFile(filePath, parsed.version);
    return emptyHerdrAgentsState();
  }

  if (parsed.version === 1) {
    return migrateV1ToV2(parsed.agents);
  }

  const state = emptyHerdrAgentsState();
  if (!parsed.agents || typeof parsed.agents !== "object") {
    state.closedHistory = parseClosedHistory(parsed.closedHistory);
    reconcileHerdrAgentsState(state);
    pruneClosedHistory(state);
    return state;
  }

  copyAgentRecords(state, parsed.agents);
  state.closedHistory = parseClosedHistory(parsed.closedHistory);
  reconcileHerdrAgentsState(state);
  pruneClosedHistory(state);
  return state;
}

function isExactStateVersion(version: unknown): version is 1 | 2 {
  return version === 1 || version === 2;
}

function migrateV1ToV2(agents: unknown): HerdrAgentsState {
  const state = emptyHerdrAgentsState();
  if (agents && typeof agents === "object") {
    copyAgentRecords(state, agents);
  }
  reconcileHerdrAgentsState(state);
  pruneClosedHistory(state);
  return state;
}

function copyAgentRecords(state: HerdrAgentsState, agents: unknown): void {
  for (const [key, record] of Object.entries(
    agents as Record<string, Partial<HerdrAgentStateRecord>>,
  )) {
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
      ...(typeof record.ownerSessionId === "string"
        ? { ownerSessionId: record.ownerSessionId }
        : {}),
      ...(typeof record.ownerSessionFile === "string"
        ? { ownerSessionFile: record.ownerSessionFile }
        : {}),
      ...(typeof record.closedHistoryId === "string"
        ? { closedHistoryId: record.closedHistoryId }
        : {}),
      ...(typeof record.closedHistoryGeneration === "number" &&
      Number.isFinite(record.closedHistoryGeneration)
        ? { closedHistoryGeneration: record.closedHistoryGeneration }
        : {}),
      updatedAt:
        typeof record.updatedAt === "string"
          ? record.updatedAt
          : new Date(0).toISOString(),
    };
  }
}

async function quarantineStateFile(
  filePath: string,
  version: unknown,
): Promise<void> {
  const suffix =
    version === undefined
      ? "missing"
      : typeof version === "number" || typeof version === "string"
        ? String(version)
        : "malformed";
  let dest = `${filePath}.quarantine.v${suffix}`;
  try {
    await fs.rename(filePath, dest);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") return;
    if (code === "EEXIST") {
      dest = `${filePath}.quarantine.v${suffix}.${Date.now()}`;
      await fs.rename(filePath, dest);
      return;
    }
    throw error;
  }
}

export async function saveHerdrAgentsState(
  state: HerdrAgentsState,
  filePath = getHerdrAgentsStatePath(),
): Promise<void> {
  if (failNextStateSaves > 0) {
    failNextStateSaves -= 1;
    throw new Error("injected state save failure");
  }
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

  if (reconcileHerdrAgentsState(state)) changed = true;

  return changed;
}

/** Drop live records whose terminals are gone, then persist staged→resumable. */
export async function persistPrunedAgentsState(
  panes: PaneInfo[],
  filePath = getHerdrAgentsStatePath(),
): Promise<HerdrAgentsState> {
  return withStateFileLock(filePath, async () => {
    const state = await loadHerdrAgentsState(filePath);
    if (pruneHerdrAgentsState(state, panes)) {
      await saveHerdrAgentsState(state, filePath);
    }
    return state;
  });
}

/**
 * Whether this Orchestrator should list, reuse, or collect the record.
 *
 * Stamped records match `ownerTerminalId` to this pane's terminal. Legacy
 * records without an owner stay visible in pane layout only when they live
 * in the current tab; tab-layout leftovers stay visible until restamped so
 * persistent agents keep working across `/reload`. Workspace layout has no
 * pre-stamping era, so an unstamped record cannot be a legacy leftover and
 * is NOT treated as owned — otherwise it would be visible, closable, and
 * label-stealable from every Orchestrator.
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
    ownerSessionId?: string;
    ownerSessionFile?: string;
    closedHistoryId?: string;
    closedHistoryGeneration?: number;
  } = {},
  filePath = getHerdrAgentsStatePath(),
): Promise<void> {
  const key = paneStateKey(pane);
  if (!key) return;

  await withStateFileLock(filePath, async () => {
    throwIfInjectedMutation("lifecycle");
    const state = await loadHerdrAgentsState(filePath);
    const existing = state.agents[key];
    state.agents[key] = {
      lifecycle,
      ...metadata,
      ...(!metadata.ownerTerminalId && existing?.ownerTerminalId
        ? { ownerTerminalId: existing.ownerTerminalId }
        : {}),
      ...(!metadata.ownerSessionId && existing?.ownerSessionId
        ? { ownerSessionId: existing.ownerSessionId }
        : {}),
      ...(!metadata.ownerSessionFile && existing?.ownerSessionFile
        ? { ownerSessionFile: existing.ownerSessionFile }
        : {}),
      ...(!metadata.closedHistoryId && existing?.closedHistoryId
        ? { closedHistoryId: existing.closedHistoryId }
        : {}),
      ...(!metadata.closedHistoryGeneration && existing?.closedHistoryGeneration
        ? { closedHistoryGeneration: existing.closedHistoryGeneration }
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
 * directory), so overlapping poller ticks — including a second Orchestrator —
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
    throwIfInjectedMutation("detached");
    const state = await loadHerdrAgentsState(filePath);
    const record = state.agents[key];
    if (!record?.detached) return false;
    delete record.detached;
    await saveHerdrAgentsState(state, filePath);
    return true;
  });
}

function isClosedHistoryStatus(value: unknown): value is ClosedHistoryStatus {
  return (
    value === "resumable" ||
    value === "claimed" ||
    value === "invalid" ||
    value === "staged"
  );
}

function parseClosedHistory(raw: unknown): ClosedAgentHistoryRecord[] {
  if (!Array.isArray(raw)) return [];
  const records: ClosedAgentHistoryRecord[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Partial<ClosedAgentHistoryRecord>;
    if (typeof record.id !== "string" || !record.id) continue;
    if (typeof record.ownerSessionId !== "string" || !record.ownerSessionId) {
      continue;
    }
    if (typeof record.profileName !== "string" || !record.profileName) continue;
    if (typeof record.tabLabel !== "string" || !record.tabLabel) continue;
    if (typeof record.childSessionFile !== "string") continue;
    if (!path.isAbsolute(record.childSessionFile)) continue;
    if (typeof record.childSessionId !== "string" || !record.childSessionId) {
      continue;
    }
    if (typeof record.cwd !== "string" || !record.cwd) continue;
    if (!isLayout(record.layout)) continue;
    if (record.lifecycle !== "oneshot") continue;
    if (!isClosedHistoryStatus(record.status)) continue;
    const claimGeneration =
      typeof record.claimGeneration === "number" &&
      Number.isFinite(record.claimGeneration)
        ? record.claimGeneration
        : 0;
    records.push({
      id: record.id,
      ownerSessionId: record.ownerSessionId,
      ...(typeof record.ownerSessionFile === "string"
        ? { ownerSessionFile: record.ownerSessionFile }
        : {}),
      profileName: record.profileName,
      tabLabel: record.tabLabel,
      childSessionFile: record.childSessionFile,
      childSessionId: record.childSessionId,
      cwd: record.cwd,
      layout: record.layout,
      lifecycle: "oneshot",
      createdAt:
        typeof record.createdAt === "string"
          ? record.createdAt
          : new Date(0).toISOString(),
      closedAt:
        typeof record.closedAt === "string"
          ? record.closedAt
          : new Date(0).toISOString(),
      status: record.status,
      claimGeneration,
      ...(typeof record.claimedAt === "string"
        ? { claimedAt: record.claimedAt }
        : {}),
    });
  }
  return records;
}

function historyRecency(record: ClosedAgentHistoryRecord): number {
  const closed = Date.parse(record.closedAt);
  return Number.isFinite(closed) ? closed : 0;
}

function liveAgentForHistory(
  state: HerdrAgentsState,
  historyId: string,
): HerdrAgentStateRecord | undefined {
  return Object.values(state.agents).find(
    (record) => record.closedHistoryId === historyId,
  );
}

export function reconcileHerdrAgentsState(
  state: HerdrAgentsState,
  now = Date.now(),
): boolean {
  let changed = false;
  const leaseMs = getClosedClaimLeaseMs();
  for (const record of state.closedHistory) {
    const live = liveAgentForHistory(state, record.id);
    if (record.status === "staged") {
      if (!live) {
        record.status = "resumable";
        delete record.claimedAt;
        changed = true;
      }
      continue;
    }
    if (record.status !== "claimed") continue;
    if (live) {
      if (
        live.closedHistoryGeneration === undefined ||
        live.closedHistoryGeneration === record.claimGeneration
      ) {
        continue;
      }
    }
    const claimedAt = record.claimedAt ? Date.parse(record.claimedAt) : NaN;
    const age = Number.isFinite(claimedAt) ? now - claimedAt : leaseMs + 1;
    if (age >= leaseMs) {
      record.status = "resumable";
      delete record.claimedAt;
      changed = true;
    }
  }
  return changed;
}

export function pruneClosedHistory(
  state: HerdrAgentsState,
  now = Date.now(),
): boolean {
  const before = state.closedHistory;
  const cutoff = now - CLOSED_HISTORY_TTL_MS;
  let next = before.filter((record) => {
    if (record.status === "claimed" || record.status === "staged") return true;
    return historyRecency(record) >= cutoff;
  });

  const byOwner = new Map<string, ClosedAgentHistoryRecord[]>();
  for (const record of next) {
    const list = byOwner.get(record.ownerSessionId) ?? [];
    list.push(record);
    byOwner.set(record.ownerSessionId, list);
  }
  const kept: ClosedAgentHistoryRecord[] = [];
  for (const list of byOwner.values()) {
    const sorted = list.toSorted(
      (a, b) => historyRecency(b) - historyRecency(a),
    );
    const pinned = sorted.filter(
      (record) => record.status === "claimed" || record.status === "staged",
    );
    const rest = sorted.filter(
      (record) => record.status !== "claimed" && record.status !== "staged",
    );
    kept.push(
      ...pinned,
      ...rest.slice(
        0,
        Math.max(0, CLOSED_HISTORY_MAX_PER_OWNER - pinned.length),
      ),
    );
  }

  next = kept.toSorted((a, b) => historyRecency(b) - historyRecency(a));
  const pinned = next.filter(
    (record) => record.status === "claimed" || record.status === "staged",
  );
  const rest = next.filter(
    (record) => record.status !== "claimed" && record.status !== "staged",
  );
  next = [
    ...pinned,
    ...rest.slice(0, Math.max(0, CLOSED_HISTORY_MAX_GLOBAL - pinned.length)),
  ];

  if (
    next.length === before.length &&
    next.every((record, index) => record.id === before[index]?.id)
  ) {
    return false;
  }
  state.closedHistory = next;
  return true;
}

function newHistoryId(): string {
  return `ch_${randomBytes(8).toString("hex")}`;
}

export interface ArchiveClosedOneShotInput {
  id?: string;
  ownerSessionId: string;
  ownerSessionFile?: string;
  profileName: string;
  tabLabel: string;
  childSessionFile: string;
  childSessionId: string;
  cwd: string;
  layout: HerdrAgentLayout;
}

export async function archiveClosedOneShot(
  input: ArchiveClosedOneShotInput,
  filePath = getHerdrAgentsStatePath(),
): Promise<ClosedAgentHistoryRecord> {
  return withStateFileLock(filePath, async () => {
    const state = await loadHerdrAgentsState(filePath);
    const now = new Date().toISOString();
    const existing =
      (input.id
        ? state.closedHistory.find((record) => record.id === input.id)
        : undefined) ??
      state.closedHistory.find(
        (record) =>
          record.ownerSessionId === input.ownerSessionId &&
          record.tabLabel === input.tabLabel,
      );

    const record: ClosedAgentHistoryRecord = {
      id: existing?.id ?? newHistoryId(),
      ownerSessionId: input.ownerSessionId,
      ...(input.ownerSessionFile
        ? { ownerSessionFile: input.ownerSessionFile }
        : {}),
      profileName: input.profileName,
      tabLabel: input.tabLabel,
      childSessionFile: input.childSessionFile,
      childSessionId: input.childSessionId,
      cwd: input.cwd,
      layout: input.layout,
      lifecycle: "oneshot",
      createdAt: existing?.createdAt ?? now,
      closedAt: now,
      status: "resumable",
      claimGeneration: existing?.claimGeneration ?? 0,
    };

    state.closedHistory = [
      record,
      ...state.closedHistory.filter((item) => item.id !== record.id),
    ];
    pruneClosedHistory(state);
    await saveHerdrAgentsState(state, filePath);
    return record;
  });
}

export async function stageClosedOneShot(
  input: ArchiveClosedOneShotInput & {
    livePane: Pick<PaneInfo, "terminal_id">;
  },
  filePath = getHerdrAgentsStatePath(),
): Promise<ClosedAgentHistoryRecord> {
  return withStateFileLock(filePath, async () => {
    throwIfInjectedMutation("stage");
    const state = await loadHerdrAgentsState(filePath);
    const key = paneStateKey(input.livePane);
    if (!key || !state.agents[key]) {
      throw new Error(
        "Cannot stage a closed one-shot: the live agent record is missing.",
      );
    }
    const now = new Date().toISOString();
    const existing =
      (input.id
        ? state.closedHistory.find((record) => record.id === input.id)
        : undefined) ??
      state.closedHistory.find(
        (record) =>
          record.ownerSessionId === input.ownerSessionId &&
          record.tabLabel === input.tabLabel,
      );

    const record: ClosedAgentHistoryRecord = {
      id: existing?.id ?? newHistoryId(),
      ownerSessionId: input.ownerSessionId,
      ...(input.ownerSessionFile
        ? { ownerSessionFile: input.ownerSessionFile }
        : {}),
      profileName: input.profileName,
      tabLabel: input.tabLabel,
      childSessionFile: input.childSessionFile,
      childSessionId: input.childSessionId,
      cwd: input.cwd,
      layout: input.layout,
      lifecycle: "oneshot",
      createdAt: existing?.createdAt ?? now,
      closedAt: now,
      status: "staged",
      claimGeneration: existing?.claimGeneration ?? 0,
    };

    state.closedHistory = [
      record,
      ...state.closedHistory.filter((item) => item.id !== record.id),
    ];
    const live = state.agents[key];
    if (live) {
      live.closedHistoryId = record.id;
      live.updatedAt = now;
    }
    await saveHerdrAgentsState(state, filePath);
    return record;
  });
}

export async function finalizeStagedClosedOneShot(
  input: {
    historyId: string;
    livePane?: Pick<PaneInfo, "terminal_id">;
  },
  filePath = getHerdrAgentsStatePath(),
): Promise<void> {
  await withStateFileLock(filePath, async () => {
    throwIfInjectedMutation("finalize");
    const state = await loadHerdrAgentsState(filePath);
    const record = state.closedHistory.find(
      (item) => item.id === input.historyId,
    );
    if (record && (record.status === "staged" || record.status === "claimed")) {
      record.status = "resumable";
      delete record.claimedAt;
      record.closedAt = new Date().toISOString();
    }
    if (input.livePane) {
      const key = paneStateKey(input.livePane);
      if (key) delete state.agents[key];
    }
    pruneClosedHistory(state);
    await saveHerdrAgentsState(state, filePath);
  });
}

export type ClaimClosedHistoryResult =
  { ok: true; record: ClosedAgentHistoryRecord } | { ok: false; error: string };

export async function claimClosedHistory(
  input: {
    ownerSessionId: string;
    tabLabel: string;
    profileName: string;
  },
  filePath = getHerdrAgentsStatePath(),
): Promise<ClaimClosedHistoryResult> {
  return withStateFileLock(filePath, async () => {
    const state = await loadHerdrAgentsState(filePath);
    reconcileHerdrAgentsState(state);
    const matches = state.closedHistory.filter(
      (record) =>
        record.ownerSessionId === input.ownerSessionId &&
        record.tabLabel === input.tabLabel,
    );
    if (matches.length === 0) {
      return {
        ok: false as const,
        error: `No closed one-shot Herdr agent named "${input.tabLabel}" is owned by this Orchestrator session.`,
      };
    }

    const claimed = matches.find((record) => record.status === "claimed");
    if (claimed) {
      return {
        ok: false as const,
        error: `Closed Herdr agent "${input.tabLabel}" is already being resumed.`,
      };
    }

    const newest = matches
      .filter((record) => record.status === "resumable")
      .toSorted((a, b) => historyRecency(b) - historyRecency(a))[0];
    if (!newest) {
      return {
        ok: false as const,
        error: `Closed Herdr agent "${input.tabLabel}" cannot be resumed in its current state.`,
      };
    }
    if (newest.profileName !== input.profileName) {
      return {
        ok: false as const,
        error: `Closed Herdr agent "${input.tabLabel}" was a ${newest.profileName} agent, not ${input.profileName}.`,
      };
    }
    if (newest.lifecycle !== "oneshot") {
      return {
        ok: false as const,
        error: `Closed Herdr agent "${input.tabLabel}" is not a resumable one-shot.`,
      };
    }
    const live = liveAgentForHistory(state, newest.id);
    if (live) {
      return {
        ok: false as const,
        error: `Closed Herdr agent "${input.tabLabel}" still has a live generation and cannot be resumed over it.`,
      };
    }

    newest.status = "claimed";
    newest.claimGeneration += 1;
    newest.claimedAt = new Date().toISOString();
    await saveHerdrAgentsState(state, filePath);
    return { ok: true as const, record: { ...newest } };
  });
}

export async function releaseClosedHistory(
  id: string,
  generation: number,
  filePath = getHerdrAgentsStatePath(),
): Promise<void> {
  await withStateFileLock(filePath, async () => {
    const state = await loadHerdrAgentsState(filePath);
    const record = state.closedHistory.find((item) => item.id === id);
    if (!record) return;
    if (record.status !== "claimed") return;
    if (record.claimGeneration !== generation) return;
    record.status = "resumable";
    delete record.claimedAt;
    await saveHerdrAgentsState(state, filePath);
  });
}

export async function markClosedHistoryInvalid(
  id: string,
  generation: number,
  filePath = getHerdrAgentsStatePath(),
): Promise<void> {
  await withStateFileLock(filePath, async () => {
    const state = await loadHerdrAgentsState(filePath);
    const record = state.closedHistory.find((item) => item.id === id);
    if (!record) return;
    if (record.claimGeneration !== generation) return;
    record.status = "invalid";
    delete record.claimedAt;
    await saveHerdrAgentsState(state, filePath);
  });
}

export function findOwnedClosedHistory(
  state: HerdrAgentsState,
  ownerSessionId: string,
  tabLabel: string,
): ClosedAgentHistoryRecord | undefined {
  return state.closedHistory
    .filter(
      (record) =>
        record.ownerSessionId === ownerSessionId &&
        record.tabLabel === tabLabel &&
        record.status !== "invalid" &&
        record.status !== "staged",
    )
    .toSorted((a, b) => historyRecency(b) - historyRecency(a))[0];
}
