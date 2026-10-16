# herdr_agent flow

Current runtime: Pi `1.2.0`, Herdr client/server `0.9.4`, official Pi integration
`v9`. See [README.md](../README.md) for loading and tool parameters.

## Loading and profiles

Pi loads `src/index.ts` through the package manifest or an explicit
`pi -e ./src/index.ts`. The main session registers `herdr_agent`, commands,
renderers, and orchestration guidance; the tool entry is
`src/tool/execute.ts` (`executeHerdrAgent`), which resolves the profile, applies
the TUI/config/resume guards, then dispatches to `src/tool/status.ts` (taskless
status) or the spawn flow in `src/tool/spawn/`. `HERDR_AGENT_CHILD=1` registers
only the child result/session writer and model-only `ask_question`.
Orchestration guidance uses the named `herdr_agents` system-prompt section for
both user and custom-message runs, preserving Pi's other prompt sections.

`src/agents.ts` discovers profiles on every call from `getAgentDir()/agents`
and the nearest project `.pi/agents`. `session_start` (including `/reload`)
also rediscovers them to refresh the `Available:` list in the tool schema and
the profile names `/run` completes and recognizes.
`herdr-agents.json` is read once at extension load. Project profiles override user profiles
by name. See [agent-profiles.md](agent-profiles.md) for fields and precedence.

New children have fresh context. The role body and child protocol are written
to `system.md`, passed through `--append-system-prompt` (default) or
`--system-prompt` (profile `system-prompt: replace`).
The task prompt includes the private `HERDR_RESULT_FILE` marker.

## Target placement and startup

`herdr api snapshot` discovers the session. `HERDR_PANE_ID` takes precedence
over UI focus because focus can change while a tool runs.

The spawn feature owns its phases: `spawn/flow.ts` (`runAgentTask`) holds the
placement lock, the rollback of partially spawned resumed agents and the prompt
handoff; `spawn/targets.ts` resolves placement and creates the tab or split
pane; `spawn/continuation.ts` reuses a parked question and claims closed
history for `resumeClosed`; `spawn/lifecycle.ts` starts the child, records its
lifecycle and runs the prompt turn. `openClosedAgent` in `spawn/flow.ts` runs the
same `resumeClosed` path for the `/herdr-agents` overlay but stops before the
prompt turn and records the agent with `detached: false`, so the poller never
delivers or closes it.

Layout comes from `herdr-agents.json` ([config.md](config.md)), never the tool
parameters.

Creation responses supply IDs; the extension does not predict them. Placement
is locked through startup, state recording, and pane-column rebalancing so
parallel spawns see each other's targets. Exact equal-height ratios use
`layout.export` and `layout.set_split_ratio` through the socket API.

Child shells receive `HERDR_AGENT_CHILD=1` and `PROCESS_LAUNCHED_BY_Q=1`. The
latter prevents Kiro's shell wrapper from obscuring the real shell. A shell's
history isolation still requires its own child-marker configuration.

Herdr starts a named Pi agent:

```bash
herdr agent start <automation-name> --kind pi --pane <pane-id> --timeout 30000 -- \
  --name '<label>' --append-system-prompt '<system.md>'
```

Profile model, thinking, skills, and tool restrictions add Pi arguments.
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

`herdr_agent` requires TUI mode. RPC, JSON, and print sessions are rejected
before any Herdr call, because they have no widget poller. The profile is
resolved first, so an unknown profile is reported even outside TUI.

`agent` is required to start a new agent. A call that omits it must pass a
`tabLabel`, which `execute` resolves against this session's managed state — the
live record, or the owned closed-history record when `resumeClosed` is set — to
the profile name it continues with. An unresolved label is an error, never a
spawn.

A call without `task` (or with a blank one) is a status check. It first returns
a parked question or an already-collected notice if there is one. Otherwise it
reads the status from `herdr agent get` and previews the child's latest captured
assistant text from `result.md`. It never prompts, waits, claims, closes,
resurrects a closed agent, or reads the terminal.

## Questions and result collection

Child `message_end` appends each non-empty finalized assistant response to
`result.md`, separated by a blank line, so an answer split across several
messages is delivered whole. The child retains its result channel across manual
user, steering and custom-message continuations, including a model switch after
quota exhaustion. A new valid `HERDR_RESULT_FILE:` marker replaces the channel;
starting, resuming or forking a session clears it.

Each managed run writes an `interrupted` marker beside `result.md` before work
starts. Only successful `agent_before_settle` removes it. Escape skips that
boundary, leaving the marker intact even when a tool is interrupted. The poller
leaves unfinished runs open and unclaimed; partial text remains available to
status previews. Send a correction in the same child pane to continue its task.
A successful continuation removes the marker and delivers the accumulated
output. Before a new task, the parent clears old result/question files and the
interruption marker.
Session metadata is stored beside the result for durable resume.

Collection checks `question.md` before `result.md`. `ask_question` writes the
question and returns `terminate: true`, without a redundant assistant response
or provider request. Call it alone, not in a batch with other tools. Failed
question delivery does not terminate the turn. The parent
returns/delivers the question and leaves the one-shot open. Answer by sending
a normal `task` with the same `tabLabel`.

After the claim and before the notification, the close and the temp cleanup, the
complete result is copied once to a report file under
`<agent dir>/herdr-agents-results` (`src/reports.ts`). The delivered text is
bounded only when that copy exists: above 6 000 retained source characters it is
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

`resumeClosed: true` requires an explicit `tabLabel` and a non-empty `task`.
The extension validates session ID/cwd against the native JSONL header and
claims the matching owner-session history slot. Pi starts with `--session`
pointing at that file, using the current profile policy from the archived cwd.
It closes again after the next successful result.

A live label takes precedence: answer a parked question, check the status of
active work, or wait for a detached outcome to be delivered. Resume never
spawns a closed copy over live work. Concurrent resumes have one claim winner.

A failed state save does not abort the spawn. The child still writes its artifact, and the poller cannot deliver or close that agent because it has no record.

State updates use the existing exclusive directory lock with owner sentinels.
There is no automatic stale-lock takeover. Native Pi session files are not
deleted when the extension prunes its bounded closed-history index.
