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
Use `lifecycle: "oneshot"` for one-off tasks that should close after completion; this is the default.
Use `lifecycle: "persistent"` when a role should stay available for follow-up tasks or accumulate context. The tool reuses a matching persistent tab automatically.
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
  "timeoutMs": 600000,
  "lifecycle": "oneshot"
}
```

The task must be self-contained because newly created child Pi sessions start with fresh context and do not inherit the Orchestrator conversation.

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

## 6. The extension creates or reuses a Herdr target

Layout is internal configuration and is not exposed in `herdr_agent` parameters. `HERDR_AGENTS_LAYOUT` accepts `pane` or `tab`; unset and unsupported values use `pane`.

In default pane mode, the first agent splits the Orchestrator pane to the right with ratio `0.6`, leaving the new agent 40%:

```bash
herdr pane split <orchestrator-pane> --direction right --ratio 0.6 --no-focus
```

Additional agents split the largest managed pane downward, keeping them in the right column. The extension then uses `layout.set_split_ratio` to give every managed agent equal height, and repeats that rebalance after an agent closes. Placement and label allocation are serialized across parallel tool calls.

Legacy tab mode creates a sibling tab as before:

```bash
herdr tab create --workspace <workspace-id> --label <label> --no-focus
```

`lifecycle: "oneshot"` always creates a fresh target. `lifecycle: "persistent"` first looks for a managed agent with the exact requested `tabLabel`; pane mode searches the Orchestrator tab and tab mode searches sibling tabs. The default label is the title-cased profile name. Duplicate fresh labels receive `#2`, `#3`, etc.

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

If `wait` is false, the tool returns after starting/sending the task. This is only valid for `lifecycle: "persistent"`; `lifecycle: "oneshot"` requires waiting so the extension can close the tab.

If `wait` is true, the extension:

1. emits `pi.events.emit("herdr:blocked", { active: true, label })`;
2. waits for the child pane to finish;
3. reads recent unwrapped output;
4. emits `pi.events.emit("herdr:blocked", { active: false, label })`.

The `herdr:blocked` event is consumed by Herdr's installed Pi state extension. It lets the Herdr UI show that the Orchestrator is blocked while waiting for a child.

### Re-waiting after a timeout

`timeoutMs` (default 600000ms / 10 minutes) bounds a single tool call's wait, not the child agent's
lifetime. A large delegated task (e.g. spinning up testcontainers and iterating on e2e tests) can
legitimately still be `working` when the tool call times out.

To continue waiting on the same tab without starting a new one or re-sending the task, call
`herdr_agent` again with the same `tabLabel` and `task` omitted. This re-wait mode:

- looks up the existing tab by exact `tabLabel` (any lifecycle, not just persistent);
- does not call `pane run` — it never sends a new prompt into the pane;
- waits (respecting `wait`/`timeoutMs` as usual) and returns the pane's current output.

This avoids two bad alternatives: assuming the timeout means failure, or falling back to raw
`herdr wait agent-status`/`herdr pane read` bash commands to poll the same pane manually.

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

For a **reused** persistent tab, an extra safeguard applies: `waitForAgentFinished` is called with
`requireActiveFirst: true`. Sending a new task to an already-running pane (`pane run`) does not
immediately change Herdr's reported `agent_status` — it can still show `done`/`idle` from the
*previous* task for a moment, before the child Pi process picks up the new prompt and reports
`working`. With `requireActiveFirst: true`, the wait loop ignores `done`/`idle` until it has
observed `working`/`blocked` at least once, so it can't mistake the previous task's leftover
status for completion of the new one. Freshly created tabs don't need this, since there is no
previous task whose status could leak through.

## 11. The extension reads child output

After completion:

```bash
herdr pane read <pane-id> --source recent-unwrapped --lines 180
```

The tool returns that text to the Orchestrator.

The Orchestrator is expected to synthesize the result, not blindly forward it.

## 12. The extension keeps or closes the tab

For `lifecycle: "persistent"`, the extension leaves the managed pane or tab open after completion.

This is intentional:

- the user can inspect child reasoning/output;
- the Orchestrator can reuse a tab later;
- Herdr works as a visible persistent workspace, not a hidden subprocess runner.

For `lifecycle: "oneshot"`, the extension closes only the target created by the current tool call after it has successfully waited and read output: `pane close` in pane mode or `tab close` in tab mode.

Timeout, abort, or execution errors leave the one-shot target open for debugging.

If closing fails after output was read, the tool still returns the agent output with a warning and leaves the target open for debugging.
