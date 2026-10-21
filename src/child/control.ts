import { promises as fs, watch, type FSWatcher } from 'node:fs';

import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';

import { setAgentResultInterrupted } from '../artifacts.ts';
import {
  controlDirFor,
  readControlRequest,
  writeControlAck,
} from '../control.ts';
import type { ControlRequest, ControlStatus } from '../control/schema.ts';
import { bestEffort } from '../utils.ts';

/** How long an interrupt waits for its own `agent_settled` before acking `requested`. */
export const CONTROL_ABORT_OBSERVE_MS = 2000;

export interface ChildRunState {
  /** From the `AGENT_RESULT_FILE:` marker in the incoming assignment. */
  resultFile?: string;
  /** `agent_start` .. `agent_settled`; a continuation re-enters without a settle. */
  active: boolean;
  /** `before_agent_start`: the reference point of the freshness heuristic. */
  runStartedAt: number;
  /** Most recent context seen in any handler; resolves at call time. */
  context?: ExtensionContext;
}

/** Register after child handlers so settle observation follows marker restoration. */
export function registerChildControl(
  pi: ExtensionAPI,
  state: ChildRunState,
): void {
  const reserved = new Set<string>();
  // Drained on shutdown so no ack rename lands after it returns.
  const ackPublishes = new Set<Promise<void>>();
  let watcher: FSWatcher | undefined;
  let watchedDir: string | undefined;
  let closed = false;
  let settleWaiters: Array<(aborted: boolean | undefined) => void> = [];

  const closeWatcher = (): void => {
    watcher?.close();
    watcher = undefined;
    watchedDir = undefined;
  };

  const releaseSettleWaiters = (aborted?: boolean): void => {
    for (const settle of settleWaiters.splice(0)) settle(aborted);
  };

  const controlDir = (): string | undefined => controlDirFor(state.resultFile);

  const ensureWatcher = async (): Promise<void> => {
    const dir = controlDir();
    if (!dir || dir === watchedDir) return;
    closeWatcher();
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    // Shutdown may land during mkdir; a watcher installed then would leak.
    if (closed) return;
    watchedDir = dir;
    // A close may remove the channel before consumption or acknowledgement completes.
    watcher = watch(dir, () => void consume().catch(() => {}));
  };

  // A throwing `isIdle` (replaced runtime) is a refusal, not a success.
  const isIdle = (): boolean | undefined => {
    try {
      return state.context?.isIdle();
    } catch {
      return true;
    }
  };

  const acknowledge = async (
    dir: string,
    request: ControlRequest,
    status: ControlStatus,
  ): Promise<void> => {
    if (closed) return;
    const publish = writeControlAck(dir, {
      id: request.id,
      action: request.action,
      status,
      at: Date.now(),
    });
    // No await before this add: shutdown drains every publish started before `closed`.
    ackPublishes.add(publish);
    try {
      await publish;
    } finally {
      ackPublishes.delete(publish);
    }
  };

  const waitForSettle = (): Promise<boolean | undefined> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        settleWaiters = settleWaiters.filter((waiter) => waiter !== settle);
        resolve(undefined);
      }, CONTROL_ABORT_OBSERVE_MS);
      const settle = (aborted: boolean | undefined): void => {
        clearTimeout(timer);
        resolve(aborted);
      };
      settleWaiters.push(settle);
    });

  const consume = async (): Promise<void> => {
    const dir = controlDir();
    if (!dir || closed) return;
    const request = await readControlRequest(dir);
    if (!request || closed) return;
    // No await between read and reserve: an id is admitted once.
    if (reserved.has(request.id)) return;
    reserved.add(request.id);

    if (request.action === 'steer' && !request.message?.trim()) return;

    if (
      !state.active ||
      isIdle() !== false ||
      request.createdAt < state.runStartedAt
    ) {
      await acknowledge(dir, request, 'idle');
      return;
    }

    if (request.action === 'steer') {
      // No await after the guard: the steer must enqueue synchronously. Never `triggerTurn`.
      pi.sendMessage(
        {
          customType: 'agent_steer',
          content: request.message ?? '',
          display: false,
          details: { requestId: request.id },
        },
        { deliverAs: 'steer' },
      );
      await acknowledge(dir, request, 'queued');
      return;
    }

    // Set the marker before abort to block ordinary result delivery.
    // `abort` throws on a replaced runtime: that is a refusal.
    await setAgentResultInterrupted(state.resultFile, true);
    // Shutdown may land during the marker write: no abort or ack after it.
    if (closed) return;
    const settled = waitForSettle();
    try {
      state.context?.abort();
    } catch {
      await acknowledge(dir, request, 'idle');
      return;
    }
    const aborted = await settled;
    await acknowledge(dir, request, aborted === true ? 'aborted' : 'requested');
  };

  pi.on('session_start', async () => {
    reserved.clear();
    closed = false;
    closeWatcher();
  });

  pi.on('before_agent_start', async () => {
    // Best effort: without a watcher the parent reports `unknown`.
    await bestEffort(undefined, ensureWatcher);
  });

  pi.on('agent_settled', async (event) => {
    releaseSettleWaiters(event.aborted === true);
  });

  pi.on('session_shutdown', async () => {
    closed = true;
    releaseSettleWaiters(undefined);
    closeWatcher();
    reserved.clear();
    // Failures are ignored: nobody is left to read them.
    await Promise.allSettled([...ackPublishes]);
  });
}
