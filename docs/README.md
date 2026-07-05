# herdr-agents documentation

`herdr-agents` is a Pi extension that turns Herdr into a persistent delegation layer.

It registers a `herdr_agent` tool. The tool creates or reuses Herdr tabs, starts fresh Pi agents in those tabs, gives them role-specific prompts from `~/.pi/agent/agents/*.md`, waits for their result, and returns the visible pane output to the Orchestrator.

## Why this exists

The original Herdr workflow was written as prose in `AGENTS.md`: create tabs, name them, run Pi, wait, read output, keep panes open. That worked, but it asked the model to manually remember Herdr CLI details.

This extension moves that workflow into a tool:

- less prompt boilerplate;
- fewer raw `herdr` CLI calls from the model;
- consistent tab naming and child protocol;
- fresh context for delegated agents;
- persistent Herdr tabs that remain inspectable by the user.

## Main concepts

### Orchestrator

The current/main Pi session. It receives the user's request and decides whether isolated context is useful.

On first use, the extension renames the current Herdr tab to `Orchestrator`.

### Herdr agent

A child Pi process launched in its own Herdr tab. It is persistent: the tab remains open after completion.

The child receives:

1. the normal Pi runtime/tooling;
2. an agent profile prompt from `~/.pi/agent/agents/<name>.md`;
3. the `HERDR_RESULT` completion protocol;
4. a self-contained task prompt from the Orchestrator.

### Agent profile

A markdown file with frontmatter and a body, for example:

```md
---
name: reviewer
description: Reviews code changes for correctness and regressions.
tools: read, grep, find, ls, bash
model: kiro-acp/claude-opus-4.8
---

You are a disciplined senior code reviewer.
...
```

The extension uses:

- `name` to select the profile;
- `description` for availability/debug details;
- `tools` to restrict child Pi tools;
- `model` to select the child model;
- body as the child system prompt addition.

## Runtime files

- `index.ts` — registers the Pi extension hook and `herdr_agent` tool.
- `constants.ts` — global injected instruction and child protocol text.
- `agents.ts` — profile discovery and frontmatter parsing.
- `herdr.ts` — Herdr CLI calls, tab/pane lookup, completion waiting.
- `schema.ts` — TypeBox tool parameter schema.
- `utils.ts` — shell-safe command building and temp prompt files.
- `types.ts` — shared interfaces.

## Loading

The extension is loaded from the symlinked Pi extension directory:

```text
~/.pi/agent/extensions/herdr-agents/index.ts
```

Its package metadata declares only the extension entrypoint:

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

A global `/parallel-review` Pi prompt uses this extension's `herdr_agent` tool, but the prompt itself is maintained outside this extension.

## Tool parameters

`herdr_agent` accepts:

```ts
{
  agent: string;
  task: string;
  tabLabel?: string;
  wait?: boolean;
  timeoutMs?: number;
  reuseExisting?: boolean;
}
```

Typical call:

```json
{
  "agent": "reviewer",
  "tabLabel": "HR Correctness",
  "task": "Review the current diff for correctness and regressions...",
  "wait": true
}
```

## Known design choices

- Tabs are not closed automatically.
- Fresh context is preferred over forked conversation context.
- Child agents are prevented from recursively registering `herdr_agent` by `HERDR_AGENT_CHILD=1`.
- The Orchestrator must synthesize child results. Child output should not be blindly forwarded.
- Raw Herdr CLI remains useful for diagnostics, but normal delegation should go through `herdr_agent`.

See also:

- [`flow.md`](./flow.md) — detailed lifecycle.
- [`session-findings.md`](./session-findings.md) — development findings and bug history.
