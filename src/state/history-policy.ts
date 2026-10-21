import * as path from 'node:path';

import { Value } from 'typebox/value';

import { isSessionCost } from '../artifacts/schema.ts';
import {
  ClosedAgentHistoryRecordInput,
  type ClosedAgentHistoryRecord,
  type HerdrAgentStateRecord,
  type HerdrAgentsState,
} from './schema.ts';

export const CLOSED_HISTORY_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const CLOSED_HISTORY_MAX_PER_OWNER = 32;
export const CLOSED_HISTORY_MAX_GLOBAL = 256;
const DEFAULT_CLOSED_CLAIM_LEASE_MS = 60_000;
const CLAIM_LEASE_MS_ENV = 'PI_AGENTS_CLAIM_LEASE_MS';

function getClosedClaimLeaseMs(): number {
  return envMs(CLAIM_LEASE_MS_ENV, DEFAULT_CLOSED_CLAIM_LEASE_MS);
}

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function parseClosedHistory(raw: unknown): ClosedAgentHistoryRecord[] {
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
    const { createdAt, closedAt, claimGeneration, sessionCost, ...fields } =
      item;
    records.push({
      ...fields,
      // A genuine zero is a measurement; an unreadable cost stays unknown.
      ...(isSessionCost(sessionCost) ? { sessionCost } : {}),
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
