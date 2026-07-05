# AGENTS.md — herdr-agents extension

This extension belongs to the dotfiles repo and is symlinked into `~/.pi/agent/extensions/herdr-agents` via the `pi` stow package.

## Purpose

`herdr-agents` gives Pi a `herdr_agent` tool for persistent delegation through Herdr tabs.

The intended model behavior:

- The main Pi session is the Orchestrator.
- When isolated context helps, the Orchestrator calls `herdr_agent` instead of raw `herdr` CLI commands.
- `herdr_agent` starts a fresh Pi process in a named Herdr tab using an agent profile from `~/.pi/agent/agents/*.md`.
- Child tabs stay open as persistent Herdr agents; do not close them automatically.
- The Orchestrator waits for the child result, reads it, and synthesizes the answer.

## Files

- `index.ts` — Pi extension entrypoint and `herdr_agent` tool registration.
- `agents.ts` — loads agent profiles from user/project Pi agent directories.
- `herdr.ts` — Herdr CLI wrappers and pane/tab wait helpers.
- `schema.ts` — TypeBox schema for tool parameters.
- `constants.ts` — injected Orchestrator instructions and child-agent protocol.
- `utils.ts` — shell quoting, title casing, temp prompt files.
- `types.ts` — shared TypeScript interfaces.
- `docs/` — detailed implementation and session notes.

## Important behavior

- `HERDR_AGENT_CHILD=1` disables this extension inside child Pi processes. This prevents recursive tool registration and duplicate Orchestrator instructions in delegated panes.
- `HERDR_PANE_ID` is preferred over focused pane detection. Focus can move while a tool is running.
- Waiting treats both `done` and certain `idle` states as finished. Herdr may show a completed agent as `idle` after the pane has been observed.
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
  --outfile /tmp/herdr-agents-check.js \
  --external @earendil-works/pi-coding-agent \
  --external @earendil-works/pi-tui \
  --external typebox

# Confirm the tool is visible to a fresh Pi model.
PI_OFFLINE=1 pi --no-context-files --no-skills --no-prompt-templates --no-themes \
  -p 'List exact tool names available. Do not use tools.'
```

After changing symlinked files, restart Pi or run `/reload` in the active session.
