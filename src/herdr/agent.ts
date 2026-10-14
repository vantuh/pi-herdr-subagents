import { delay, execHerdr, HerdrCliError } from './cli.ts';

type StartedAgentSnapshot = {
  agent: string;
  status: string;
};

type ParsedAgentGet = {
  agent?: string;
  status?: string;
  stateChangeSeq?: number;
  completionSeq?: number;
};

function parseAgentGetOutput(output: string): ParsedAgentGet {
  let parsed: {
    result?: {
      agent?: {
        agent?: unknown;
        agent_status?: unknown;
        state_change_seq?: unknown;
        completion_seq?: unknown;
      };
    };
  };
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Malformed herdr agent get output: ${message}`);
  }

  const raw = parsed.result?.agent;
  return {
    agent: typeof raw?.agent === 'string' ? raw.agent : undefined,
    status:
      typeof raw?.agent_status === 'string' ? raw.agent_status : undefined,
    stateChangeSeq:
      typeof raw?.state_change_seq === 'number'
        ? raw.state_change_seq
        : undefined,
    completionSeq:
      typeof raw?.completion_seq === 'number' ? raw.completion_seq : undefined,
  };
}

export function parseStartedAgentSnapshot(
  output: string,
): StartedAgentSnapshot {
  const parsed = parseAgentGetOutput(output);
  if (typeof parsed.agent !== 'string' || typeof parsed.status !== 'string') {
    throw new Error(
      'Malformed herdr agent get output: expected result.agent.agent and agent_status.',
    );
  }
  return { agent: parsed.agent, status: parsed.status };
}

export function buildAgentRenameArgs(target: string, name: string): string[] {
  return ['agent', 'rename', target, name];
}

export function startedAgentReady(
  snapshot: StartedAgentSnapshot,
  expectedAgent: string,
): boolean {
  return (
    snapshot.agent === expectedAgent &&
    (snapshot.status === 'idle' || snapshot.status === 'done')
  );
}

async function waitForStartedAgent(
  paneId: string,
  expectedAgent: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const snapshot = parseStartedAgentSnapshot(
        await execHerdr(['agent', 'get', paneId], signal),
      );
      if (startedAgentReady(snapshot, expectedAgent)) return;
    } catch (error) {
      if (signal?.aborted) throw error;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Herdr did not settle on ${expectedAgent} in pane ${paneId} within ${timeoutMs}ms.`,
      );
    }
    await delay(100, signal);
  }
}

export async function startAgent(
  name: string,
  paneId: string,
  piArgs: string[],
  signal?: AbortSignal,
): Promise<void> {
  const args = [
    'agent',
    'start',
    name,
    '--kind',
    'pi',
    '--pane',
    paneId,
    '--timeout',
    '30000',
    '--',
    ...piArgs,
  ];
  const shellReadyDeadline = Date.now() + 5_000;
  while (true) {
    try {
      await execHerdr(args, signal);
      return;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (
        error instanceof HerdrCliError &&
        error.code === 'agent_kind_mismatch'
      ) {
        // The launch already happened; wait for Pi instead of starting it twice.
        try {
          await waitForStartedAgent(paneId, 'pi', 30_000, signal);
          await execHerdr(buildAgentRenameArgs(paneId, name), signal);
          return;
        } catch (settleError) {
          if (signal?.aborted) throw settleError;
          throw error;
        }
      }
      if (
        !(error instanceof HerdrCliError) ||
        error.code !== 'agent_pane_busy' ||
        Date.now() >= shellReadyDeadline
      ) {
        throw error;
      }
      // A newly created pane can exist before its shell reaches the prompt.
      await delay(100, signal);
    }
  }
}

/** Herdr hardcodes a 5s lifecycle gate on `agent prompt --wait`. */
const PROMPT_ACCEPT_TIMEOUT_MS = 30_000;
const PROMPT_ACCEPT_POLL_MS = 100;

export type HerdrAgentSnapshot = {
  status: string;
  stateChangeSeq: number;
  completionSeq?: number;
};

export function buildAgentPromptArgs(target: string, prompt: string): string[] {
  return ['agent', 'prompt', target, prompt];
}

