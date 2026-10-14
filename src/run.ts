export interface RunDelegationRequest {
  agent?: string;
  task: string;
}

const DEFAULT_AGENT_NAMES = [
  "scout",
  "researcher",
  "planner",
  "worker",
  "reviewer",
] as const;

export function parseRunArgs(
  args: string,
  knownAgents: readonly string[] = DEFAULT_AGENT_NAMES,
): RunDelegationRequest | null {
  const task = args.trim();
  if (!task) return null;

  const [first, ...rest] = task.split(/\s+/);
  const agent = first.toLowerCase();
  if (knownAgents.includes(agent)) {
    const delegatedTask = rest.join(" ").trim();
    if (!delegatedTask) return null;
    return { agent, task: delegatedTask };
  }

  return { task };
}

export function formatRunUserMessage(request: RunDelegationRequest): string {
  if (request.agent) {
    return `[via /run → ${request.agent}] ${request.task}`;
  }
  return `[via /run] ${request.task}`;
}

/**
 * The council question is everything after the command name; unlike /run
 * there is no leading agent token to strip.
 */
export function parseCouncilArgs(args: string): string | null {
  const question = args.trim();
  return question ? question : null;
}

export function formatCouncilUserMessage(
  question: string,
  models: string[],
): string {
  return [
    `[via /council] ${question}`,
    "",
    "Spawn one `researcher` Herdr agent per model with `herdr_agent`, all in one turn as parallel calls, `wait: false`.",
    "- `agent: \"researcher\"` for every call",
    "- `model: \"<model>\"` set to that call's model (overrides the profile model)",
    "- `tabLabel: \"Council — <model>\"` with the exact model in the label",
    "- `task`: the user's question verbatim, self-contained",
    `Models: ${models.join(", ")}.`,
    "This overrides the usual independence / 4–5-parallel-limit delegation rule for this turn.",
    "When every council answer has been delivered, consolidate all answers into one final response for the user: agreements, disagreements, and the best supported conclusion. Do not spawn additional agents and do not duplicate the researchers' work while they run.",
  ].join("\n");
}
