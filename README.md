# pi-herdr-subagents

A [Pi](https://github.com/earendil-works/pi) extension that lets a Pi session
delegate tasks to child Pi agents running in [Herdr](https://herdr.dev).

The extension adds four tools: `agent_spawn`, `agent_send`, `agent_stop` and
`agent_status`. The main session (the Orchestrator) calls `agent_spawn` with an
agent profile and a task. The extension starts a child Pi in its own Herdr tab or
pane, returns at once, and delivers the child's result back to the Orchestrator
as a message when the child finishes. `agent_send` talks to an existing agent,
`agent_stop` aborts a running one, and `agent_status` checks one or lists them.

## Features

- **One-shot agents.** Each child starts with a fresh context and closes after it
  delivers a result. `agent_send` to a closed agent's name reopens it with its
  prior conversation.
- **Questions.** A child can call `ask_question`. The question reaches the
  Orchestrator, and the answer goes back through `agent_send` with the same
  name.
- **Non-blocking.** The Orchestrator keeps working while children run. Results
  and questions arrive exactly once.
- **Agent control.** `agent_send` to a running agent sends a correction into its
  next turn, and `agent_stop` interrupts its run. Neither starts, resumes,
  answers or closes an agent through the control channel; the call returns a
  status, and a stopped agent normally stays open for continuation or
  close-and-resume. A delivery already in flight can still arrive and close the
  pane. See [docs/tool.md](docs/tool.md#2-control-path).
- **File-based results.** Results are written to artifact files, so long output
  does not depend on terminal scrollback.
- **Durable reports.** Every delivered result is also saved as a plain-text
  report under `~/.pi/agent/pi-herdr-subagents-results` for 30 days. A long
  result is delivered as a head/tail excerpt plus that path, so one big report
  cannot flood the Orchestrator's context.
- **Layouts.** Agents open in a dedicated Herdr workspace (default), as split
  panes, or as tabs in the current workspace.
- **Commands.** `/run` delegates a task explicitly. `/agents` lists and
  focuses your agents, and closes finished ones. `/agent-models` chooses
  models by editing profile frontmatter; new spawns use the pin without reload.

## Requirements

- Pi `1.3.0`.
- Herdr client and server `0.9.5`.
- Herdr's Pi integration `v9`: `herdr integration install pi`.
- The Orchestrator Pi session runs inside a Herdr pane, in interactive (TUI)
  mode. RPC, JSON and print modes are not supported.

The development dependencies `@earendil-works/pi-coding-agent` and
`@earendil-works/pi-tui` are pinned to `1.3.0`, so `npm run typecheck` and the
unit/integration suites compile against the runtime SDK.

## Installation

From a clone of this repository:

```bash
pi install .      # for every project
pi install . -l   # for the current project only (.pi/settings.json)
```

Then run `/reload` in Pi. To try the extension without installing it, start Pi
inside Herdr with `pi -e ./src/index.ts`.

## Agent profiles

`agent_spawn` runs a child from a profile: a markdown file with YAML
frontmatter. The extension ships no profiles; create at least one. Profiles are
read on every call from:

- `~/.pi/agent/agents/*.md` (user profiles);
- the nearest `.pi/agents/` directory above the working directory (project
  profiles). A project profile overrides a user profile with the same name.

```md
---
name: reviewer
description: Reviews code changes for correctness and regressions.
tools: read, grep, find, ls, bash
model: provider/model-id
---

You are a disciplined senior code reviewer.
Report Critical / Warnings / Suggestions with file and line evidence.
```

Save it as `~/.pi/agent/agents/reviewer.md` and run `/reload` so the
Orchestrator and `/run` see the new name.

`name` and `description` are required. Omit `model` to use Pi's default model.
A non-empty `tools` list is an allowlist, with `ask_question` added
automatically; omit it to keep Pi's default tools. By default the body is
appended to the child's system prompt; `system-prompt: replace` replaces it.
Optional fields `thinking`, `skills` and `disable-model-invocation` are
described with the rest in [docs/agent-profiles.md](docs/agent-profiles.md).

## Usage

The Orchestrator calls `agent_spawn` on its own when delegation helps. You can
also ask for it explicitly:

```text
/run reviewer review the current diff for regressions
```

The first word is used as the profile when it matches a discovered profile
name (case-insensitive); otherwise the whole text is the task and the
Orchestrator picks the profile. A named profile is a strong hint, not a
guarantee: the Orchestrator may pick a clearly better one. `/run` is refused
while the Orchestrator is busy with a turn. Profiles added mid-session appear
after `/reload`.

Tool parameters (each tool has its own required set; no mode is chosen by
leaving a parameter out):

| Tool           | Parameters                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------- |
| `agent_spawn`  | `agent` (profile, required), `task` (self-contained, required), `name` (optional; defaults to the title-cased profile name). A `name` that matches a live agent is rejected. |
| `agent_send`   | `name` (exact name of an agent this session owns, required), `message` (required).              |
| `agent_stop`   | `name` (a live agent this session owns, required).                                              |
| `agent_status` | `name` (optional): one agent's status and a preview of its latest text; without it, the live agents this session owns. |

```json
{
  "agent": "reviewer",
  "name": "Diff review",
  "task": "Review the current diff for regressions."
}
```

`agent_send` picks what to do from the state of `name`:

1. A live agent that asked a question: `message` is the answer.
2. A live agent that is working: `message` is a steer, injected at its next turn
   boundary. An agent that already settled reports that its result arrives
   automatically.
3. No live agent, but a closed one of this session: it resumes with its prior
   conversation and `message` is the new task. The profile comes from the stored
   record.
4. Otherwise the call reports an unknown name.

A steer or stop call returns one status: `queued`, `aborted`, `requested`,
`idle`, or `unknown`. `queued` means the message reached the agent's steering
queue, not that the model read it, and a stop drops it. `unknown` means no
acknowledgement arrived within the deadline; do not retry it, check the agent's
status instead. A stopped agent normally stays open: continue it manually in its
pane, or close it with `/agents` and continue it with `agent_send`. A delivery
already in flight can still arrive and close the pane; ignore a result for work
you interrupted.

How an agent runs:

1. The call returns as soon as the task is sent to the child.
2. When the child finishes, its result arrives in the Orchestrator as a message
   and the child closes.
3. If the child asks a question, it stays open. Answer it with `agent_send` and
   the same `name`.
4. A child that stops without writing a result stays open. Inspect it or close
   it with `/agents`.

Every delivered result is copied to a report file under
`~/.pi/agent/pi-herdr-subagents-results`, one file per delivered outcome (a
resumed turn writes its own). The delivered message ends with
`Full report saved to <path>`;
read it with `offset`/`limit` to page through the part the message left out. A
result above 6 000 characters arrives as its first 4 000 and last 2 000
characters around a `… N characters omitted …` marker — that bound counts
retained source characters, so the message itself is slightly longer than the
excerpt. Reports are deleted 30 days after they are written, when the extension
loads or after a new save; questions and interrupted runs write none. If a
report cannot be written, the complete result is delivered with a warning
instead of an excerpt.

If a child hits a model limit, switch models in its pane and send `continue`.
Manual and steering messages preserve its result channel. Failed or aborted
turns stay open with their partial output until a successful continuation.
You can also press Escape in the child pane and send a correction to continue
the same task without losing its context or result channel.

`agent_spawn` with an explicit `name` that belongs to a live agent is rejected,
so work is never duplicated: use `agent_send` to answer or steer it, or wait
until it closes and `agent_send` to continue it. Without `name`, a second call
for the same profile starts another agent with a suffixed name, such as
`Reviewer #2`.

`/agents` lists the agents this Orchestrator started, across workspaces:
`Enter` focuses an agent, `d` or `Ctrl+D` closes it, `Esc` exits. Only finished
agents can be closed; a working agent or one waiting on a question is kept. The
list refreshes once a second while it stays open, so an agent spawned in
parallel, or a changed context, status or cost, appears without reopening it;
the selected row is kept by its identity (the pane for a live agent, the
history record for a closed one). Opening the command with nothing to list
shows the same watching list, so a spawn in another pane appears there too.

Below the live agents it lists the closed one-shots of the current Orchestrator
session. `Enter` on one reopens its Pi session in a new pane or tab without
sending a task, so you can read what it did; close it with `d` to archive it
again. Anything typed into the reopened agent extends its session, and
`agent_send` to that name steers or answers it while it stays open.

Above the editor, a widget lists the same agents with their task time, label and
status. Both surfaces show the child's current context as `ctx 38k / 200k`: the
estimated tokens of its current context over its model window. A child that has
not finished a turn yet, or whose capacity Pi cannot determine, shows `ctx —`;
`ctx — / 200k` is a known window with an unknown count, and `ctx 0 / 200k` is a
measured empty context. The value is published after each finalized child turn,
so it can lag the turn in progress, and after compaction it stays unknown until
the next response.

The `/agents` rows also show the child session's recorded cost estimate as
`~$0.024`: the sum of the usage Pi stored across the whole child session
(assistant messages, tool results, standalone usage and compaction), not the
current task's share. `<$0.001` is a recorded amount below that rounding,
`~$0.000` is a recorded zero, and `cost —` means the child recorded no cost at
all, or recorded one Pi could not read as a whole — never a fabricated zero and
never a partial sum. It is a provider-reported USD estimate of the last
published snapshot, not a subscription or billing total, so it can lag the turn
in progress. The row reads `status • cost • ctx`, so the price stays visible in
a narrow overlay. The widget stays context-only. Closed rows show `closed`, the
frozen cost and the time they were archived; the pane id and cwd stay in managed
state for focus, close and resume.

New child sessions are stored in `<getAgentDir()>/herdr-agent-sessions`
(default: `~/.pi/agent/herdr-agent-sessions`), outside the default `/resume`
history. Use `agent_send` or `/agents` to reopen them. Existing child
sessions are not moved and remain visible in the default history.

## Configuration

Optional settings live in `~/.pi/agent/pi-herdr-subagents.json`. The file is read
once when the extension loads; run `/reload` after editing it. A missing or
invalid file uses the defaults. State and its lock are local to the active Pi
agent directory: `<getAgentDir()>/pi-herdr-subagents-state.json` and its `.lock`
sidecar. Profiles can share a config symlink without sharing state. An explicit
`PI_AGENTS_STATE_PATH` overrides the state path.

The state file and reports directory are renamed once at load from the older
`herdr-agents-*` names in the same directory; the config file is not renamed for
you. Existing multi-profile installations must back up and split the previously
shared state before using profile-local files
([docs/config.md](docs/config.md#storage-names)).

```json
{
  "layout": "workspace",
  "workspace": { "label": "subagents" }
}
```

| `layout`              | Where agents open                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `workspace` (default) | One tab per agent in a dedicated workspace, recreated if you close it.                     |
| `pane`                | The first agent splits your pane 60/40. Later agents stack in the right column.            |
| `tab`                 | One tab per agent in your current workspace.                                               |

`workspace.label` must differ from the label of the workspace the Orchestrator
runs in; otherwise starting an agent fails.

Let running agents finish before you change `layout`. Agents started with the
old layout stay visible in `/agents`, but status checks and reuse no
longer find them. See [docs/config.md](docs/config.md).

## Development

```bash
npm ci --ignore-scripts   # install locked dependencies
npm run typecheck         # tsc over src/
npm run lint              # oxlint
npm run format            # oxfmt, rewrites files in place
npm run test:unit         # pure helpers, seconds
npm run test:integration  # extension against a simulated Herdr, about 2 minutes
npm run test:e2e          # real Herdr server and real Pi children
```

E2E tests need `pi` and `herdr` on `PATH`. All tests use temporary directories
and state files, so a running Pi or Herdr session is not affected.

## Documentation

- [docs/config.md](docs/config.md): `pi-herdr-subagents.json` fields and defaults.
- [docs/agent-profiles.md](docs/agent-profiles.md): profile fields and discovery.
- [docs/tool.md](docs/tool.md): the `agent_spawn`, `agent_send`, `agent_stop` and
  `agent_status` tool contracts, and the instructions injected into the
  Orchestrator.
- [docs/flow.md](docs/flow.md): the runtime lifecycle of an agent call.

## License

[MIT](LICENSE)
