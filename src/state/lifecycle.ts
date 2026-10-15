import type { PaneInfo } from '../herdr/schema.ts';
import { isForeignServerRecord, paneStateKey } from './live-records.ts';
import type { HerdrAgentStateRecord } from './schema.ts';
import { getHerdrAgentsStatePath, mutateHerdrAgentsState } from './store.ts';

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
