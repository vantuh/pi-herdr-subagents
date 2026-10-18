import { readAgentSessionMeta } from '../artifacts.ts';
import type { ContextMetrics } from '../artifacts/schema.ts';
import type { HerdrAgentInfo } from '../herdr/types.ts';
import { bestEffort } from '../utils.ts';

const UNKNOWN = '—';

/**
 * Reads each listed agent's published context sample. A missing, unreadable or
 * invalid artifact leaves that row at `ctx —`; it never fails the whole list.
 */
export async function attachAgentContext(
  agents: HerdrAgentInfo[],
): Promise<void> {
  await Promise.all(
    agents.map(async (agent) => {
      const meta = await bestEffort(undefined, () =>
        readAgentSessionMeta(agent.resultFile),
      );
      if (meta?.context) agent.context = meta.context;
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
