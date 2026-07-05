# Development session findings

This file records the important findings from the session that created and debugged `herdr-agents`.

## 1. Why a tool was created

Initial idea: encode a Herdr delegation workflow in global `AGENTS.md`.

Problem: prose instructions made the model manually call raw Herdr CLI commands:

- check `HERDR_ENV`;
- call `herdr pane list`;
- create tabs;
- run Pi;
- wait and read output.

That worked but was too fragile and verbose.

Final direction: register a Pi tool named `herdr_agent` and inject a short global instruction:

```md
When isolated context helps, use the `herdr_agent` tool instead of raw Herdr CLI commands.
```

This lets the model delegate with a direct tool call instead of reconstructing the workflow.

## 2. `AGENTS.md` was intentionally cleaned up

The old Herdr instructions were removed from `agents/.agents/AGENTS.md`.

Reason: Herdr-specific behavior now belongs to the extension. The shared `AGENTS.md` should stay generic and portable.

The extension injects Herdr guidance through `before_agent_start`.

## 3. Pi extension API supports this cleanly

The relevant Pi extension capabilities:

- `pi.registerTool(...)` registers `herdr_agent`.
- `pi.on("before_agent_start", ...)` appends Orchestrator instructions.
- `pi.events.emit(...)` communicates with Herdr's installed state extension.
- Prompt templates can be packaged through `pi.prompts` in `package.json` and `settings.json`.

## 4. Agent profiles are reused

Existing profiles live in:

```text
~/.pi/agent/agents/*.md
```

Examples:

- `researcher.md`
- `scout.md`
- `planner.md`
- `reviewer.md`
- `worker.md`

The extension reads these profiles instead of inventing another agent config format.

Each profile provides:

- `name`;
- `description`;
- optional `tools`;
- optional `model`;
- role prompt body.

## 5. Fresh context is intentional

Child agents are started as fresh Pi processes.

They do not inherit the Orchestrator conversation. The Orchestrator must send a self-contained task.

This avoids context pollution and matches the desired "persistent Herdr agent" mental model.

## 6. Child agents must not recursively register the extension

Child Pi processes are launched with:

```bash
HERDR_AGENT_CHILD=1
```

At extension load time:

```ts
if (process.env.HERDR_AGENT_CHILD === "1") return;
```

This prevents children from:

- registering `herdr_agent` again;
- receiving Orchestrator-only Herdr delegation guidance;
- recursively spawning more agents unless explicitly implemented later.

## 7. `HERDR_PANE_ID` is more reliable than focused pane

Early versions used the focused pane from `herdr pane list`.

Finding: focus can move while a tool is running. If the user clicks another tab/pane, "focused" no longer identifies the Orchestrator.

Herdr sets:

```bash
HERDR_PANE_ID
```

The extension now prefers that env var and only falls back to focused pane if needed.

## 8. Herdr already has a Pi state integration

Herdr installs:

```text
~/.pi/agent/extensions/herdr-agent-state.ts
```

It reports Pi state over the Herdr socket:

- `working`
- `idle`
- `blocked`

It also listens for:

```ts
pi.events.on("herdr:blocked", ...)
```

The extension emits this event while waiting for child agents so the Orchestrator pane appears blocked/waiting in Herdr UI.

## 9. `done` is not the only finished state

Observed bug:

- child `Worker apply review fixes` pane finished;
- Herdr showed it as `idle`;
- Orchestrator stayed stuck on `Waiting for Herdr agent Worker apply review fixes`.

Cause: the extension waited only for `agent_status=done`.

Finding: Herdr can show a completed child as `idle`, especially after the pane has been observed.

Fix: custom polling now treats:

- `done` as finished;
- `idle` as finished after Pi has appeared in the pane and the pane was active, or after startup grace time.

## 10. Prompt loading and extension loading are separate concerns

We tested three settings variants.

### No package entry

Result:

- `herdr_agent` tool loaded through extension auto-discovery;
- `/parallel-review` did **not** load.

