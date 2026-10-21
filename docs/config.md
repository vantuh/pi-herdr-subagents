# Configuration

User settings live in one JSON file, `pi-herdr-subagents.json`, in the Pi agent
directory. The default path is `~/.pi/agent/pi-herdr-subagents.json`.

The file is read once when the extension is loaded, so it is not re-read per
spawn. An edit takes effect on `/reload` (or after restarting Pi), never
mid-session. It is not part of the agent tool
schemas. Source: `src/config.ts`; schema: `src/config/schema.ts`.

## Example

Every field is optional. This file is the same as omitting the file:

```json
{
  "layout": "workspace",
  "workspace": { "label": "subagents" }
}
```

## Fields

Unknown keys are ignored. A missing file, invalid JSON, or a JSON value that
is not an object yields `{}`, so every field falls back to its default.

| Field | Format | Default | Behavior |
|---|---|---|---|
| `layout` | `"workspace"`, `"pane"`, or `"tab"` | `"workspace"` | Trimmed, case-insensitive. Any other value is dropped and the default is used. |
| `workspace.label` | string | `"subagents"` | Label of the dedicated agents workspace. Trimmed. A blank or non-string value uses the default. |

| `layout` | Where agents open |
|---|---|
| `workspace` | One tab per agent in the dedicated workspace. The workspace is created again if you close it. The Orchestrator's workspace gains no splits or tabs. |
| `pane` | The first agent splits the Orchestrator pane 60/40. Later agents stack in the right column. |
| `tab` | One tab per agent in the Orchestrator's current workspace. |

Do not change `layout` while agents are live. The running session keeps the old
layout until reload, and after that reload existing agents stay visible and
closable through `/agents`, but status checks and reuse only find agents of
the layout now in the file.

`workspace.label` must not be the label of the Orchestrator's own workspace.
A match fails the spawn and leaves the Orchestrator workspace unchanged.

## Storage names

All three storage names derive from the package name: this file, the state file
`pi-herdr-subagents-state.json` and the reports directory
`pi-herdr-subagents-results/`. The legacy names (`herdr-agents.json`,
`herdr-agents-state.json`, `herdr-agents-results/`) are migrated once when the
extension loads: the state file is renamed under the state lock and the reports
directory in the same parent. When both names exist the new one wins and the old
one stays untouched; a symlinked reports directory is refused. A failed rename
warns on stderr and never blocks the load.

This config file is not renamed at runtime: it is managed by chezmoi, so rename
its source and reload instead. Until then the extension reads only the new name
and starts with the defaults.

## Not in this file

Wait timeout (600 s), profile `model` / `thinking` / `tools`, and state-file
paths are not JSON settings. `PI_AGENTS_STATE_PATH`,
`PI_AGENTS_LOCK_WAIT_MS`, and `PI_AGENTS_CLAIM_LEASE_MS` are environment
variables for tests and debugging. The durable-report directory
(`<agent dir>/pi-herdr-subagents-results`) and its 30-day retention are not
configurable either: the directory follows `PI_CODING_AGENT_DIR`, and the
retention is the fixed `REPORT_TTL_DAYS` in `src/reports.ts`.

Agent control has no config key either. The ack deadlines (2000 ms for a steer,
3000 ms for a stop, a 25 ms poll), the child's 2000 ms abort-observation
window and the `control/` directory beside `result.md` are fixed in
`src/tool/control.ts`, `src/control.ts` and `src/child/control.ts`.
