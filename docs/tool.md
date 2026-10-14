# `herdr_agent` tool reference

This document describes the `herdr_agent` tool as the Orchestrator model sees it. Sources: `src/index.ts` (`registerHerdrAgentTool`, `execute`), `src/schema.ts`, `src/prompts.ts`.

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
| `promptGuidelines` | `Use herdr_agent when global Delegation says isolated context helps; call after /run, a named role, or explicit delegation request.` and `Follow the Herdr agents system instructions for self-contained tasks, independent parallel calls, avoiding duplicate work, re-wait, and resume.` |

The tool is registered with a static `agent` description at load. On `session_start` (including `/reload`) it is registered again, replacing the first registration, with the profile names discovered from the working directory appended as ` Available: a, b, c.` Profiles with `disable-model-invocation` are left out of that listing but can still be spawned by exact name.

Child Pi panes (`HERDR_AGENT_CHILD=1`) never get this tool.

### Parameters

Only `agent` is required by the schema. Some modes require more fields at runtime (see the table).

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `agent` | string | yes | — | Profile name from `~/.pi/agent/agents/*.md` (project profiles in `.pi/agents/` override same-named user profiles). Schema description: `Agent profile name from ~/.pi/agent/agents/*.md, e.g. researcher, scout, reviewer, planner, worker.` plus the dynamic `Available:` list. |
| `task` | string | no | — | Self-contained task for the agent. Omit it only to re-wait on a running agent. |
| `tabLabel` | string | no* | Title-cased profile name, e.g. `Researcher` | Agent label. Identifies the agent for re-wait, parked-question answers and `resumeClosed`. *Required when `task` is omitted, and when `resumeClosed` is `true`. |
| `wait` | boolean | no | `false` in UI sessions, `true` in headless sessions | `true` blocks until the agent finishes and returns its result. `false` returns once the prompt is accepted. |
| `resumeClosed` | boolean | no | `false` | Continue a closed one-shot with its prior context. Requires a non-empty `task` and an explicit `tabLabel`. |

