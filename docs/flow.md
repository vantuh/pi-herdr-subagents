# Agent flow

Current runtime: Pi `1.3.0`, Herdr client/server `0.9.5`, official Pi integration
`v9`. See [README.md](../README.md) for loading and tool parameters.

## Loading and profiles

Pi loads `src/index.ts` through the package manifest or an explicit
`pi -e ./src/index.ts`. The main session registers `agent_spawn`, `agent_send`,
`agent_stop` and `agent_status`, commands, renderers, and orchestration
guidance. The tool entries are in `src/tool/execute.ts` (`executeAgentSpawn`,
`executeAgentSend`, `executeAgentStatusCall`) and `src/tool/control.ts`
(`executeAgentStop`, `controlLiveAgent`). `agent_spawn` resolves the profile,
applies the TUI/config guards and runs the spawn flow in `src/tool/spawn/`;
`agent_send` dispatches by the named agent's state (below); `agent_status` calls
`src/tool/status.ts` for one agent or lists the owned live ones.
`PI_AGENT_CHILD=1` registers only the child result/session writer and
model-only `ask_question`. Orchestration guidance uses the named `agents`
system-prompt section for both user and custom-message runs, preserving Pi's
other prompt sections.

`src/agents.ts` discovers profiles on every call from `getAgentDir()/agents`
and the nearest project `.pi/agents`. `session_start` (including `/reload`)
also rediscovers them to refresh the `Available:` list in the tool schema and
the profile names `/run` completes and recognizes.
`src/state/migrate.ts` runs once at extension load, before the config read: it
renames the legacy `herdr-agents-state.json` under the state lock and the legacy
`herdr-agents-results/` directory in the same parent, so both storage names
follow the package name. State reads await that migration through
`whenStorageReady`. `pi-herdr-subagents.json` is read once at extension load.
Project profiles override user profiles by name. See
[agent-profiles.md](agent-profiles.md) for fields and precedence.

New children have fresh context. The role body and child protocol are written
to `system.md`, passed through `--append-system-prompt` (default) or
`--system-prompt` (profile `system-prompt: replace`).
The task prompt includes the private `AGENT_RESULT_FILE` marker.

## Target placement and startup

`herdr api snapshot` discovers the session. `HERDR_PANE_ID` takes precedence
over UI focus because focus can change while a tool runs.

The spawn feature owns its phases: `spawn/flow.ts` (`runAgentTask`) holds the
placement lock, the rollback of partially spawned resumed agents and the prompt
handoff; `spawn/targets.ts` resolves placement and creates the tab or split
pane; `spawn/continuation.ts` refuses a live name for a spawn, reuses a parked
question for an answer and claims closed history for a resume;
`spawn/lifecycle.ts` starts the child, records its lifecycle and runs the prompt
turn. The entry point picks the spawn mode (`spawn`, `answer` or `resume`); it
is never inferred from tool parameters. `openClosedAgent` in `spawn/flow.ts` runs
the same resume path for the `/agents` overlay but stops before the
prompt turn and records the agent with `detached: false`, so the poller never
delivers or closes it.

Layout comes from `pi-herdr-subagents.json` ([config.md](config.md)), never the
tool parameters.

Creation responses supply IDs; the extension does not predict them. Placement
is locked through startup, state recording, and pane-column rebalancing so
parallel spawns see each other's targets. Exact equal-height ratios use
`layout.export` and `layout.set_split_ratio` through the socket API.

Child shells receive `PI_AGENT_CHILD=1` and `PROCESS_LAUNCHED_BY_Q=1`. The
latter prevents Kiro's shell wrapper from obscuring the real shell. A shell's
history isolation still requires its own child-marker configuration.

Herdr starts a named Pi agent:

```bash
herdr agent start <automation-name> --kind pi --pane <pane-id> --timeout 30000 -- \
  --session-dir '<agentDir>/herdr-agent-sessions' \
  --name '<label>' --append-system-prompt '<system.md>'
```

Profile model, thinking, skills, and tool restrictions add Pi arguments.
Every child also gets `--session-dir <getAgentDir()>/herdr-agent-sessions`, so
new child sessions land outside the default `/resume` history.
The automation name is distinct from the display label and terminal ID.
Herdr owns cold-shell startup retries and terminal-identity checks. It returns
only when Pi is detected and ready for input. A current ACP provider may briefly
own the foreground; kind-mismatch recovery waits for Pi without launching twice.

## Prompt submission

