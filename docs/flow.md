# herdr_agent flow

This document describes the runtime flow of the `herdr_agent` tool.

## 1. Pi loads the extension

Pi loads the extension from the symlinked extension directory:

```text
~/.pi/agent/extensions/herdr-agents/index.ts
```

`index.ts` runs in Orchestrator or child mode. `HERDR_AGENT_CHILD=1` prevents recursive delegation tools inside child panes, but child mode still registers a small result-writer hook. On each assistant `message_end`, that hook writes the latest finalized response to the result artifact named in the task prompt.

## 2. The Orchestrator receives global guidance

The extension appends Orchestrator guidance from `constants.ts` through `before_agent_start` (abridged here):

```md
When isolated context helps, use the `herdr_agent` tool instead of raw Herdr CLI commands.
Pick the smallest suitable agent profile.
Use `lifecycle: "oneshot"` for one-off tasks that should close after completion; this is the default.
Use `lifecycle: "persistent"` when a role should stay available for follow-up tasks or accumulate context. The tool reuses a matching managed target automatically.
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

`herdr.ts` bootstraps discovery with one machine-readable snapshot:

```bash
herdr api snapshot
```

The snapshot contains panes, tabs, agents, focused IDs, layout metadata, and protocol/version information. The extension prefers `HERDR_PANE_ID` over the snapshot's focused pane.

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

Additional agents split the largest managed pane downward, keeping them in the right column. The extension then uses `layout.set_split_ratio` to give every managed agent equal height, and repeats that rebalance after an agent closes. For new pane agents, the placement lock remains held through `agent start`, managed-state recording, and rebalancing; this ensures parallel calls see previously created agents before choosing a split direction or label.

Legacy tab mode creates a sibling tab as before:

```bash
herdr tab create --workspace <workspace-id> --label <label> --no-focus
```

`lifecycle: "oneshot"` always creates a fresh target. `lifecycle: "persistent"` first looks for a managed agent with the exact requested `tabLabel`; pane mode searches the Orchestrator tab and tab mode searches sibling tabs. The default label is the title-cased profile name. Duplicate fresh labels receive `#2`, `#3`, etc.

## 7. The extension prepares prompts and a result artifact

The extension writes `system.md` and reserves `result.md` in one private `${TMPDIR}/herdr-agent-*` directory (`os.tmpdir()` in Node). The task is submitted directly through the Herdr agent API and includes the result path marker. Before every prompt, the parent removes any previous `result.md`; child mode then writes each non-empty finalized assistant message without requiring the profile to have a `write` tool. If a turn produces no artifact, result collection falls back to terminal output instead of returning stale persistent-agent content.

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

The new pane/tab shell is created with `HERDR_AGENT_CHILD=1` and `PROCESS_LAUNCHED_BY_Q=1`. The child marker makes the zsh history configuration select `HISTFILE=/dev/null`; setting `HISTFILE` through `--env` is insufficient because zsh initializes that special parameter itself. `PROCESS_LAUNCHED_BY_Q` prevents Kiro CLI's nested terminal wrapper from replacing the real shell, which keeps the pane compatible with `herdr agent start`. A fresh Pi is then started through Herdr's agent lifecycle API:

```bash
herdr agent start <short-unique-name> --kind pi --pane <pane-id> -- \
  --name '<tab-label>' \
  --model '<profile-model>' \
  --tools '<profile-tools>' \
  --append-system-prompt '<system.md>'
```

`agent start` waits until Herdr detects Pi and it is ready for input. The short automation name matches `[a-z][a-z0-9_-]{0,31}` and is persisted separately from the human-readable label. Existing legacy agents without such a name fall back to their pane ID.

## 9. The Orchestrator waits

If `wait` is false, the tool returns after starting/sending the task. This is only valid for `lifecycle: "persistent"`; `lifecycle: "oneshot"` requires waiting so the extension can close the managed target.

Every task is submitted through `herdr agent prompt` **without** `--wait`. Herdr's `agent prompt --wait` hardcodes a 5s post-submit lifecycle gate and returns `agent_prompt_stalled` when Pi is slow to leave idle — often looking like "text pasted, Enter never pressed".

If `wait` is true, the extension instead:

```bash
herdr agent get <name-or-pane>          # snapshot state_change_seq
herdr agent prompt <name-or-pane> '<task>'
# poll up to 30s for working/blocked, or a newer idle/done seq;
# after 5s with no change, nudge once: herdr agent send-keys <target> enter
herdr agent wait <name-or-pane> \
  --until idle --until done --timeout <ms>
```

Waiting for `working` (or a newer settled `state_change_seq`) before accepting `idle`/`done` preserves the no-stale-completion guarantee that atomic `--wait` used to provide. The extension emits `herdr:blocked` around that wait. `blocked` is deliberately not a completion state because it usually means the child needs approval or an answer.

The `herdr:blocked` event is consumed by Herdr's installed Pi state extension. It lets the Herdr UI show that the Orchestrator is blocked while waiting for a child.

### Re-waiting after a timeout

`timeoutMs` (default 600000ms / 10 minutes) bounds a single tool call's wait, not the child agent's
lifetime. A large delegated task (e.g. spinning up testcontainers and iterating on e2e tests) can
legitimately still be `working` when the tool call times out.

To continue waiting on the same managed target without starting a new one or re-sending the task, call
`herdr_agent` again with the same `tabLabel` and `task` omitted. This re-wait mode:

- looks up the existing managed pane or tab by exact `tabLabel` (any lifecycle, not just persistent);
- does not send a new prompt into the pane;
- calls `herdr agent wait --until idle --until done` against the saved automation name (or legacy pane ID);
- returns the saved result artifact, with terminal output as fallback;
- closes a successfully recovered one-shot target.

This avoids two bad alternatives: assuming the timeout means failure, or falling back to raw
`herdr wait agent-status`/`herdr pane read` bash commands to poll the same pane manually.

## 10. Completion detection

Completion detection is delegated to Herdr 0.7.5's server-owned agent waits. Prompt acceptance requires an observed `working`/`blocked` state (or an increased `state_change_seq` that lands on `idle`/`done`) so a reused agent's previous settled state cannot satisfy a newly submitted prompt. Standalone `agent wait` pins the current pane occupant, so a replacement process cannot accidentally satisfy a re-wait.

## 11. The extension reads child output

After completion, the extension first reads the agent's `result.md` artifact. This avoids terminal scrollback limits and alternate-screen loss. If the artifact is absent—for example, for a legacy child started before this feature—it falls back to:

```bash
herdr agent read <name-or-pane> --source recent-unwrapped --lines 180
```

The tool returns that text to the Orchestrator.

The Orchestrator is expected to synthesize the result, not blindly forward it.

## 12. The extension keeps or closes the target

For `lifecycle: "persistent"`, the extension leaves the managed pane or tab and its temp directory available after completion.

This is intentional:

- the user can inspect child reasoning/output;
- the Orchestrator can reuse the managed target later;
- Herdr works as a visible persistent workspace, not a hidden subprocess runner.

For `lifecycle: "oneshot"`, the extension closes only the target created by the current tool call after it has successfully waited and read output: `pane close` in pane mode or `tab close` in tab mode. After a successful close, it removes that agent's temp directory. Closing a managed persistent agent through `/herdr-agents` also removes its temp directory.

Timeout, abort, or execution errors leave the one-shot target open for debugging.

If closing fails after output was read, the tool still returns the agent output with a warning and leaves the target open for debugging.
