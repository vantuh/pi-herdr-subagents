# pi-herdr-subagents

A Pi coding-agent extension (package
`@vantuh/pi-herdr-subagents`) that delegates one-shot tasks to child Pi agents
running in [Herdr](https://herdr.dev) panes or tabs.

It registers a `herdr_agent` tool. The orchestrating Pi session calls it with an
agent profile and a self-contained task. The extension starts a child Pi process
through Herdr's agent automation API, returns once the prompt is submitted,
and the poller delivers the result and closes the target.

## Capabilities

- `herdr_agent` tool: spawn a child Pi agent from a markdown profile, then
  collect its result.
- One-shot agents with fresh context. A closed agent can be continued with its
  prior context through `resumeClosed`.
- A question channel: a child can call `ask_question` and the orchestrator
  answers it with a normal follow-up task.
- Async delivery: results and questions are delivered by the TUI widget
  poller once the agent settles. RPC, JSON, and print sessions are rejected.
- Result artifacts, so large outputs do not depend on terminal scrollback.
- Commands: `/run`, `/herdr-agents`.
- Layouts: a dedicated subagents workspace (default), split panes, or tabs.

## Prerequisites

- Pi `1.2.0` and [Herdr](https://herdr.dev) client/server `0.9.4`.
  Only current APIs are supported; no older-version compatibility layer.
- Herdr's official Pi integration `v9`, installed with
  `herdr integration install pi`. It supplies authoritative lifecycle and
  session reporting. Install it yourself; tests use an isolated agent directory.
- The orchestrating Pi session must run inside a Herdr pane.

## Loading

The package manifest declares `./src/index.ts` as its Pi extension entrypoint.
Try it inside Herdr with `pi -e ./src/index.ts`. For persistent loading, run
`pi install .` from this repository, then `/reload` in Pi.
Pi supplies the peer dependencies when loading the extension. For local
development, run `npm ci --ignore-scripts` to install the locked dependencies.

Child agents set `HERDR_AGENT_CHILD=1`. In that mode only `ask_question` and the
result writer are registered, so children cannot delegate through this extension.

## Agent profile

A profile is a markdown file with YAML frontmatter, selected by the `agent`
parameter. Profiles are read on every call from `<pi agent dir>/agents/*.md`
(`~/.pi/agent/agents` by default) and from the nearest `.pi/agents` above the
working directory. A project profile overrides a user profile of the same name.

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

Replace `provider/model-id` with a model available in your Pi configuration, or
omit `model` to use Pi's default. `name` and `description` are required; the body
is appended to the child's system prompt. See
[docs/agent-profiles.md](docs/agent-profiles.md) for every field.

## Usage

Fields of the `herdr_agent` tool:

| Field | Description |
|---|---|
| `agent` | Profile name. |
| `task` | Self-contained task. Omit it to check a live agent's status by `tabLabel`. |
| `tabLabel` | Agent label; defaults to the title-cased profile name. Identifies the agent for status checks, answers and resume. |
| `resumeClosed` | Continue a closed one-shot, matched by exact `tabLabel`, with its prior context. Requires `task`. |

```json
{ "agent": "reviewer", "tabLabel": "Diff review", "task": "Review the current diff for regressions." }
```

Lifecycle:

- Every agent is a one-shot. The call returns when the prompt is submitted.
  The widget poller delivers the result and then closes the target. A child
  that settles without a result artifact stays open; a status check shows its
  scrollback, and `/herdr-agents` can close it.
- `herdr_agent` requires TUI mode. RPC, JSON, and print sessions are rejected
  before any Herdr call.
- A child that calls `ask_question` stays open. The question arrives as a
  message. Answer with a normal `task` and the same `tabLabel`.
- A task sent by `tabLabel` to a live agent is rejected rather than spawning a
  duplicate. Check its status, answer the question, or use `resumeClosed` after
  it closes.
- Results and questions are delivered exactly once.

### Commands

- `/run [agent] <task>` — explicitly delegate a task, for example
  `/run scout find where auth is handled`.
- `/herdr-agents` — TUI-only overlay to list managed agents across workspaces, focus or close them.

## Configuration

Layout is set in `herdr-agents.json` in the Pi agent dir. It is not part of the
tool schema. Field rules are in [docs/config.md](docs/config.md). A missing or
invalid file falls back to the defaults:

```json
{
  "layout": "workspace",
  "workspace": { "label": "subagents" }
}
```

| `layout` | Behavior |
|---|---|
| `workspace` (default) | One tab per agent in a dedicated workspace, created again if you close it. Your own workspace gains no splits or tabs. |
| `pane` | The first agent splits the orchestrator pane 60/40; further agents stack in the right column. |
| `tab` | One tab per agent in the current workspace. |

The file is read once when the extension is loaded, not on every spawn.
Config changes only take effect on `/reload` (or after restarting Pi); editing it
mid-session has no effect. **Do not change `layout` while agents are
live:** the running session keeps the old layout until reload, and after the
reload the agents of the previous layout become orphaned. They stay visible and
closable through `/herdr-agents`, but status checks and reuse only find agents of
the configured layout.

## Development

```bash
npm ci --ignore-scripts   # install locked development dependencies
npm run test:unit         # pure helpers; seconds
npm run test:integration  # extension against a simulated Herdr; minutes
npm run test:e2e          # real Herdr server and real Pi children
```

Tests use local dependencies from `package-lock.json`. E2E also requires `pi`
and `herdr` on `PATH`. Tests redirect `TMPDIR`, state and the Pi agent dir,
so a live session is not touched.

## Documentation

- [docs/config.md](docs/config.md) — `herdr-agents.json` fields and defaults.
- [docs/agent-profiles.md](docs/agent-profiles.md) — profile fields and discovery.
- [docs/flow.md](docs/flow.md) — runtime lifecycle of `herdr_agent`.
- [docs/tool.md](docs/tool.md) — exposed tool contract and injected instructions.
