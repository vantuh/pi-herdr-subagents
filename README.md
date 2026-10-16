# pi-herdr-subagents

A [Pi](https://github.com/earendil-works/pi) extension that lets a Pi session
delegate tasks to child Pi agents running in [Herdr](https://herdr.dev).

The extension adds a `herdr_agent` tool. The main session (the Orchestrator)
calls it with an agent profile and a task. The extension starts a child Pi in its
own Herdr tab or pane, returns at once, and delivers the child's result back to
the Orchestrator as a message when the child finishes.

## Features

- **One-shot agents.** Each child starts with a fresh context and closes after it
  delivers a result. `resumeClosed` reopens a closed agent with its prior
  conversation.
- **Questions.** A child can call `ask_question`. The question reaches the
  Orchestrator, and the answer goes back as a normal task with the same label.
- **Non-blocking.** The Orchestrator keeps working while children run. Results
  and questions arrive exactly once.
- **File-based results.** Results are written to artifact files, so long output
  does not depend on terminal scrollback.
- **Durable reports.** Every delivered result is also saved as a plain-text
  report under `~/.pi/agent/herdr-agents-results` for 30 days. A long result is
  delivered as a head/tail excerpt plus that path, so one big report cannot
  flood the Orchestrator's context.
- **Layouts.** Agents open in a dedicated Herdr workspace (default), as split
  panes, or as tabs in the current workspace.
- **Commands.** `/run` delegates a task explicitly. `/herdr-agents` lists and
  focuses your agents, and closes finished ones. `/herdr-agent-models` chooses
  models by editing profile frontmatter; new spawns use the pin without reload.

## Requirements

- Pi `1.2.0`.
- Herdr client and server `0.9.5`.
- Herdr's Pi integration `v9`: `herdr integration install pi`.
- The Orchestrator Pi session runs inside a Herdr pane, in interactive (TUI)
  mode. RPC, JSON and print modes are not supported.

## Installation

From a clone of this repository:

```bash
pi install .      # for every project
pi install . -l   # for the current project only (.pi/settings.json)
```

Then run `/reload` in Pi. To try the extension without installing it, start Pi
inside Herdr with `pi -e ./src/index.ts`.

## Agent profiles

`herdr_agent` runs a child from a profile: a markdown file with YAML
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

The Orchestrator calls `herdr_agent` on its own when delegation helps. You can
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

Tool parameters:

| Parameter      | Description                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------- |
| `agent`        | Profile name. Required to start a new agent; omit it when `tabLabel` addresses an existing one.    |
| `task`         | Self-contained task. Omit it to check the status of a live agent by `tabLabel`.                    |
| `tabLabel`     | Agent label. Defaults to the title-cased profile name. Used for status checks, answers and resume. |
| `resumeClosed` | Reopen a closed agent, matched by `tabLabel`, with its prior conversation. Requires `task` and an explicit `tabLabel`; only agents started by the current Orchestrator session can be resumed. |

```json
{
  "agent": "reviewer",
  "tabLabel": "Diff review",
  "task": "Review the current diff for regressions."
}
```

How an agent runs:

1. The call returns as soon as the task is sent to the child.
2. When the child finishes, its result arrives in the Orchestrator as a message
   and the child closes.
3. If the child asks a question, it stays open. Answer it with `task` set to the
   answer and the same `tabLabel`.
4. A child that stops without writing a result stays open. Inspect it or close
   it with `/herdr-agents`.

Every delivered result is copied to a report file under
`~/.pi/agent/herdr-agents-results`, one file per delivered outcome (a `resumeClosed`
turn writes its own). The delivered message ends with `Full report saved to <path>`;
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

A new task sent with an explicit `tabLabel` that belongs to a live agent is
rejected, so work is never duplicated: check its status, answer its question,
or wait until it closes and use `resumeClosed`. Without `tabLabel`, a second call
for the same profile starts another agent with a suffixed label, such as
`Reviewer #2`.

`/herdr-agents` lists the agents this Orchestrator started, across workspaces:
`Enter` focuses an agent, `d` or `Ctrl+D` closes it, `Esc` exits. Only finished
agents can be closed; a working agent or one waiting on a question is kept.

Below the live agents it lists the closed one-shots of the current Orchestrator
session. `Enter` on one reopens its Pi session in a new pane or tab without
sending a task, so you can read what it did; close it with `d` to archive it
again. Anything typed into the reopened agent extends its session, and
`resumeClosed` on that label is rejected while it stays open.

## Configuration

Optional settings live in `~/.pi/agent/herdr-agents.json`. The file is read
once when the extension loads; run `/reload` after editing it. A missing or
invalid file uses the defaults:

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
old layout stay visible in `/herdr-agents`, but status checks and reuse no
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

- [docs/config.md](docs/config.md): `herdr-agents.json` fields and defaults.
- [docs/agent-profiles.md](docs/agent-profiles.md): profile fields and discovery.
- [docs/tool.md](docs/tool.md): the `herdr_agent` tool contract and the
  instructions injected into the Orchestrator.
- [docs/flow.md](docs/flow.md): the runtime lifecycle of an agent call.

## License

[MIT](LICENSE)
