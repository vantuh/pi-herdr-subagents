import { Type } from 'typebox';
import type { Static } from 'typebox';

export const DEFAULT_AGENT_PARAM_DESCRIPTION =
  'Agent profile name from ~/.pi/agent/agents/*.md or the project .pi/agents.';

/**
 * The `agent` parameter is model-facing: profiles marked
 * `disable-model-invocation` stay spawnable by exact name but are dropped
 * from the listing, so the Orchestrator only sees the profiles it should
 * reach for on its own.
 */
export function describeAgentProfiles(
  profiles: ReadonlyArray<{
    name: string;
    description?: string;
    disableModelInvocation?: boolean;
  }>,
): string {
  const listable = new Map<string, string | undefined>();
  for (const profile of profiles) {
    if (!profile.name || profile.disableModelInvocation) continue;
    if (listable.has(profile.name)) continue;
    listable.set(profile.name, profile.description?.trim() || undefined);
  }

  const entries = [...listable].map(([name, description]) =>
    description ? `${name} (${description})` : name,
  );
  const listing =
    entries.length > 0 ? ` Available: ${entries.join(', ')}.` : '';
  return `${DEFAULT_AGENT_PARAM_DESCRIPTION}${listing}`;
}

export type HerdrAgentParams = Static<ReturnType<typeof buildHerdrAgentParams>>;

export function buildHerdrAgentParams(
  agentDescription: string = DEFAULT_AGENT_PARAM_DESCRIPTION,
) {
  return Type.Object({
    agent: Type.String({
      description: agentDescription,
    }),
    task: Type.Optional(
      Type.String({
        description:
          'Self-contained task to give the Herdr agent. Omit to check a live agent matched by tabLabel: the call returns its status and a preview of its latest captured assistant text, and does not send a new prompt. A blank task is treated the same way. Check only when the user asks or a decision depends on its progress, never to wait for completion: the outcome arrives as a message automatically.',
      }),
    ),
    tabLabel: Type.Optional(
      Type.String({
        description:
          'Herdr agent label. Defaults to the agent role, e.g. Researcher. Required when task is omitted, to identify which live agent to check.',
      }),
    ),
    resumeClosed: Type.Optional(
      Type.Boolean({
        description:
          'Continue a closed one-shot agent owned by this Orchestrator session with its accumulated context, matched by exact tabLabel. Requires a non-empty task and tabLabel. This is the way to give a follow-up task to a previous agent. Never resumes over a live agent: parked questions are answered in place, working agents are checked with the same tabLabel and no task, and settled results arrive as messages. Omitting task checks status and never resurrects a closed agent.',
      }),
    ),
  });
}
