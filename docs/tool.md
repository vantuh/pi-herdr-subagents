# Agent tools reference

This document describes the four tools the Orchestrator model sees. Sources: `src/index.ts` (registrations), `src/tool/execute.ts` (`executeAgentSpawn`, `executeAgentSend`, `executeAgentStatusCall`), `src/tool/control.ts` (`executeAgentStop`, `controlLiveAgent`), `src/tool/status.ts`, `src/tool/spawn/` (spawn flow), `src/tool/schema.ts`, `src/prompts.ts`.

The document has three parts:

1. **Exposed tool contract** — what Pi registers: names, descriptions, parameter schemas. This is the contract.
2. **Control path** — guards, statuses and `details` of a steer (`agent_send` to a working agent) and of `agent_stop`.
3. **Injected instructions** — extra system-prompt text the extension appends. It guides usage but is not part of the tool definitions.

Each tool has its own required parameters. No mode is chosen by omitting a parameter.

| Tool | Does |
|---|---|
| `agent_spawn(agent, task, name?)` | Start a fresh one-shot agent. |
| `agent_send(name, message)` | Answer a parked question, steer a working agent, or continue a closed agent with its context. |
| `agent_stop(name)` | Abort the current run of a live agent; the agent stays open. |
| `agent_status(name?)` | Check one live agent, or list the live agents this session owns. |

Child Pi panes (`PI_AGENT_CHILD=1`) never get these tools.

## 1. Exposed tool contract

### `agent_spawn`

| Field | Value |
|---|---|
| `name` | `agent_spawn` |
| `label` | `Agent Spawn` |
| `description` | `Spawn a one-shot agent with a named profile from ~/.pi/agent/agents. Agents close after delivering their result; continue a closed one with agent_send and the same name.` |
| `promptSnippet` | `Delegate exploration, research, planning, review, and isolated implementation to a one-shot agent.` |
| `promptGuidelines` | `Use agent_spawn when isolated context helps, after /run, or on an explicit delegation request.` and `Follow the agents system instructions for self-contained tasks, independent parallel calls, avoiding duplicate work, status checks, and continuing agents.` |

The tool is registered with a static `agent` description at load. On `session_start` (including `/reload`) it is registered again, replacing the first registration, with the profiles discovered from the working directory appended as ` Available: scout (Fast codebase recon), worker (Isolated implementation).` — each entry is the profile name plus its frontmatter `description` in parentheses, omitted when the profile has none. Profiles with `disable-model-invocation` are left out of that listing but can still be spawned by exact name.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `agent` | string | yes | — | Profile name from `~/.pi/agent/agents/*.md` (project profiles in `.pi/agents/` override same-named user profiles). Schema description: `Agent profile name from ~/.pi/agent/agents/*.md or the project .pi/agents.` plus the dynamic `Available:` list. |
| `task` | string | yes | — | Self-contained task for the new agent. |
| `name` | string | no | Title-cased profile name, e.g. `Researcher` | Name of the new agent. Later calls address the agent by this name. |

A blank `agent` or `task` is an error. There are no `layout`, `lifecycle`, `wait`, or `timeoutMs` parameters. Layout comes from `herdr-agents.json` ([config.md](config.md)). The call returns when the prompt is submitted; the widget poller delivers the outcome.

Starts a new child Pi in a new Herdr target (a tab in the subagents workspace by default), sends the task, and returns `Agent <name> started (<paneId>).` followed by a no-wait hint: `Its outcome arrives as a message automatically. Do not check its status or sleep to wait for it; end your turn or continue unrelated work.` Models otherwise poll status or `sleep` while the agent runs. The widget poller later delivers the outcome as an `agent_result` or `agent_question` message, exactly once. A result is delivered only when the child wrote a non-empty result artifact; a question only when it wrote `question.md`. One-shot targets are closed when the result is delivered. If the agent settles with no artifact the poller delivers nothing and keeps the agent. A status check then reports that the agent finished without a result.

Name handling:

- A default name that is already taken gets a suffix (for example `Researcher #2`).
- An explicit `name` that matches a live agent is rejected, even when that agent has a parked question:

  ```text
  A live agent named "<name>" already exists. Use agent_send with that name to answer or steer it, or pass a different name for a fresh agent.
  ```

- A name that only matches some other tab gets a suffix either way.

