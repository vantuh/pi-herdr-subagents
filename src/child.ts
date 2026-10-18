import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import {
  ASK_QUESTION_TOOL,
  assistantText,
  findResultFileMarker,
  SESSION_META_ENV,
  writeAgentQuestion,
  appendAgentResult,
  setAgentResultInterrupted,
  writeAgentSessionMeta,
} from './artifacts.ts';
import type { ContextMetrics } from './artifacts/schema.ts';
import { getCurrentContext } from './herdr/snapshot.ts';
import { textResult } from './tool/result.ts';

export async function captureChildSessionMeta(
  ctx: ExtensionContext,
  context?: ContextMetrics,
): Promise<string | undefined> {
  const dest = process.env[SESSION_META_ENV]?.trim();
  const sessionManager = ctx.sessionManager;
  if (!dest || !sessionManager) return undefined;
  const sessionId = sessionManager.getSessionId()?.trim();
  if (!sessionId) return undefined;
  const sessionFile = sessionManager.getSessionFile()?.trim();
  const cwd = sessionManager.getCwd().trim();
  if (!cwd) return undefined;
  return writeAgentSessionMeta(dest, {
    sessionId,
    cwd,
    updatedAt: new Date().toISOString(),
    ...(sessionFile ? { sessionFile } : {}),
    ...(context ? { context } : {}),
  });
}

/**
 * Mirrors this pane's Herdr label (set by `herdr agent start <name>`) into
 * pi.setSessionName() once at session_start. pi-autoname's restore() has no
 * marker for a `--name`-assigned session name, so it treats the session as
 * unnamed and renames it on the first agent_settled despite the Orchestrator
 * already naming it. Emitting session_info_changed here lets pi-autoname's
 * respectManualName logic (enabled in pi-autoname.json) recognize the name
 * as manual and skip renaming it.
 */
async function mirrorPaneLabelAsSessionName(pi: ExtensionAPI): Promise<void> {
  try {
    const { currentPane } = await getCurrentContext();
    if (currentPane.label) pi.setSessionName(currentPane.label);
  } catch {
    // No Herdr context (e.g. socket unavailable) — nothing to mirror.
  }
}

/**
 * Child-side half of the Herdr agent protocol. Runs only when
 * `HERDR_AGENT_CHILD=1`, so the delegation tool and the status widget stay out
 * of spawned agents.
 *
 * Both features hang off the result-file marker in the incoming prompt: the
 * result is written there, and the question file is derived from the same
 * directory.
 */
export function registerChildMode(pi: ExtensionAPI): void {
  let resultFile: string | undefined;
  // Every metadata write republishes this sample, so a path-only publish never
  // erases it; a new assignment, session or compaction clears it first.
  let context: ContextMetrics | undefined;
  const publishSessionMeta = (ctx: ExtensionContext) =>
    captureChildSessionMeta(ctx, context);

  pi.on('session_start', async (_event, ctx) => {
    resultFile = undefined;
    context = undefined;
    await publishSessionMeta(ctx);
    await mirrorPaneLabelAsSessionName(pi);
  });

  pi.on('before_agent_start', async (event, ctx) => {
    const assignment = event.messageType === 'user';
    if (assignment) {
      resultFile = findResultFileMarker(event.prompt) ?? resultFile;
      // A new assignment invalidates the previous turn's measurement.
      context = undefined;
    }
    // Escape skips agent_before_settle, so block delivery before work starts —
    // before the display metadata, whose write may fail.
    if (resultFile) await setAgentResultInterrupted(resultFile, true);
    if (assignment && resultFile) await publishSessionMeta(ctx);
  });

  pi.on('message_end', async (event) => {
    if (!resultFile || event.message.role !== 'assistant') return;
    const output = assistantText(event.message);
    if (output.trim()) await appendAgentResult(resultFile, output);
  });

  // message_end runs before persistence; turn_end sees the finalized context.
  pi.on('turn_end', async (_event, ctx) => {
    const usage = ctx.getContextUsage();
    context = usage
      ? { tokens: usage.tokens, contextWindow: usage.contextWindow }
      : undefined;
    await publishSessionMeta(ctx);
  });

  // Compaction makes the published count stale; Pi still reports the window.
  pi.on('session_compact', async (_event, ctx) => {
    const contextWindow =
      ctx.getContextUsage()?.contextWindow ?? context?.contextWindow;
    context = contextWindow ? { tokens: null, contextWindow } : undefined;
    await publishSessionMeta(ctx);
  });

  // Herdr reports idle after errors too; preserve partial text for a manual retry.
  pi.on('agent_before_settle', async (event) => {
    if (!resultFile) return;
    await setAgentResultInterrupted(resultFile, event.outcome !== 'completed');
  });

  pi.registerTool({
    name: ASK_QUESTION_TOOL,
    label: 'Ask Orchestrator',
    exposure: 'model-only',
    description:
      'Ask the Orchestrator one question when requirements are ambiguous or a decision would materially change scope. End your turn immediately after calling this; the answer arrives as your next prompt.',
    promptSnippet:
      'Ask the Orchestrator a single clarifying question instead of guessing.',
    promptGuidelines: [
      'Call ask_question only for genuine ambiguity or a scope-changing decision, not for details you can settle by reading the repo.',
      'After ask_question, end the turn immediately: no other tool calls and no HERDR_RESULT.',
    ],
    parameters: Type.Object({
      question: Type.String({
        description:
          'One specific question. Include the options you see and what you would pick by default.',
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const question = params.question.trim();
      if (!question) {
        return textResult('question must not be empty.', {}, true);
      }

      // Without a managed result file there is no channel back to the
      // Orchestrator, so asking would silently strand the agent.
      const written = await writeAgentQuestion(resultFile, question);
      if (!written) {
        return textResult(
          'No Orchestrator channel is available in this session, so the question cannot be delivered. Decide yourself, state the assumption you made, and continue.',
          {},
          true,
        );
      }

      if (ctx) await publishSessionMeta(ctx);

      return {
        ...textResult(
          'Question sent to the Orchestrator. The answer will arrive as your next prompt.',
          { delivered: true },
        ),
        terminate: true,
      };
    },
  });
}