Reason: `~/.pi/agent/extensions/herdr-agents/index.ts` is auto-discovered, but `prompts/*.md` in that package are not loaded unless the package is registered or the prompt is placed in global prompts.

### Package entry with `extensions: []`

Result:

- `/parallel-review` loaded;
- `herdr_agent` disappeared from the model's tool list.

This was a real bug. The model started using raw Herdr CLI and loader investigation because it did not see the tool.

### Final chosen package entry

```json
{
  "source": "extensions/herdr-agents",
  "extensions": ["index.ts"],
  "prompts": ["prompts/*.md"]
}
```

Result:

- `herdr_agent` is visible;
- `/parallel-review` expands;
- extension and prompt are both explicitly owned by the package.

## 11. Runtime smoke test for tool visibility

Useful command:

```bash
PI_OFFLINE=1 pi --no-context-files --no-skills --no-prompt-templates --no-themes \
  -p 'List exact tool names available. Do not use tools.'
```

Expected output includes:

```text
herdr_agent
```

If `herdr_agent` is missing, check:

- `settings.json` package entry;
- symlinks under `~/.pi/agent/extensions/herdr-agents`;
- whether `HERDR_AGENT_CHILD=1` is accidentally set in the parent environment;
- extension load errors on Pi startup.

## 12. Runtime smoke test for prompt expansion

Useful command:

```bash
PI_OFFLINE=1 pi --no-tools --no-context-files --no-skills --no-themes \
  -p '/parallel-review answer in one sentence: did this slash prompt expand?'
```

Expected: model says the prompt expanded into review instructions.

If it receives a literal slash command, prompt loading is broken.

## 13. Stow/symlink issue after splitting files

After the extension was refactored from one `index.ts` into multiple files, Pi failed with:

```text
Cannot find module './agents.ts'
```

Cause: `~/.pi/agent/extensions/herdr-agents/index.ts` was symlinked, but new sibling files were not yet linked.

Fix:

```bash
cd ~/dotfiles && stow pi
```

or otherwise ensure every file in `pi/.pi/agent/extensions/herdr-agents/` exists under `~/.pi/agent/extensions/herdr-agents/`.

## 14. `parallel-review` prompt was adapted

The prompt originally talked about generic subagents.

It now explicitly says:

- use `herdr_agent`;
- use fresh Herdr tabs;
- do not use raw `herdr` CLI commands;
- prefer the `reviewer` profile;
- synthesize `HERDR_RESULT` output.

This reduces confusion between Pi's old subagent concepts and the new Herdr persistent-agent workflow.

## 15. Reviewer disagreement during debugging

Two Herdr reviewer panes disagreed about `extensions: []`.

- One reviewer reasoned from loader code and thought auto-discovery would still register the extension.
- Another reviewer argued from package filtering semantics that `extensions: []` disables the extension.

Runtime testing settled it:

```text
extensions: [] => herdr_agent missing
extensions: ["index.ts"] => herdr_agent visible
```

Takeaway: for extension loading issues, always verify the actual model tool list, not only docs/source reasoning.

## 16. Current known rough edges

These are known but not currently fixed:

- Temp prompt directories under `/tmp/herdr-agent-*` are not cleaned up.
- Herdr CLI JSON responses are parsed with light assumptions rather than full runtime validation.
- Reusing an existing tab sends `@task-file` into that pane; this assumes the child Pi is ready to accept a new prompt.
- Child agents do not inherit Orchestrator context by design, so poor task prompts lead to poor child results.

## 17. Desired future improvements

Potential future work:

- Add a `herdr_agent_send` tool for explicit follow-up messages to existing tabs.
- Add a `herdr_agent_list` tool to list known persistent agents/tabs.
- Add temp file cleanup after child startup.
- Add stronger Herdr response validation with clearer error messages.
- Add a small test harness or documented smoke-test script.
- Consider optional result extraction that returns only the `HERDR_RESULT` block plus recent context.
