# `herdr_agent` tool reference

This document describes the `herdr_agent` tool as the Orchestrator model sees it. Sources: `src/index.ts` (`registerHerdrAgentTool`), `src/tool/execute.ts` (`executeHerdrAgent` entry point), `src/tool/spawn/` (spawn flow), `src/tool/schema.ts`, `src/prompts.ts`.

The document has three parts:

1. **Exposed tool contract** — what Pi registers for `herdr_agent`: name, description, parameter schema. This is the contract.
2. **Control tool contract** — `herdr_agent_control`: registration, parameters, guards, statuses and `details`.
3. **Injected instructions** — extra system-prompt text the extension appends. It guides usage but is not part of the tool definition.

## 1. Exposed tool contract

### Registration

| Field | Value |
|---|---|
| `name` | `herdr_agent` |
| `label` | `Herdr Agent` |
| `description` | `Spawn a one-shot Herdr agent with a named profile from ~/.pi/agent/agents. Agents close after delivering their result; continue a closed one-shot with its context via resumeClosed and the same tabLabel.` |
| `promptSnippet` | `Delegate exploration, research, planning, review, and isolated implementation to a one-shot Herdr agent.` |
| `promptGuidelines` | `Use herdr_agent when isolated context helps, after /run, or on an explicit delegation request.` and `Follow the Herdr agents system instructions for self-contained tasks, independent parallel calls, avoiding duplicate work, status checks, and resume.` |

The tool is registered with a static `agent` description at load. On `session_start` (including `/reload`) it is registered again, replacing the first registration, with the profiles discovered from the working directory appended as ` Available: scout (Fast codebase recon), worker (Isolated implementation).` — each entry is the profile name plus its frontmatter `description` in parentheses, omitted when the profile has none. Profiles with `disable-model-invocation` are left out of that listing but can still be spawned by exact name.

Child Pi panes (`HERDR_AGENT_CHILD=1`) never get this tool.

### Parameters

No parameter is required by the schema. `agent` is required to start a new agent; a call that addresses an existing agent by `tabLabel` may omit it. Some modes require more fields at runtime (see the table).

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `agent` | string | to start a new agent | — | Profile name from `~/.pi/agent/agents/*.md` (project profiles in `.pi/agents/` override same-named user profiles). Schema description: `Agent profile name from ~/.pi/agent/agents/*.md or the project .pi/agents.` plus the dynamic `Available:` list. Omit it when `tabLabel` addresses an existing agent: the profile comes from this session's live record, or with `resumeClosed: true` from the owned closed-history record. An unresolved label is an error, never a spawn. |
| `task` | string | no | — | Self-contained task for the agent. Omit it to check a live agent matched by `tabLabel`: the call returns status and a preview of the latest captured assistant text, and does not send a new prompt. |
| `tabLabel` | string | no* | Title-cased profile name, e.g. `Researcher` | Agent label. Identifies the agent for status checks, parked-question answers and `resumeClosed`. *Required when `task` is omitted, and when `resumeClosed` is `true`. |
| `resumeClosed` | boolean | no | `false` | Continue a closed one-shot from this session with its prior context, matched by exact `tabLabel`. Requires a non-empty `task` and an explicit `tabLabel`. |

There are no `layout`, `lifecycle`, `wait`, or `timeoutMs` parameters. Layout comes from `herdr-agents.json` ([config.md](config.md)). A call with a task returns when the prompt is submitted; the widget poller delivers the outcome. A status check returns right after its lookup.

### Modes

The mode is picked from `task`, `resumeClosed` and what is already live under the label.

| Call | Mode |
|---|---|
| `task`, no live agent under the label | Fresh spawn (requires `agent`) |
| no `task`, `tabLabel` | Status check on a live agent |
| `task` + same `tabLabel` as a live agent that parked a question | Answer a parked question |
| `task` + `tabLabel` + `resumeClosed: true`, agent closed | Resume a closed one-shot |

#### Fresh spawn

Starts a new child Pi in a new Herdr target (a tab in the subagents workspace by default), sends the task, and returns `Herdr agent <label> started (<paneId>).` followed by a no-wait hint: `Its outcome arrives as a message automatically. Do not check its status or sleep to wait for it; end your turn or continue unrelated work.` Models otherwise poll status or `sleep` while the agent runs. The widget poller later delivers the outcome as a `herdr_agent_result` or `herdr_agent_question` message, exactly once. A result is delivered only when the child wrote a non-empty result artifact; a question only when it wrote `question.md`. One-shot targets are closed when the result is delivered. If the agent settles with no artifact the poller delivers nothing and keeps the agent. A status check then reports that the agent finished without a result.

