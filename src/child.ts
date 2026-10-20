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
import { type ContextMetrics, isSessionCost } from './artifacts/schema.ts';
import { type ChildRunState, registerChildControl } from './child/control.ts';
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
  // Recomputed at every publish: the entries of a resumed session carry the
  // previous generation's usage, so this stays the whole session's total.
  const sessionCost = sumRecordedSessionCost(sessionManager.getEntries());
  return writeAgentSessionMeta(dest, {
    sessionId,
    cwd,
    updatedAt: new Date().toISOString(),
    ...(sessionFile ? { sessionFile } : {}),
    ...(context ? { context } : {}),
    ...(sessionCost !== undefined ? { sessionCost } : {}),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const NO_USAGE = 'no-usage';
const UNREADABLE_COST = 'unreadable-cost';

// Missing required usage makes the total incomplete; optional SDK usage may be absent.
function recordedCost(
  usage: unknown,
  optional: boolean,
): number | typeof NO_USAGE | typeof UNREADABLE_COST {
  if (usage === undefined) return optional ? NO_USAGE : UNREADABLE_COST;
  if (!isRecord(usage) || !isRecord(usage.cost)) return UNREADABLE_COST;
  const total = usage.cost.total;
  return isSessionCost(total) ? total : UNREADABLE_COST;
}

function entryCost(
  entry: unknown,
): number | typeof NO_USAGE | typeof UNREADABLE_COST {
  if (!isRecord(entry)) return NO_USAGE;
  if (entry.type === 'usage') return recordedCost(entry.usage, false);
  if (entry.type === 'branch_summary' || entry.type === 'compaction') {
    return recordedCost(entry.usage, true);
  }
  if (entry.type !== 'message' || !isRecord(entry.message)) return NO_USAGE;
  const message = entry.message;
  if (message.role === 'assistant') return recordedCost(message.usage, false);
  if (message.role === 'toolResult') {
    return recordedCost(message.usage, true);
  }
  return NO_USAGE;
}

// Recompute the full session so resumed and compacted history counts once.
// An unreadable recorded cost makes the full total unknown, not a partial sum.
function sumRecordedSessionCost(
  entries: readonly unknown[],
): number | undefined {
  let measured = false;
  let total = 0;
  for (const entry of entries) {
    const cost = entryCost(entry);
    if (cost === NO_USAGE) continue;
    if (cost === UNREADABLE_COST) return undefined;
    measured = true;
    total += cost;
  }
  return measured ? total : undefined;
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
  // Read by the control consumer: run state and the result-file channel.
  const run: ChildRunState = { active: false, runStartedAt: 0 };
  // Every metadata write republishes this sample, so a path-only publish never
  // erases it; a new assignment, session or compaction clears it first.
  let context: ContextMetrics | undefined;
  const publishSessionMeta = (ctx: ExtensionContext) =>
    captureChildSessionMeta(ctx, context);

  pi.on('session_start', async (_event, ctx) => {
    run.resultFile = undefined;
    run.context = undefined;
    context = undefined;
    await publishSessionMeta(ctx);
    await mirrorPaneLabelAsSessionName(pi);
  });

  pi.on('before_agent_start', async (event, ctx) => {
    run.context = ctx;
    // The freshness heuristic's reference point; continuations do not re-enter.
    run.runStartedAt = Date.now();
    const assignment = event.messageType === 'user';
    if (assignment) {
      run.resultFile = findResultFileMarker(event.prompt) ?? run.resultFile;
      // A new assignment invalidates the previous turn's measurement.
      context = undefined;
    }
    // Escape skips agent_before_settle, so block delivery before work starts —
    // before the display metadata, whose write may fail.
    if (run.resultFile) await setAgentResultInterrupted(run.resultFile, true);
    if (assignment && run.resultFile) await publishSessionMeta(ctx);
  });

  // A continuation fires agent_start again without an intervening settle, so
  // `active` covers the whole run.
  pi.on('agent_start', async (_event, ctx) => {
    run.active = true;
    run.context = ctx;
  });

  pi.on('agent_settled', async (event, ctx) => {
    run.active = false;
    run.context = ctx;
    // An abort that landed during agent_before_settle cleared the marker with a
    // completed boundary; the settle is the last chance to restore it.
    if (event.aborted) await setAgentResultInterrupted(run.resultFile, true);
  });

  pi.on('message_end', async (event) => {
    if (!run.resultFile || event.message.role !== 'assistant') return;
    const output = assistantText(event.message);
    if (output.trim()) await appendAgentResult(run.resultFile, output);
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
    if (!run.resultFile) return;
    await setAgentResultInterrupted(
      run.resultFile,
      event.outcome !== 'completed',
    );
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
      const written = await writeAgentQuestion(run.resultFile, question);
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

  // Last, so its `agent_settled` observation runs after the marker write above.
  registerChildControl(pi, run);
}
