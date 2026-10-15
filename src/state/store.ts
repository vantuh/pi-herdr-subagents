import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { Value } from 'typebox/value';

import { readIfExists } from '../artifacts.ts';
import type { HerdrNamedAgent, PaneInfo } from '../herdr/schema.ts';
import { parseJson } from '../json.ts';
import {
  ClosedAgentHistoryRecordInput,
  HerdrAgentStateRecordInput,
  StateEnvelope,
  type ClosedAgentHistoryRecord,
  type HerdrAgentStateRecord,
  type HerdrAgentsState,
} from './schema.ts';

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

type StateMutationResult<T> = { save: boolean; value: T };

/**
 * One locked load-mutate-save cycle. `mutate` receives the loaded state and
 * returns the value to hand back plus whether anything changed.
 */
export async function mutateHerdrAgentsState<T>(
  filePath: string,
  options: { signal?: AbortSignal; inject?: StateMutationKind },
  mutate: (state: HerdrAgentsState) => StateMutationResult<T>,
): Promise<T> {
  return withStateFileLock(
    filePath,
    async () => {
      if (options.inject) throwIfInjectedMutation(options.inject);
      const state = await loadHerdrAgentsState(filePath);
      options.signal?.throwIfAborted();
      const { save, value } = mutate(state);
      if (save) await saveHerdrAgentsState(state, filePath);
      return value;
    },
    options.signal,
  );
}

/** A record stamped by a different Herdr server is not this Orchestrator's. */
function isForeignServerRecord(
  record: Pick<HerdrAgentStateRecord, 'serverSocketPath'>,
  serverSocketPath = process.env.HERDR_SOCKET_PATH,
): boolean {
  return (
    !!record.serverSocketPath && record.serverSocketPath !== serverSocketPath
  );
}

/** A live Pi agent whose Herdr automation name matches this record. */
export function liveAgentWithAutomationName(
  record: Pick<HerdrAgentStateRecord, 'automationName'>,
  agents: readonly HerdrNamedAgent[],
): HerdrNamedAgent | undefined {
  if (!record.automationName) return undefined;
  return agents.find(
    (agent) => agent.name === record.automationName && agent.agent === 'pi',
  );
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

  const parsed = parseJson(StateEnvelope, raw);
  if (!parsed) {
    await quarantineStateFile(filePath, 'json');
    return emptyHerdrAgentsState();
  }

  if (!isExactStateVersion(parsed.version)) {
    await quarantineStateFile(filePath, parsed.version);
    return emptyHerdrAgentsState();
  }

  const state = emptyHerdrAgentsState();
  if (parsed.agents) {
    copyAgentRecords(state, parsed.agents);
  }
  state.closedHistory = parseClosedHistory(parsed.closedHistory);
  reconcileHerdrAgentsState(state);
  pruneClosedHistory(state);
  return state;
}

function isExactStateVersion(version: unknown): version is 1 | 2 {
  return version === 1 || version === 2;
}