Every task uses atomic `herdr agent prompt` without `--wait`. The upstream
`--wait` path has a five-second activity gate, which is too short for some
Pi transitions. The extension does not poll for prompt acceptance and does not
call `herdr agent wait`. The tool returns as soon as the prompt is submitted.
The per-second widget poller (`src/ui/poller.ts`) is the only collector: each
tick hands the managed agents to `deliverDetachedOutcomes` in
`src/ui/detached-outcomes.ts`, which delivers a settled result or question and
closes a finished one-shot. The extension never sends an extra Enter.

The agent tools require TUI mode. RPC, JSON, and print sessions are rejected
before any Herdr call, because they have no widget poller. `agent_spawn`
resolves the profile first, so an unknown profile is reported even outside TUI.

`agent_spawn` always starts a fresh agent and needs `agent` and `task`. An
explicit `name` that matches a live agent is rejected; a default name gets a
suffix. It never reuses a live agent.

`agent_send` never spawns. It resolves `name` against this session's managed
state and picks one path, in this order: a live agent with a parked question
takes the message as its answer (same pane, a new prompt turn); any other live
agent gets a steer through the control transport (below); with no live agent, an
owned closed-history record of that exact name is resumed, taking its profile
from the stored record; otherwise the call reports an unknown name. A live agent
that already settled answers the steer with `idle`, which the call reports as
"the result arrives automatically".

`agent_status` with a `name` first returns a parked question or an
already-collected notice if there is one. Otherwise it reads the status from
`herdr agent get` and previews the child's latest captured assistant text from
`result.md`. Without a `name` it lists the live agents this session owns. It
never prompts, waits, claims, closes, resurrects a closed agent, or reads the
terminal.

## Questions and result collection

Child `message_end` appends each non-empty finalized assistant response to
`result.md`, separated by a blank line, so an answer split across several
messages is delivered whole. The child retains its result channel across manual
user, steering and custom-message continuations, including a model switch after
quota exhaustion. A new valid `AGENT_RESULT_FILE:` marker replaces the channel;
starting, resuming or forking a session clears it.

Each managed run writes an `interrupted` marker beside `result.md` before work
starts. Only successful `agent_before_settle` removes it. Escape skips that
boundary, leaving the marker intact even when a tool is interrupted. The poller
leaves unfinished runs open and unclaimed; partial text remains available to
status previews. Send a correction in the same child pane to continue its task.
A successful continuation removes the marker and delivers the accumulated
output. Before a new task, the parent clears old result/question files and the
interruption marker.
Session metadata is stored beside the result for durable resume. It also
carries the child's current context sample and its recorded session cost. The
child publishes both at `turn_end` from `ctx.getContextUsage()` (estimated
tokens and the model window) and from the usage recorded in
`ctx.sessionManager.getEntries()`, because Pi persists the turn before that
boundary — `message_end` handlers run before the persistence, so a sample taken
there would be a turn behind. The cost is summed over assistant messages, tool
results, standalone `usage` entries and compaction/branch-summary entries, once
per entry, so it is the whole session's cumulative USD estimate; a resumed
session republishes the same cumulative total because its entries are loaded
with the session file. A usage entry Pi only sometimes attaches (tool results,
compaction, branch summaries) is skipped when it is absent, but an entry whose
recorded cost cannot be read makes the total unknown instead of passing a
partial sum off as the session total. Starting a new or resumed session, and
starting a new assignment, clear the stale context first; compaction keeps the
known window and drops the token count until the next response.

Both surfaces read the samples through `src/ui/agent-metrics.ts` in one artifact
read per agent: the widget on each one-second tick, and the manager when its
list opens or on each of its own one-second refreshes while it stays open. The
manager opens the same watching list even when nothing is listed yet, so a
spawn that appears in parallel shows up without reopening the command; a
refresh runs with the overlay's abort signal, so a shutdown cancels the tick and
the session waits for one in flight instead of leaving the state-file lock
behind. One missing, unreadable or invalid artifact leaves that row at `ctx —`
and `cost —` without failing the widget or the list; a session whose recorded
cost cannot be read as a whole is unknown rather than a partial sum. Context
stays display-only. The session cost is display-only on live rows too — it is
never written to the live agent record — and it is the last published snapshot,
so it can lag the turn in progress. A one-shot freezes it in closed history when
`stageClosedOneShot` stages the record, before the temp artifacts are removed,
so a closed row keeps showing it after the artifact is gone. A re-archive
replaces the frozen value with the newer cumulative one and only falls back to
it for the same child session, so a reused label never inherits another
session's cost.

