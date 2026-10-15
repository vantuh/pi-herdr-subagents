import type { HerdrNamedAgent, PaneInfo } from '../herdr/schema.ts';
import { reconcileHerdrAgentsState } from './history-policy.ts';
import type { HerdrAgentStateRecord, HerdrAgentsState } from './schema.ts';

// Terminal identity survives pane moves; live handoff rekeys it from verified
// automation names and the recorded child/owner panes before pruning.
export function paneStateKey(
  pane: Pick<PaneInfo, 'terminal_id'>,
): string | undefined {
  return pane.terminal_id ? `terminal:${pane.terminal_id}` : undefined;
}

/** A record stamped by a different Herdr server is not this Orchestrator's. */
export function isForeignServerRecord(
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
