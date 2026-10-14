# Agent profiles

> **RETIRED 2026-09-04 — not loaded, not maintained.** Migrated to
> [pi-subagents](https://github.com/nicobailon/pi-subagents) (+ pi-intercom).
> This page documents the archived behavior of `src/agents.ts`, `src/utils.ts`
> and `src/index.ts`.

An agent profile is a markdown file: YAML frontmatter plus a body. `herdr_agent`
selects one by its `agent` parameter and uses it to start the child Pi process.

## Example

```md
---
name: reviewer
description: Reviews code changes for correctness and regressions.
tools: read, grep, find, ls, bash
model: provider/model-id
thinking: high
skills: none
system-prompt: append
disable-model-invocation: false
---

You are a disciplined senior code reviewer.
Report Critical / Warnings / Suggestions with file and line evidence.
```

Replace `provider/model-id` with a model available in your Pi configuration,
or omit `model` to use Pi's default.

## Fields

All keys are lowercase, exactly as written. Unknown keys are ignored.

| Field | Required | Format | Default / behavior |
|---|:---:|---|---|
| `name` | yes | string | Profile name; matched exactly against the `agent` parameter. |
| `description` | yes | string | Not used when spawning; only required for the profile to load. |
| `tools` | no | comma-separated string or YAML list | Omitted/empty: no `--tools` flag, child keeps Pi's default tools. Otherwise a strict allowlist (see [Tools](#tools)). |
| `model` | no | string | Passed as `--model`. Omitted: Pi's default. A non-string value is ignored. The `model` tool parameter overrides it for a fresh spawn. |
| `thinking` | no | string | One of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (trimmed, case-insensitive); passed as `--thinking`. Omitted/empty: no flag. Other strings: flag omitted and the spawn result carries the warning `Unknown thinking level "<value>" ignored.`; the spawn still proceeds. |
| `skills` | no | comma-separated string or YAML list | Omitted (or empty string): child keeps Pi's normal skill discovery. `none`, `[]` or an empty YAML list: no skills (`--no-skills`). A non-empty list: `--no-skills` plus `--skill <file>` for each name found. Names matching no skill produce the warning `Skills not found: ...`; the spawn still proceeds. |
| `system-prompt` | no | `append` or `replace` (trimmed, case-insensitive) | Default `append` (`--append-system-prompt`). `replace` uses `--system-prompt`. Any other value falls back to `append`. |
| `disable-model-invocation` | no | `true` / `false` (boolean or string) | Default `false`. Any other value is treated as unset. `true` hides the profile from advertised lists, not from discovery (see [Visibility](#visibility)). |

Notes:

- `name` and `description` must be YAML strings, otherwise the file is skipped.
  Empty strings pass that check and are not rejected, so `name: ""` yields a
  profile that nothing practical can select. A bare YAML number or boolean is not
  a string; quote it.
- Files whose names do not end in `.md`, or that cannot be read, are skipped
  silently.

## Prompt body

The body (trimmed) becomes the profile system prompt. The extension appends the
Herdr child protocol (result/`ask_question` rules) to it and writes both to a
temp file. That file is passed with `--append-system-prompt` (default) or
`--system-prompt` (`system-prompt: replace`). An empty body leaves only the
protocol text.

## Tools

- Empty or omitted `tools` does not deny all tools; it means "no restriction".
  The extension passes no `--tools` flag.
- A non-empty `tools` list becomes `--tools`, a strict allowlist over all tools,
  extension-provided ones included. The extension adds `ask_question` to the
  list, because a child cannot re-enable a filtered tool itself and would
  otherwise have no way to ask the Orchestrator a question.
- Child panes run with `HERDR_AGENT_CHILD=1`. In that mode the extension
  registers only `ask_question`: the `herdr_agent` tool, commands and
  instruction injection are not available, so children cannot delegate through
  this extension. Listing `herdr_agent` in `tools` has no effect. This does not
  restrict delegation tools provided by other extensions.

## Discovery and precedence

Profiles are loaded on every `herdr_agent` call from:

1. User directory: `getAgentDir()/agents/*.md` (default `~/.pi/agent/agents`).
2. Project directory: the nearest `.pi/agents` found by walking up from the
   Orchestrator's cwd (the first existing directory wins; it does not merge
   with parent project directories).

Profiles are keyed by `name`. A project profile replaces a user profile with the
same name. Within one directory, if two files share a name, the one read last
wins (directory read order).

## Visibility

`disable-model-invocation: true` removes the profile from the list in the
`agent` parameter description and from the `Available:` list in the
unknown-agent error. The profile is still spawnable by exact name.

## Related

- [README.md](../README.md#agent-profile) — overview of profiles.
- `src/agents.ts` — parsing and discovery; `src/utils.ts` — `normalizeTools`,
  `buildChildToolAllowlist`; `src/index.ts` — `buildChildPiArgs`.
