import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';

import { readAgentQuestion, readAgentResult } from '../artifacts.ts';
import { execHerdr } from '../herdr/cli.ts';
import { listManagedWorkspaceAgents } from '../herdr/placement.ts';
import {
  buildAgentFinishedNotificationArgs,
  getCurrentContext,
} from '../herdr/snapshot.ts';
import { formatAgentQuestion } from '../prompts.ts';
import {
  claimDetachedAgent,
  emptyHerdrAgentsState,
  persistPrunedAgentsState,
} from '../state/store.ts';
import {
  bestEffort,
  closeOneShot,
  dropCollectedSpawnWarnings,
  formatCollectedOutput,
  spawnWarningDetails,
} from '../tool/one-shot.ts';
import type { HerdrAgentInfo } from '../types.ts';
import { formatSpawnWarnings } from '../utils.ts';
import {
  AGENT_QUESTION_MESSAGE_TYPE,
  AGENT_RESULT_MESSAGE_TYPE,
} from './renderers.ts';
import {
  AGENTS_WIDGET_ID,
  AGENTS_WIDGET_TICK_MS,
  isSettledAgentStatus,
  renderAgentWidgetLines,
  type StatusTone,
  visibleWidgetAgents,
  type WidgetPaint,
} from './widget.ts';

export async function loadCurrentAgents(): Promise<HerdrAgentInfo[]> {
  const current = await getCurrentContext();
  const state = await bestEffort(emptyHerdrAgentsState(), () =>
    persistPrunedAgentsState(current.panes),
  );
  return listManagedWorkspaceAgents(current, state);
}

// Widget ticks prune only when live terminals disappeared so staged
// history can finalize without a second-long write on every idle tick.
async function loadAgentsForWidget(): Promise<HerdrAgentInfo[]> {
  const current = await getCurrentContext();
  const state = await bestEffort(emptyHerdrAgentsState(), () =>
    persistPrunedAgentsState(current.panes),
  );
  return listManagedWorkspaceAgents(current, state);
}

// An extension instance replaced by /reload keeps its interval alive with a
// stale closure, so the handle lives on globalThis and is cleared on load.
type WidgetTimerHolder = {
  __herdrAgentsWidgetTimer?: ReturnType<typeof setInterval> | null;
};

let widgetTicking = false;

// The interval fires on its own schedule, so a tick can still be running when
// the session shuts down. Shutdown awaits it: a tick that outlives the session
// keeps pruning the state file and calling Herdr after teardown.
let widgetTick: Promise<void> | null = null;

/** Resolve once no widget tick is running, so shutdown can wait for one. */
export async function settleAgentsWidgetPoller(): Promise<void> {
  await widgetTick;
}

function startWidgetTick(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (widgetTicking) return;
  widgetTicking = true;
  widgetTick = updateAgentsWidget(pi, ctx);
}

// Labels the Orchestrator is currently blocked on inside a `wait: true` call.
// Kept in-process rather than in the state file: it describes this session's
// call stack, not the agent, and it must stay accurate across the re-wait path
// too. Deliberately not derived from the `herdr:blocked` event — that payload
// is a contract consumed by Herdr's own Pi state extension
// (extensions/herdr-agent-state.ts), so it is left untouched.
const awaitedAgentLabels = new Set<string>();

export function beginAwaitingAgent(label: string): void {
  awaitedAgentLabels.add(label);
}

export function endAwaitingAgent(label: string): void {
  awaitedAgentLabels.delete(label);
}

