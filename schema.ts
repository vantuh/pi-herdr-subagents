import { Type } from "typebox";

export const DEFAULT_AGENT_PARAM_DESCRIPTION =
  "Agent profile name from ~/.pi/agent/agents/*.md, e.g. researcher, scout, reviewer, planner, worker.";

/**
 * The `agent` parameter is model-facing: profiles marked
 * `disable-model-invocation` stay spawnable by exact name but are dropped
 * from the listing, so the Orchestrator only sees the profiles it should
 * reach for on its own.
 */
export function describeAgentProfiles(
  profiles: ReadonlyArray<{
    name: string;
    disableModelInvocation?: boolean;
  }>,
): string {
  const names = [
    ...new Set(
      profiles
        .filter((profile) => profile.name && !profile.disableModelInvocation)
        .map((profile) => profile.name),
    ),
  ];

  const listing = names.length > 0 ? ` Available: ${names.join(", ")}.` : "";
  return `${DEFAULT_AGENT_PARAM_DESCRIPTION}${listing}`;
}

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
          "Self-contained task to give the Herdr agent. Omit only to re-wait on an existing agent (matched by tabLabel) that is still running, e.g. after a previous call timed out — this reconnects without sending a new prompt.",
      }),
    ),
    tabLabel: Type.Optional(
      Type.String({
        description:
          "Herdr agent label. Defaults to the agent role, e.g. Researcher. Required when task is omitted, to identify which existing agent to re-wait on.",
      }),
    ),
    model: Type.Optional(
      Type.String({
        description:
          "Override the agent profile's model for this spawn (e.g. ask the same profile to several different models). Only applies to a fresh spawn.",
      }),
    ),
    wait: Type.Optional(
      Type.Boolean({
        description:
          "Wait for the Herdr agent to finish and read its result. Default: false — the tool returns as soon as the prompt is accepted and the result is delivered to you on its own once the agent finishes. Pass true only when you need the answer before continuing this turn. Headless sessions require wait: true; an explicit false is rejected.",
      }),
    ),
    resumeClosed: Type.Optional(
      Type.Boolean({
        description:
          "Continue a closed one-shot agent owned by this Orchestrator session with its accumulated context, matched by exact tabLabel. Requires a non-empty task and tabLabel. This is the way to give a follow-up task to a previous agent. Never resumes over a live agent: parked questions are answered in place, working agents must be re-waited, settled detached results must be collected. Omit task to re-wait on a still-running agent — that never resurrects a closed one.",
      }),
    ),
  });
}
