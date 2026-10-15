import { execFile } from 'node:child_process';
import { createConnection } from 'node:net';

import { Type } from 'typebox';

import { isManagedHerdrTempPath, SESSION_META_ENV } from '../artifacts.ts';
import { parseJson } from '../json.ts';

export class HerdrCliError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly args: readonly string[],
  ) {
    super(message);
    this.name = 'HerdrCliError';
  }
}

const SENSITIVE_AGENT_START_FLAGS = new Set([
  '--session',
  '--system-prompt',
  '--append-system-prompt',
]);

export function redactHerdrArgs(args: readonly string[]): string[] {
  const redacted = [...args];
  if (
    redacted[0] === 'agent' &&
    redacted[1] === 'prompt' &&
    redacted.length >= 4
  ) {
    redacted[3] = '<prompt>';
  }
  for (let i = 0; i < redacted.length; i++) {
    const current = redacted[i];
    const next = redacted[i + 1];
    if (SENSITIVE_AGENT_START_FLAGS.has(current) && next !== undefined) {
      redacted[i + 1] = '<redacted>';
      i += 1;
      continue;
    }
    if (current === '--env' && next !== undefined) {
      const eq = next.indexOf('=');
      const key = eq >= 0 ? next.slice(0, eq) : next;
      const value = eq >= 0 ? next.slice(eq + 1) : '';
      if (
        key === SESSION_META_ENV ||
        isSensitivePath(value) ||
        isManagedHerdrTempPath(value)
      ) {
        redacted[i + 1] = `${key}=<redacted>`;
      }
      i += 1;
      continue;
    }
    if (isSensitivePath(current) || isManagedHerdrTempPath(current)) {
      redacted[i] = '<path>';
    }
  }
  return redacted;
}

function isSensitivePath(value: string): boolean {
  if (!value) return false;
  if (
    value.includes('.jsonl') &&
    (value.startsWith('/') || value.includes('\\'))
  ) {
    return true;
  }
  return value.includes('herdr-agent-') || value.includes('herdr-pi-sessions');
}

export function sensitiveArgValues(args: readonly string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const current = args[i];
    const next = args[i + 1];
    if (SENSITIVE_AGENT_START_FLAGS.has(current) && next !== undefined) {
      values.push(next);
      i += 1;
      continue;
    }
    if (current === '--env' && next !== undefined) {
      const eq = next.indexOf('=');
      if (eq >= 0) values.push(next.slice(eq + 1));
      i += 1;
      continue;
    }
    if (isSensitivePath(current) || isManagedHerdrTempPath(current)) {
      values.push(current);
    }
  }
  return [...new Set(values.filter((value) => value.length > 0))].toSorted(
    (a, b) => b.length - a.length,
  );
}

function replacementForSensitiveValue(value: string): string {
  if (value.includes('herdr-agent-')) return '<temp>';
  if (value.includes('.jsonl') || value.includes('herdr-pi-sessions')) {
    return '<session>';
  }
  return '<redacted>';
}

export function sanitizeHerdrOutput(
  text: string,
  sensitiveValues: readonly string[] = [],
): string {
  let result = text;
  for (const value of sensitiveValues) {
    if (!value) continue;
    const replacement = replacementForSensitiveValue(value);
    result = result.split(value).join(replacement);
    const jsonEscaped = JSON.stringify(value).slice(1, -1);
    if (jsonEscaped !== value) {
      result = result.split(jsonEscaped).join(replacement);
    }
  }
  return result;
}

const HerdrErrorEnvelope = Type.Object({
  error: Type.Object({
    code: Type.Optional(Type.String()),
    message: Type.String(),
  }),
});

function parseHerdrError(
  stderr: string,
  fallback: string,
): {
  code?: string;
  message: string;
} {
  const parsed = parseJson(HerdrErrorEnvelope, stderr);
  if (parsed?.error?.message) {
    return { code: parsed.error.code, message: parsed.error.message };
  }
  // Herdr may also emit a human-readable CLI validation error.
  return { message: stderr || fallback };
}

export function execHerdr(
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    let onAbort: (() => void) | undefined;
    const cleanup = () => {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    };

    const proc = execFile(
      process.env.HERDR_BIN_PATH || 'herdr',
      args,
      { signal, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        cleanup();
        if (error) {
          const parsed = parseHerdrError(stderr?.trim(), error.message);
          const sensitive = sensitiveArgValues(args);
          const safeArgs = redactHerdrArgs(args);
          const code = parsed.code ? ` [${parsed.code}]` : '';
          const safeMessage = sanitizeHerdrOutput(parsed.message, sensitive);
          reject(
            new HerdrCliError(
              sanitizeHerdrOutput(
                `herdr ${safeArgs.join(' ')} failed${code}: ${safeMessage}`,
                sensitive,
              ),
              parsed.code,
              safeArgs,
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );

    if (signal) {
      onAbort = () => {
        proc.kill('SIGTERM');
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

const HerdrSocketResponse = Type.Object({
  id: Type.Optional(Type.String()),
  result: Type.Optional(Type.Unknown()),
  error: Type.Optional(Type.Object({ message: Type.Optional(Type.String()) })),
});

export function execHerdrApi(
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socketPath = process.env.HERDR_SOCKET_PATH;
    if (!socketPath) {
      reject(new Error('HERDR_SOCKET_PATH is not set.'));
      return;
    }

    const requestId = `herdr-agents:${process.pid}:${Date.now()}:${Math.random()}`;
    const socket = createConnection(socketPath);
    let buffer = '';
    let settled = false;

    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => finish(new Error('Aborted'));

    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;

      const response = parseJson(HerdrSocketResponse, buffer.slice(0, newline));
      if (!response) {
        finish(new Error(`Malformed Herdr ${method} socket response.`));
        return;
      }
      if (response.id !== requestId) return;
      if (response.error) {
        finish(new Error(response.error.message ?? `${method} failed`));
        return;
      }
      finish(undefined, response.result);
    });
    socket.on('error', (error) => finish(error));
    socket.on('end', () =>
      finish(new Error(`Herdr socket closed during ${method}.`)),
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
