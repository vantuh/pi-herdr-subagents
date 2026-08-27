import { Type } from "typebox";

export const HerdrAgentParams = Type.Object({
  agent: Type.String({
    description:
      "Agent profile name from ~/.pi/agent/agents/*.md, e.g. researcher, scout, reviewer, planner, worker.",
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
});
