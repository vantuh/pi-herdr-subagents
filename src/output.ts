/** Display budget for the status preview, not a filter on its content. */
const PREVIEW_LINES = 30;
const PREVIEW_CHARS = 2_000;

/**
 * Bounded preview of the child's latest captured assistant text. Content is
 * kept verbatim: only the tail is dropped, with an explicit marker.
 */
export function formatAssistantPreview(text: string): string {
  const lines = text.trim().split('\n');
  let truncated = lines.length > PREVIEW_LINES;
  if (truncated) lines.splice(0, lines.length - PREVIEW_LINES);
  let preview = lines.join('\n').trim();
  if (preview.length > PREVIEW_CHARS) {
    preview = preview.slice(-PREVIEW_CHARS).trimStart();
    truncated = true;
  }
  return truncated ? `… (truncated)\n${preview}` : preview;
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

export function spawnWarningDetails(warnings: readonly string[]): {
  spawnWarnings?: string[];
} {
  return warnings.length > 0 ? { spawnWarnings: [...warnings] } : {};
}