Schema description of `wait`: *"Default: false — … Headless sessions require wait: true; an explicit false is rejected."* The headless default of `true` comes from `execute` (`params.wait ?? !ctx.hasUI`). The rejection applies to calls with a `task`; see [UI vs headless sessions](#ui-vs-headless-sessions).

There are no `layout`, `lifecycle` or `timeoutMs` parameters. Layout comes from `herdr-agents.json` ([config.md](config.md)). The wait timeout is fixed at 600 s.

### Modes

The mode is picked from `task`, `resumeClosed` and what is already live under the label.

| Call | Mode |
|---|---|
| `task`, no live agent under the label | Fresh spawn |
| no `task`, `tabLabel` | Re-wait on a live agent |
| `task` + same `tabLabel` as a live agent that parked a question | Answer a parked question |
| `task` + `tabLabel` + `resumeClosed: true`, agent closed | Resume a closed one-shot |

#### Fresh spawn

Starts a new child Pi in a new Herdr target (a tab in the subagents workspace by default), sends the task, and then:

- `wait: true` — blocks and returns the result (see [Results](#results)). The target closes after a successful result.
- `wait: false` — returns `Herdr agent <label> started (<paneId>).` The widget poller later delivers the outcome as a `herdr_agent_result` or `herdr_agent_question` message, exactly once. A result is delivered only when the child wrote a non-empty result artifact; a question only when it wrote `question.md`. One-shot targets are closed when the result is delivered. If the agent settles with no artifact (scrollback-only output), the poller delivers nothing and keeps the agent: collect it with a re-wait using `wait: true`, which reads the pane scrollback.

The label is made unique if needed (for example `Researcher #2`) when no `tabLabel` was given and the default label is taken.

```json
{ "agent": "scout", "task": "Find where session tokens are validated. Read-only. Return file paths with line numbers." }
```

```json
{ "agent": "reviewer", "tabLabel": "Diff review", "task": "Review the current diff for regressions. Read-only.", "wait": true }
```

#### Re-wait

Omit `task` and pass the `tabLabel` of a live agent. No prompt is sent. Use it when a previous call timed out, was aborted, or you need to block on a detached agent.

```json
{ "agent": "scout", "tabLabel": "Scout", "wait": true }
```

Notes:

- `wait` defaults to `false` in UI sessions. A re-wait with `wait: false` (or omitted in a UI session) does not block and does not inspect results or questions; it returns `Herdr agent <label> (<paneId>) is still running.` even if the agent has already settled. Pass `wait: true` to actually wait.
- Only a re-wait with `wait: true` collects. If the agent finished, its result is returned and a one-shot target is closed. If it parked a question, the question is returned. Output comes from the result artifact, else from the pane scrollback.
- Errors: `tabLabel is required when task is omitted (re-wait mode).` and `No running Herdr agent named "<label>" found to re-wait on.`
- Omitting `task` never reopens a closed agent. Use `resumeClosed` for that.

#### Answer a parked question

A child may call `ask_question` instead of finishing. The tool result (blocking call or delivered `herdr_agent_question` message) reads:

```text
Herdr agent <label> (<agent>) asked a question instead of finishing:

<question>

The agent is still open and waiting. Answer it by calling herdr_agent again
with tabLabel "<label>" and task set to your answer.
Answer from your own context, or ask the user if the decision is theirs.
```

Answer with a normal task call using the same label. The answer goes into the same pane, so the agent keeps its context. `resumeClosed` is not needed.

```json
{ "agent": "scout", "tabLabel": "Scout", "task": "Use the v2 API only.", "wait": true }
```

The parked agent stays open until it really finishes, even though it is a one-shot.

#### Resume a closed one-shot

Continues a closed one-shot in a new child that reopens the archived Pi session, so it keeps its earlier conversation.

```json
{ "agent": "worker", "tabLabel": "Auth refactor", "resumeClosed": true, "task": "Also update the unit tests for the new signature.", "wait": true }
```

Rules checked by `execute`:

- `task` must be non-empty and `tabLabel` must be explicit (not defaulted).
- `tabLabel` must match exactly a closed one-shot owned by this Orchestrator session.
- `agent` must be the same profile the closed agent used.
- The archived session file and working directory must still exist. Otherwise the history entry is marked invalid and the call fails.
- A closed agent that is already being resumed cannot be claimed again.
- `resumeClosed` never resumes over a live agent. A working or open agent, or a settled detached result that has not been collected, is rejected with guidance (re-wait or let the result be delivered). A parked question is the exception: it is answered in place.

#### Live agent with the same label

A `task` with an explicit `tabLabel` that matches a live agent, without `resumeClosed`, and not a parked question, is rejected so no duplicate is spawned:

```text
A live Herdr agent named "<label>" already exists and cannot receive a new task. …
```

Fix: re-wait, wait for delivery and then use `resumeClosed`, or choose a different `tabLabel`.

### UI vs headless sessions

Calls that supply a `task` (fresh spawn, parked-question answer, `resumeClosed`):

| Session | `wait` omitted | `wait: true` | `wait: false` |
|---|---|---|---|
| UI (`ctx.hasUI`) | detached (`false`) | blocks | detached |
| Headless | blocks (`true`) | blocks | rejected |

Headless error for a task call with `wait: false`: `wait: false requires a UI session with the agents widget poller; requires wait: true in a headless session because nothing would deliver the result or close the agent.` Reason: detached delivery needs the widget poller, which only runs with a UI.

Taskless re-wait is dispatched before that check, so it is not rejected in headless sessions. Omitted `wait` blocks there, and an explicit `wait: false` returns the non-blocking "is still running" status without collecting anything.

While blocking, the extension emits `herdr:blocked` so Herdr can mark the Orchestrator pane as waiting.

### Results

All results are text content. `details` carries metadata. Keys used by agent-relevant outcomes:

| Outcome | Text | Notable `details` |
|---|---|---|
| Result collected (`wait: true`) | The captured assistant text: the child's last non-empty assistant message from the result artifact, else raw recent pane scrollback (last 180 lines). Empty output becomes `(Herdr agent <label> finished with no visible output.)` | `waited: true`, `closed`, `closeError`, `tabLabel`, `paneId`, `reused`, `resumed` |
| Close failed after a result | The result, then `Warning: failed to close one-shot Herdr agent <label>: <error>` | `closed: false`, `closeError` |
| Question | The question text above | `status: "question"`, `closed: false`, `waited: true` |
| Detached start | `Herdr agent <label> started (<paneId>).` | `waited: false` |
| Wait timed out or aborted | See below | `waited: false`, `interrupted: true`, `interruptReason: "timeout"` or `"aborted"` |
| Profile warnings | Appended `Spawn warnings:` list (unknown thinking level, ignored skills) | `spawnWarnings` |

Interrupted wait text (the child is not closed and no prompt is re-sent):

```text
Wait timed out while Herdr agent <label> is still running.
The child was not closed and no new prompt was sent.
Call herdr_agent again with the same tabLabel "<label>" and omit task to re-wait.
Do not resend the task.
```

For aborts the first line is `Wait was aborted (outer tool/session timeout) while Herdr agent <label> is still running.` The interrupted result is not an error. Follow it with a re-wait using `wait: true`.

### Errors

Returned with `isError: true`:

| Condition | Message (start) |
|---|---|
| Unknown profile | `Unknown Herdr agent: <name>. Available: …` (`details.availableAgents`) |
| `wait: false` with a `task` in headless session | `wait: false requires a UI session …` (taskless re-wait is not rejected) |
| `resumeClosed` without `task` | `resumeClosed requires a non-empty task. …` |
| `resumeClosed` without `tabLabel` | `resumeClosed requires an explicit non-empty tabLabel.` |
| No owned closed agent | `No closed one-shot Herdr agent named "<label>" is owned by this Orchestrator session.` |
| Profile mismatch on resume | `Closed Herdr agent "<label>" was a <profile> agent, not <agent>.` |
| Resume already claimed | `Closed Herdr agent "<label>" is already being resumed.` |
| Archive unusable | `Cannot resume "<label>": …` |
| `resumeClosed` over live agent | `A live Herdr agent named "<label>" is still working. …` / `… already settled and is waiting to be collected. …` / `… is still open. …` |
| Re-wait target missing or no `tabLabel` | See [Re-wait](#re-wait) |
| Task to a live agent by label | See [Live agent with the same label](#live-agent-with-the-same-label) |
| `workspace.label` equals the Orchestrator's own workspace | `The configured workspace.label matches this Orchestrator's own workspace. …` |

Herdr CLI failures and malformed Herdr output are thrown as tool errors with the Herdr message.

## 2. Injected instructions (not part of the tool schema)

On every Orchestrator turn the extension appends `GLOBAL_INSTRUCTIONS` (`src/prompts.ts`) to the system prompt through `before_agent_start`. It repeats the usage rules above and adds policy that is not enforced by the schema:

- Use `herdr_agent` for delegation instead of raw Herdr CLI commands.
- Pick the smallest suitable profile: `scout`, `researcher`, `planner`, `worker`, `reviewer`.
- Do not duplicate delegated work. Do not recurse.
- Run parallel calls only for independent reads or disjoint write slices (4–5 at most).
- Make each task self-contained: goal, scope, paths or links, constraints, expected output, read-only vs edit permission.
- Synthesize results yourself; do not forward raw pane output.
- Detached by default: do not start the delegated work yourself while a detached agent is still on it; pass `wait: true` if you need the answer in this turn.

After `/run`, `buildRunTurnInstructions` adds a one-turn note that authorizes delegation for the user's task.

The child receives its own protocol (`CHILD_PROTOCOL`): finish with a `HERDR_RESULT:` block (`status`, `summary`, `evidence`, `changes`, `next`), or call `ask_question` once when requirements are genuinely ambiguous. The `HERDR_RESULT:` format is only requested; the extension does not validate it, so a result may lack it.
