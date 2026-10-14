import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { readIfExists } from '../artifacts.ts';
import {
  isHerdrAgentLayout,
  type HerdrAgentLayout,
  type HerdrNamedAgent,
  type PaneInfo,
} from '../types.ts';

export interface HerdrAgentStateRecord {
  lifecycle: 'oneshot' | 'persistent';
  serverSocketPath?: string;
  paneId?: string;
  ownerPaneId?: string;
  tabLabel?: string;
  agent?: string;
  automationName?: string;
  resultFile?: string;
  layout?: HerdrAgentLayout;
  /** Spawn-time profile values Pi ignored; retained until the outcome is delivered. */
  spawnWarnings?: string[];
  /**
   * Pending collection. Lives in the state file rather than memory so a
   * pending delivery survives `/reload`.
   */
  detached?: boolean;
  /** A committed outcome claim; a new task's lifecycle record clears it. */
  collected?: boolean;
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

type ClosedHistoryStatus = 'resumable' | 'claimed' | 'invalid' | 'staged';

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
  lifecycle: 'oneshot';
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
const DEFAULT_STATE_LOCK_WAIT_MS = 60_000;
const DEFAULT_CLOSED_CLAIM_LEASE_MS = 60_000;

const STATE_PATH_ENV = 'HERDR_AGENTS_STATE_PATH';
const STATE_LOCK_WAIT_MS_ENV = 'HERDR_AGENTS_LOCK_WAIT_MS';
const CLAIM_LEASE_MS_ENV = 'HERDR_AGENTS_CLAIM_LEASE_MS';

type StateMutationKind = 'lifecycle' | 'stage' | 'finalize' | 'detached';

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

export function throwIfInjectedMutation(kind: StateMutationKind): void {
  if (failNextMutations[kind] <= 0) return;
  failNextMutations[kind] -= 1;
  throw new Error(`injected ${kind} state save failure`);
}

function getStateLockWaitMs(): number {
  return envMs(STATE_LOCK_WAIT_MS_ENV, DEFAULT_STATE_LOCK_WAIT_MS);
}

function getClosedClaimLeaseMs(): number {
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

async function releaseLock(
  lockDir: string,
  sentinelPath: string,
): Promise<void> {
  await fs.unlink(sentinelPath).catch(() => {});
  await fs.rmdir(lockDir).catch(() => {});
}

async function tryAcquireExclusiveLock(
  lockPath: string,
  token: string,
): Promise<(() => Promise<void>) | 'locked'> {
  try {
    await fs.mkdir(lockPath);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'EEXIST' || code === 'ENOTDIR') return 'locked';
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
      { flag: 'wx', encoding: 'utf8' },
    );
  } catch (error) {
    await releaseLock(lockPath, sentinelPath);
    throw error;
  }

  return async () => {
    await releaseLock(lockPath, sentinelPath);
  };
}

async function acquireExclusiveLock(
  lockPath: string,
  signal?: AbortSignal,
): Promise<() => Promise<void>> {
  const token = randomBytes(16).toString('hex');
  const deadline = Date.now() + getStateLockWaitMs();
  while (true) {
    signal?.throwIfAborted();
    const acquired = await tryAcquireExclusiveLock(lockPath, token);
    if (acquired !== 'locked') return acquired;

    if (Date.now() >= deadline) {
      const retried = await tryAcquireExclusiveLock(lockPath, token);
      if (retried !== 'locked') return retried;
      throw new Error(
        `Timed out waiting for ${lockPath}. Another process still holds this exclusive lock directory (or a legacy lock file occupies that path); do not delete it while that process may be alive. If you are sure no Pi/herdr-agents process is running, remove the lock directory (or leftover lock file) manually and retry.`,
      );
    }
    await sleep(15, undefined, { signal });
  }
}

export async function withStateFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const previous = stateFileQueues.get(filePath) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  stateFileQueues.set(
    filePath,
    previous.then(() => current),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(signal?.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      previous
        .then(() => resolve(), reject)
        .finally(() => signal?.removeEventListener('abort', onAbort));
      if (signal?.aborted) onAbort();
    });
    signal?.throwIfAborted();
    const release = await acquireExclusiveLock(`${filePath}.lock`, signal);
    try {
      signal?.throwIfAborted();
      return await fn();
    } finally {
      await release();
    }
  } finally {
    releaseQueue();
  }
}

export function getHerdrAgentsStatePath(): string {
  return (
    process.env[STATE_PATH_ENV] ??
    path.join(os.homedir(), '.pi', 'agent', 'herdr-agents-state.json')
  );
}

