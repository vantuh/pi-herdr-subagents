/**
 * THROWAWAY prototype of the control transport and the child consumer
 * (docs/plans/agent-control.md, §7.2 and §7.3) for slice 1 A.
 *
 * Not product code and not a template for it: slice 1 measures the file
 * watcher, the atomic publish, the id reservation, the double steer guard and
 * the ack latency before any control implementation exists. Reused product
 * helpers (`findResultFileMarker`, `setAgentResultInterrupted`) are read-only
 * imports.
 */

import { randomUUID } from 'node:crypto';
import { promises as fs, type FSWatcher, watch } from 'node:fs';
import * as path from 'node:path';

import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';

import {
  findResultFileMarker,
  setAgentResultInterrupted,
} from '../src/artifacts.ts';

export interface PrototypeControlRequest {
  id: string;
  action: 'steer' | 'interrupt';
  message?: string;
  createdAt: number;
}

export interface PrototypeControlAck {
  id: string;
  action: 'steer' | 'interrupt';
  status: 'queued' | 'aborted' | 'requested' | 'idle';
  at: number;
}

export interface PrototypeAckRecord extends PrototypeControlAck {
  /** Publish-to-ack latency, the number D7's timeouts are tuned from. */
  latencyMs: number;
}

export function prototypeControlDirFor(resultFile: string): string {
  return path.join(path.dirname(resultFile), 'control');
}

/** `tmp + rename`, the atomic publish protocol used by the state store. */
export async function publishControlRequest(
  dir: string,
  request: PrototypeControlRequest,
): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'request.json');
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(request)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fs.rename(tmp, file);
}

