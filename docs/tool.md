# `herdr_agent` tool reference

This document describes the `herdr_agent` tool as the Orchestrator model sees it. Sources: `src/index.ts` (`registerHerdrAgentTool`), `src/tool/execute.ts` (`executeHerdrAgent` entry point), `src/tool/spawn/` (spawn flow), `src/tool/schema.ts`, `src/prompts.ts`.

The document has two parts:

1. **Exposed tool contract** — what Pi registers: name, description, parameter schema. This is the contract.
2. **Injected instructions** — extra system-prompt text the extension appends. It guides usage but is not part of the tool definition.

## 1. Exposed tool contract

### Registration

| Field | Value |
|---|---|
| `name` | `herdr_agent` |
| `label` | `Herdr Agent` |
| `description` | `Spawn a one-shot Herdr agent with a named profile from ~/.pi/agent/agents. Agents close after delivering their result; continue a closed one-shot with its context via resumeClosed and the same tabLabel.` |
| `promptSnippet` | `Delegate exploration, research, planning, review, and isolated implementation to a one-shot Herdr agent.` |
| `promptGuidelines` | `Use herdr_agent when isolated context helps, after /run, or on an explicit delegation request.` and `Follow the Herdr agents system instructions for self-contained tasks, independent parallel calls, avoiding duplicate work, status checks, and resume.` |

The tool is registered with a static `agent` description at load. On `session_start` (including `/reload`) it is registered again, replacing the first registration, with the profile names discovered from the working directory appended as ` Available: a, b, c.` Profiles with `disable-model-invocation` are left out of that listing but can still be spawned by exact name.

Child Pi panes (`HERDR_AGENT_CHILD=1`) never get this tool.

### Parameters

Only `agent` is required by the schema. Some modes require more fields at runtime (see the table).

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `agent` | string | yes | — | Profile name from `~/.pi/agent/agents/*.md` (project profiles in `.pi/agents/` override same-named user profiles). Schema description: `Agent profile name from ~/.pi/agent/agents/*.md or the project .pi/agents.` plus the dynamic `Available:` list. |
| `task` | string | no | — | Self-contained task for the agent. Omit it to check a live agent matched by `tabLabel`: the call returns status and a preview of the latest captured assistant text, and does not send a new prompt. |
| `tabLabel` | string | no* | Title-cased profile name, e.g. `Researcher` | Agent label. Identifies the agent for status checks, parked-question answers and `resumeClosed`. *Required when `task` is omitted, and when `resumeClosed` is `true`. |
| `resumeClosed` | boolean | no | `false` | Continue a closed one-shot with its prior context. Requires a non-empty `task` and an explicit `tabLabel`. Never resumes over a live agent. |

There are no `layout`, `lifecycle`, `wait`, or `timeoutMs` parameters. Layout comes from `herdr-agents.json` ([config.md](config.md)). A call with a task returns when the prompt is submitted; the widget poller delivers the outcome. A status check returns right after its lookup.

### Modes

The mode is picked from `task`, `resumeClosed` and what is already live under the label.

| Call | Mode |
|---|---|
| `task`, no live agent under the label | Fresh spawn |
| no `task`, `tabLabel` | Status check on a live agent |
| `task` + same `tabLabel` as a live agent that parked a question | Answer a parked question |
| `task` + `tabLabel` + `resumeClosed: true`, agent closed | Resume a closed one-shot |

#### Fresh spawn

Starts a new child Pi in a new Herdr target (a tab in the subagents workspace by default), sends the task, and returns `Herdr agent <label> started (<paneId>).` The widget poller later delivers the outcome as a `herdr_agent_result` or `herdr_agent_question` message, exactly once. A result is delivered only when the child wrote a non-empty result artifact; a question only when it wrote `question.md`. One-shot targets are closed when the result is delivered. If the agent settles with no artifact the poller delivers nothing and keeps the agent. A status check then reports that the agent finished without a result.

