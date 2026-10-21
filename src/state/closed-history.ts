import { randomBytes } from 'node:crypto';

import type { PaneInfo } from '../herdr/schema.ts';
import {
  historyRecency,
  liveAgentForHistory,
  pruneClosedHistory,
  reconcileHerdrAgentsState,
} from './history-policy.ts';
import { paneStateKey } from './live-records.ts';
import type { ClosedAgentHistoryRecord, HerdrAgentsState } from './schema.ts';
import { getHerdrAgentsStatePath, mutateHerdrAgentsState } from './store.ts';

function newHistoryId(): string {
  return `ch_${randomBytes(8).toString('hex')}`;
}

type StageClosedOneShotInput = Pick<
  ClosedAgentHistoryRecord,
  | 'ownerSessionId'
  | 'ownerSessionFile'
  | 'profileName'
  | 'tabLabel'
  | 'childSessionFile'
  | 'childSessionId'
  | 'cwd'
  | 'layout'
  | 'sessionCost'
> & { id?: string };

export async function stageClosedOneShot(
  input: StageClosedOneShotInput & {
    livePane: Pick<PaneInfo, 'terminal_id'>;
  },
  filePath = getHerdrAgentsStatePath(),
  signal?: AbortSignal,
): Promise<ClosedAgentHistoryRecord> {
  return mutateHerdrAgentsState(
    filePath,
    { signal, inject: 'stage' },
    (state) => {
      const key = paneStateKey(input.livePane);
      if (!key || !state.agents[key]) {
        throw new Error(
          'Cannot stage a closed one-shot: the live agent record is missing.',
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

      // The child republishes a cumulative total, so a fresh sample replaces
      // the frozen one. Only the same child session may fall back to it: a
      // reused label with a new session must not inherit another run's cost.
      const priorCost =
        existing?.childSessionId === input.childSessionId
          ? existing.sessionCost
          : undefined;
      const sessionCost = input.sessionCost ?? priorCost;

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
        lifecycle: 'oneshot',
        createdAt: existing?.createdAt ?? now,
        closedAt: now,
        status: 'staged',
        claimGeneration: existing?.claimGeneration ?? 0,
        ...(sessionCost !== undefined ? { sessionCost } : {}),
      };

      state.closedHistory = [
        record,
        ...state.closedHistory.filter((item) => item.id !== record.id),
      ];
      const live = state.agents[key];
      live.closedHistoryId = record.id;
      live.updatedAt = now;
      return { save: true, value: record };
    },
  );
}

export async function finalizeStagedClosedOneShot(
  input: {
    historyId: string;
    livePane?: Pick<PaneInfo, 'terminal_id'>;
  },
  filePath = getHerdrAgentsStatePath(),
  signal?: AbortSignal,
): Promise<void> {
  await mutateHerdrAgentsState(
    filePath,
    { signal, inject: 'finalize' },
    (state) => {
      const record = state.closedHistory.find(
        (item) => item.id === input.historyId,
      );
      if (
        record &&
        (record.status === 'staged' || record.status === 'claimed')
      ) {
        record.status = 'resumable';
        delete record.claimedAt;
        record.closedAt = new Date().toISOString();
      }
      if (input.livePane) {
        const key = paneStateKey(input.livePane);
        if (key) delete state.agents[key];
      }
      pruneClosedHistory(state);
      return { save: true, value: undefined };
    },
  );
}

type ClaimClosedHistoryResult =
  | { ok: true; record: ClosedAgentHistoryRecord }
  | { ok: false; error: string };

export async function claimClosedHistory(
  input: {
    ownerSessionId: string;
    tabLabel: string;
    profileName: string;
  },
  filePath = getHerdrAgentsStatePath(),
): Promise<ClaimClosedHistoryResult> {
  return mutateHerdrAgentsState<ClaimClosedHistoryResult>(
    filePath,
    {},
    (state) => {
      reconcileHerdrAgentsState(state);
      const matches = state.closedHistory.filter(
        (record) =>
          record.ownerSessionId === input.ownerSessionId &&
          record.tabLabel === input.tabLabel,
      );
      if (matches.length === 0) {
        return {
          save: false,
          value: {
            ok: false as const,
            error: `No closed one-shot agent named "${input.tabLabel}" is owned by this Orchestrator session.`,
          },
        };
      }

      const claimed = matches.find((record) => record.status === 'claimed');
      if (claimed) {
        return {
          save: false,
          value: {
            ok: false as const,
            error: `Closed agent "${input.tabLabel}" is already being resumed.`,
          },
        };
      }

      const newest = matches
        .filter((record) => record.status === 'resumable')
        .toSorted((a, b) => historyRecency(b) - historyRecency(a))[0];
      if (!newest) {
        return {
          save: false,
          value: {
            ok: false as const,
            error: `Closed agent "${input.tabLabel}" cannot be resumed in its current state.`,
          },
        };
      }
      if (newest.profileName !== input.profileName) {
        return {
          save: false,
          value: {
            ok: false as const,
            error: `Closed agent "${input.tabLabel}" was a ${newest.profileName} agent, not ${input.profileName}.`,
          },
        };
      }
      if (newest.lifecycle !== 'oneshot') {
        return {
          save: false,
          value: {
            ok: false as const,
            error: `Closed agent "${input.tabLabel}" is not a resumable one-shot.`,
          },
        };
      }
      const live = liveAgentForHistory(state, newest.id);
      if (live) {
        return {
          save: false,
          value: {
            ok: false as const,
            error: `Closed agent "${input.tabLabel}" still has a live generation and cannot be resumed over it.`,
          },
        };
      }

      newest.status = 'claimed';
      newest.claimGeneration += 1;
      newest.claimedAt = new Date().toISOString();
      return {
        save: true,
        value: { ok: true as const, record: { ...newest } },
      };
    },
  );
}

export async function releaseClosedHistory(
  id: string,
  generation: number,
  filePath = getHerdrAgentsStatePath(),
): Promise<void> {
  await mutateHerdrAgentsState(filePath, {}, (state) => {
    const record = state.closedHistory.find((item) => item.id === id);
    if (
      !record ||
      record.status !== 'claimed' ||
      record.claimGeneration !== generation
    ) {
      return { save: false, value: undefined };
    }
    record.status = 'resumable';
    delete record.claimedAt;
    return { save: true, value: undefined };
  });
}

export async function markClosedHistoryInvalid(
  id: string,
  generation: number,
  filePath = getHerdrAgentsStatePath(),
): Promise<void> {
  await mutateHerdrAgentsState(filePath, {}, (state) => {
    const record = state.closedHistory.find((item) => item.id === id);
    if (!record || record.claimGeneration !== generation) {
      return { save: false, value: undefined };
    }
    record.status = 'invalid';
    delete record.claimedAt;
    return { save: true, value: undefined };
  });
}

/** Closed one-shots of this owner that can be reopened now, newest first. */
export function listOwnedResumableHistory(
  state: HerdrAgentsState,
  ownerSessionId: string,
): ClosedAgentHistoryRecord[] {
  return state.closedHistory
    .filter(
      (record) =>
        record.ownerSessionId === ownerSessionId &&
        record.status === 'resumable' &&
        !liveAgentForHistory(state, record.id),
    )
    .toSorted((a, b) => historyRecency(b) - historyRecency(a));
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
        record.status !== 'invalid' &&
        record.status !== 'staged',
    )
    .toSorted((a, b) => historyRecency(b) - historyRecency(a))[0];
}
