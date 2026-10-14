# Composer and pi-cursor-sdk compatibility

This document records the prompt and skill tuning needed for Composer models provided by `pi-cursor-sdk` to use the `herdr_agent` delegation tool reliably.

## Problem: provider-specific tool name

The `herdr-agents` extension registers the Pi tool as:

```text
herdr_agent
```

For Composer models, `pi-cursor-sdk` exposes Pi tools to the model through a namespace. Composer therefore sees the tool as:

```text
pi__herdr_agent
```

The original Herdr system instructions still told the model to call `herdr_agent`. Other Pi models understood that name because it matched their available tool, but Composer could fail to associate it with the namespaced `pi__herdr_agent` tool. This resulted in hesitation, unrelated inspection, or failure to delegate directly.

## Compatibility extension

The single-file compatibility extension lives at:

```text
pi/.pi/agent/extensions/zz-composer-herdr-agent.ts
```

It uses `before_agent_start` on every turn and rewrites exact `herdr_agent` references in the completed system prompt to `pi__herdr_agent` only when:

```ts
ctx.model.provider === "cursor" && ctx.model.id.startsWith("composer")
```

The extension does not rename the registered Pi tool or alter its implementation. It adapts the instructions to the provider-visible name that Composer understands; `pi-cursor-sdk` bridges the namespaced call back to the locally registered `herdr_agent` tool.

The file is prefixed with `zz-` so it is discovered after `herdr-agents` in the current setup and can rewrite the instructions appended by that extension. This ordering is part of the current compatibility design.

Because the active model is checked during every `before_agent_start` event, switching models within a session also works:

- `cursor/composer*` receives `pi__herdr_agent` instructions;
- OpenAI Codex, Kiro ACP, local models, and non-Composer Cursor models retain `herdr_agent` unchanged;
- an existing `pi__herdr_agent` reference is not rewritten a second time.

## Problem: opening an agent without a task

A later Composer test asked it to open a persistent worker without assigning work yet. Composer recognized `pi__herdr_agent`, but delayed the call while reading the Herdr skill, agent profile, and source files.

This was a separate tool-contract ambiguity, not a namespace failure. Omitting `task` from `herdr_agent` means re-waiting on an already running tab; it cannot create a new blank agent. A new agent therefore still needs a task string.

`GLOBAL_INSTRUCTIONS` was refined to make the intended workaround explicit. When the user asks to open an agent without a task, the model should immediately call the delegation tool with:

- `lifecycle: "persistent"`;
- `wait: false`;
- a stable `tabLabel`;
- a minimal standby `task` telling the child to wait for follow-up and do no work.

The model should not inspect skills, agent files, or documentation for this case.

## Tool and skill boundary

The shared `herdr` skill previously overlapped with `herdr_agent`. Its description advertised agent spawning, and its body included a raw CLI recipe for starting another agent. When Composer was uncertain, this overlap encouraged it to load the skill and explore a second delegation path.

The skill at `agents/.agents/skills/herdr/SKILL.md` was narrowed:

- `herdr_agent` is the high-level path for worker, scout, researcher, planner, and reviewer delegation;
- the skill should not load merely to spawn, wait for, or reuse those agents;
- the raw agent-spawn recipe was removed;
- the skill remains responsible for lower-level Herdr operations such as arbitrary tabs and panes, servers, commands, terminal output, and explicit manual coordination.

Keeping both is useful as long as their responsibilities remain distinct: the tool manages AI-agent delegation, while the skill documents terminal multiplexer control that the tool does not cover.

## Verified behavior

After these changes, a fresh Composer session handled this request directly:

```text
Create a separate worker agent without a task for now. We will give it tasks as we work; until then it should wait.
```

Composer immediately called `pi__herdr_agent` with a persistent standby worker. It did not load the Herdr skill or run exploratory `find`/`grep` commands.
