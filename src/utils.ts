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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

export function formatCollectedOutput(
  output: string,
  tabLabel: string,
  closeError: string | undefined,
  warnings: readonly string[],
): string {
  return formatSpawnWarnings(
    formatAgentOutput(output, tabLabel, closeError),
    warnings,
  );
}

/**
 * Lifecycle state persistence (state/store.ts) is best-effort: a failure to
 * load/save/prune/record/delete must never abort agent execution/output or
 * manager listing. This swallows the error and returns a fallback so callers
 * can proceed without persisted lifecycle info.
 */
export async function bestEffort<T>(
  fallback: T,
  task: () => Promise<T>,
): Promise<T> {
  try {
    return await task();
  } catch {
    return fallback;
  }
}
