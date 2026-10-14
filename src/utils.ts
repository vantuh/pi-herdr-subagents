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