Collection checks `question.md` before `result.md`. `ask_question` writes the
question and returns `terminate: true`, without a redundant assistant response
or provider request. Call it alone, not in a batch with other tools. Failed
question delivery does not terminate the turn. The parent
returns/delivers the question and leaves the one-shot open. Answer by sending
`agent_send` with the same `name`.

After the claim and before the notification, the close and the temp cleanup, the
complete result is copied once to a report file under
`<agent dir>/pi-herdr-subagents-results` (`src/reports.ts`). The delivered text
is bounded only when that copy exists: above 6 000 retained source characters it is
the first 4 000 and the last 2 000 around an exact `… N characters omitted …`
marker plus the report path. A report write that fails delivers the complete
text with a warning, never a silent truncation. Questions and interrupted runs
write no report. Report retention (30 days from the stamp in the file name,
pruned at load and after each save) is separate from the closed-history
retention, and neither one re-delivers the other's data.

If the agent settled without a result artifact, a status check reports
`finished without a result`; the poller does not deliver that case and the agent
stays open. A working agent without an artifact reports its Herdr status.
Agent output comes only from artifacts: terminal scrollback is never read, because a Pi pane's output
is mostly TUI chrome (banner, resource lists, redraw frames, status bar).

Detached claims use the shared state lock so background collection does not
deliver the same outcome twice. `deliverDetachedOutcomes` re-checks each
agent's settled status before claiming, because a tick's snapshot can predate
the prompt. Outcomes found in one poller tick are batched; only the final
custom message triggers a turn.

## Close and resume

Every spawned agent is a one-shot; answering a parked question reuses its open
target instead of spawning. Historical persistent records remain stored but
unmanaged; they are never converted to closable one-shots or claimed for delivery.
Successful collection stages continuation
metadata before closing the owned pane/tab. Only then does the extension
finalize the archived history and clean up temporary files. The durable report
is written before that close, so closing never discards the delivered text. Close
failures return the collected output with a warning and leave the target
inspectable.

`agent_send` resumes only when no live agent carries the name and this session
owns a closed one-shot of that exact name; the closed-history record supplies the
profile. The extension validates session ID/cwd against the native JSONL header and
claims the matching owner-session history slot. Pi starts with `--session`
pointing at that file, using the current profile policy from the archived cwd.
It closes again after the next successful result. Resumed children also receive
`--session-dir`, but `--session` keeps the archived file at its existing path.
Sessions created before directory isolation are not moved.

A live name takes precedence: `agent_send` answers a parked question or steers
active work, and a settled result is waited for until it is delivered. Resume
never spawns a closed copy over live work. Concurrent resumes have one claim winner.

A failed state save does not abort the spawn. The child still writes its artifact, and the poller cannot deliver or close that agent because it has no record.

State updates use the existing exclusive directory lock with owner sentinels.
There is no automatic stale-lock takeover. Native Pi session files are not
deleted when the extension prunes its bounded closed-history index.

## Agent control

