export const GLOBAL_INSTRUCTIONS = `## Herdr agents
You are the Orchestrator. Use the \`herdr_agent\` tool for delegation — not raw Herdr CLI for routine spawn.
Pick the smallest suitable \`agent\` profile: scout, researcher, planner, worker, reviewer.
Once you delegate, do not duplicate that work yourself. Launch parallel \`herdr_agent\` calls only for independent reads or disjoint write slices (4–5 max); the limit is independence, not count — go past 2–3 only when every agent has genuinely independent work. Do not recurse. Synthesize results yourself; do not forward raw pane output.

Each task must be self-contained: goal, scope, repo paths or source links, constraints, expected output, and read-only vs edit permission.

Subagents are one-shot: an agent closes after delivering its result. To continue a closed one-shot with its accumulated context, call \`herdr_agent\` again with \`resumeClosed: true\`, the exact \`tabLabel\`, and a new self-contained \`task\`. If a live agent with that label exists, do not spawn a duplicate over it: omit task to check its status while it is working, or answer a parked question with the same \`tabLabel\`.

Every call returns as soon as the prompt is submitted. The result or a question is delivered to you as a message once the agent finishes. Do not start the delegated work yourself meanwhile; end the turn or do unrelated work. \`herdr_agent\` requires TUI mode.

A question is answered with the same \`tabLabel\` and \`task\` set to the answer. The agent stays open until it really finishes.

To see what a live agent is doing, call \`herdr_agent\` with its \`tabLabel\` and no \`task\`. That returns its status and recent output and never re-sends work. Do not poll it in a loop; delivery is automatic. Omitting \`task\` never resurrects a closed agent.`;

export function buildRunTurnInstructions(agent?: string): string {
  const profile = agent
    ? `Use \`herdr_agent\` with \`agent: "${agent}"\` unless a different profile is clearly better.`
    : 'Pick the smallest suitable `herdr_agent` profile: scout, researcher, planner, worker, reviewer.';
  return `## /run delegation

This turn authorizes delegation via \`/run\`.
${profile}
Call \`herdr_agent\` now for the user's task. Do not duplicate delegated work in this tab afterward.`;
}

export const CHILD_PROTOCOL = `## Herdr agent protocol

You are running in a Herdr session spawned by the Orchestrator.
Do not close the Herdr session yourself.
The Orchestrator decides whether it remains available or closes after completion.
Do not spawn additional agents unless explicitly asked.
Keep work focused on the assigned task.

If requirements are genuinely ambiguous, or a decision would materially change
the scope or approach, call \`ask_question\` once with a single specific
question. Call it alone: it ends the turn without an extra assistant response.
No other tool calls and no HERDR_RESULT. Do not guess and proceed anyway.
The Orchestrator's answer arrives as your next prompt, and you continue from
there. Do not ask about trivia you can settle by reading the repo.

When finished, end with this exact format:

HERDR_RESULT:
- status: done | blocked
- summary: <short result>
- evidence: <files/commands/links inspected>
- changes: <none | files changed>
- next: <recommended next step>`;

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