If the label is taken by a live managed agent, a default label gets a suffix (for example `Researcher #2`), while an explicit `tabLabel` is rejected (see [Live agent with the same label](#live-agent-with-the-same-label)). A label that only matches some other tab gets a suffix either way.

```json
{ "agent": "scout", "task": "Find where session tokens are validated. Read-only. Return file paths with line numbers." }
```

```json
{ "agent": "reviewer", "tabLabel": "Diff review", "task": "Review the current diff for regressions. Read-only." }
```

#### Status check

Omit `task` and pass the `tabLabel` of a live agent. No prompt is sent, and nothing is claimed, closed, or resumed. `agent` may be omitted too: the profile is resolved from the live record this session owns, and only when nothing matches does the call fail with `No agent labeled "<label>" found for this session. Pass agent to start a new one.`

```json
{ "tabLabel": "Scout" }
```

Notes:

- A working or blocked agent returns `status: <herdr status>`, plus `Latest assistant text (preview; not a completion):` with the child's most recent captured text when it has written any. The preview is display-capped at the last 30 lines / 2k characters, marked `… (truncated)`, and its content is otherwise untouched. Pane scrollback is never read.
- A parked question returns the question text with `status: "question"` and `closed: false`.
- A settled agent with no result artifact returns `finished without a result`, with no preview. The agent stays open.
- An agent whose outcome was already delivered returns that it was already collected. If the target is still open, close it with `/herdr-agents`, then continue with `resumeClosed`.
- A blank `task` is treated as omitted.
- Errors: `tabLabel is required when task is omitted.`, `No running Herdr agent named "<label>" found.`, and, when `agent` is omitted too, `No agent labeled "<label>" found for this session. Pass agent to start a new one.`
- Omitting `task` never reopens a closed agent. Use `resumeClosed` for that. The user can also reopen one for reading from `/herdr-agents`; it is then a live agent, so `resumeClosed` on its label is rejected until it is closed again.

#### Answer a parked question

A child may call `ask_question` instead of finishing. The delivered `herdr_agent_question` message reads:

```text
Herdr agent <label> (<agent>) asked a question instead of finishing:

<question>

The agent is still open and waiting. Answer it by calling herdr_agent again
with tabLabel "<label>" and task set to your answer.
Answer from your own context, or ask the user if the decision is theirs.
```

Answer with a normal task call using the same label. The answer goes into the same pane, so the agent keeps its context, and the call returns `Answer sent to Herdr agent <label> (<paneId>).` plus the no-wait hint. `resumeClosed` is not needed.

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
- `agent` must be the same profile the closed agent used. It may be omitted when the live record or the owned closed-history record supplies the profile.
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

Every call, including a status check, requires TUI mode. RPC, JSON, and print sessions return `herdr_agent requires TUI mode. Non-TUI sessions have no widget poller to deliver the result.` before any Herdr call. RPC can report `hasUI`, and that still has no widget collector. `herdr_agent_control` applies the same gate with its own text, [guard 4](#guards).

### Results

The tool call itself returns text as soon as the prompt is submitted. The child's output arrives later as a custom message. `details` carries metadata.

| Outcome | Text | Notable `details` |
|---|---|---|
| Start | `Herdr agent <label> started (<paneId>).` (an answer: `Answer sent to Herdr agent <label> (<paneId>).`) plus the no-wait hint | `tabId`, `paneId`, `tabLabel`, `reused`, `agent`, optional `resumed`, optional `spawnWarnings` |
| Delivered result (`herdr_agent_result`) | The captured assistant text plus `Full report saved to <path>`. Above 6 000 characters it is a head/tail excerpt around `… N characters omitted …`. A failed report save appends `Warning: failed to save the full report for Herdr agent <label>: <error>`, a failed close appends `Warning: failed to close one-shot Herdr agent <label>: <error>` | `tabLabel`, `agent`, `paneId` |
| Delivered question (`herdr_agent_question`) | The question text above | `tabLabel`, `agent`, `paneId`, `question` |
| Status check | `Herdr agent <label> (<paneId>) status: <status>.` (plus the no-wait hint while not settled), optionally followed by the assistant-text preview, or the question text, or `finished without a result` | `tabId`, `paneId`, `tabLabel`, `agent`, `status`; a question also sets `closed: false` |
| Profile warnings | Appended `Spawn warnings:` list (unknown thinking level, ignored skills) | `spawnWarnings` |

### Bounded delivery

The full text of a delivered result is written once to a report file in
`herdr-agents-results` inside the Pi agent directory (`src/reports.ts`), and the
message states its absolute path. Above 6 000 characters the message keeps the
first 4 000 and the last 2 000 characters (cut at line boundaries) and names the
exact number of dropped characters. That bound counts retained source characters,
not the total message: the marker and the path line are extra. `details` gains no
key for the path — the model reads it in the message body. Questions, interrupted
runs and manual closes write no report, and a report save that fails delivers the
complete text with the warning above instead of an excerpt.

### Errors

Returned with `isError: true`:

| Condition | Message (start) |
|---|---|
| Unknown profile | `Unknown Herdr agent: <name>. Available: …` (`details.availableAgents`) |
| No profile at all | `agent is required to start a new agent; tabLabel is required to address an existing one.` |
| `agent` omitted and no matching agent | `No agent labeled "<label>" found for this session. Pass agent to start a new one.` |
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

## 2. Control tool (`herdr_agent_control`)

Acts on a child this Orchestrator session already started. It never starts,
resumes, answers or closes an agent. Sources: `src/tool/control.ts` (guards,
statuses, ack wait), `src/index.ts` (`registerHerdrAgentControlTool`),
`src/control.ts` (transport), `src/child/control.ts` (child consumer). The
transport protocol and its limitations are in [flow.md](flow.md#agent-control).

### Registration

| Field | Value |
|---|---|
| `name` | `herdr_agent_control` |
| `label` | `Herdr Agent Control` |
| `description` | `Steer or interrupt a running Herdr agent that this session spawned. It cannot start, resume, answer, or close an agent.` |
| `promptSnippet` | `Steer or interrupt a running Herdr agent when work already in progress needs a correction or must stop.` |
| `promptGuidelines` | `Steer (action "steer") only when a correction must reach work already in progress; never to check progress.` / `Interrupt (action "interrupt") only when the user or a decision requires stopping the run.` / `A steer is queued at the next turn boundary and can be dropped by an interrupt.` / `If the call reports idle, check the agent status with herdr_agent instead of sending it a task.` / `Never repeat a control call that reported unknown.` |

Registered at extension load (once per `/reload`) in the Orchestrator branch of
`src/index.ts`, with no dynamic description. A child Pi pane
(`HERDR_AGENT_CHILD=1`) returns before that branch, so a child cannot steer or
interrupt another child.

### Parameters

Exactly three parameters; nothing else exists.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `tabLabel` | string | yes | Exact label of a live Herdr agent owned by this session. Schema description: `Exact label of a live Herdr agent owned by this session. Required.` |
| `action` | `"steer"` or `"interrupt"` | yes | `steer` injects the message into the child's current run; `interrupt` aborts it. |
| `message` | string | for `steer` only | The correction to inject at the next turn boundary. Schema description: `Correction to inject at the next turn boundary of the running agent. Required for steer.` An `interrupt` carrying a non-blank message is an error. |

`tabLabel` and `message` are trimmed. A blank `tabLabel` is an error, not a
defaulted label.

### Guards

Checked in this order, before any control-channel write. Each failure returns
`isError: true` with `details` of exactly `{ tabLabel, action }` (the trimmed
label and the requested action) and one text:

| # | Condition | Text |
|---|---|---|
| 1 | blank `tabLabel` | `tabLabel is required.` |
| 2 | `steer` with blank or absent `message` | `action "steer" requires a non-empty message.` |
| 3 | `interrupt` with a non-blank `message` | `action "interrupt" takes no message; a steer cannot be combined with an interrupt.` |
| 4 | `ctx.mode !== 'tui'` | `herdr_agent_control requires TUI mode.` |
| 5 | no live managed agent with that label | `No running Herdr agent named "<label>" found for this session. Pass its exact label; do not start a new agent to steer.` |
| 6 | the record's `ownerSessionId` differs from this session's id, including when either side is missing | `Herdr agent "<label>" is not owned by this Orchestrator session, so it cannot be controlled.` |
| 7 | the record has no usable managed `resultFile`, so no control directory can be derived | `Herdr agent "<label>" has no control channel recorded. Check its status before retrying.` |

Guards 1–4 run before any Herdr call. Guards 5–7 read Herdr discovery and
managed state through `loadContextWithState`, which also prunes state as every
other call does; the tool adds no state field and no Herdr command kind.
Ownership is checked in the tool because the managed lookup is terminal-scoped:
without it a new Pi session in the same pane could control the previous
session's child. A child whose record lacks `ownerSessionId` is never
controllable.

Herdr CLI failures while resolving the target throw, as elsewhere in the
extension; they are not turned into a status.

### Statuses, `details` and texts

An attempted operation returns one text and `details` of exactly
`{ tabLabel, paneId, action, status, requestId }`, with `isError` omitted —
including when `status` is `unknown`. `requestId` is the uuid this call
published.

| `action` | `status` | Text |
|---|---|---|
| `steer` | `queued` | `Steer queued for Herdr agent <label> (<paneId>). It enters the run at its next turn boundary; queuing is not proof the agent has read it. Its answer still arrives with the final result — do not re-send it as a task.` |
| `steer` | `idle` | `Herdr agent <label> (<paneId>) did not apply the steer: it was not in an active run, or the request was already stale. Check its status with the same tabLabel: answer a parked question with a task, or wait for its result.` |
| `steer` | `unknown` | `No acknowledgement from Herdr agent <label> (<paneId>) within 2000 ms. The steer may or may not be applied; do not retry it. Check its status before deciding what to send next.` |
| `interrupt` | `aborted` | `Herdr agent <label> (<paneId>) aborted its run, so no result from that run should normally arrive and the agent stays open. A collection already in flight can still deliver that run's text and close the pane; ignore a result for work you interrupted. A live agent cannot take a new task: continue it manually in its pane, or close it with /herdr-agents and then continue it with resumeClosed and the same tabLabel.` |
| `interrupt` | `requested` | `Interrupt sent to Herdr agent <label> (<paneId>); the child did not report a settled abort within 2000 ms, so the run may have already finished on its own. On the ordinary path expect no result from that run, but a collection already in flight can still deliver its text; ignore a result for work you interrupted. Check its status, then continue it manually in its pane or close it with /herdr-agents and continue it with resumeClosed.` |
| `interrupt` | `idle` | `Herdr agent <label> (<paneId>) is not in an active run, so there was nothing to interrupt. Check its status; its result may still arrive.` |
| `interrupt` | `unknown` | `No acknowledgement from Herdr agent <label> (<paneId>) within 3000 ms. The interrupt may or may not have been applied; do not retry it. Check its status before assuming it stopped.` |

`queued`, `aborted`, `requested` and `idle` are written by the child.
`unknown` is the parent's own: the ack deadline is 2000 ms for `steer` and
3000 ms for `interrupt`, polling every 25 ms, and `requested` already covers the
child's own 2000 ms observation of its abort. An acknowledgement the caller
cannot interpret — a different id, unreadable JSON, the other action's outcome,
or a status that action never produces — counts as no acknowledgement and is
reported as `unknown`, never as a partial success.

### Queued is not applied

`queued` means the message entered the child's steering queue, not that the
model read it. It reaches the provider request at the child's next turn boundary,
it does not create a new turn, it is not labelled separately in the delivered
result, and an interrupt drops it: the child's TUI abort binding clears queued
steering messages before aborting the run. The child's own answer still arrives
as one normal `herdr_agent_result`; do not also send it as a task.

### No retry

A control call is never retried. On a missed ack the tool reports `unknown`,
leaves the transport files in place, and starts no retry, timer or background
task; the next operation cleans them, and a late ack for an old request id can
neither satisfy nor overwrite a newer operation. A repeated call is a new
operation with its own id, which is why the status texts say not to retry.

### After an interrupt

An interrupted child stays live. A live child that is not parked on a question
cannot take a new `herdr_agent` task (a task addressing its label is rejected),
so the two recovery paths are: the user continues it manually in its pane, or it
is closed with `/herdr-agents` and continued with `herdr_agent`,
`resumeClosed: true` and the same `tabLabel`. An interrupt does not retract
work already delivered: a collection tick that read the marker before it was
written can still deliver that run's text and close the one-shot pane, and a
result for work the Orchestrator interrupted should be ignored. It also does not
retract an already-written question.

## 3. Injected instructions (not part of the tool schema)

On every Orchestrator turn the extension appends `GLOBAL_INSTRUCTIONS` (`src/prompts.ts`) to the system prompt through `before_agent_start`. It repeats the usage rules above and adds policy that is not enforced by the schema:

- Use `herdr_agent` for delegation instead of raw Herdr CLI commands.
- Pick the smallest suitable profile from the `Available:` list, which shows each profile's description; the instructions name no profiles.
- Agents do not see the conversation, so each task is self-contained: goal, scope, paths or links, constraints, expected output, read-only vs edit permission, and, for edits, the check to run.
- Run parallel calls only for independent reads or disjoint write slices (at most 4), each with a distinct `tabLabel`.
- Every call returns when the task is submitted; the result or question arrives as a message. Never wait with status checks or `sleep`, and do not redo delegated work; end the turn or do unrelated work.
- Treat a result as a report: verify claims before acting on them and synthesize it for the user. A `blocked` result needs a decision: continue the agent or handle it yourself.
- Check a live agent's status only when the user asks or a decision depends on its progress.
- Control a running agent only through `herdr_agent_control`: steer only when a correction must reach work already in progress, interrupt only when the user or a decision requires stopping the run, and never repeat a call that reported `unknown`. `idle` means check the status instead of sending a task.

For the user message that `/run` sends, `buildRunTurnInstructions` adds a one-turn note that authorizes delegation for the user's task.

The child receives its own protocol (`CHILD_PROTOCOL`): do not close its pane or start other agents, call `ask_question` when requirements are genuinely ambiguous, and otherwise answer in its profile's output format, ending with one line `HERDR_RESULT: done | blocked — <summary>`. The line is only requested; the extension does not validate it, so a result may lack it.
