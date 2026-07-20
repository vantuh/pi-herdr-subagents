# herdr-agents documentation

`herdr-agents` is a Pi extension that turns Herdr into a one-shot or persistent delegation layer.

It registers a `herdr_agent` tool. The tool creates Herdr panes by default, starts Pi agents in them, gives them role-specific prompts from `~/.pi/agent/agents/*.md`, waits for their result, and returns the visible output to the Orchestrator. One-shot agents close after a successful result; persistent agents stay open and are reused for matching follow-up tasks. Set `HERDR_AGENTS_LAYOUT=tab` before starting Pi to restore the legacy tab layout; layout is intentionally absent from the tool schema.

## Why this exists

The original Herdr workflow was written as prose in `AGENTS.md`: create tabs, name them, run Pi, wait, read output, keep panes open. That worked, but it asked the model to manually remember Herdr CLI details.

This extension moves that workflow into a tool:

- less prompt boilerplate;
- fewer raw `herdr` CLI calls from the model;
- consistent tab naming and child protocol;
- fresh context for one-shot delegated agents;
- persistent Herdr tabs when a role should remain inspectable and reusable.

## Delegation policy

Global `agents/.agents/AGENTS.md` is authoritative for **when** to delegate. This extension docs describe **how** Pi/Herdr delegates.

| Situation | `agent` profile | Delegate? | Default lifecycle | Expected output |
|---|---|:---:|---:|---|
| Unknown code, entry points, call/data-flow tracing | `scout` | when needed | one-shot | file/line evidence, flow, likely change areas, risks |
| Official docs, API behavior, library choice, current facts | `researcher` | when needed | one-shot | concise decision brief, primary-source links, gaps |
| Multi-file approach after code/requirements are understood | `planner` | after scout | one-shot | ordered plan with paths, validations, open questions |
| Clear and isolated implementation slice | `worker` | after plan | one-shot | minimal diff and actual validation result |
| Non-trivial/risky final diff, migration, public contract | `reviewer` | when needed | one-shot | evidence-backed Critical / Warnings / Suggestions |
| Bounded domain with expected follow-up | same role | — | persistent | stable scope-specific `tabLabel` and explicit handoff |

**When NOT to delegate** (stay direct in Orchestrator tab):

- needle query: specific file, class, or function in 1–2 files
- known single-file edit or typo fix
- one-command check (`git status`, single test run)
- answer is already in the current conversation context

**Negative policy:** no parallel workers with overlapping write areas. Parallelize only independent reads or disjoint write slices (2–3 agents max).

**Lifecycle examples:**

- One-shot scout: `{ "agent": "scout", "task": "...", "lifecycle": "oneshot" }` — tab closes after result.
- Persistent scout: `{ "agent": "scout", "tabLabel": "Scout — message-bus", "task": "...", "lifecycle": "persistent" }` — follow-up reuses the same label.
- Re-wait after timeout: `{ "tabLabel": "Scout — message-bus" }` with no `task`.

## Main concepts

### Orchestrator

The current/main Pi session. It receives the user's request and decides whether isolated context is useful.

On first use, the extension renames the current Herdr tab to `Orchestrator`.

### Herdr agent

A child Pi process launched in a managed Herdr pane or tab.

The internal layout defaults to `pane`: the first agent splits the Orchestrator pane to the right at 60/40, and additional agents split the largest managed pane downward in the right column. After spawn or close, the extension rebalances that column to equal heights (for example, three agents use thirds). Short placement operations are serialized so parallel tool calls preserve that structure. `HERDR_AGENTS_LAYOUT=tab` selects the legacy one-tab-per-agent behavior.

Lifecycle modes are independent of layout:

- `lifecycle: "oneshot"` — one-shot task. The extension waits for the result, reads output, then closes the managed target after successful completion.
- `lifecycle: "persistent"` — reusable role. The target remains open after completion and matching future tasks are sent to it instead of creating a duplicate.

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

### Layout configuration

Pane mode is the default and requires no environment variable. To temporarily restore legacy tab mode, set this before starting Pi (for example in `zsh/.zshrc.d/10-env.zsh`):

```sh
export HERDR_AGENTS_LAYOUT=tab
```

Use `pane` or remove the variable to return to the default. Restart Pi after changing a shell environment variable; `/reload` reloads extension code but cannot import environment changes from the parent shell.

## Tool parameters

`herdr_agent` accepts:

```ts
{
  agent: string;
  task: string;
  tabLabel?: string;
  wait?: boolean;
  timeoutMs?: number;
  lifecycle?: "oneshot" | "persistent";
}
```

### `/run` command

Explicit delegation via `/run`:

```text
/run scout find where auth is handled
/run reviewer check the current diff
/run implement the login timeout fix
```

`/run [agent] <task>` injects a one-turn delegation authorization and sends the task as a user message.

Typical tool call:

```json
{
  "agent": "reviewer",
  "tabLabel": "HR Correctness",
  "task": "Review the current diff for correctness and regressions...",
  "wait": true,
  "lifecycle": "oneshot"
}
```

## Known design choices

- `lifecycle: "oneshot"` is the default: use one-shot agents unless the role needs to survive for later tasks.
- One-shot targets are closed only after successful completion and output read; timeout/error/abort leaves them open for debugging.
- `lifecycle: "persistent"` reuses an existing managed agent by exact label. Pane mode searches the Orchestrator tab; legacy tab mode searches sibling tabs.
- Fresh context is preferred over forked conversation context for newly created agents.
- Child agents are prevented from recursively registering `herdr_agent` by `HERDR_AGENT_CHILD=1`.
- The Orchestrator must synthesize child results. Child output should not be blindly forwarded.
- Raw Herdr CLI remains useful for diagnostics, but normal delegation should go through `herdr_agent`.

See also:

- [`flow.md`](./flow.md) — detailed lifecycle.
- [`session-findings.md`](./session-findings.md) — development findings and bug history.
- [`composer-cursor-sdk-compatibility.md`](./composer-cursor-sdk-compatibility.md) — Composer tool-name adaptation and tool/skill boundary tuning.
