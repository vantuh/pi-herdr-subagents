import { randomUUID } from 'node:crypto';

import type {
  AgentToolResult,
  ExtensionToolContext,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { Static } from 'typebox';

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
import { bestEffort } from '../utils.ts';
import { orchestratorIdentity } from './child-args.ts';
import { textResult } from './result.ts';

export const CONTROL_STEER_ACK_TIMEOUT_MS = 2000;
export const CONTROL_INTERRUPT_ACK_TIMEOUT_MS = 3000;

export type HerdrAgentControlParams = Static<
  ReturnType<typeof buildHerdrAgentControlParams>
>;

export function buildHerdrAgentControlParams() {
  return Type.Object({
    tabLabel: Type.String({
      description:
        'Exact label of a live Herdr agent owned by this session. Required.',
    }),
    action: Type.Union([Type.Literal('steer'), Type.Literal('interrupt')]),
    message: Type.Optional(
      Type.String({
        description:
          'Correction to inject at the next turn boundary of the running agent. Required for steer.',
      }),
    ),
  });
}

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
      return `Steer queued for Herdr agent ${label} (${paneId}). It enters the run at its next turn boundary; queuing is not proof the agent has read it. Its answer still arrives with the final result — do not re-send it as a task.`;
    }
    if (status === 'idle') {
      return `Herdr agent ${label} (${paneId}) did not apply the steer: it was not in an active run, or the request was already stale. Check its status with the same tabLabel: answer a parked question with a task, or wait for its result.`;
    }
    return `No acknowledgement from Herdr agent ${label} (${paneId}) within ${CONTROL_STEER_ACK_TIMEOUT_MS} ms. The steer may or may not be applied; do not retry it. Check its status before deciding what to send next.`;
  }

  if (status === 'aborted') {
    return `Herdr agent ${label} (${paneId}) aborted its run, so no result from that run should normally arrive and the agent stays open. A collection already in flight can still deliver that run's text and close the pane; ignore a result for work you interrupted. A live agent cannot take a new task: continue it manually in its pane, or close it with /herdr-agents and then continue it with resumeClosed and the same tabLabel.`;
  }
  if (status === 'requested') {
    return `Interrupt sent to Herdr agent ${label} (${paneId}); the child did not report a settled abort within ${CONTROL_ABORT_OBSERVE_MS} ms, so the run may have already finished on its own. On the ordinary path expect no result from that run, but a collection already in flight can still deliver its text; ignore a result for work you interrupted. Check its status, then continue it manually in its pane or close it with /herdr-agents and continue it with resumeClosed.`;
  }
  if (status === 'idle') {
    return `Herdr agent ${label} (${paneId}) is not in an active run, so there was nothing to interrupt. Check its status; its result may still arrive.`;
  }
  return `No acknowledgement from Herdr agent ${label} (${paneId}) within ${CONTROL_INTERRUPT_ACK_TIMEOUT_MS} ms. The interrupt may or may not have been applied; do not retry it. Check its status before assuming it stopped.`;
}

/**
 * `herdr_agent_control`: one operation on a live child this session owns.
 *
 * The guards run in order and no control-channel write happens before all of
 * them pass; the reused `loadContextWithState` does its own state pruning, as
 * D2 allows. The call never spawns, prompts, claims, collects or closes: it only
 * publishes a request in the child's control directory and reads its
 * acknowledgement.
 */
export async function executeHerdrAgentControl(
  params: HerdrAgentControlParams,
  signal: AbortSignal | undefined,
  ctx: ExtensionToolContext,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const label = params.tabLabel?.trim() ?? '';
  const action = params.action;
  const message = params.message?.trim() ?? '';
  const guardFailure = (text: string) =>
    textResult(text, { tabLabel: label, action }, true);

  if (!label) return guardFailure('tabLabel is required.');
  if (action === 'steer' && !message) {
    return guardFailure('action "steer" requires a non-empty message.');
  }
  if (action === 'interrupt' && message) {
    return guardFailure(
      'action "interrupt" takes no message; a steer cannot be combined with an interrupt.',
    );
  }
  if (ctx.mode !== 'tui') {
    return guardFailure('herdr_agent_control requires TUI mode.');
  }

  const { context, state } = await loadContextWithState(signal);
  const agent = listManagedWorkspaceAgents(context, state).find(
    (item) => item.tabLabel === label,
  );
  if (!agent) {
    return guardFailure(
      `No running Herdr agent named "${label}" found for this session. Pass its exact label; do not start a new agent to steer.`,
    );
  }

  // The managed list is terminal-scoped, so a new Pi session in the same pane
  // still sees the previous session's child; only this session may control it.
  const ownerSessionId = orchestratorIdentity(ctx).ownerSessionId;
  if (!ownerSessionId || agent.ownerSessionId !== ownerSessionId) {
    return guardFailure(
      `Herdr agent "${label}" is not owned by this Orchestrator session, so it cannot be controlled.`,
    );
  }

  const dir = controlDirFor(agent.resultFile);
  if (!dir) {
    return guardFailure(
      `Herdr agent "${label}" has no control channel recorded. Check its status before retrying.`,
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

  // Publish, wait, clean: the whole operation holds the per-directory queue, so
  // a parallel call cannot publish over this request or remove its ack.
  const status = await withControlDirQueue(dir, async () => {
    signal?.throwIfAborted();
    // The parent is the sole remover: clean leftovers of an earlier operation
    // before publishing, so only this request can be consumed and acked.
    await removeControlArtifacts(dir);
    // Cancellation can land while the pre-clean awaits; without this check the
    // request would still be published after the caller cancelled.
    signal?.throwIfAborted();
    await writeControlRequest(dir, request);
    const ack = await awaitControlAck(dir, request.id, timeoutMs, signal);
    const result = acceptedStatus(action, ack) ?? 'unknown';
    if (result !== 'unknown') {
      // Only a status this caller trusts removes the transport files. A timeout
      // or an unreadable ack leaves them for the next operation's pre-clean.
      await bestEffort(undefined, () =>
        removeControlArtifacts(dir, request.id),
      );
    }
    return result;
  });

  return textResult(statusText(action, status, label, agent.paneId), {
    tabLabel: label,
    paneId: agent.paneId,
    action,
    status,
    requestId: request.id,
  });
}