function copyAgentRecords(
  state: HerdrAgentsState,
  agents: Record<string, unknown>,
): void {
  for (const [key, record] of Object.entries(agents)) {
    if (!Value.Check(HerdrAgentStateRecordInput, record)) continue;
    const { updatedAt, ...fields } = record;
    state.agents[key] = {
      ...fields,
      updatedAt: updatedAt ?? new Date(0).toISOString(),
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
    if (isForeignServerRecord(record, serverSocketPath)) continue;
    if (liveKeys.has(key)) continue;
    const named = liveAgentWithAutomationName(record, agents);
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
  snapshot: { panes: PaneInfo[]; agents?: readonly HerdrNamedAgent[] },
  options: {
    filePath?: string;
    serverSocketPath?: string;
    signal?: AbortSignal;
  } = {},
): Promise<HerdrAgentsState> {
  const filePath = options.filePath ?? getHerdrAgentsStatePath();
  const serverSocketPath =
    options.serverSocketPath ?? process.env.HERDR_SOCKET_PATH;
  return mutateHerdrAgentsState(
    filePath,
    { signal: options.signal },
    (state) => ({
      save: pruneHerdrAgentsState(
        state,
        snapshot.panes,
        serverSocketPath,
        snapshot.agents,
      ),
      value: state,
    }),
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
  if (isForeignServerRecord(record)) return false;
  if (record.ownerTerminalId) {
    return !!ownerTerminalId && record.ownerTerminalId === ownerTerminalId;
  }
  if (record.layout === 'tab') return true;
  return paneTabId === currentTab;
}

type AgentLifecycleMetadata = Partial<
  Omit<
    HerdrAgentStateRecord,
    'lifecycle' | 'paneId' | 'collected' | 'updatedAt'
  >
>;

/** Live-record fields a continued agent carries over when metadata omits them. */
const CARRIED_LIFECYCLE_FIELDS = [
  'ownerPaneId',
  'ownerTerminalId',
  'ownerSessionId',
  'ownerSessionFile',
  'closedHistoryId',
  'closedHistoryGeneration',
] as const satisfies ReadonlyArray<keyof AgentLifecycleMetadata>;

function carriedLifecycleFields(
  existing: HerdrAgentStateRecord | undefined,
  metadata: AgentLifecycleMetadata,
): AgentLifecycleMetadata {
  if (!existing) return {};
  return Object.fromEntries(
    CARRIED_LIFECYCLE_FIELDS.filter(
      (field) => metadata[field] === undefined && existing[field] !== undefined,
    ).map((field) => [field, existing[field]]),
  ) as AgentLifecycleMetadata;
}

export async function recordAgentLifecycle(
  pane: Pick<PaneInfo, 'pane_id' | 'terminal_id'>,
  metadata: AgentLifecycleMetadata = {},
  filePath = getHerdrAgentsStatePath(),
): Promise<void> {
  const key = paneStateKey(pane);
  if (!key) return;

  await mutateHerdrAgentsState(filePath, { inject: 'lifecycle' }, (state) => {
    const existing = state.agents[key];
    if (existing && existing.lifecycle !== 'oneshot') {
      return { save: false, value: undefined };
    }
    const serverSocketPath =
      metadata.serverSocketPath ??
      process.env.HERDR_SOCKET_PATH ??
      existing?.serverSocketPath;
    state.agents[key] = {
      lifecycle: 'oneshot',
      paneId: pane.pane_id,
      ...metadata,
      ...carriedLifecycleFields(existing, metadata),
      ...(serverSocketPath ? { serverSocketPath } : {}),
      updatedAt: new Date().toISOString(),
    };
    return { save: true, value: undefined };
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

  await mutateHerdrAgentsState(filePath, { signal }, (state) => {
    const record = state.agents[key];
    if (!record?.spawnWarnings?.length) {
      return { save: false, value: undefined };
    }
    const { spawnWarnings: _dropped, ...rest } = record;
    state.agents[key] = rest;
    return { save: true, value: undefined };
  });
}

export async function deleteAgentLifecycle(
  pane: Pick<PaneInfo, 'terminal_id'>,
  filePath = getHerdrAgentsStatePath(),
  signal?: AbortSignal,
): Promise<void> {
  const key = paneStateKey(pane);
  if (!key) return;

  await mutateHerdrAgentsState(filePath, { signal }, (state) => {
    if (!state.agents[key]) return { save: false, value: undefined };
    delete state.agents[key];
    return { save: true, value: undefined };
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

  return mutateHerdrAgentsState(
    filePath,
    { signal, inject: 'detached' },
    (state) => {
      const record = state.agents[key];
      if (
        record?.lifecycle !== 'oneshot' ||
        record.collected ||
        !record.detached ||
        isForeignServerRecord(record)
      ) {
        return { save: false, value: false };
      }
      delete record.detached;
      record.collected = true;
      return { save: true, value: true };
    },
  );
}

function parseClosedHistory(raw: unknown): ClosedAgentHistoryRecord[] {
  if (!Array.isArray(raw)) return [];
  const records: ClosedAgentHistoryRecord[] = [];
  for (const item of raw) {
    if (!Value.Check(ClosedAgentHistoryRecordInput, item)) continue;
    if (
      !item.id ||
      !item.ownerSessionId ||
      !item.profileName ||
      !item.tabLabel ||
      !item.childSessionId ||
      !item.cwd
    ) {
      continue;
    }
    if (!path.isAbsolute(item.childSessionFile)) continue;
    const { createdAt, closedAt, claimGeneration, ...fields } = item;
    records.push({
      ...fields,
      createdAt: createdAt ?? new Date(0).toISOString(),
      closedAt: closedAt ?? new Date(0).toISOString(),
      claimGeneration: claimGeneration ?? 0,
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

function isPinned(record: ClosedAgentHistoryRecord): boolean {
  return record.status === 'claimed' || record.status === 'staged';
}

/** Keeps every pinned record plus the newest unpinned ones up to `max`. */
function capKeepingPinned(
  records: ClosedAgentHistoryRecord[],
  max: number,
): ClosedAgentHistoryRecord[] {
  const sorted = records.toSorted(
    (a, b) => historyRecency(b) - historyRecency(a),
  );
  const pinned = sorted.filter(isPinned);
  const rest = sorted.filter((record) => !isPinned(record));
  return [...pinned, ...rest.slice(0, Math.max(0, max - pinned.length))];
}

export function pruneClosedHistory(
  state: HerdrAgentsState,
  now = Date.now(),
): boolean {
  const before = state.closedHistory;
  const cutoff = now - CLOSED_HISTORY_TTL_MS;
  const fresh = before.filter(
    (record) => isPinned(record) || historyRecency(record) >= cutoff,
  );

  const byOwner = new Map<string, ClosedAgentHistoryRecord[]>();
  for (const record of fresh) {
    const list = byOwner.get(record.ownerSessionId) ?? [];
    list.push(record);
    byOwner.set(record.ownerSessionId, list);
  }
  const kept = [...byOwner.values()].flatMap((list) =>
    capKeepingPinned(list, CLOSED_HISTORY_MAX_PER_OWNER),
  );
  const next = capKeepingPinned(kept, CLOSED_HISTORY_MAX_GLOBAL);

  if (
    next.length === before.length &&
    next.every((record, index) => record.id === before[index]?.id)
  ) {
    return false;
  }
  state.closedHistory = next;
  return true;
}
