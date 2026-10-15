export interface RunDelegationRequest {
  agent?: string;
  task: string;
}

export function parseRunArgs(
  args: string,
  knownAgents: readonly string[],
): RunDelegationRequest | null {
  const task = args.trim();
  if (!task) return null;

  const [first, ...rest] = task.split(/\s+/);
  const agent = knownAgents.find(
    (name) => name.toLowerCase() === first.toLowerCase(),
  );
  if (agent) {
    const delegatedTask = rest.join(' ').trim();
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
