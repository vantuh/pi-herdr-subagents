# pi-herdr-subagents

A Pi coding-agent extension (package
`@vantuh/pi-herdr-subagents`) that delegates one-shot tasks to child Pi agents
running in [Herdr](https://herdr.dev) panes or tabs.

It registers a `herdr_agent` tool. The orchestrating Pi session calls it with an
agent profile and a self-contained task. The extension starts a child Pi process
through Herdr's agent automation API, waits for (or later collects) the result,
and closes the target.

## Capabilities

- `herdr_agent` tool: spawn a child Pi agent from a markdown profile, then
  collect its result.
- One-shot agents with fresh context. A closed agent can be continued with its
  prior context through `resumeClosed`.
- A question channel: a child can call `ask_question` and the orchestrator
  answers it with a normal follow-up task.
- Async delivery: in TUI mode, results (or questions) are delivered by a widget
  poller once the agent settles. RPC, JSON, and print sessions wait for the outcome.
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
| `task` | Self-contained task. Omit it to re-wait on a running agent by `tabLabel`. |
| `tabLabel` | Agent label; defaults to the title-cased profile name. Identifies the agent for re-wait, answers and resume. |
| `wait` | `true` blocks for the result. Default `false` in TUI mode: the poller delivers the outcome later. RPC, JSON, and print sessions default to `true` and reject explicit `false`, including taskless re-waits. |
| `resumeClosed` | Continue a closed one-shot, matched by exact `tabLabel`, with its prior context. Requires `task`. |

```json
{ "agent": "reviewer", "tabLabel": "Diff review", "task": "Review the current diff for regressions.", "wait": true }
```

Lifecycle:

- Every agent is a one-shot. The target closes after a successful result; on
  timeout, error or abort it stays open for debugging. The fixed wait timeout
  is 600 s, after which the tool returns a re-wait hint.
- A child that calls `ask_question` stays open. Answer with a normal `task` and
  the same `tabLabel`.
- A task sent by `tabLabel` to a live agent is rejected rather than spawning a
  duplicate. Re-wait, answer the question, or use `resumeClosed` after it closes.
- Detached results and questions are delivered exactly once.

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

The file is read on every spawn. **Do not change `layout` while agents are
live:** they become orphaned. They stay visible and closable through
`/herdr-agents`, but re-wait only finds agents of the configured layout.

## Development

```bash
npm ci --ignore-scripts   # install locked development dependencies
npm test                  # unit project: helpers, integration, contract; no real Herdr
npm run test:e2e          # e2e project: real Herdr server and real Pi children
npm run test:all          # both projects
```

Tests use local dependencies from `package-lock.json`. E2E also requires `pi`
and `herdr` on `PATH`. Tests redirect `TMPDIR`, state and the Pi agent dir,
so a live session is not touched.

## Documentation

- [docs/config.md](docs/config.md) — `herdr-agents.json` fields and defaults.
- [docs/agent-profiles.md](docs/agent-profiles.md) — profile fields and discovery.
- [docs/flow.md](docs/flow.md) — runtime lifecycle of `herdr_agent`.
- [docs/tool.md](docs/tool.md) — exposed tool contract and injected instructions.
