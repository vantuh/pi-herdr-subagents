import { Type } from "typebox";

export const HerdrAgentParams = Type.Object({
  agent: Type.String({
    description:
      "Agent profile name from ~/.pi/agent/agents/*.md, e.g. researcher, scout, reviewer, planner, worker.",
  }),
  task: Type.Optional(
    Type.String({
      description:
        "Self-contained task to give the Herdr agent. Omit only to re-wait on an existing tab (matched by tabLabel) that is still running, e.g. after a previous call to this tool timed out while the agent kept working — this reconnects to the same pane instead of sending a new prompt.",
    }),
  ),
  tabLabel: Type.Optional(
    Type.String({
      description:
        "Herdr tab label. Defaults to the agent role, e.g. Researcher. Required when task is omitted, to identify which existing tab to re-wait on.",
    }),
  ),
  wait: Type.Optional(
    Type.Boolean({
      description:
        "Wait for the Herdr agent to finish and read its result. Default: true. Required (must be true) when lifecycle is 'oneshot', since the tab is only closed after a successful wait.",
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
        "Agent tab lifecycle. Use 'oneshot' for one-off tasks that close after completion, or 'persistent' to keep/reuse the tab for follow-up tasks. Default: oneshot. 'oneshot' requires wait: true.",
    }),
  ),
});
