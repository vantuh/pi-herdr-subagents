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