export function emptyHerdrAgentsState(): HerdrAgentsState {
  return { version: 2, agents: {}, closedHistory: [] };
}

function isLifecycle(
  value: unknown,
): value is HerdrAgentStateRecord['lifecycle'] {
  return value === 'oneshot' || value === 'persistent';
}

// Terminal identity survives pane moves; live handoff rekeys it from verified
// automation names and the recorded child/owner panes before pruning.
export function paneStateKey(
  pane: Pick<PaneInfo, 'terminal_id'>,
): string | undefined {
  return pane.terminal_id ? `terminal:${pane.terminal_id}` : undefined;
}

export async function loadHerdrAgentsState(
  filePath = getHerdrAgentsStatePath(),
): Promise<HerdrAgentsState> {
  const raw = await readIfExists(filePath);
  if (raw === undefined) return emptyHerdrAgentsState();

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
    await quarantineStateFile(filePath, 'json');
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
  if (!parsed.agents || typeof parsed.agents !== 'object') {
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
  if (agents && typeof agents === 'object') {
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
    if (!record || typeof record !== 'object') continue;
    if (!isLifecycle(record.lifecycle)) continue;

    state.agents[key] = {
      lifecycle: record.lifecycle,
      ...(typeof record.serverSocketPath === 'string'
        ? { serverSocketPath: record.serverSocketPath }
        : {}),
      ...(typeof record.paneId === 'string' ? { paneId: record.paneId } : {}),
      ...(typeof record.ownerPaneId === 'string'
        ? { ownerPaneId: record.ownerPaneId }
        : {}),
      ...(typeof record.tabLabel === 'string'
        ? { tabLabel: record.tabLabel }
        : {}),
      ...(typeof record.agent === 'string' ? { agent: record.agent } : {}),
      ...(typeof record.automationName === 'string'
        ? { automationName: record.automationName }
        : {}),
      ...(typeof record.resultFile === 'string'
        ? { resultFile: record.resultFile }
        : {}),
      ...(isHerdrAgentLayout(record.layout) ? { layout: record.layout } : {}),
      ...(Array.isArray(record.spawnWarnings)
        ? {
            spawnWarnings: record.spawnWarnings.filter(
              (warning): warning is string => typeof warning === 'string',
            ),
          }
        : {}),
      ...(record.detached === true ? { detached: true } : {}),
      ...(record.collected === true ? { collected: true } : {}),
      ...(typeof record.ownerTerminalId === 'string'
        ? { ownerTerminalId: record.ownerTerminalId }
        : {}),
      ...(typeof record.ownerSessionId === 'string'
        ? { ownerSessionId: record.ownerSessionId }
        : {}),
      ...(typeof record.ownerSessionFile === 'string'
        ? { ownerSessionFile: record.ownerSessionFile }
        : {}),
      ...(typeof record.closedHistoryId === 'string'
        ? { closedHistoryId: record.closedHistoryId }
        : {}),
      ...(typeof record.closedHistoryGeneration === 'number' &&
      Number.isFinite(record.closedHistoryGeneration)
        ? { closedHistoryGeneration: record.closedHistoryGeneration }
        : {}),
      updatedAt:
        typeof record.updatedAt === 'string'
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
      ? 'missing'
      : typeof version === 'number' || typeof version === 'string'
        ? String(version)
        : 'malformed';
  let dest = `${filePath}.quarantine.v${suffix}`;
  try {
    await fs.rename(filePath, dest);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT') return;
    if (code === 'EEXIST') {
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
    throw new Error('injected state save failure');
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fs.rename(tempPath, filePath);
}

export function pruneHerdrAgentsState(
  state: HerdrAgentsState,
  panes: PaneInfo[],
  serverSocketPath = process.env.HERDR_SOCKET_PATH,
  agents: readonly HerdrNamedAgent[] = [],
): boolean {
  const liveKeys = new Set(
    panes
      .map((pane) => paneStateKey(pane))
      .filter((key): key is string => !!key),
  );

  let changed = false;
  for (const [key, record] of Object.entries(state.agents)) {
    // Legacy records retain snapshot-based pruning until restamped.
    if (record.serverSocketPath && record.serverSocketPath !== serverSocketPath)
      continue;
    if (liveKeys.has(key)) continue;
    const named = record.automationName
      ? agents.find(
          (agent) =>
            agent.name === record.automationName && agent.agent === 'pi',
        )
      : undefined;
    if (
      named &&
      record.lifecycle === 'oneshot' &&
      record.serverSocketPath &&
      record.serverSocketPath === serverSocketPath
    ) {
      const owner = panes.find((pane) => pane.pane_id === record.ownerPaneId);
      const child = panes.find(
        (pane) =>
          pane.pane_id === named.pane_id &&
          pane.terminal_id === named.terminal_id,
      );
      const nextKey = child ? paneStateKey(child) : undefined;
      if (
        record.paneId === named.pane_id &&
        record.ownerSessionId &&
        owner?.terminal_id &&
        nextKey &&
        !state.agents[nextKey]
      ) {
        state.agents[nextKey] = {
          ...record,
          ownerTerminalId: owner.terminal_id,
        };
        delete state.agents[key];
        changed = true;
      }
      // A known live name with incomplete identity is not evidence of disappearance.
      continue;
    }
    delete state.agents[key];
    changed = true;
  }

  if (reconcileHerdrAgentsState(state)) changed = true;

  return changed;
}

/** Reconcile handoff identities before pruning and finalizing staged history. */
export async function persistPrunedAgentsState(
  panes: PaneInfo[],
  filePath = getHerdrAgentsStatePath(),
  serverSocketPath = process.env.HERDR_SOCKET_PATH,
  signal?: AbortSignal,
  agents: readonly HerdrNamedAgent[] = [],
): Promise<HerdrAgentsState> {
  return withStateFileLock(
    filePath,
    async () => {
      const state = await loadHerdrAgentsState(filePath);
      signal?.throwIfAborted();
      if (pruneHerdrAgentsState(state, panes, serverSocketPath, agents)) {
        await saveHerdrAgentsState(state, filePath);
      }
      return state;
    },
    signal,
  );
}

/**
 * Whether this Orchestrator should list, reuse, or collect the record.
 *
 * Historical persistent records stay stored but are not actionable.
 * Stamped records require the owner's terminal. Ownerless pane records
 * stay local to the current tab; workspace records require a stamped owner.
 */
export function isAgentOwnedBy(
  record: HerdrAgentStateRecord,
  ownerTerminalId: string | undefined,
  paneTabId: string,
  currentTab: string,
): record is HerdrAgentStateRecord & { lifecycle: 'oneshot' } {
  if (record.lifecycle !== 'oneshot') return false;
  if (
    record.serverSocketPath &&
    record.serverSocketPath !== process.env.HERDR_SOCKET_PATH
  )
    return false;
  if (record.ownerTerminalId) {
    return !!ownerTerminalId && record.ownerTerminalId === ownerTerminalId;
  }
  if (record.layout === 'tab') return true;
  return paneTabId === currentTab;
}

export async function recordAgentLifecycle(
  pane: PaneInfo,
  metadata: {
    serverSocketPath?: string;
    ownerPaneId?: string;
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
    throwIfInjectedMutation('lifecycle');
    const state = await loadHerdrAgentsState(filePath);
    const existing = state.agents[key];
    if (existing && existing.lifecycle !== 'oneshot') return;
    const serverSocketPath =
      metadata.serverSocketPath ??
      process.env.HERDR_SOCKET_PATH ??
      existing?.serverSocketPath;
    state.agents[key] = {
      lifecycle: 'oneshot',
      paneId: pane.pane_id,
      ...metadata,
      ...(!metadata.ownerPaneId && existing?.ownerPaneId
        ? { ownerPaneId: existing.ownerPaneId }
        : {}),
      ...(serverSocketPath ? { serverSocketPath } : {}),
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
 * Spawn warnings belong on the first delivery only. A reused task rewrites
 * the record without them; this drops them after a successful delivery so
 * they are not reprinted.
 */
export async function clearAgentSpawnWarnings(
  pane: Pick<PaneInfo, 'terminal_id'>,
  filePath = getHerdrAgentsStatePath(),
  signal?: AbortSignal,
): Promise<void> {
  const key = paneStateKey(pane);
  if (!key) return;

  await withStateFileLock(
    filePath,
    async () => {
      const state = await loadHerdrAgentsState(filePath);
      signal?.throwIfAborted();
      const record = state.agents[key];
      if (!record?.spawnWarnings?.length) return;
      const { spawnWarnings: _dropped, ...rest } = record;
      state.agents[key] = rest;
      await saveHerdrAgentsState(state, filePath);
    },
    signal,
  );
}

export async function deleteAgentLifecycle(
  pane: Pick<PaneInfo, 'terminal_id'>,
  filePath = getHerdrAgentsStatePath(),
  signal?: AbortSignal,
): Promise<void> {
  const key = paneStateKey(pane);
  if (!key) return;

  await withStateFileLock(
    filePath,
    async () => {
      const state = await loadHerdrAgentsState(filePath);
      signal?.throwIfAborted();
      if (!state.agents[key]) return;
      delete state.agents[key];
      await saveHerdrAgentsState(state, filePath);
    },
    signal,
  );
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
 * rather than risking a duplicate — the result artifact still exists.
 */
export function claimDetachedAgent(
  pane: Pick<PaneInfo, 'terminal_id'>,
  filePath = getHerdrAgentsStatePath(),
  signal?: AbortSignal,
): Promise<boolean> {
  return claimCollection(pane, filePath, signal);
}

async function claimCollection(
  pane: Pick<PaneInfo, 'terminal_id'>,
  filePath = getHerdrAgentsStatePath(),
  signal?: AbortSignal,
): Promise<boolean> {
  const key = paneStateKey(pane);
  if (!key) return false;

  return withStateFileLock(
    filePath,
    async () => {
      throwIfInjectedMutation('detached');
      const state = await loadHerdrAgentsState(filePath);
      signal?.throwIfAborted();
      const record = state.agents[key];
      if (
        record?.lifecycle !== 'oneshot' ||
        record.collected ||
        !record.detached
      )
        return false;
      if (
        record.serverSocketPath &&
        record.serverSocketPath !== process.env.HERDR_SOCKET_PATH
      )
        return false;
      delete record.detached;
      record.collected = true;
      await saveHerdrAgentsState(state, filePath);
      return true;
    },
    signal,
  );
}

function isClosedHistoryStatus(value: unknown): value is ClosedHistoryStatus {
  return (
    value === 'resumable' ||
    value === 'claimed' ||
    value === 'invalid' ||
    value === 'staged'
  );
}

function parseClosedHistory(raw: unknown): ClosedAgentHistoryRecord[] {
  if (!Array.isArray(raw)) return [];
  const records: ClosedAgentHistoryRecord[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Partial<ClosedAgentHistoryRecord>;
    if (typeof record.id !== 'string' || !record.id) continue;
    if (typeof record.ownerSessionId !== 'string' || !record.ownerSessionId) {
      continue;
    }
    if (typeof record.profileName !== 'string' || !record.profileName) continue;
    if (typeof record.tabLabel !== 'string' || !record.tabLabel) continue;
    if (typeof record.childSessionFile !== 'string') continue;
    if (!path.isAbsolute(record.childSessionFile)) continue;
    if (typeof record.childSessionId !== 'string' || !record.childSessionId) {
      continue;
    }
    if (typeof record.cwd !== 'string' || !record.cwd) continue;
    if (!isHerdrAgentLayout(record.layout)) continue;
    if (record.lifecycle !== 'oneshot') continue;
    if (!isClosedHistoryStatus(record.status)) continue;
    const claimGeneration =
      typeof record.claimGeneration === 'number' &&
      Number.isFinite(record.claimGeneration)
        ? record.claimGeneration
        : 0;
    records.push({
      id: record.id,
      ownerSessionId: record.ownerSessionId,
      ...(typeof record.ownerSessionFile === 'string'
        ? { ownerSessionFile: record.ownerSessionFile }
        : {}),
      profileName: record.profileName,
      tabLabel: record.tabLabel,
      childSessionFile: record.childSessionFile,
      childSessionId: record.childSessionId,
      cwd: record.cwd,
      layout: record.layout,
      lifecycle: 'oneshot',
      createdAt:
        typeof record.createdAt === 'string'
          ? record.createdAt
          : new Date(0).toISOString(),
      closedAt:
        typeof record.closedAt === 'string'
          ? record.closedAt
          : new Date(0).toISOString(),
      status: record.status,
      claimGeneration,
      ...(typeof record.claimedAt === 'string'
        ? { claimedAt: record.claimedAt }
        : {}),
    });
  }
  return records;
}

export function historyRecency(record: ClosedAgentHistoryRecord): number {
  const closed = Date.parse(record.closedAt);
  return Number.isFinite(closed) ? closed : 0;
}

export function liveAgentForHistory(
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
    if (record.status === 'staged') {
      if (!live) {
        record.status = 'resumable';
        delete record.claimedAt;
        changed = true;
      }
      continue;
    }
    if (record.status !== 'claimed') continue;
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
      record.status = 'resumable';
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
    if (record.status === 'claimed' || record.status === 'staged') return true;
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
      (record) => record.status === 'claimed' || record.status === 'staged',
    );
    const rest = sorted.filter(
      (record) => record.status !== 'claimed' && record.status !== 'staged',
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
    (record) => record.status === 'claimed' || record.status === 'staged',
  );
  const rest = next.filter(
    (record) => record.status !== 'claimed' && record.status !== 'staged',
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
