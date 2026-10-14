import type { AgentToolResult } from '@earendil-works/pi-coding-agent';

/**
 * Tool result with a single text part. `isError` is omitted when false so
 * success results keep the exact key set callers assert on.
 */
export function textResult(
  text: string,
  details: Record<string, unknown> = {},
  isError = false,
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: 'text', text }],
    details,
    ...(isError ? { isError: true } : {}),
  };
}