A steer (`agent_send` to a live agent with no parked question) and `agent_stop`
(`src/tool/control.ts`) act on a child this Orchestrator
session already started: they resolve the name in the managed live records,
requires `ownerSessionId` to equal this session's id, derives the child's control
directory, publishes one request and waits for the child's acknowledgement. It
never spawns, resumes, answers, claims, collects or closes an agent, it touches
no result, question or session artifact, and the poller, delivery, reports and
closed history are untouched. The parameters,
guards, exact texts and `details` keys are in [tool.md](tool.md#2-control-path).

### Transport

The channel is the `control/` directory beside the child's `result.md`
(`controlDirFor` in `src/control.ts`), derived from the same temp path and
`result.md` basename as `question.md`, the `interrupted` marker and
`session.json`, and guarded by the shared managed-temp-path rule. One marker, one
spelling, and the existing temp cleanup on close removes the whole directory. The
child creates the directory (`0700`) when it first resolves the result file,
because it must exist to be watched; the parent creates it too, idempotently,
before publishing.

Two file names live in it, both `0600`:

```jsonc
// request.json — one outstanding request per child
{ "id": "<uuid>", "action": "steer", "message": "<text>", "createdAt": 1792160700675 }

// ack.<uuid>.json — per-id, written only by the child
{ "id": "<uuid>", "action": "steer", "status": "queued", "at": 1792160700681 }
```

Both sides validate with `parseJson` + TypeBox (`src/control/schema.ts`). The id
is the ack file name, so it is schema-constrained to `[A-Za-z0-9-]`. There is no
version field: child and parent are the same working copy, and a child running
older extension code writes no ack at all, which the parent reports as `unknown`.

Publishing is `tmp + rename`. The temp file is written one level up, in the agent
temp directory and not inside `control/`: a temp file in the watched directory can
have its write coalesced with the rename into a single event that names only the
temp file, so the request is never read. That loss was measured (1 publish in 40)
before the temp file moved out.

### Who writes what

The child only ever writes `ack.<id>.json` for the id it consumed. The parent is
the sole remover, inside a per-directory in-process queue that makes the whole
publish–wait–clean operation serial per child:

- pre-clean: remove `request.json` and every `ack.*.json` (cancellation is
  checked before and after this step, so a cancelled call publishes nothing),
- publish `request.json`, poll `ack.<id>.json` every 25 ms up to 2000 ms
  (`steer`) or 3000 ms (`interrupt`),
- on an ack it trusts: remove `request.json` and its own `ack.<id>.json`, best
  effort; otherwise remove nothing.

An ack counts only when its file name id and payload id both equal the published
id. Per-id files are what make a late ack harmless: an ack for an old id cannot
overwrite a newer operation's ack, so the newer call either gets its own ack or
honestly reports `unknown`. A missing ack or invalid JSON is treated as "not yet
acked" until the deadline. A schema-valid matching-id ack with an incompatible
action or status produces `unknown` immediately. Neither case starts a retry,
timer or background task after the call returns.

### Child consume

The child installs an `fs.watch` on the control directory when it resolves the
result file and re-targets it if that directory changes; `session_shutdown`
closes it and drains acknowledgements already being published.

A watch event runs one consume: read `request.json`, validate it, return if the
id is already reserved, otherwise reserve the id with no `await` after it — so
duplicate events and re-reads cannot apply one request twice. Then:

- refuse with `idle` when the child's own `active` flag is false, when
  `ctx.isIdle()` is not `false`, or when `createdAt < runStartedAt`. `active`
  alone is stale while earlier settle handlers run, and Pi's idle predicate is
  also false during a standalone compaction, so both checks are required. The
  `createdAt` comparison is a best-effort staleness heuristic recorded in
  `before_agent_start`, not run identity: an equal-millisecond timestamp or a
  wall-clock adjustment can make an old request look fresh.
- `steer`: `pi.sendMessage(..., { deliverAs: 'steer' })` with `display: false`
  and `details.requestId`, then ack `queued`. No `await` sits between the check
  and the call, and `triggerTurn` is never used, so no new turn is started. A
  steered message is `role: 'custom'`, so it never enters `result.md`.
- `interrupt`: write the `interrupted` marker, then call `ctx.abort()`, then wait
  up to 2000 ms for the child's own `agent_settled` and ack `aborted` when it
  carried `aborted === true`, `requested` otherwise. The marker also has to be set
  before the abort: an abort can land while `agent_before_settle` runs, which
  clears it. The child's own `agent_settled` handler sets it again when
  `event.aborted` is true.

### What the marker does not guarantee

The marker is ordinary-path protection, not a proof. `deliverDetachedOutcomes`
reads it once, then reads and claims the result without serialization, so a
marker write that lands after that read loses: a collection tick already in
flight can still deliver an interrupted run's text as a success and close the
one-shot pane. That race was measured against the real poller and accepted: the
interrupt stops work, it does not retract a delivery already begun, and a result
for work the Orchestrator interrupted is to be ignored. A question is checked
before the result branch and ignores the marker, so an interrupt never retracts
an already-written question.

An interrupt that races a clean finish leaves a complete-but-undelivered result
blocked until the agent is continued: a live child that is not parked on a
question cannot take a new task, so the recovery paths are a manual turn in its
pane, or close with `/agents` and continue it with `agent_send` and the same `name`.

### Reachable limits

- Watch-event loss reports `unknown`. A publish made inside a freshly installed
  watcher's startup window was lost in 1 of 20 measurements, and the window is
  reachable because the spawn tool returns as soon as Herdr accepts the prompt —
  the Orchestrator can send a steer right after the child's first run starts.
  A lost event is honest `unknown`, never a false ack.
- An in-run compaction can summarize the steer's referent, and Pi may replace a
  failed response and retry. Nothing detects, reports or repairs that; no
  control-specific compaction hook detects or repairs that loss.
- Two Orchestrator processes on one session are outside the contract: ownership
  scopes children to one session, but the transport itself is last-writer-wins.
- A live child started before `/reload` runs the older extension code and cannot
  be controlled.
