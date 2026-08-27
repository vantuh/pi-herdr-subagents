# herdr-agents documentation

`herdr-agents` is a Pi extension that turns Herdr into a one-shot or persistent delegation layer.

It registers a `herdr_agent` tool. The tool creates Herdr panes by default, starts named Pi agents through Herdr's agent automation API, gives them role-specific prompts from `~/.pi/agent/agents/*.md`, waits atomically for their result, and returns a persisted result artifact (or terminal output fallback) to the Orchestrator. One-shot agents close after a successful result; persistent agents stay open and are reused for matching follow-up tasks. Set `HERDR_AGENTS_LAYOUT=tab` before starting Pi to restore the legacy tab layout; layout is intentionally absent from the tool schema.

## Why this exists

The original Herdr workflow was written as prose in `AGENTS.md`: create tabs, name them, run Pi, wait, read output, keep panes open. That worked, but it asked the model to manually remember Herdr CLI details.

This extension moves that workflow into a tool:

- less prompt boilerplate;
- fewer raw `herdr` CLI calls from the model;
- consistent target naming and child protocol;
- fresh context for one-shot delegated agents;
- persistent Herdr panes or tabs when a role should remain inspectable and reusable.

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

**Negative policy:** no parallel workers with overlapping write areas. Parallelize only independent reads or disjoint write slices (4–5 agents max). The limit is independence, not count: past 2–3 agents, each additional one must have genuinely independent work. Five is the upper bound because a fifth pane in the 40% agent column is ~1/5 of terminal height.

**Lifecycle examples:**

- One-shot scout: `{ "agent": "scout", "task": "...", "lifecycle": "oneshot" }` — managed target closes after result.
- Persistent scout: `{ "agent": "scout", "tabLabel": "Scout — message-bus", "task": "...", "lifecycle": "persistent" }` — follow-up reuses the same label.
- Re-wait after timeout: `{ "agent": "scout", "tabLabel": "Scout — message-bus" }` with no `task`.

## Main concepts

### Orchestrator

The current/main Pi session. It receives the user's request and decides whether isolated context is useful.

On first use, the extension renames the current Herdr tab to `Orchestrator`.

### Herdr agent

A child Pi process launched in a managed Herdr pane or tab.

The internal layout defaults to `pane`: the first agent splits the Orchestrator pane to the right at 60/40, and additional agents split the largest managed pane downward in the right column. After spawn or close, the extension rebalances that column to equal heights (for example, three agents use thirds). For new pane agents, placement is serialized through successful `agent start`, managed-state recording, and rebalancing so parallel tool calls preserve that structure. `HERDR_AGENTS_LAYOUT=tab` selects the legacy one-tab-per-agent behavior.

Lifecycle modes are independent of layout:

- `lifecycle: "oneshot"` — one-shot task. The extension waits for the result, reads output, then closes the managed target after successful completion.
- `lifecycle: "persistent"` — reusable role. The target remains open after completion and matching future tasks are sent to it instead of creating a duplicate.

The child receives:

1. the normal Pi runtime/tooling;
2. an agent profile prompt from `~/.pi/agent/agents/<name>.md`;
3. the `HERDR_RESULT` completion protocol;
4. a self-contained task prompt from the Orchestrator;
5. an `ask_question` tool for asking the Orchestrator one clarifying question
   instead of guessing.

### Question channel

A child that hits genuine ambiguity calls `ask_question`, which writes
`question.md` next to its result artifact and returns immediately. The child
then ends its turn, which makes it idle, which satisfies the wait the
Orchestrator is already sitting in — no extra polling and no new wait states.

The Orchestrator checks `question.md` before the result. When a question is
present it returns early with the question text and leaves the target open,
**including one-shots**, which are closed only after a real completion. The
answer is sent as an ordinary `task` with the same `tabLabel`, so a parked
target is reusable by label regardless of lifecycle; the stale question is
cleared before each prompt.

`ask_question` must never block the turn. A session parked on a dialog reports
`working`, not `blocked` — Herdr's status is published by the Pi state
extension, which derives `blocked` solely from the Orchestrator's own
`herdr:blocked` event — so a blocking implementation would hang until timeout.

`--tools` is a strict allowlist over extension tools too, and a child cannot
re-enable a filtered tool itself, so `ask_question` is appended to the
allowlist at spawn time whenever a profile restricts `tools`.

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
- `herdr.ts` — Herdr CLI calls, session snapshot discovery, named-agent lifecycle, and server-owned waits.
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
  task?: string;
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
- Child agents are prevented from recursively registering `herdr_agent` by `HERDR_AGENT_CHILD=1`; child mode retains the result-artifact writer and the `ask_question` channel (`child.ts`).
- Herdr 0.7.5 or newer is required for `agent start`, atomic `agent prompt`, `agent wait`, `agent send-keys`, `agent read`, and `api snapshot`.
- Human-readable labels remain the persistent reuse key. A separate generated Herdr automation name is the stable command target; legacy agents fall back to pane IDs.
- Completion output is persisted in a per-agent artifact, so large results do not depend on terminal scrollback. The artifact is cleared before each prompt to prevent stale persistent-agent output; terminal reading remains the fallback when no new artifact is written.
- The Orchestrator must synthesize child results. Child output should not be blindly forwarded.
- Raw Herdr CLI remains useful for diagnostics, but normal delegation should go through `herdr_agent`.

See also:

- [`herdr-0.7-agent-api-migration.md`](./herdr-0.7-agent-api-migration.md) — migration to Herdr's named-agent automation API, compatibility findings, and verification results.
- [`plan-interactive-agents.md`](./plan-interactive-agents.md) — phased plan for the status widget, bidirectional `ask_question` channel, loadout snapshot, and optional async delegation.
- [`flow.md`](./flow.md) — detailed lifecycle.
- [`session-findings.md`](./session-findings.md) — development findings and bug history.
- [`composer-cursor-sdk-compatibility.md`](./composer-cursor-sdk-compatibility.md) — Composer tool-name adaptation and tool/skill boundary tuning.
