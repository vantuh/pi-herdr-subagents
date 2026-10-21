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

export type AgentSpawnParams = Static<ReturnType<typeof buildAgentSpawnParams>>;

export function buildAgentSpawnParams(
  agentDescription: string = DEFAULT_AGENT_PARAM_DESCRIPTION,
) {
  return Type.Object({
    agent: Type.String({ description: agentDescription }),
    task: Type.String({
      description:
        'Self-contained task to give the new agent. The outcome arrives as a message automatically; never wait for it.',
    }),
    name: Type.Optional(
      Type.String({
        description:
          'Name of the new agent. Defaults to the agent role, e.g. Researcher. Must not match a live agent: use agent_send to reach one.',
      }),
    ),
  });
}

export type AgentSendParams = Static<ReturnType<typeof buildAgentSendParams>>;

export function buildAgentSendParams() {
  return Type.Object({
    name: Type.String({
      description:
        'Exact name of an agent owned by this session, live or closed.',
    }),
    message: Type.String({
      description:
        'What to send. Answers a parked question, steers a running agent at its next turn boundary, or gives a closed agent a follow-up task that keeps its context.',
    }),
  });
}

export type AgentStopParams = Static<ReturnType<typeof buildAgentStopParams>>;

export function buildAgentStopParams() {
  return Type.Object({
    name: Type.String({
      description: 'Exact name of a live agent owned by this session.',
    }),
  });
}

export type AgentStatusParams = Static<
  ReturnType<typeof buildAgentStatusParams>
>;

export function buildAgentStatusParams() {
  return Type.Object({
    name: Type.Optional(
      Type.String({
        description:
          'Exact name of a live agent to check. Omit to list the live agents this session owns.',
      }),
    ),
  });
}
