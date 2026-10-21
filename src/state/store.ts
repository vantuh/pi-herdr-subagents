import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Value } from 'typebox/value';

import { readIfExists } from '../artifacts.ts';
import type { HerdrNamedAgent, PaneInfo } from '../herdr/schema.ts';
import { parseJson } from '../json.ts';
import {
  parseClosedHistory,
  pruneClosedHistory,
  reconcileHerdrAgentsState,
} from './history-policy.ts';
import { pruneHerdrAgentsState } from './live-records.ts';
import { withStateFileLock } from './lock.ts';
import {
  HerdrAgentStateRecordInput,
  StateEnvelope,
  type HerdrAgentsState,
} from './schema.ts';

const STATE_PATH_ENV = 'PI_AGENTS_STATE_PATH';

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

export function getHerdrAgentsStatePath(): string {
  return (
    process.env[STATE_PATH_ENV] ??
    path.join(os.homedir(), '.pi', 'agent', 'herdr-agents-state.json')
  );
}

export function emptyHerdrAgentsState(): HerdrAgentsState {
  return { version: 2, agents: {}, closedHistory: [] };
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