If the label is taken by a live managed agent, a default label gets a suffix (for example `Researcher #2`), while an explicit `tabLabel` is rejected (see [Live agent with the same label](#live-agent-with-the-same-label)). A label that only matches some other tab gets a suffix either way.

```json
{ "agent": "scout", "task": "Find where session tokens are validated. Read-only. Return file paths with line numbers." }
```

```json
{ "agent": "reviewer", "tabLabel": "Diff review", "task": "Review the current diff for regressions. Read-only." }
```

#### Status check

Omit `task` and pass the `tabLabel` of a live agent. No prompt is sent, and nothing is claimed, closed, or resumed.

```json
{ "agent": "scout", "tabLabel": "Scout" }
```

Notes:

- A working or blocked agent returns `status: <herdr status>`, plus `Latest assistant text (preview; not a completion):` with the child's most recent captured text when it has written any. The preview is display-capped at the last 30 lines / 2k characters, marked `… (truncated)`, and its content is otherwise untouched. Pane scrollback is never read.
- A parked question returns the question text with `status: "question"` and `closed: false`.
- A settled agent with no result artifact returns `finished without a result`, with no preview. The agent stays open.
- An agent whose outcome was already delivered returns that it was already collected. If the target is still open, close it with `/herdr-agents`, then continue with `resumeClosed`.
- A blank `task` is treated as omitted.
- Errors: `tabLabel is required when task is omitted.` and `No running Herdr agent named "<label>" found.`
- Omitting `task` never reopens a closed agent. Use `resumeClosed` for that.

#### Answer a parked question

A child may call `ask_question` instead of finishing. The delivered `herdr_agent_question` message reads:

```text
Herdr agent <label> (<agent>) asked a question instead of finishing:

<question>

The agent is still open and waiting. Answer it by calling herdr_agent again
with tabLabel "<label>" and task set to your answer.
Answer from your own context, or ask the user if the decision is theirs.
```

Answer with a normal task call using the same label. The answer goes into the same pane, so the agent keeps its context. `resumeClosed` is not needed.

```json
{ "agent": "scout", "tabLabel": "Scout", "task": "Use the v2 API only." }
```

The parked agent stays open until it really finishes, even though it is a one-shot.

#### Resume a closed one-shot

Continues a closed one-shot in a new child that reopens the archived Pi session, so it keeps its earlier conversation.

```json
{ "agent": "worker", "tabLabel": "Auth refactor", "resumeClosed": true, "task": "Also update the unit tests for the new signature." }
```

Rules checked by `execute`:

- `task` must be non-empty and `tabLabel` must be explicit (not defaulted).
- `tabLabel` must match exactly a closed one-shot owned by this Orchestrator session.
- `agent` must be the same profile the closed agent used.
- The archived session file and working directory must still exist. Otherwise the history entry is marked invalid and the call fails.
- A closed agent that is already being resumed cannot be claimed again.
- `resumeClosed` never resumes over a live agent. A working agent, an agent still open, or a settled result that has not been delivered is rejected with guidance (check status, or wait for delivery). A parked question is the exception: it is answered in place.

#### Live agent with the same label

A `task` with an explicit `tabLabel` that matches a live agent, without `resumeClosed`, and not a parked question, is rejected so no duplicate is spawned:

```text
A live Herdr agent named "<label>" already exists and cannot receive a new task. …
```

Fix: check its status, wait for delivery and then use `resumeClosed`, or choose a different `tabLabel`.

### TUI requirement

Every call, including a status check, requires TUI mode. RPC, JSON, and print sessions return `herdr_agent requires TUI mode. Non-TUI sessions have no widget poller to deliver the result.` before any Herdr call. RPC can report `hasUI`, and that still has no widget collector.

### Results

The tool call itself returns text as soon as the prompt is submitted. The child's output arrives later as a custom message. `details` carries metadata.

| Outcome | Text | Notable `details` |
|---|---|---|
| Start | `Herdr agent <label> started (<paneId>).` | `tabId`, `paneId`, `tabLabel`, `reused`, `agent`, optional `resumed`, optional `spawnWarnings` |
| Delivered result (`herdr_agent_result`) | The captured assistant text. A failed close appends `Warning: failed to close one-shot Herdr agent <label>: <error>` | `tabLabel`, `agent`, `paneId` |
| Delivered question (`herdr_agent_question`) | The question text above | `tabLabel`, `agent`, `paneId`, `question` |
| Status check | `Herdr agent <label> (<paneId>) status: <status>.`, optionally followed by the assistant-text preview, or the question text, or `finished without a result` | `tabId`, `paneId`, `tabLabel`, `agent`, `status`; a question also sets `closed: false` |
| Profile warnings | Appended `Spawn warnings:` list (unknown thinking level, ignored skills) | `spawnWarnings` |

### Errors

Returned with `isError: true`:

| Condition | Message (start) |
|---|---|
| Unknown profile | `Unknown Herdr agent: <name>. Available: …` (`details.availableAgents`) |
| Non-TUI session | `herdr_agent requires TUI mode. …` |
| `resumeClosed` without `task` | `resumeClosed requires a non-empty task. …` |
| `resumeClosed` without `tabLabel` | `resumeClosed requires an explicit non-empty tabLabel.` |
| No owned closed agent | `No closed one-shot Herdr agent named "<label>" is owned by this Orchestrator session.` |
| Profile mismatch on resume | `Closed Herdr agent "<label>" was a <profile> agent, not <agent>.` |
| Resume already claimed | `Closed Herdr agent "<label>" is already being resumed.` |
| Archive unusable | `Cannot resume "<label>": …` |
| `resumeClosed` over live agent | `A live Herdr agent named "<label>" is still working. …` / `… already settled and is waiting to be delivered. …` / `… is still open. …` |
| Status-check target missing or no `tabLabel` | See [Status check](#status-check) |
| Task to a live agent by label | See [Live agent with the same label](#live-agent-with-the-same-label) |
| `workspace.label` equals the Orchestrator's own workspace | `The configured workspace.label matches this Orchestrator's own workspace. …` |

Herdr CLI failures and malformed Herdr output are thrown as tool errors with the Herdr message.

## 2. Injected instructions (not part of the tool schema)

On every Orchestrator turn the extension appends `GLOBAL_INSTRUCTIONS` (`src/prompts.ts`) to the system prompt through `before_agent_start`. It repeats the usage rules above and adds policy that is not enforced by the schema:

- Use `herdr_agent` for delegation instead of raw Herdr CLI commands.
- Pick the smallest suitable profile from the `Available:` list; the instructions name no profiles.
- Do not duplicate delegated work. Do not recurse.
- Run parallel calls only for independent reads or disjoint write slices (4–5 at most).
- Make each task self-contained: goal, scope, paths or links, constraints, expected output, read-only vs edit permission.
- Synthesize results yourself; do not forward raw pane output.
- Every call returns when the prompt is submitted. Do not start the delegated work yourself meanwhile; end the turn or do unrelated work. The result or question arrives as a message. `herdr_agent` requires TUI mode.

For the user message that `/run` sends, `buildRunTurnInstructions` adds a one-turn note that authorizes delegation for the user's task.

The child receives its own protocol (`CHILD_PROTOCOL`): finish with a `HERDR_RESULT:` block (`status`, `summary`, `evidence`, `changes`, `next`), or call `ask_question` once when requirements are genuinely ambiguous. The `HERDR_RESULT:` format is only requested; the extension does not validate it, so a result may lack it.