```json
{ "agent": "scout", "task": "Find where session tokens are validated. Read-only. Return file paths with line numbers." }
```

```json
{ "agent": "reviewer", "name": "Diff review", "task": "Review the current diff for regressions. Read-only." }
```

### `agent_send`

| Field | Value |
|---|---|
| `name` | `agent_send` |
| `label` | `Agent Send` |
| `description` | `Send a message to an agent this session owns, addressed by name. Answers a question the agent asked, steers a running agent at its next turn boundary, or gives a closed agent a follow-up task that keeps its context.` |
| `promptSnippet` | `Answer an agent question, steer a running agent, or continue a closed agent with a follow-up task.` |
| `promptGuidelines` | `Use agent_send to answer a question an agent asked, using its exact name and your answer as the message.` / `Steer a running agent only when a correction must reach work already in progress; never to check progress.` / `To continue a closed agent with its context, send it a new self-contained task by its exact name.` / `If agent_send reports the agent is not in an active run, wait for its result instead of sending a task.` / `Never repeat an agent_send call that reported no acknowledgement.` |

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `name` | string | yes | Exact name of an agent owned by this session, live or closed. |
| `message` | string | yes | What to send. |

`name` and `message` are trimmed; a blank one is an error (`name is required.` / `message is required.`). Outside TUI mode the call returns `agent_send requires TUI mode. Non-TUI sessions have no widget poller to deliver the result.` before any Herdr call.

#### Dispatch

The call is dispatched by the state of the named agent, in this order (`executeAgentSend` in `src/tool/execute.ts`):

| # | State of `name` | What happens |
|---|---|---|
| 1 | Live agent with a parked question | `message` is the answer: a new prompt turn in the same pane. Returns `Answer sent to agent <name> (<paneId>).` plus the no-wait hint, `details.reused: true`. |
| 2 | Live agent that is working | Steer: `message` is injected at the child's next turn boundary. See [Control path](#2-control-path). |
| 3 | Live agent that is settled, no question | The same steer path; the child reports `idle` and the call says the result arrives automatically. Nothing is sent. |
| 4 | No live agent, closed one-shot of this session with that exact name | Resume: a new child reopens the archived Pi session, so it keeps its earlier conversation. `message` is the new task. |
| 5 | Anything else | `No agent named "<name>" found for this session. Use agent_spawn to start one.` |

States 2 and 3 are not told apart by the parent: the child decides from its own run state. The profile of a resumed agent comes from the stored closed-history record; the call has no `agent` parameter.

Resume rules, checked by the spawn flow:

- `name` must match exactly a closed one-shot owned by this Orchestrator session. A record owned by another session is invisible, so the call reports an unknown agent.
- The archived session file and working directory must still exist. Otherwise the history entry is marked invalid and the call fails.
- A closed agent that is already being resumed cannot be claimed again.
- A resume never runs over a live pane that carries the name: a working agent, an agent still open, or a settled result that has not been delivered is rejected with guidance. In practice dispatch sends a live agent down the answer or steer path first.

A question answer returns the same details as a start; a resume adds `resumed: true`.

```json
{ "name": "Scout", "message": "Use the v2 API only." }
```

```json
{ "name": "Auth refactor", "message": "Also update the unit tests for the new signature." }
```

### `agent_stop`

| Field | Value |
|---|---|
| `name` | `agent_stop` |
| `label` | `Agent Stop` |
| `description` | `Abort the current run of a running agent this session owns. The agent stays open. It cannot start, answer, resume, or close an agent.` |
| `promptSnippet` | `Stop the current run of a running agent when the user or a decision requires it.` |
| `promptGuidelines` | `Use agent_stop only when the user or a decision requires stopping the run.` / `A stop drops a queued steer.` / `Never repeat an agent_stop call that reported no acknowledgement.` |

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `name` | string | yes | Exact name of a live agent owned by this session. |

