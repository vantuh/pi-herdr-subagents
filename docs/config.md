# Configuration

User settings live in one JSON file, `herdr-agents.json`, in the Pi agent
directory. The default path is `~/.pi/agent/herdr-agents.json`.

The file is read on every spawn. It is not part of the `herdr_agent` tool
schema. Source: `src/config.ts`.

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

Do not change `layout` while agents are live. Existing agents stay visible and
closable through `/herdr-agents`, but status checks and reuse only find agents of the layout
now in the file.

`workspace.label` must not be the label of the Orchestrator's own workspace.
A match fails the spawn and leaves the Orchestrator workspace unchanged.

## Not in this file

Wait timeout (600 s), profile `model` / `thinking` / `tools`, and state-file
paths are not JSON settings. `HERDR_AGENTS_STATE_PATH`,
`HERDR_AGENTS_LOCK_WAIT_MS`, and `HERDR_AGENTS_CLAIM_LEASE_MS` are environment
variables for tests and debugging.
