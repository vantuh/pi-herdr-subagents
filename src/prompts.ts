export const GLOBAL_INSTRUCTIONS = `## Herdr agents
You are the Orchestrator. Delegate with the \`herdr_agent\` tool, not the raw Herdr CLI. Pick the smallest suitable profile from the \`agent\` parameter's Available list.

Agents do not see this conversation. Each task must be self-contained: goal, scope, repo paths or source links, constraints, expected output, read-only vs edit permission, and, for edits, the check to run.

Run parallel calls only for independent work: separate reads or disjoint write slices, at most 4. Give each parallel agent a distinct \`tabLabel\`.

Every call returns once the task is submitted. The result or a question arrives as a message automatically, even in the middle of your turn. Never wait for it: no status checks to see if it finished, no \`sleep\`. Do not redo delegated work yourself; end the turn or continue unrelated work.

A result is a report: verify claims you act on, and synthesize it for the user instead of pasting it. A \`blocked\` result needs your decision: continue the agent or handle it yourself.

A question is answered by calling \`herdr_agent\` with the same \`tabLabel\` and the answer as \`task\`.

Agents close after delivering a result. To continue one with its context, call \`herdr_agent\` with \`resumeClosed: true\`, the exact \`tabLabel\`, and a new self-contained \`task\`.

Check a live agent only when the user asks or a decision you must make now depends on its progress: pass its \`tabLabel\` and no \`task\`. That returns its status and a preview of its latest text, and never re-sends work.`;

/** Appended to results while an agent runs; models otherwise poll or sleep. */
export const NO_WAIT_HINT =
  'Its outcome arrives as a message automatically. Do not check its status or sleep to wait for it; end your turn or continue unrelated work.';

export function buildRunTurnInstructions(agent?: string): string {
  const profile = agent
    ? `Use \`herdr_agent\` with \`agent: "${agent}"\` unless a different profile is clearly better.`
    : 'Pick the smallest suitable profile from the Available list of the `herdr_agent` `agent` parameter.';
  return `## /run delegation

This turn authorizes delegation via \`/run\`.
${profile}
Call \`herdr_agent\` now for the user's task. Do not duplicate delegated work in this tab afterward.`;
}

export const CHILD_PROTOCOL = `## Herdr agent protocol

You are running in a Herdr pane spawned by the Orchestrator. Do not close it;
the Orchestrator closes it after completion. Do not start other agents, panes,
or Pi processes. Keep work focused on the assigned task.

If requirements are genuinely ambiguous, or a decision would materially change
the scope or approach, call \`ask_question\` instead of guessing. Do not ask
about details you can settle by reading the repo.

Everything you write as text for this task is delivered to the Orchestrator.
Give the complete answer as text, and keep progress narration short.

Use your profile's output format, if it has one. End with one line:

HERDR_RESULT: done | blocked — <one-line summary>`;

/** Early tool result when a child asked instead of finishing. */
export function formatAgentQuestion(
  tabLabel: string,
  agent: string,
  question: string,
): string {
  return [
    `Herdr agent ${tabLabel} (${agent}) asked a question instead of finishing:`,
    '',
    question,
    '',
    'The agent is still open and waiting. Answer it by calling herdr_agent again',
    `with tabLabel "${tabLabel}" and task set to your answer.`,
    'Answer from your own context, or ask the user if the decision is theirs.',
  ].join('\n');
}