export async function readControlRequest(
  dir: string,
): Promise<PrototypeControlRequest | undefined> {
  try {
    const raw = await fs.readFile(path.join(dir, 'request.json'), 'utf8');
    const parsed = JSON.parse(raw) as PrototypeControlRequest;
    return typeof parsed?.id === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function readControlAck(
  dir: string,
  id: string,
): Promise<PrototypeControlAck | undefined> {
  try {
    const raw = await fs.readFile(path.join(dir, `ack.${id}.json`), 'utf8');
    const parsed = JSON.parse(raw) as PrototypeControlAck;
    return parsed?.id === id ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function awaitControlAck(
  dir: string,
  id: string,
  timeoutMs: number,
): Promise<PrototypeControlAck | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ack = await readControlAck(dir, id);
    if (ack) return ack;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return undefined;
}

export async function ackFiles(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((name) => name.startsWith('ack.'));
  } catch {
    return [];
  }
}

export interface PrototypeControlConsumer {
  /** Acks this consumer wrote, with their publish-to-ack latency. */
  acks: PrototypeAckRecord[];
  /** Ids applied by a steer or an interrupt. */
  applications: string[];
  /** Consumption passes that saw an already-reserved id. */
  duplicateReads: number;
  /** Watch callbacks delivered by the OS watcher. */
  watchEvents: number;
  /** Settle observations, with how long after the abort they arrived. */
  settles: Array<{ aborted: boolean; at: number }>;
  /** Guard decisions, with the `active`/`idle` values each one saw. */
  decisions: Array<{
    id: string;
    status: PrototypeControlAck['status'];
    active: boolean;
    idle: boolean | undefined;
  }>;
  /** Live child-run state the guard reads, for assertions. */
  probe(): { active: boolean; idle: boolean | undefined };
  /** Whether the control-directory watcher is installed. */
  isWatching(): boolean;
  /** Simulates one extra watch callback (used to prove id reservation). */
  consume(): Promise<void>;
}

/** How long an interrupt waits for its own `agent_settled` (plan D5/D7). */
const PROTOTYPE_ABORT_OBSERVE_MS = 2000;

/**
 * Child-side consumer. Registered after the real child extension, so its
 * `agent_settled` handler runs after the extension's — which is what makes the
 * stale-`active` window in check 2 observable.
 */
export function registerPrototypeControlConsumer(
  pi: ExtensionAPI,
): PrototypeControlConsumer {
  const reserved = new Set<string>();
  const acks: PrototypeAckRecord[] = [];
  const applications: string[] = [];
  const settles: PrototypeControlConsumer['settles'] = [];
  const decisions: PrototypeControlConsumer['decisions'] = [];
  const settleWaiters: Array<
    (settle: { aborted: boolean; at: number } | undefined) => void
  > = [];

  let resultFile: string | undefined;
  let active = false;
  let runStartedAt = 0;
  let context: ExtensionContext | undefined;
  let watcher: FSWatcher | undefined;
  let watchingDir: string | undefined;
  let duplicateReads = 0;
  let watchEvents = 0;

  const isIdle = (): boolean | undefined => {
    try {
      return context?.isIdle();
    } catch {
      // A context from a replaced runtime throws; treated as a refusal.
      return true;
    }
  };

  const ensureWatcher = async (): Promise<void> => {
    const dir = resultFile ? prototypeControlDirFor(resultFile) : undefined;
    if (!dir || dir === watchingDir) return;
    watcher?.close();
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    watchingDir = dir;
    // `fs.watch` from `node:fs`, not the promise API: the latter returns an
    // async iterator and delivers no callbacks.
    watcher = watch(dir, () => {
      watchEvents += 1;
      void consume();
    });
  };

  const writeAck = async (
    dir: string,
    request: PrototypeControlRequest,
    status: PrototypeControlAck['status'],
  ): Promise<void> => {
    const ack: PrototypeControlAck = {
      id: request.id,
      action: request.action,
      status,
      at: Date.now(),
    };
    await fs.writeFile(
      path.join(dir, `ack.${request.id}.json`),
      `${JSON.stringify(ack)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    acks.push({ ...ack, latencyMs: ack.at - request.createdAt });
  };

  const waitForSettle = (
    timeoutMs: number,
  ): Promise<{ aborted: boolean; at: number } | undefined> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), timeoutMs);
      settleWaiters.push((settle) => {
        clearTimeout(timer);
        resolve(settle);
      });
    });

  const consume = async (): Promise<void> => {
    const dir = resultFile ? prototypeControlDirFor(resultFile) : undefined;
    if (!dir) return;
    // Admission: asynchronous read, then reserve with no await after it.
    const request = await readControlRequest(dir);
    if (!request) return;
    if (reserved.has(request.id)) {
      duplicateReads += 1;
      return;
    }
    reserved.add(request.id);

    // D3, evaluated with no await between the last check and the call.
    const idle = isIdle();
    const record = (status: PrototypeControlAck['status']) => {
      decisions.push({ id: request.id, status, active, idle });
      return writeAck(dir, request, status);
    };
    if (!active || idle !== false) {
      await record('idle');
      return;
    }
    if (request.createdAt < runStartedAt) {
      await record('idle');
      return;
    }
    if (request.action === 'steer') {
      pi.sendMessage(
        {
          customType: 'herdr_agent_steer',
          content: request.message ?? '',
          display: false,
          details: { requestId: request.id },
        },
        { deliverAs: 'steer' },
      );
      applications.push(request.id);
      await record('queued');
      return;
    }

    await setAgentResultInterrupted(resultFile, true);
    const settled = waitForSettle(PROTOTYPE_ABORT_OBSERVE_MS);
    try {
      context?.abort();
    } catch {
      await record('idle');
      return;
    }
    applications.push(request.id);
    const settle = await settled;
    await record(settle?.aborted ? 'aborted' : 'requested');
  };

  pi.on('session_start', async () => {
    reserved.clear();
    watcher?.close();
    watcher = undefined;
    watchingDir = undefined;
  });

  pi.on('before_agent_start', async (event, ctx) => {
    context = ctx;
    if (event.messageType === 'user') {
      resultFile = findResultFileMarker(event.prompt) ?? resultFile;
      runStartedAt = Date.now();
    }
    await ensureWatcher();
  });

  pi.on('agent_start', async (_event, ctx) => {
    active = true;
    context = ctx;
  });

  pi.on('agent_settled', async (event, ctx) => {
    active = false;
    context = ctx;
    const settle = { aborted: event.aborted === true, at: Date.now() };
    settles.push(settle);
    if (settle.aborted) await setAgentResultInterrupted(resultFile, true);
    for (const resolve of settleWaiters.splice(0)) resolve(settle);
  });

  pi.on('session_shutdown', async () => {
    watcher?.close();
    watcher = undefined;
    watchingDir = undefined;
  });

  const consumer: PrototypeControlConsumer = {
    acks,
    applications,
    get duplicateReads() {
      return duplicateReads;
    },
    get watchEvents() {
      return watchEvents;
    },
    settles,
    decisions,
    probe: () => ({ active, idle: isIdle() }),
    isWatching: () => watcher !== undefined,
    consume,
  };
  return consumer;
}
