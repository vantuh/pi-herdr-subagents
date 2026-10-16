import { REPORT_TTL_DAYS } from './reports.ts';

/** Display budget for the status preview, not a filter on its content. */
const PREVIEW_LINES = 30;
const PREVIEW_CHARS = 2_000;

/** Retained-source budget, not an output budget: the marker and path add their own overhead. */
export const RESULT_EXCERPT_HEAD_CHARS = 4_000;
export const RESULT_EXCERPT_TAIL_CHARS = 2_000;

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

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Whole-line cuts fall back to characters when no nonempty prefix fits. */
function retainedHead(text: string, budget: number): string {
  const end = text.lastIndexOf('\n', budget);
  const whole = end > 0 ? text.slice(0, end) : '';
  return (whole || cutHead(text, budget)).trimEnd();
}

function retainedTail(text: string, budget: number): string {
  const newline = text.indexOf('\n', text.length - budget - 1);
  const whole = newline >= 0 ? text.slice(newline + 1) : '';
  return (whole || cutTail(text, budget)).trimStart();
}

/** Character cut that never leaves a lone surrogate at the cut. */
function cutHead(text: string, budget: number): string {
  let end = Math.min(budget, text.length);
  if (
    end > 0 &&
    end < text.length &&
    isHighSurrogate(text.charCodeAt(end - 1)) &&
    isLowSurrogate(text.charCodeAt(end))
  ) {
    end -= 1;
  }
  return text.slice(0, end);
}

function cutTail(text: string, budget: number): string {
  let start = Math.max(0, text.length - budget);
  if (
    start > 0 &&
    start < text.length &&
    isLowSurrogate(text.charCodeAt(start)) &&
    isHighSurrogate(text.charCodeAt(start - 1))
  ) {
    start += 1;
  }
  return text.slice(start);
}

/**
 * The delivered body of a collected result: the full text, or a head/tail
 * excerpt when a durable report of it exists. Truncation never happens without
 * `reportPath`, because the report is the only copy of what the excerpt drops.
 */
export function formatResultForDelivery(input: {
  result: string;
  tabLabel: string;
  reportPath?: string;
  reportError?: string;
}): string {
  if (input.reportError) {
    return `${input.result}\n\nWarning: failed to save the full report for Herdr agent ${input.tabLabel}: ${input.reportError}. Delivering the full result instead.`;
  }
  if (!input.reportPath) return input.result;
  if (
    input.result.length <=
    RESULT_EXCERPT_HEAD_CHARS + RESULT_EXCERPT_TAIL_CHARS
  ) {
    return `${input.result}\n\nFull report saved to ${input.reportPath}`;
  }

  const head = retainedHead(input.result, RESULT_EXCERPT_HEAD_CHARS);
  const tail = retainedTail(input.result, RESULT_EXCERPT_TAIL_CHARS);
  // Exact by construction: head and tail are the slices the excerpt keeps.
  const omitted = input.result.length - head.length - tail.length;
  return (
    `${head}\n\n… ${omitted} characters omitted …\n\n${tail}\n\n` +
    `Full report saved to ${input.reportPath} (kept ${REPORT_TTL_DAYS} days) — read it when you need the omitted part.`
  );
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
