# herdr_agent flow

Current runtime: Pi `1.2.0`, Herdr client/server `0.9.4`, official Pi integration
`v9`. See [README.md](../README.md) for loading and tool parameters.

## Loading and profiles

Pi loads `src/index.ts` through the package manifest or an explicit
`pi -e ./src/index.ts`. The main session registers `herdr_agent`, commands,
renderers, and orchestration guidance; the tool body itself is
`src/tool/execute.ts` (`executeHerdrAgent`). `HERDR_AGENT_CHILD=1` registers
only the child result/session writer and model-only `ask_question`.
Orchestration guidance uses the named `herdr_agents` system-prompt section for
both user and custom-message runs, preserving Pi's other prompt sections.

`src/agents.ts` discovers profiles on every call from `getAgentDir()/agents`
and the nearest project `.pi/agents`. `session_start` (including `/reload`)
also rediscovers them to refresh the `Available:` list in the tool schema.
`herdr-agents.json` is read once at extension load. Project profiles override user profiles
by name. See [agent-profiles.md](agent-profiles.md) for fields and precedence.

New children have fresh context. The role body and child protocol are written
to `system.md`, passed through `--append-system-prompt` (default) or
`--system-prompt` (profile `system-prompt: replace`).
The task prompt includes the private `HERDR_RESULT_FILE` marker.

## Target placement and startup

`herdr api snapshot` discovers the session. `HERDR_PANE_ID` takes precedence
over UI focus because focus can change while a tool runs.

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
The per-second widget poller is the only collector: it delivers a settled
result or question and closes a finished one-shot. The extension never sends
an extra Enter.

`herdr_agent` requires TUI mode. RPC, JSON, and print sessions are rejected
before any Herdr call, because they have no widget poller. The profile is
resolved first, so an unknown profile is reported even outside TUI.

A call without `task` (or with a blank one) is a status check. It first returns
a parked question or an already-collected notice if there is one. Otherwise it
reads the status from `herdr agent get` and previews the child's latest captured
assistant text from `result.md`. It never prompts, waits, claims, closes,
resurrects a closed agent, or reads the terminal.

## Questions and result collection

Child `message_end` appends each non-empty finalized assistant response to
`result.md`, separated by a blank line, so an answer split across several
messages is delivered whole. Before a new task, the parent clears old result/question files.
Session metadata is stored beside the result for durable resume.

Collection checks `question.md` before `result.md`. `ask_question` writes the
question and returns `terminate: true`, without a redundant assistant response
or provider request. Call it alone, not in a batch with other tools. Failed
question delivery does not terminate the turn. The parent
returns/delivers the question and leaves the one-shot open. Answer by sending
a normal `task` with the same `tabLabel`.

If the agent settled without a result artifact, a status check reports
`finished without a result`; the poller does not deliver that case and the agent
stays open. A working agent without an artifact reports its Herdr status.
Agent output comes only from artifacts: terminal scrollback is never read, because a Pi pane's output
is mostly TUI chrome (banner, resource lists, redraw frames, status bar).

Detached claims use the shared state lock so background collection does not
deliver the same outcome twice. Outcomes found in one poller tick are batched;
only the final custom message triggers a turn.

## Close and resume

Every spawned agent is a one-shot; answering a parked question reuses its open
target instead of spawning. Historical persistent records remain stored but
unmanaged; they are never converted to closable one-shots or claimed for delivery.
Successful collection stages continuation
metadata before closing the owned pane/tab. Only then does the extension
finalize the archived history and clean up temporary files. Close failures
return the collected output with a warning and leave the target inspectable.

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
