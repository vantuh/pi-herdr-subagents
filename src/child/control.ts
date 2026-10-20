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
  /** From the `HERDR_RESULT_FILE:` marker in the incoming assignment. */
  resultFile?: string;
  /** `agent_start` .. `agent_settled`; a continuation re-enters without a settle. */
  active: boolean;
  /** `before_agent_start`: the reference point of the freshness heuristic. */
  runStartedAt: number;
  /** Most recent context seen in any handler; resolves at call time. */
  context?: ExtensionContext;
}

/**
 * Child-side consumer of the control transport (docs/plans/agent-control.md,
 * §7.3). Watches the control directory beside `result.md`, applies at most one
 * admission of each request, and answers with `ack.<id>.json`.
 *
 * Registered after the child's own handlers, so its `agent_settled` observation
 * runs after the interrupted marker write.
 */
export function registerChildControl(
  pi: ExtensionAPI,
  state: ChildRunState,
): void {
  const reserved = new Set<string>();
  // Acknowledgements whose publish already started; `session_shutdown` drains
  // them, so no ack rename lands after shutdown returns.
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
    // Shutdown can run while the directory creation is in flight; a watcher
    // installed after it would never be closed.
    if (closed) return;
    watchedDir = dir;
    // `fs.watch` from `node:fs`: the promises API returns an async iterator and
    // delivers no callbacks. A background consume never rejects either: the
    // outcome of a request is reported through its ack file, and a write that
    // fails after the parent removed a closed agent's directory (ENOENT) has no
    // one left to tell.
    watcher = watch(dir, () => void consume().catch(() => {}));
  };

  // An unreadable `isIdle` (a context from a replaced runtime throws) is a
  // refusal, never a success.
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
    // Registered with no await in between, so shutdown drains exactly the
    // publications that had already started before it flipped `closed`.
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
    // Read above, reserved here, with no await in between: duplicate watch
    // events and re-reads cannot admit the same id twice.
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
      // No await between the guard above and this call: Pi's steer branch
      // enqueues synchronously, and `triggerTurn` is never used.
      pi.sendMessage(
        {
          customType: 'herdr_agent_steer',
          content: request.message ?? '',
          display: false,
          details: { requestId: request.id },
        },
        { deliverAs: 'steer' },
      );
      await acknowledge(dir, request, 'queued');
      return;
    }

    // Marker before abort: an aborted run must not reach a completed boundary
    // that clears it. A context from a replaced runtime throws on `abort`
    // instead; that is a refusal, and the ordinary boundary clears the marker.
    await setAgentResultInterrupted(state.resultFile, true);
    // Shutdown can run while the marker is being written: no waiter, no abort
    // and no ack after it.
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
    // Best effort: without a watcher every request reports `unknown` to the
    // parent, which is the honest status, and a broken channel must not fail
    // the run.
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
    // Drain, so a publish that started earlier cannot rename its ack after
    // shutdown returns. A failure has nobody left to read it, as in `acknowledge`.
    await Promise.allSettled([...ackPublishes]);
  });
}
