import { Type } from "typebox";

export const HerdrAgentParams = Type.Object({
  agent: Type.String({
    description:
      "Agent profile name from ~/.pi/agent/agents/*.md, e.g. researcher, scout, reviewer, planner, worker.",
  }),
  task: Type.String({
    description: "Self-contained task to give the Herdr agent.",
  }),
  tabLabel: Type.Optional(
    Type.String({
      description:
        "Herdr tab label. Defaults to the agent role, e.g. Researcher.",
    }),
  ),
  wait: Type.Optional(
    Type.Boolean({
      description:
        "Wait for the Herdr agent to finish and read its result. Default: true.",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      description: "Wait timeout in milliseconds. Default: 600000.",
    }),
  ),
  reuseExisting: Type.Optional(
    Type.Boolean({
      description:
        "Reuse an existing tab with the same label and send the task there. Default: false for fresh context.",
    }),
  ),
});
