import { randomUUID } from 'node:crypto';

import type {
  AgentToolResult,
  ExtensionToolContext,
} from '@earendil-works/pi-coding-agent';

import { CONTROL_ABORT_OBSERVE_MS } from '../child/control.ts';
import {
  awaitControlAck,
  controlDirFor,
  removeControlArtifacts,
  withControlDirQueue,
  writeControlRequest,
} from '../control.ts';
import type {
  ControlAck,
  ControlAction,
  ControlStatus,
} from '../control/schema.ts';
import { listManagedWorkspaceAgents } from '../herdr/placement.ts';
import { loadContextWithState } from '../herdr/snapshot.ts';
import type { HerdrAgentInfo } from '../herdr/types.ts';
import { bestEffort } from '../utils.ts';
import { orchestratorIdentity } from './child-args.ts';
import { textResult } from './result.ts';
import type { AgentStopParams } from './schema.ts';

export const CONTROL_STEER_ACK_TIMEOUT_MS = 2000;
export const CONTROL_INTERRUPT_ACK_TIMEOUT_MS = 3000;

/**
 * Statuses the parent accepts for each action. An acknowledgement that names
 * the other action's outcome is not a partial success: it is reported as
 * `unknown`, which is the honest reading of a channel that answered with
 * something this caller cannot interpret.
 */
const ACCEPTED_STATUSES: Record<ControlAction, readonly ControlStatus[]> = {
  steer: ['queued', 'idle'],
  interrupt: ['aborted', 'requested', 'idle'],
};

function acceptedStatus(
  action: ControlAction,
  ack: ControlAck | undefined,
): ControlStatus | undefined {
  if (!ack || ack.action !== action) return undefined;
  return ACCEPTED_STATUSES[action].includes(ack.status)
    ? ack.status
    : undefined;
}

/** Reported statuses: every child-written outcome plus the parent's own `unknown`. */
type ReportedStatus = ControlStatus | 'unknown';

function statusText(
  action: ControlAction,
  status: ReportedStatus,
  label: string,
  paneId: string,
): string {
  if (action === 'steer') {
    if (status === 'queued') {
      return `Message queued for agent ${label} (${paneId}). It enters the run at its next turn boundary; queuing is not proof the agent has read it. Its answer still arrives with the final result — do not re-send it as a task.`;
    }
    if (status === 'idle') {
      return `Agent ${label} (${paneId}) did not take the message: it is not in an active run, or the request was already stale. Its result arrives automatically; wait for it. Check it with agent_status only if a decision depends on it.`;
    }
    return `No acknowledgement from agent ${label} (${paneId}) within ${CONTROL_STEER_ACK_TIMEOUT_MS} ms. The message may or may not be applied; do not retry it. Check its status before deciding what to send next.`;
  }

  if (status === 'aborted') {
    return `Agent ${label} (${paneId}) aborted its run, so no result from that run should normally arrive and the agent stays open. A collection already in flight can still deliver that run's text and close the pane; ignore a result for work you interrupted. A live agent cannot take a new task: continue it manually in its pane, or close it with /herdr-agents and then continue it with agent_send and the same name.`;
  }
  if (status === 'requested') {
    return `Stop sent to agent ${label} (${paneId}); the child did not report a settled abort within ${CONTROL_ABORT_OBSERVE_MS} ms, so the run may have already finished on its own. On the ordinary path expect no result from that run, but a collection already in flight can still deliver its text; ignore a result for work you interrupted. Check its status, then continue it manually in its pane or close it with /herdr-agents and continue it with agent_send.`;
  }
  if (status === 'idle') {
    return `Agent ${label} (${paneId}) is not in an active run, so there was nothing to stop. Check its status; its result may still arrive.`;
  }
  return `No acknowledgement from agent ${label} (${paneId}) within ${CONTROL_INTERRUPT_ACK_TIMEOUT_MS} ms. The stop may or may not have been applied; do not retry it. Check its status before assuming it stopped.`;
}

/**
 * `agent_stop`: aborts the current run of a live child this session owns and
 * keeps it open.
 *
 * The guards run in order and no control-channel write happens before all of
 * them pass; the reused `loadContextWithState` does its own state pruning, as
 * D2 allows.
 */
export async function executeAgentStop(
  params: AgentStopParams,
  signal: AbortSignal | undefined,
  ctx: ExtensionToolContext,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const label = params.name?.trim() ?? '';
  const guardFailure = (text: string) =>
    textResult(text, { name: label, action: 'interrupt' }, true);

  if (!label) return guardFailure('name is required.');
  if (ctx.mode !== 'tui') {
    return guardFailure('agent_stop requires TUI mode.');
  }

  const { context, state } = await loadContextWithState(signal);
  const agent = listManagedWorkspaceAgents(context, state).find(
    (item) => item.tabLabel === label,
  );
  if (!agent) {
    return guardFailure(
      `No running agent named "${label}" found for this session. Pass its exact name.`,
    );
  }
  return await controlLiveAgent(agent, 'interrupt', undefined, signal, ctx);
}

/**
 * One control operation on a live child, called after its caller found the
 * agent. The call never spawns, prompts, claims, collects or closes: it only
 * publishes a request in the child's control directory and reads its
 * acknowledgement.
 */
export async function controlLiveAgent(
  agent: HerdrAgentInfo,
  action: ControlAction,
  message: string | undefined,
  signal: AbortSignal | undefined,
  ctx: ExtensionToolContext,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const label = agent.tabLabel;
  const guardFailure = (text: string) =>
    textResult(text, { name: label, action }, true);

  // The managed list is terminal-scoped; only the owning session may control.
  const ownerSessionId = orchestratorIdentity(ctx).ownerSessionId;
  if (!ownerSessionId || agent.ownerSessionId !== ownerSessionId) {
    return guardFailure(
      `Agent "${label}" is not owned by this Orchestrator session, so it cannot be controlled.`,
    );
  }

  const dir = controlDirFor(agent.resultFile);
  if (!dir) {
    return guardFailure(
      `Agent "${label}" has no control channel recorded. Check its status before retrying.`,
    );
  }

  const request = {
    id: randomUUID(),
    action,
    ...(action === 'steer' ? { message } : {}),
    createdAt: Date.now(),
  };
  const timeoutMs =
    action === 'steer'
      ? CONTROL_STEER_ACK_TIMEOUT_MS
      : CONTROL_INTERRUPT_ACK_TIMEOUT_MS;

  // The whole operation holds the queue, so no parallel call interferes.
  const status = await withControlDirQueue(dir, async () => {
    signal?.throwIfAborted();
    // Clean earlier leftovers so only this request can be consumed and acked.
    await removeControlArtifacts(dir);
    // Cancellation may land during the pre-clean.
    signal?.throwIfAborted();
    await writeControlRequest(dir, request);
    const ack = await awaitControlAck(dir, request.id, timeoutMs, signal);
    const result = acceptedStatus(action, ack) ?? 'unknown';
    if (result !== 'unknown') {
      // `unknown` keeps the files for the next pre-clean.
      await bestEffort(undefined, () =>
        removeControlArtifacts(dir, request.id),
      );
    }
    return result;
  });

  return textResult(statusText(action, status, label, agent.paneId), {
    name: label,
    paneId: agent.paneId,
    action,
    status,
    requestId: request.id,
  });
}
