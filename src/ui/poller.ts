import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';

import { readAgentQuestion, readAgentResult } from '../artifacts.ts';
import { getAgentSnapshot, isSettledAgentStatus } from '../herdr/agent.ts';
import { execHerdr } from '../herdr/cli.ts';
import { listManagedWorkspaceAgents } from '../herdr/placement.ts';
import { loadContextWithState } from '../herdr/snapshot.ts';
import type { HerdrAgentInfo } from '../herdr/types.ts';
import {
  formatCollectedOutput,
  formatSpawnWarnings,
  spawnWarningDetails,
} from '../output.ts';
import { formatAgentQuestion } from '../prompts.ts';
import { claimDetachedAgent } from '../state/store.ts';
import { closeOneShot, dropCollectedSpawnWarnings } from '../tool/one-shot.ts';
import { bestEffort } from '../utils.ts';
import {
  AGENT_QUESTION_MESSAGE_TYPE,
  AGENT_RESULT_MESSAGE_TYPE,
} from './renderers.ts';
import {
  AGENTS_WIDGET_ID,
  AGENTS_WIDGET_TICK_MS,
  renderAgentWidgetLines,
  type StatusTone,
  type WidgetPaint,
} from './widget.ts';

export async function loadCurrentAgents(
  signal?: AbortSignal,
): Promise<HerdrAgentInfo[]> {
  const { context, state } = await loadContextWithState(signal);
  return listManagedWorkspaceAgents(context, state);
}

// An extension instance replaced by /reload keeps its interval alive with a
// stale closure, so the handle lives on globalThis and is cleared on load.
type WidgetPoller = {
  controller: AbortController;
  timer?: ReturnType<typeof setInterval>;
  tick?: Promise<void>;
};
type WidgetTimerHolder = { __herdrAgentsWidgetPoller?: WidgetPoller };
const pollers = new WeakMap<ExtensionAPI, WidgetPoller>();

export function initializeAgentsWidgetPoller(pi: ExtensionAPI): void {
  const holder = globalThis as WidgetTimerHolder;
  const previous = holder.__herdrAgentsWidgetPoller;
  if (previous) {
    previous.controller.abort();
    clearInterval(previous.timer);
  }
  const poller: WidgetPoller = { controller: new AbortController() };
  pollers.set(pi, poller);
  holder.__herdrAgentsWidgetPoller = poller;
}

export async function settleAgentsWidgetPoller(
  pi: ExtensionAPI,
): Promise<void> {
  await pollers.get(pi)?.tick;
}

function startWidgetTick(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  poller: WidgetPoller,
): void {
  if (poller.tick || poller.controller.signal.aborted) return;
  poller.tick = updateAgentsWidget(pi, ctx, poller).finally(() => {
    poller.tick = undefined;
  });
}

export function stopAgentsWidgetPoller(pi: ExtensionAPI): void {
  const poller = pollers.get(pi);
  if (!poller) return;
  poller.controller.abort();
  clearInterval(poller.timer);
  poller.timer = undefined;
}

function themeWidgetPaint(ctx: ExtensionContext): WidgetPaint {
  const theme = ctx.ui.theme;
  const toneColor: Record<StatusTone, 'accent' | 'warning' | 'muted'> = {
    active: 'accent',
    attention: 'warning',
    quiet: 'muted',
  };
  return {
    header: (text) => theme.fg('muted', text),
    elapsed: (text) => theme.fg('dim', text),
    status: (text, tone) => theme.fg(toneColor[tone], text),
  };
}

export function buildAgentFinishedNotificationArgs(
  tabLabel: string,
  agent: string,
  resultExcerpt: string,
): string[] {
  const trimmed = resultExcerpt.trim();
  const body =
    trimmed.length > 400 ? `${trimmed.slice(0, 400).trimEnd()}…` : trimmed;
  return [
    'notification',
    'show',
    `Pi · ${tabLabel} finished`,
    '--body',
    body || `${agent} finished with an empty result.`,
  ];
}

/**
 * A tick's snapshot can predate the prompt, so a stale `idle` would deliver a
 * partial artifact and close a still-working child. A failed status read keeps
 * the snapshot's verdict instead of stalling every delivery.
 */
async function agentStillSettled(
  agent: HerdrAgentInfo,
  signal?: AbortSignal,
): Promise<boolean> {
  const snapshot = await bestEffort(undefined, () =>
    getAgentSnapshot(agent.automationName ?? agent.paneId, signal),
  );
  return snapshot === undefined || isSettledAgentStatus(snapshot.status);
}

/**
 * Deliver outcomes of detached agents — a finished result, or a question the
 * child asked instead of finishing.
 *
 * The tool returns as soon as the prompt is submitted, so this poller is the
 * only collector. It already watches every agent's status once a second.
 *
 * The claim is taken *before* sending, so a result is delivered exactly once.
 *
 * Outcomes found in one tick are sent as a batch with a single turn trigger on
 * the last message. Triggering on the first instead starts a turn that the rest
 * must queue behind as `steer`, and `steer` lands only after that turn's tool
 * calls finish — observed with two agents asking in parallel, where the second
 * question surfaced one whole turn after. Batching makes them arrive together.
 */