An interrupted agent stays open. See [After a stop](#after-a-stop).

### `agent_status`

| Field | Value |
|---|---|
| `name` | `agent_status` |
| `label` | `Agent Status` |
| `description` | `Check one live agent by name (status and a preview of its latest text), or list the live agents this session owns. Read-only: never sends work, claims, or closes.` |
| `promptSnippet` | `Check an agent when the user asks or a decision depends on its progress.` |
| `promptGuidelines` | `Use agent_status only when the user asks or a decision depends on progress, never to wait for completion: the outcome arrives as a message automatically.` |

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `name` | string | no | Exact name of a live agent to check. Omit it to list the live agents this session owns. |

#### With `name`

Looks up the live agent. No prompt is sent, and nothing is claimed, closed, or resumed.

```json
{ "name": "Scout" }
```

- A working or blocked agent returns `status: <herdr status>`, plus `Latest assistant text (preview; not a completion):` with the child's most recent captured text when it has written any. The preview is display-capped at the last 30 lines / 2k characters, marked `… (truncated)`, and its content is otherwise untouched. Pane scrollback is never read.
- A parked question returns the question text with `status: "question"` and `closed: false`.
- A settled agent with no result artifact returns `finished without a result`, with no preview. The agent stays open.
- An agent whose outcome was already delivered returns that it was already collected. If the target is still open, close it with `/agents`, then continue with `agent_send`.
- Errors: `No running agent named "<name>" found for this session.`; a live target whose legacy owner/pane identity cannot be reconciled returns `Owned Herdr target <target> is still live, but its legacy owner/pane identity cannot be reconciled safely. …`.
- It never reopens a closed agent. Use `agent_send` for that. The user can also reopen one for reading from `/agents`; it is then a live agent, so `agent_send` to its name steers or answers it until it is closed again.

#### Without `name`

Lists the live agents whose record has `ownerSessionId` equal to this session's id, one line per agent:

```text
Live agents owned by this session:
Scout (scout): working
Diff review (reviewer): idle
```

An empty list returns `No live agents are owned by this session.` `details.agents` is an array of `{ name, agent, status }`. The call is read-only: no claim, no prompt, no state write beyond the usual pruning in `loadContextWithState`.

### TUI requirement

Every call of every tool, including a status check, requires TUI mode. RPC, JSON, and print sessions return `<tool> requires TUI mode.` before any Herdr call (`agent_spawn`, `agent_send` and `agent_status` add `Non-TUI sessions have no widget poller to deliver the result.`). RPC can report `hasUI`, and that still has no widget collector.

### Results

The tool call itself returns text as soon as the prompt is submitted. The child's output arrives later as a custom message. `details` carries metadata.

| Outcome | Text | Notable `details` |
|---|---|---|
| Start | `Agent <name> started (<paneId>).` (an answer: `Answer sent to agent <name> (<paneId>).`) plus the no-wait hint | `tabId`, `paneId`, `name`, `reused`, `agent`, optional `resumed`, optional `spawnWarnings` |
| Delivered result (`agent_result`) | The captured assistant text plus `Full report saved to <path>`. Above 6 000 characters it is a head/tail excerpt around `… N characters omitted …`. A failed report save appends `Warning: failed to save the full report for agent <name>: <error>`, a failed close appends `Warning: failed to close one-shot agent <name>: <error>` | `name`, `agent`, `paneId` |
| Delivered question (`agent_question`) | The question text below | `name`, `agent`, `paneId`, `question` |
| Status check | `Agent <name> (<paneId>) status: <status>.` (plus the no-wait hint while not settled), optionally followed by the assistant-text preview, or the question text, or `finished without a result` | `tabId`, `paneId`, `name`, `agent`, `status`; a question also sets `closed: false` |
| Status list | See [Without `name`](#without-name) | `agents` |
| Profile warnings | Appended `Spawn warnings:` list (unknown thinking level, ignored skills) | `spawnWarnings` |

A delivered question reads:

```text
Agent <name> (<agent>) asked a question instead of finishing:

<question>

The agent is still open and waiting. Answer it by calling agent_send
with name "<name>" and message set to your answer.
Answer from your own context, or ask the user if the decision is theirs.
```

The parked agent stays open until it really finishes, even though it is a one-shot.

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

| Tool | Condition | Message (start) |
|---|---|---|
| `agent_spawn` | Blank `agent` or `task` | `agent is required.` / `task is required.` |
| `agent_spawn` | Unknown profile | `Unknown agent profile: <name>. Available: …` (`details.availableAgents`) |
| `agent_spawn` | Explicit `name` of a live agent | See [`agent_spawn`](#agent_spawn) |
| `agent_spawn` | `workspace.label` equals the Orchestrator's own workspace | `The configured workspace.label matches this Orchestrator's own workspace. …` |
| `agent_send` | Blank `name` or `message` | `name is required.` / `message is required.` |
| `agent_send` | Unknown name | `No agent named "<name>" found for this session. Use agent_spawn to start one.` |
| `agent_send` | Unknown stored profile of a resumed agent | `Unknown agent profile: <profile>. Available: …` |
| `agent_send` | Resume claim or archive failure | `Closed agent "<name>" is already being resumed.` / `Cannot resume "<name>": …` / `Closed agent "<name>" cannot be resumed in its current state.` |
| `agent_send` | Resume over a live pane | `A live agent named "<name>" is still working. …` / `… already settled and is waiting to be delivered. …` / `… is still open. …` |
| `agent_send` | Steer guards | See [Guards](#guards) |
| `agent_status` | Named agent missing | See [With `name`](#with-name) |
| all | Non-TUI session | `<tool> requires TUI mode. …` |

Herdr CLI failures and malformed Herdr output are thrown as tool errors with the Herdr message.

## 2. Control path

A steer (`agent_send` to a live agent with no parked question) and `agent_stop` act on a child this Orchestrator session already started. They never start, resume, answer or close an agent. Sources: `src/tool/control.ts` (guards, statuses, ack wait), `src/control.ts` (transport), `src/child/control.ts` (child consumer). The transport protocol and its limitations are in [flow.md](flow.md#agent-control).

The control tools are registered at extension load (once per `/reload`) in the Orchestrator branch of `src/index.ts`. A child Pi pane (`PI_AGENT_CHILD=1`) returns before that branch, so a child cannot steer or stop another child.

### Guards

Checked in this order, before any control-channel write. A guard failure returns `isError: true`.

`agent_send` checks, before it reads Herdr state, a non-blank `name` and `message` and TUI mode, then looks the name up (the dispatch above). Once a live agent without a parked question is found, `controlLiveAgent` runs guards 6–7. `agent_stop` runs guards 1, 4, 5, 6, 7 in that order with its own texts. Guard failures of `controlLiveAgent` and `agent_stop` return `details` of exactly `{ name, action }` (`action` is `steer` or `interrupt`).

| # | Condition | Text |
|---|---|---|
| 1 | blank `name` | `name is required.` |
| 4 | `ctx.mode !== 'tui'` | `agent_stop requires TUI mode.` (`agent_send`: see above) |
| 5 | no live managed agent with that name | `agent_stop`: `No running agent named "<name>" found for this session. Pass its exact name.` (`agent_send`: unknown-name error, or an answer/resume path) |
| 6 | the record's `ownerSessionId` differs from this session's id, including when either side is missing | `Agent "<name>" is not owned by this Orchestrator session, so it cannot be controlled.` |
| 7 | the record has no usable managed `resultFile`, so no control directory can be derived | `Agent "<name>" has no control channel recorded. Check its status before retrying.` |

The dispatch and `agent_stop` read Herdr discovery and managed state through `loadContextWithState`, which also prunes state as every other call does; the tools add no state field and no Herdr command kind. Ownership is checked in `controlLiveAgent` because the managed lookup is terminal-scoped: without it a new Pi session in the same pane could control the previous session's child. A child whose record lacks `ownerSessionId` is never controllable.

Herdr CLI failures while resolving the target throw, as elsewhere in the extension; they are not turned into a status.

### Statuses, `details` and texts

An attempted operation returns one text and `details` of exactly `{ name, paneId, action, status, requestId }`, with `isError` omitted — including when `status` is `unknown`. `requestId` is the uuid this call published.

| `action` | `status` | Text |
|---|---|---|
| `steer` | `queued` | `Message queued for agent <name> (<paneId>). It enters the run at its next turn boundary; queuing is not proof the agent has read it. Its answer still arrives with the final result — do not re-send it as a task.` |
| `steer` | `idle` | `Agent <name> (<paneId>) did not take the message: it is not in an active run, or the request was already stale. Its result arrives automatically; wait for it. Check it with agent_status only if a decision depends on it.` |
| `steer` | `unknown` | `No acknowledgement from agent <name> (<paneId>) within 2000 ms. The message may or may not be applied; do not retry it. Check its status before deciding what to send next.` |
| `interrupt` | `aborted` | `Agent <name> (<paneId>) aborted its run, so no result from that run should normally arrive and the agent stays open. A collection already in flight can still deliver that run's text and close the pane; ignore a result for work you interrupted. A live agent cannot take a new task: continue it manually in its pane, or close it with /agents and then continue it with agent_send and the same name.` |
| `interrupt` | `requested` | `Stop sent to agent <name> (<paneId>); the child did not report a settled abort within 2000 ms, so the run may have already finished on its own. On the ordinary path expect no result from that run, but a collection already in flight can still deliver its text; ignore a result for work you interrupted. Check its status, then continue it manually in its pane or close it with /agents and continue it with agent_send.` |
| `interrupt` | `idle` | `Agent <name> (<paneId>) is not in an active run, so there was nothing to stop. Check its status; its result may still arrive.` |
| `interrupt` | `unknown` | `No acknowledgement from agent <name> (<paneId>) within 3000 ms. The stop may or may not have been applied; do not retry it. Check its status before assuming it stopped.` |

`queued`, `aborted`, `requested` and `idle` are written by the child. `unknown` is the parent's own: the ack deadline is 2000 ms for a steer and 3000 ms for a stop, polling every 25 ms, and `requested` already covers the child's own 2000 ms observation of its abort. An acknowledgement the caller cannot interpret — a different id, unreadable JSON, the other action's outcome, or a status that action never produces — counts as no acknowledgement and is reported as `unknown`, never as a partial success.

### Queued is not applied

`queued` means the message entered the child's steering queue, not that the model read it. It reaches the provider request at the child's next turn boundary, it does not create a new turn, it is not labelled separately in the delivered result, and a stop drops it: the child's TUI abort binding clears queued steering messages before aborting the run. The child's own answer still arrives as one normal `agent_result`; do not also send it as a task.

### No retry

A control call is never retried. On a missed ack the tool reports `unknown`, leaves the transport files in place, and starts no retry, timer or background task; the next operation cleans them, and a late ack for an old request id can neither satisfy nor overwrite a newer operation. A repeated call is a new operation with its own id, which is why the status texts say not to retry.

### After a stop

A stopped child stays live. A live child that is not parked on a question cannot take a new task, so the two recovery paths are: the user continues it manually in its pane, or it is closed with `/agents` and continued with `agent_send` and the same name. A stop does not retract work already delivered: a collection tick that read the marker before it was written can still deliver that run's text and close the one-shot pane, and a result for work the Orchestrator stopped should be ignored. It also does not retract an already-written question.

## 3. Injected instructions (not part of the tool schemas)

On every Orchestrator turn the extension appends `GLOBAL_INSTRUCTIONS` (`src/prompts.ts`) to the system prompt as the `agents` section through `before_agent_start`. It repeats the usage rules above and adds policy that is not enforced by the schemas:

- Delegate with the agent tools instead of raw Herdr CLI commands.
- Pick the smallest suitable profile from the `Available:` list, which shows each profile's description; the instructions name no profiles.
- Agents do not see the conversation, so each task is self-contained: goal, scope, paths or links, constraints, expected output, read-only vs edit permission, and, for edits, the check to run.
- Run parallel `agent_spawn` calls only for independent reads or disjoint write slices (at most 4), each with a distinct `name`.
- Every call returns when the task is submitted; the result or question arrives as a message. Never wait with status checks or `sleep`, and do not redo delegated work; end the turn or do unrelated work.
- Treat a result as a report: verify claims before acting on them and synthesize it for the user. A `blocked` result needs a decision: continue the agent or handle it yourself.
- Reach an existing agent only with `agent_send` (answer, steer, or continue a closed one) and stop a run only with `agent_stop`. Steer only when a correction must reach work already in progress, stop only when the user or a decision requires it, and never repeat a call that reported `No acknowledgement`. If `agent_send` reports the agent is not in an active run, wait for its result instead of sending a task.
- Check a live agent's status only when the user asks or a decision depends on its progress.

For the user message that `/run` sends, `buildRunTurnInstructions` adds a one-turn note that authorizes delegation for the user's task.

The child receives its own protocol (`CHILD_PROTOCOL`): do not close its pane or start other agents, call `ask_question` when requirements are genuinely ambiguous, and otherwise answer in its profile's output format, ending with one line `AGENT_RESULT: done | blocked — <summary>`. The line is only requested; the extension does not validate it, so a result may lack it.