export function stopAgentsWidgetPoller(): void {
  const holder = globalThis as WidgetTimerHolder;
  if (!holder.__herdrAgentsWidgetTimer) return;
  clearInterval(holder.__herdrAgentsWidgetTimer);
  holder.__herdrAgentsWidgetTimer = null;
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

/**
 * Deliver outcomes of agents nobody is waiting for — a finished result, or a
 * question the child asked instead of finishing.
 *
 * This is the half of `wait: false` that was missing: the tool returns
 * immediately, and from then on nothing watches the child, so an uncollected
 * result was simply lost. The widget poller is already a per-second watcher
 * that knows every agent's status, so delivery rides on it rather than adding
 * another loop.
 *
 * The claim is taken *before* sending, and any synchronous collection releases
 * it too, so a result is delivered exactly once no matter which path gets there
 * first.
 *
 * Outcomes found in one tick are sent as a batch with a single turn trigger on
 * the last message. Triggering on the first instead starts a turn that the rest
 * must queue behind as `steer`, and `steer` lands only after that turn's tool
 * calls finish — observed with two agents asking in parallel, where the second
 * question surfaced a whole turn later. Batching makes them arrive together.
 */
export async function deliverDetachedOutcomes(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  agents: readonly HerdrAgentInfo[],
): Promise<void> {
  const pending: Array<{
    customType: string;
    content: string;
    display: boolean;
    details: Record<string, unknown>;
  }> = [];

  for (const agent of agents) {
    if (!agent.detached || !agent.terminalId) continue;
    if (!isSettledAgentStatus(agent.status)) continue;

    // Checked before the result, exactly as the blocking path does: a child that
    // asked ends its turn without HERDR_RESULT, so it settles like a completion
    // while the artifact may already hold its assistant text.
    const question = await bestEffort(undefined, () =>
      readAgentQuestion(agent.resultFile),
    );
    if (question) {
      const claimedQuestion = await bestEffort(false, () =>
        claimDetachedAgent({ terminal_id: agent.terminalId }),
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
      await dropCollectedSpawnWarnings({ terminal_id: agent.terminalId });
      continue;
    }

    const result = await bestEffort(undefined, () =>
      readAgentResult(agent.resultFile),
    );
    // Settled without an artifact means the child produced nothing usable;
    // leave the claim so an explicit re-wait can still read the scrollback.
    if (!result) continue;

    const claimed = await bestEffort(false, () =>
      claimDetachedAgent({ terminal_id: agent.terminalId }),
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
        ),
      );
    }

    // Routing through formatAgentOutput (trim + empty-output placeholder) is
    // equivalent to the old `${result}${closeNote}` only because the claim
    // above already proves readAgentResult returned a non-empty trimmed
    // string; readAgentResult trims and maps "" to undefined.
    let closeError: string | undefined;
    if (agent.lifecycle === 'oneshot') {
      // One-shots are closed by whoever collects them. Until now that was
      // always the waiting tool call, which is why `oneshot` required
      // `wait: true`.
      closeError = await closeOneShot({
        layout: agent.layout,
        tabId: agent.tabId,
        paneId: agent.paneId,
        resultFile: agent.resultFile,
        lifecyclePane: { terminal_id: agent.terminalId },
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
    await dropCollectedSpawnWarnings({ terminal_id: agent.terminalId });
  }

  if (pending.length === 0) return;

  // Only the final message triggers a turn. Triggering on the first would start
  // a turn the rest then have to queue behind as `steer`, which is what pushed a
  // second parallel question a whole turn later.
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
): Promise<void> {
  try {
    const agents = await bestEffort<HerdrAgentInfo[]>([], loadAgentsForWidget);

    // Runs before the rendering short-circuits below: a detached agent is
    // hidden from the widget once collected, but its result still has to be
    // delivered.
    await bestEffort(undefined, () => deliverDetachedOutcomes(pi, ctx, agents));

    if (agents.length === 0) {
      stopAgentsWidgetPoller();
      ctx.ui.setWidget(AGENTS_WIDGET_ID, undefined);
      return;
    }

    // Only an empty *managed* set stops the poller. When agents exist but are
    // all hidden (the Orchestrator is blocking on them), keep ticking: one of
    // them can still flip to `blocked`, which is exactly the state the widget
    // must surface.
    const visible = visibleWidgetAgents(agents, awaitedAgentLabels);
    if (visible.length === 0) {
      ctx.ui.setWidget(AGENTS_WIDGET_ID, undefined);
      return;
    }

    ctx.ui.setWidget(
      AGENTS_WIDGET_ID,
      renderAgentWidgetLines(visible, Date.now(), themeWidgetPaint(ctx)),
      { placement: 'aboveEditor' },
    );
  } finally {
    widgetTicking = false;
  }
}

export function ensureAgentsWidget(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): void {
  if (ctx.mode !== 'tui') return;
  startWidgetTick(pi, ctx);

  const holder = globalThis as WidgetTimerHolder;
  if (holder.__herdrAgentsWidgetTimer) return;
  const timer = setInterval(() => {
    startWidgetTick(pi, ctx);
  }, AGENTS_WIDGET_TICK_MS);
  timer.unref?.();
  holder.__herdrAgentsWidgetTimer = timer;
}