export function buildAgentWaitArgs(
  target: string,
  timeoutMs: number,
  until: readonly string[],
): string[] {
  const args = ['agent', 'wait', target];
  for (const status of until) {
    args.push('--until', status);
  }
  args.push('--timeout', String(timeoutMs));
  return args;
}

export function parseAgentSnapshot(output: string): HerdrAgentSnapshot {
  const parsed = parseAgentGetOutput(output);
  if (
    typeof parsed.status !== 'string' ||
    typeof parsed.stateChangeSeq !== 'number'
  ) {
    throw new Error(
      'Malformed herdr agent get output: expected result.agent.agent_status and state_change_seq.',
    );
  }
  return {
    status: parsed.status,
    stateChangeSeq: parsed.stateChangeSeq,
    completionSeq: parsed.completionSeq,
  };
}

/** True when a post-submit snapshot proves the prompt was accepted. */
export function promptAcceptanceObserved(
  before: HerdrAgentSnapshot,
  current: HerdrAgentSnapshot,
): 'working' | 'settled' | null {
  if (
    current.stateChangeSeq > before.stateChangeSeq &&
    (current.status === 'working' || current.status === 'blocked')
  ) {
    return 'working';
  }
  if (
    (current.status === 'idle' || current.status === 'done') &&
    current.completionSeq !== undefined &&
    current.completionSeq > (before.completionSeq ?? 0)
  ) {
    return 'settled';
  }
  return null;
}

export async function getAgentSnapshot(
  target: string,
  signal?: AbortSignal,
): Promise<HerdrAgentSnapshot> {
  return parseAgentSnapshot(await execHerdr(['agent', 'get', target], signal));
}

async function waitForPromptAcceptance(
  target: string,
  before: HerdrAgentSnapshot,
  signal?: AbortSignal,
): Promise<'working' | 'settled'> {
  const deadline = Date.now() + PROMPT_ACCEPT_TIMEOUT_MS;

  while (true) {
    const current = await getAgentSnapshot(target, signal);
    const observed = promptAcceptanceObserved(before, current);
    if (observed) return observed;

    if (Date.now() >= deadline) {
      throw new HerdrCliError(
        `herdr agent prompt ${target} <prompt> failed [agent_prompt_stalled]: no lifecycle change within ${PROMPT_ACCEPT_TIMEOUT_MS}ms after submit`,
        'agent_prompt_stalled',
        ['agent', 'prompt', target, '<prompt>'],
      );
    }

    await delay(PROMPT_ACCEPT_POLL_MS, signal);
  }
}

/** Report blocked dialogs without exposing the submitted prompt. */
export function mapPromptError(error: unknown, target: string): never {
  if (error instanceof HerdrCliError && error.code === 'agent_blocked') {
    throw new HerdrCliError(
      `Herdr agent "${target}" is waiting at an approval/question dialog; attach with \`herdr agent attach ${target}\` and resolve it before re-prompting`,
      'agent_blocked',
      ['agent', 'prompt', target, '<prompt>'],
    );
  }
  throw error;
}

export async function promptAgent(
  target: string,
  prompt: string,
  options: { wait: boolean; timeoutMs: number },
  signal?: AbortSignal,
): Promise<void> {
  // Avoid `agent prompt --wait`: Herdr's hardcoded 5s post-submit lifecycle
  // gate returns agent_prompt_stalled when Pi is slow to leave idle, which
  // looks like "text pasted, Enter never pressed". Submit atomically, then
  // wait for newer activity or a real completion before collecting.
  const before = await getAgentSnapshot(target, signal);
  try {
    await execHerdr(buildAgentPromptArgs(target, prompt), signal);
  } catch (error) {
    mapPromptError(error, target);
  }

  if (!options.wait) return;

  const acceptance = await waitForPromptAcceptance(target, before, signal);
  if (acceptance === 'settled') return;

  await waitForAgent(target, options.timeoutMs, signal);
}

export async function waitForAgent(
  target: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  await execHerdr(
    buildAgentWaitArgs(target, timeoutMs, ['idle', 'done']),
    signal,
  );
}

export function readAgent(
  target: string,
  signal?: AbortSignal,
): Promise<string> {
  return execHerdr(
    ['agent', 'read', target, '--source', 'recent-unwrapped', '--lines', '180'],
    signal,
  );
}
