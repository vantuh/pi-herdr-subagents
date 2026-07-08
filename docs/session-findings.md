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

This avoids context pollution for newly created agents. Persistent agents can still accumulate context across follow-up tasks when `lifecycle: "persistent"` reuses their tab.

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

## 9a. Reusing a persistent tab can read the *previous* task's output (stale-result race)

Observed bug (seen live in a `notification-service` Orchestrator session): after sending a new
task to an already-existing persistent tab (`lifecycle: "persistent"`, tab reused), the
`herdr_agent` tool call returned in under 100ms with output that was clearly from the *previous*
task (e.g. husky/lint-staged setup instead of the newly requested `.env.example` consolidation).
The Orchestrator had to notice the mismatch and re-prompt the worker ("It looks like your last
response repeated the previous task's summary...").

Root cause: for a reused pane, `pane run <pane_id> <task-file>` only injects the new prompt into
the already-running child Pi's terminal. Herdr's `agent_status` for that pane is still whatever it
was at the end of the *previous* task (`done`, then possibly `idle`) until the child Pi process
asynchronously reports a new state. `waitForAgentFinished` starts polling immediately after
`pane run`, so the very first `pane list` poll can still observe the stale `done`/`idle` status
from before the new prompt was even processed. Since `observeAgentWaitState` treated `done` as an
unconditional finish signal, the wait loop returned immediately and the tool read+returned the
old terminal output.

This is a race in the extension's polling, not a model behavior issue — the child Pi had not yet
received/processed the new prompt when the "finished" output was read.

Fix: `waitForAgentFinished` accepts `{ requireActiveFirst: boolean }`. When reusing an existing
tab (`reused === true`), the extension passes `requireActiveFirst: true`, which requires the wait
loop to observe `working`/`blocked` at least once before any `done`/`idle` status is accepted as
completion of the *new* task. Freshly created tabs (`reused === false`) keep the original
immediate-`done` behavior, since there is no previous task whose stale status could leak through.

## 10. Global prompt integration

A global `/parallel-review` Pi prompt uses this extension's `herdr_agent` tool. The prompt itself is maintained outside this extension.

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

- symlinks under `~/.pi/agent/extensions/herdr-agents`;
- whether `HERDR_AGENT_CHILD=1` is accidentally set in the parent environment;
- extension load errors on Pi startup.

## 12. Stow/symlink issue after splitting files

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

## 13. Current known rough edges

These are known but not currently fixed:

- Temp prompt directories under `/tmp/herdr-agent-*` are not cleaned up.
- Herdr CLI JSON responses are parsed with light assumptions rather than full runtime validation.
- Reusing a persistent tab sends `@task-file` into that pane; this assumes the child Pi is ready to accept a new prompt.
- Child agents do not inherit Orchestrator context by design, so poor task prompts lead to poor child results.

## 14. Desired future improvements

Potential future work:

- Add smarter handling when a matching persistent tab is currently `working` or `blocked`.
- Add a `herdr_agent_list` tool to list known persistent agents/tabs.
- Add temp file cleanup after child startup.
- Add stronger Herdr response validation with clearer error messages.
- Add a small test harness or documented smoke-test script.
- Consider optional result extraction that returns only the `HERDR_RESULT` block plus recent context.
