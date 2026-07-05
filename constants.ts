export const GLOBAL_INSTRUCTIONS = `## Herdr agents

When isolated context helps, use the \`herdr_agent\` tool instead of raw Herdr CLI commands.
Pick the smallest suitable agent profile.
Keep Herdr tabs persistent. Do not close delegated tabs or panes.
The current tab is Orchestrator.
Synthesize Herdr agent results yourself; do not blindly forward output.`;

export const CHILD_PROTOCOL = `## Herdr persistent agent protocol

You are running in a persistent Herdr tab spawned by the Orchestrator.
Stay in this tab and do not close the tab or pane.
Do not spawn additional agents unless explicitly asked.
Keep work focused on the assigned task.

When finished, end with this exact format:

HERDR_RESULT:
- status: done | blocked
- summary: <short result>
- evidence: <files/commands/links inspected>
- changes: <none | files changed>
- next: <recommended next step>`;
