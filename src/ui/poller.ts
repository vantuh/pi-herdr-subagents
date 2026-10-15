import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';

import { listManagedWorkspaceAgents } from '../herdr/placement.ts';
import { loadContextWithState } from '../herdr/snapshot.ts';
import type { HerdrAgentInfo } from '../herdr/types.ts';
import { bestEffort } from '../utils.ts';
import { deliverDetachedOutcomes } from './detached-outcomes.ts';
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
