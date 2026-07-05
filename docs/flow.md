# herdr_agent flow

This document describes the runtime flow of the `herdr_agent` tool.

## 1. Pi loads the extension

Pi loads the extension from the symlinked extension directory:

```text
~/.pi/agent/extensions/herdr-agents/index.ts
```

`index.ts` runs unless `HERDR_AGENT_CHILD=1` is set.

If this is a child process, the extension returns early:

```ts
if (process.env.HERDR_AGENT_CHILD === "1") return;
```

This prevents recursive delegation tools inside child panes.

## 2. The Orchestrator receives global guidance

The extension appends a short system instruction through `before_agent_start`:

```md
When isolated context helps, use the `herdr_agent` tool instead of raw Herdr CLI commands.
Pick the smallest suitable agent profile.
Keep Herdr tabs persistent. Do not close delegated tabs or panes.
The current tab is Orchestrator.
Synthesize Herdr agent results yourself; do not blindly forward output.
```

This replaces the older approach where the full Herdr workflow lived in the global `AGENTS.md`.

## 3. The model calls `herdr_agent`

Example:

```json
{
  "agent": "reviewer",
  "tabLabel": "HR Correctness",
  "task": "Review the current diff for correctness and regressions. Return concise findings with file/line evidence.",
  "wait": true,
  "timeoutMs": 600000
}
```

The task must be self-contained because the child Pi session starts with fresh context and does not inherit the Orchestrator conversation.

## 4. The extension discovers agent profiles

`agents.ts` reads profiles from:

1. global user profiles: `~/.pi/agent/agents/*.md`;
2. nearest project profiles: `<repo>/.pi/agents/*.md`, if present.

Project profiles override user profiles with the same `name`.

The profile supplies:

- child model;
- child tool allowlist;
- child role/system instructions.

## 5. The extension identifies the Orchestrator pane

`herdr.ts` calls:

```bash
herdr pane list
```

It prefers `HERDR_PANE_ID` over the focused pane.

Reason: focus can move while a tool is running. `HERDR_PANE_ID` identifies the actual pane running the Orchestrator Pi process.

The extension then renames that tab:

```bash
herdr tab rename <current-tab> Orchestrator
```

## 6. The extension creates or reuses a Herdr tab

If `reuseExisting` is true, the extension looks for an existing tab with the requested `tabLabel`.

Otherwise it creates a new tab in the same workspace:

```bash
herdr tab create --workspace <workspace-id> --label <tab-label> --no-focus
```

`--no-focus` keeps the user's active pane stable.

If a tab label already exists, the extension appends `#2`, `#3`, etc.

## 7. The extension writes temporary prompt files

Two temp files are written under `/tmp/herdr-agent-*`:

1. `system.md` — agent profile body plus the Herdr child protocol;
2. `task.md` — the self-contained task from the Orchestrator.

The child protocol requires a final report:

```md
HERDR_RESULT:
- status: done | blocked
- summary: <short result>
- evidence: <files/commands/links inspected>
- changes: <none | files changed>
- next: <recommended next step>
```

## 8. The extension starts child Pi

For a fresh tab, the extension runs a command like:

```bash
cd '<cwd>' && HERDR_AGENT_CHILD=1 pi \
  --name '<tab-label>' \
  --model '<profile-model>' \
  --tools '<profile-tools>' \
  --append-system-prompt '<system.md>' \
  '@<task.md>'
```

Important details:

- `HERDR_AGENT_CHILD=1` disables this extension in the child.
- `--append-system-prompt` preserves the normal Pi system prompt and adds the role prompt.
- `@<task.md>` sends the task file as the initial user prompt.
- The command is shell-quoted before being sent to Herdr.

For a reused tab, the extension sends `@<task.md>` to the existing pane.

## 9. The Orchestrator waits

If `wait` is false, the tool returns after starting/sending the task.

If `wait` is true, the extension:

1. emits `pi.events.emit("herdr:blocked", { active: true, label })`;
2. waits for the child pane to finish;
3. reads recent unwrapped output;
4. emits `pi.events.emit("herdr:blocked", { active: false, label })`.

The `herdr:blocked` event is consumed by Herdr's installed Pi state extension. It lets the Herdr UI show that the Orchestrator is blocked while waiting for a child.

## 10. Completion detection

Herdr has these relevant agent states:

- `working`;
- `blocked`;
- `done`;
- `idle`;
- `unknown`.

Originally the extension waited only for `done`:

```bash
herdr wait agent-status <pane> --status done
```

That caused a hang when the child had finished but Herdr showed it as `idle` instead of `done`.

Current behavior:

- return immediately on `done`;
- also treat `idle` as finished after a Pi agent has appeared in the pane and either:
  - it was previously `working` or `blocked`; or
  - enough time has passed for startup to complete.

This matches Herdr's behavior where `done` can become `idle` after the completed pane is observed.

## 11. The extension reads child output

After completion:

```bash
herdr pane read <pane-id> --source recent-unwrapped --lines 180
```

The tool returns that text to the Orchestrator.

The Orchestrator is expected to synthesize the result, not blindly forward it.

## 12. Persistent tab remains open

The extension never closes child tabs or panes.

This is intentional:

- the user can inspect child reasoning/output;
- the Orchestrator can reuse a tab later;
- Herdr works as a visible persistent workspace, not a hidden subprocess runner.
