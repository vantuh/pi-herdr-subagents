import { randomBytes } from 'node:crypto';

export function makeHerdrAgentName(profileName: string): string {
  const base =
    profileName
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^[^a-z]+/, '')
      .slice(0, 22) || 'agent';
  return `${base}_${randomBytes(4).toString('hex')}`;
}

export function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function normalizeTools(rawTools: unknown): string[] | undefined {
  const tools = Array.isArray(rawTools)
    ? rawTools.map((tool) => String(tool).trim()).filter(Boolean)
    : typeof rawTools === 'string'
      ? rawTools
          .split(',')
          .map((tool) => tool.trim())
          .filter(Boolean)
      : undefined;

  return tools && tools.length > 0 ? tools : undefined;
}

export function formatAgentOutput(
  output: string,
  tabLabel: string,
  closeError?: string,
): string {
  const text =
    output.trim() ||
    `(Herdr agent ${tabLabel} finished with no visible output.)`;
  return closeError
    ? `${text}\n\nWarning: failed to close one-shot Herdr agent ${tabLabel}: ${closeError}`
    : text;
}

/** Model-facing spawn notes (unknown thinking, missing skills). */
export function formatSpawnWarnings(
  text: string,
  warnings: readonly string[],
): string {
  if (warnings.length === 0) return text;
  return `${text}\n\nSpawn warnings:\n${warnings.map((warning) => `- ${warning}`).join('\n')}`;
}

/** Outer abort / Herdr wait timeout — child may still be running. */
export function isRecoverableWaitInterrupt(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (
      code === 'timeout' ||
      code === 'ABORT_ERR' ||
      code === 'wait_transport_interrupted'
    )
      return true;
    if ((error as { name?: unknown }).name === 'AbortError') return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  // Prompt never accepted — re-wait without task will not help.
  if (lower.includes('agent_prompt_stalled')) return false;
  return (
    lower === 'aborted' ||
    lower.includes('operation was aborted') ||
    lower.includes(' failed [timeout]') ||
    /\babort(ed)?\b/.test(lower)
  );
}

export function waitInterruptReason(
  error: unknown,
): 'aborted' | 'timeout' | 'connection' {
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'wait_transport_interrupted'
  )
    return 'connection';
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'timeout'
  ) {
    return 'timeout';
  }
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes(' failed [timeout]') || /\[timeout\]/.test(lower)) {
    return 'timeout';
  }
  return 'aborted';
}

export function formatWaitInterrupted(
  tabLabel: string,
  reason: 'aborted' | 'timeout' | 'connection' = 'aborted',
): string {
  const why =
    reason === 'timeout'
      ? 'Wait timed out'
      : reason === 'connection'
        ? 'Wait lost its Herdr connection after bounded recovery'
        : 'Wait was aborted (outer tool/session timeout)';
  return [
    `${why} while Herdr agent ${tabLabel} is still running.`,
    'The child was not closed and no new prompt was sent.',
    `Call herdr_agent again with the same tabLabel "${tabLabel}" and omit task to re-wait.`,
    'Do not resend the task.',
  ].join('\n');
}
