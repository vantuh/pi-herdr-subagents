import { randomBytes } from 'node:crypto';

import type { HerdrAgentLayout, PaneInfo } from '../types.ts';
import {
  getHerdrAgentsStatePath,
  historyRecency,
  liveAgentForHistory,
  loadHerdrAgentsState,
  paneStateKey,
  pruneClosedHistory,
  reconcileHerdrAgentsState,
  saveHerdrAgentsState,
  throwIfInjectedMutation,
  withStateFileLock,
  type ClosedAgentHistoryRecord,
  type HerdrAgentsState,
} from './store.ts';

function newHistoryId(): string {
  return `ch_${randomBytes(8).toString('hex')}`;
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
      lifecycle: 'oneshot',
      createdAt: existing?.createdAt ?? now,
      closedAt: now,
      status: 'resumable',
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
    livePane: Pick<PaneInfo, 'terminal_id'>;
  },
  filePath = getHerdrAgentsStatePath(),
  signal?: AbortSignal,
): Promise<ClosedAgentHistoryRecord> {
  return withStateFileLock(
    filePath,
    async () => {
      throwIfInjectedMutation('stage');
      const state = await loadHerdrAgentsState(filePath);
      signal?.throwIfAborted();
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
    },
    signal,
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
  await withStateFileLock(
    filePath,
    async () => {
      throwIfInjectedMutation('finalize');
      const state = await loadHerdrAgentsState(filePath);
      signal?.throwIfAborted();
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
      await saveHerdrAgentsState(state, filePath);
    },
    signal,
  );
}

export type ClaimClosedHistoryResult =
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

    const claimed = matches.find((record) => record.status === 'claimed');
    if (claimed) {
      return {
        ok: false as const,
        error: `Closed Herdr agent "${input.tabLabel}" is already being resumed.`,
      };
    }

    const newest = matches
      .filter((record) => record.status === 'resumable')
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
    if (newest.lifecycle !== 'oneshot') {
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

    newest.status = 'claimed';
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
    if (record.status !== 'claimed') return;
    if (record.claimGeneration !== generation) return;
    record.status = 'resumable';
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
    record.status = 'invalid';
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
        record.status !== 'invalid' &&
        record.status !== 'staged',
    )
    .toSorted((a, b) => historyRecency(b) - historyRecency(a))[0];
}
