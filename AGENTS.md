# AGENTS.md — herdr-agents extension

This extension belongs to the dotfiles repo and is symlinked into `~/.pi/agent/extensions/herdr-agents` via the `pi` stow package.

## Purpose

`herdr-agents` gives Pi a `herdr_agent` tool for one-shot or persistent delegation through Herdr panes or tabs. Layout is internal configuration and is not part of the tool schema.

The intended model behavior:

- The main Pi session is the Orchestrator.
- When isolated context helps, the Orchestrator calls `herdr_agent` instead of raw `herdr` CLI commands.
- `herdr_agent` starts a Pi process in a named Herdr target using an agent profile from `~/.pi/agent/agents/*.md`.
- Use `lifecycle: "oneshot"` for one-shot tasks; the extension closes that agent target after a successful result.
- Use `lifecycle: "persistent"` when a role should stay available for follow-up tasks or accumulate context; the extension reuses a matching target automatically.
- The Orchestrator waits for the child result, reads it, and synthesizes the answer.
- With `wait: false` nobody waits: the record is marked `detached` and the widget poller delivers the outcome once the agent settles — a result as `herdr_agent_result`, or a question as `herdr_agent_question` (checked first, same order as the blocking path). One-shot targets are closed only when they actually finished. `claimDetachedAgent` clears the flag in one locked read-modify-write, and synchronous collection releases it too, so delivery happens exactly once.
- A child may instead call `ask_question`, which writes `question.md` beside the result artifact and returns. The child ends its turn and goes idle, the existing wait fires, and the Orchestrator returns the question early while leaving the target open — one-shots included. The answer is a normal `task` with the same `tabLabel`; parked targets are reusable by label whatever their lifecycle.

## Delegation policy

Global `agents/.agents/AGENTS.md` is authoritative for **when** to delegate. Role matrix, lifecycle examples, and negative policy live in `docs/README.md`. Orchestrator mechanics are in `constants.ts` (`GLOBAL_INSTRUCTIONS`).

| Situation | `agent` | Delegate? |
|---|---|:---:|
| Unknown code / flows / "where-how" | scout | when needed |
| External docs / APIs / facts | researcher | when needed |
| Known single-file edit | — | no |
| Multi-file plan | planner | after scout |
| Isolated implementation | worker | after plan |
| Non-trivial / risky diff | reviewer | when needed |

## Files

- `index.ts` — Pi extension entrypoint and `herdr_agent` tool registration.
- `agents.ts` — loads agent profiles from user/project Pi agent directories.
- `herdr.ts` — Herdr CLI/API wrappers, snapshot discovery, layout helpers, and named-agent lifecycle commands.
- `schema.ts` — TypeBox schema for tool parameters.
- `constants.ts` — injected Orchestrator instructions and child-agent protocol.
- `utils.ts` — agent-name generation, title casing, result artifacts, and temp prompt files.
- `types.ts` — shared TypeScript interfaces.
- `docs/` — detailed implementation and session notes.

## Important behavior

- Child panes start with `HERDR_AGENT_CHILD=1` and `PROCESS_LAUNCHED_BY_Q=1`: delegation tools stay disabled, final responses are persisted, zsh selects `HISTFILE=/dev/null` from the child marker, and Kiro's terminal wrapper cannot hide the real shell from `herdr agent start`.
- `HERDR_PANE_ID` is preferred over focused pane detection. Focus can move while a tool is running.
- New agents start through `herdr agent start`; prompts use atomic `herdr agent prompt` (no `--wait`), then wait for a newer `state_change_seq` with `working`/`blocked` (or settled idle/done), with one Enter nudge only while idle and `interactive_ready`, before `herdr agent wait --until idle --until done`. This avoids Herdr's hardcoded 5s `agent_prompt_stalled` gate. Abort / Herdr wait timeout returns a soft re-wait hint (child stays); re-wait uses `herdr agent wait` only.
- `lifecycle: "oneshot"` requires `wait: true`, because the Orchestrator must wait before closing the one-shot pane or tab.
- Layout defaults to `pane`. Set `HERDR_AGENTS_LAYOUT=tab` before starting Pi to use the legacy tab layout; the model receives no layout parameter.
- Pane mode splits the Orchestrator 60/40 on the first spawn and stacks additional agents down the right column. The placement lock is held through `agent start`, managed-state recording, and rebalancing so parallel calls cannot create competing right columns.
- Persistent agent reuse is label-based: the default label is the title-cased agent profile name unless `tabLabel` is provided. Reuse requires an exact managed-agent label match. Managed agents also receive a short unique Herdr automation name; legacy panes fall back to pane IDs.
- While waiting, the extension emits `pi.events.emit("herdr:blocked", ...)` so Herdr can mark the Orchestrator pane as blocked/waiting.

## Loading

This extension is loaded from the symlinked Pi extension directory:

```text
~/.pi/agent/extensions/herdr-agents/index.ts
```

A global `/parallel-review` Pi prompt uses this extension's `herdr_agent` tool, but the prompt itself is maintained outside this extension.

## Validation

Useful smoke checks:

```bash
# Parse/bundle the extension modules.
bun build pi/.pi/agent/extensions/herdr-agents/index.ts \
  --target node \
  --outfile /tmp/herdr-agents-check.js \
  --external @earendil-works/pi-coding-agent \
  --external @earendil-works/pi-tui \
  --external typebox

# Confirm the tool is visible to a fresh Pi model.
PI_OFFLINE=1 pi --no-context-files --no-skills --no-prompt-templates --no-themes \
  -p 'List exact tool names available. Do not use tools.'
```

After changing symlinked files, restart Pi or run `/reload` in the active session.