export async function deliverDetachedOutcomes(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  agents: readonly HerdrAgentInfo[],
  signal?: AbortSignal,
): Promise<void> {
  const pending: Array<{
    customType: string;
    content: string;
    display: boolean;
    details: Record<string, unknown>;
  }> = [];

  for (const agent of agents) {
    if (signal?.aborted) break;
    if (!agent.detached || !agent.terminalId) continue;
    if (!isSettledAgentStatus(agent.status)) continue;

    // Checked before the result: a child that asked ends its turn without
    // HERDR_RESULT, so it settles like a completion while the artifact may
    // already hold its assistant text.
    const question = await bestEffort(undefined, () =>
      readAgentQuestion(agent.resultFile),
    );
    if (question) {
      if (!(await agentStillSettled(agent, signal))) continue;
      const claimedQuestion = await bestEffort(false, () =>
        claimDetachedAgent(
          { terminal_id: agent.terminalId },
          undefined,
          signal,
        ),
      );
      if (!claimedQuestion) continue;

      const spawnWarnings = agent.spawnWarnings ?? [];
      // The target stays open — including one-shots — and `question.md` stays on
      // disk, which is what keeps a parked one-shot reusable by label. The next
      // prompt clears it.
      pending.push({
        customType: AGENT_QUESTION_MESSAGE_TYPE,
        content: formatSpawnWarnings(
          formatAgentQuestion(agent.tabLabel, agent.agent, question),
          spawnWarnings,
        ),
        display: true,
        details: {
          tabLabel: agent.tabLabel,
          agent: agent.agent,
          paneId: agent.paneId,
          question,
          ...spawnWarningDetails(spawnWarnings),
        },
      });
      await dropCollectedSpawnWarnings(
        { terminal_id: agent.terminalId },
        signal,
      );
      continue;
    }

    const result = await bestEffort(undefined, () =>
      readAgentResult(agent.resultFile),
    );
    // Settled without an artifact means the child produced nothing usable.
    // Leave the claim: there is nothing to deliver.
    if (!result) continue;
    if (!(await agentStillSettled(agent, signal))) continue;

    const claimed = await bestEffort(false, () =>
      claimDetachedAgent({ terminal_id: agent.terminalId }, undefined, signal),
    );
    if (!claimed) continue;

    // Nobody was waiting — that is the definition of this delivery path — so
    // ping the user through Herdr's own notification channel. Pane-layout
    // agents are already visible on screen, so they stay silent. Best effort:
    // a missing or failing notification never blocks the result delivery.
    if (agent.layout !== 'pane') {
      await bestEffort(undefined, () =>
        execHerdr(
          buildAgentFinishedNotificationArgs(
            agent.tabLabel,
            agent.agent,
            result,
          ),
          signal,
        ),
      );
    }

    // Routing through formatAgentOutput (trim + empty-output placeholder) is
    // equivalent to the old `${result}${closeNote}` only because the claim
    // above already proves readAgentResult returned a non-empty trimmed
    // string; readAgentResult trims and maps "" to undefined.
    let closeError: string | undefined;
    if (agent.lifecycle === 'oneshot') {
      // One-shots close when their result is delivered.
      closeError = await closeOneShot({
        layout: agent.layout,
        tabId: agent.tabId,
        paneId: agent.paneId,
        resultFile: agent.resultFile,
        lifecyclePane: { terminal_id: agent.terminalId },
        signal,
      });
    }

    const resultWithWarnings = formatCollectedOutput(
      result,
      agent.tabLabel,
      closeError,
      agent.spawnWarnings ?? [],
    );
    pending.push({
      customType: AGENT_RESULT_MESSAGE_TYPE,
      content: [
        `Herdr agent ${agent.tabLabel} (${agent.agent}) finished on its own:`,
        '',
        resultWithWarnings,
      ].join('\n'),
      display: true,
      details: {
        tabLabel: agent.tabLabel,
        agent: agent.agent,
        paneId: agent.paneId,
        // The renderer shows this on its own under a header; `content` keeps
        // the attribution inline because that is what the model reads.
        result: resultWithWarnings,
      },
    });
    await dropCollectedSpawnWarnings({ terminal_id: agent.terminalId }, signal);
  }

  if (pending.length === 0) return;

  // A durable claim commits delivery; cancellation stops new claims, not this batch.
  // Only the final message triggers a turn. Triggering on the first would start
  // a turn the rest then have to queue behind as `steer`, which is what pushed a
  // second parallel question one whole turn after.
  const deliverAs = ctx.isIdle?.() === false ? 'steer' : undefined;
  pending.forEach((message, index) => {
    const last = index === pending.length - 1;
    pi.sendMessage(message, {
      ...(last ? { triggerTurn: true } : {}),
      deliverAs,
    });
  });
}

async function updateAgentsWidget(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  poller: WidgetPoller,
): Promise<void> {
  const signal = poller.controller.signal;
  try {
    const agents = await loadCurrentAgents(signal);
    signal.throwIfAborted();
    await bestEffort(undefined, () =>
      deliverDetachedOutcomes(pi, ctx, agents, signal),
    );
    signal.throwIfAborted();
    if (agents.length === 0) {
      clearInterval(poller.timer);
      poller.timer = undefined;
      ctx.ui.setWidget(AGENTS_WIDGET_ID, undefined);
      return;
    }
    ctx.ui.setWidget(
      AGENTS_WIDGET_ID,
      renderAgentWidgetLines(agents, Date.now(), themeWidgetPaint(ctx)),
      { placement: 'aboveEditor' },
    );
  } catch {
    // Failed snapshots and cancellation must not prune or render an empty set.
  }
}

export function ensureAgentsWidget(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): void {
  const poller = pollers.get(pi);
  if (ctx.mode !== 'tui' || !poller || poller.controller.signal.aborted) return;
  startWidgetTick(pi, ctx, poller);
  if (poller.timer) return;
  poller.timer = setInterval(
    () => startWidgetTick(pi, ctx, poller),
    AGENTS_WIDGET_TICK_MS,
  );
  poller.timer.unref?.();
}
