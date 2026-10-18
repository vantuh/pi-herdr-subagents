import { readAgentSessionMeta } from '../artifacts.ts';
import type { ContextMetrics } from '../artifacts/schema.ts';
import type { HerdrAgentInfo } from '../herdr/types.ts';
import { bestEffort } from '../utils.ts';

const UNKNOWN = '—';

/** A missing or unreadable metrics artifact must not hide other agents. */
export async function attachAgentMetrics(
  agents: HerdrAgentInfo[],
): Promise<void> {
  await Promise.all(
    agents.map(async (agent) => {
      const meta = await bestEffort(undefined, () =>
        readAgentSessionMeta(agent.resultFile),
      );
      if (!meta) return;
      if (meta.context) agent.context = meta.context;
      if (meta.sessionCost !== undefined) agent.sessionCost = meta.sessionCost;
    }),
  );
}

/** Compact absolute count: `950`, `38k`, `1M`. */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  const thousands = Math.round(tokens / 1000);
  return thousands < 1000
    ? `${thousands}k`
    : `${Math.round(thousands / 1000)}M`;
}

/** `ctx 38k / 200k`, `ctx — / 200k`, or `ctx —` when nothing was published. */
export function formatContextLabel(
  context: ContextMetrics | undefined,
): string {
  if (!context) return `ctx ${UNKNOWN}`;
  const tokens =
    context.tokens === null ? UNKNOWN : formatTokenCount(context.tokens);
  return `ctx ${tokens} / ${formatTokenCount(context.contextWindow)}`;
}

/** Approximate recorded session USD; distinguishes unreported cost from zero. */
export function formatCostLabel(sessionCost: number | undefined): string {
  if (sessionCost === undefined) return `cost ${UNKNOWN}`;
  if (sessionCost > 0 && sessionCost < 0.001) return `<$0.001`;
  return `~$${sessionCost.toFixed(3)}`;
}
