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
    wait: Type.Optional(
      Type.Boolean({
        description:
          "Wait for the Herdr agent to finish and read its result. Default: true. With false the tool returns immediately and the result is delivered on its own once the agent finishes.",
      }),
    ),
    timeoutMs: Type.Optional(
      Type.Number({
        description: "Wait timeout in milliseconds. Default: 600000.",
      }),
    ),
    lifecycle: Type.Optional(
      Type.Union([Type.Literal("oneshot"), Type.Literal("persistent")], {
        description:
          "Agent lifecycle. Use 'oneshot' for one-off tasks that close after completion, or 'persistent' to keep/reuse the agent for follow-up tasks. Default: oneshot.",
      }),
    ),
    resumeClosed: Type.Optional(
      Type.Boolean({
        description:
          "Resume a closed one-shot agent owned by this Orchestrator session, matched by exact tabLabel. Requires a non-empty task and tabLabel. Never resumes over a live agent: parked questions are answered in place, working agents must be re-waited, settled detached results must be collected, and persistent agents are reused. Omit task to re-wait on a still-running agent — that never resurrects a closed one.",
      }),
    ),
  });
}
