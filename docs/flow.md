# herdr_agent flow

Current runtime: Pi `1.2.0`, Herdr client/server `0.9.4`, official Pi integration
`v9`. See [README.md](../README.md) for loading and tool parameters.

## Loading and profiles

Pi loads `src/index.ts` through the package manifest or an explicit
`pi -e ./src/index.ts`. The main session registers `herdr_agent`, commands,
renderers, and orchestration guidance. `HERDR_AGENT_CHILD=1` registers only the
child result/session writer and model-only `ask_question`.
Orchestration guidance uses the named `herdr_agents` system-prompt section for
both user and custom-message runs, preserving Pi's other prompt sections.

`src/agents.ts` discovers profiles on every call from `getAgentDir()/agents`
and the nearest project `.pi/agents`. Project profiles override user profiles
by name. See [agent-profiles.md](agent-profiles.md) for fields and precedence.

New children have fresh context. The role body and child protocol are written
to `system.md`, passed through `--append-system-prompt` or `--system-prompt`.
The task prompt includes the private `HERDR_RESULT_FILE` marker.

## Target placement and startup

`herdr api snapshot` discovers the session. `HERDR_PANE_ID` takes precedence
over UI focus because focus can change while a tool runs.

Layout comes from `herdr-agents.json`, never the tool parameters:

- `workspace` (default): one tab per agent in the dedicated `subagents` workspace.
- `pane`: first split is right at 60/40; later agents stack down the right column.
- `tab`: one tab per agent in the orchestrator's workspace.

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

## Prompt submission and waiting

Every task uses atomic `herdr agent prompt` without `--wait`. The upstream
`--wait` path has a five-second activity gate, which is too short for some
Pi transitions. For blocking calls, the longer acceptance wait requires newer working/blocked
activity or a newer actual `completion_seq` while idle/done. An arbitrary idle
state change does not count. The extension never sends an extra Enter. After
acceptance it uses:

```bash
herdr agent wait <target> --until idle --until done --timeout 600000
```

`blocked` is not completion: it may be an approval dialog. `herdr:blocked`
marks the waiting orchestrator through the official Pi integration.

In TUI sessions, task submission detaches by default. The per-second widget
poller collects settled agents and delivers custom result/question messages.
Explicit `wait: true` blocks. Non-TUI submission must wait because it has no
background collector. Explicit `wait: false` is rejected outside TUI mode,
including taskless re-waits. RPC's `hasUI` does not provide a widget collector.

Timeout or abort leaves the child running. Re-wait with the same `tabLabel`
and no `task`; this never resubmits the prompt or resurrects a closed agent.

## Questions and result collection

Child `message_end` writes each non-empty finalized assistant response to
`result.md`. Before a new task, the parent clears old result/question files.
Session metadata is stored beside the result for durable resume.

Collection checks `question.md` before `result.md`. `ask_question` writes the
question and returns `terminate: true`, without a redundant assistant response
or provider request. Call it alone, not in a batch with other tools. Failed
question delivery does not terminate the turn. The parent
returns/delivers the question and leaves the one-shot open. Answer by sending
a normal `task` with the same `tabLabel`.

If no result artifact exists, the explicit collection path can read terminal
output through `agent read --source recent-unwrapped --lines 180`. Artifacts
remain the primary channel because scrollback cannot guarantee complete output.

Detached claims use the shared state lock so synchronous and background
collection do not deliver the same outcome twice. Outcomes found in one poller
tick are batched; only the final custom message triggers a turn.

## Close and resume

Every new agent is a one-shot. Historical persistent records remain stored but
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

A live label takes precedence: answer a parked question, re-wait active work,
or collect a detached outcome first. Resume never spawns a closed copy over
live work. Concurrent resumes have one claim winner.

State updates use the existing exclusive directory lock with owner sentinels.
There is no automatic stale-lock takeover. Native Pi session files are not
deleted when the extension prunes its bounded closed-history index.
