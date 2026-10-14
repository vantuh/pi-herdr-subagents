import { setTimeout as sleep } from 'node:timers/promises';

import { errorMessage } from '../utils.ts';
import { execHerdr, HerdrCliError } from './cli.ts';

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await sleep(ms, undefined, { signal });
  } catch (error) {
    if (signal?.aborted) throw new Error('Aborted');
    throw error;
  }
}

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
    throw new Error(`Malformed herdr agent get output: ${errorMessage(error)}`);
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

/** Idle or done: the child has finished its turn. */
export function isSettledAgentStatus(status: string): boolean {
  return status === 'idle' || status === 'done';
}

export function startedAgentReady(
  snapshot: StartedAgentSnapshot,
  expectedAgent: string,
): boolean {
  return (
    snapshot.agent === expectedAgent && isSettledAgentStatus(snapshot.status)
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
          await execHerdr(['agent', 'rename', paneId, name], signal);
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

type HerdrAgentSnapshot = {
  status: string;
  stateChangeSeq: number;
  completionSeq?: number;
};

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

export async function getAgentSnapshot(
  target: string,
  signal?: AbortSignal,
): Promise<HerdrAgentSnapshot> {
  return parseAgentSnapshot(await execHerdr(['agent', 'get', target], signal));
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
  signal?: AbortSignal,
): Promise<void> {
  // Avoid `agent prompt --wait`: Herdr's hardcoded 5s post-submit lifecycle
  // gate returns agent_prompt_stalled when Pi is slow to leave idle.
  try {
    await execHerdr(['agent', 'prompt', target, prompt], signal);
  } catch (error) {
    mapPromptError(error, target);
  }
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
