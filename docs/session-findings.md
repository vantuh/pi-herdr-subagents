# Development session findings

This file records the important findings from creating and debugging `herdr-agents`. It is a historical companion to the current runtime description in [`flow.md`](./flow.md) and the Herdr 0.7 migration record in [`herdr-0.7-agent-api-migration.md`](./herdr-0.7-agent-api-migration.md).

## 1. Delegation belongs behind a tool

The initial workflow lived as prose in global `AGENTS.md`: inspect Herdr, create a target, launch Pi, wait, read output, and clean up.

That made the model reconstruct low-level CLI orchestration for every delegation. Registering `herdr_agent` moved those mechanics into code while keeping the model responsible for deciding when delegation is useful and for synthesizing child results.

Global `agents/.agents/AGENTS.md` therefore remains generic. The extension injects concise Herdr-specific guidance through `before_agent_start`.

## 2. Existing Pi agent profiles are the configuration source

Profiles continue to live in:

```text
~/.pi/agent/agents/*.md
```

A profile supplies its name, description, optional model, optional tool allowlist, and role prompt. Project profiles under `<repo>/.pi/agents/*.md` can override user profiles with the same name.

No second agent configuration format was introduced.

## 3. Fresh context is intentional

New children are fresh Pi processes and do not inherit the Orchestrator conversation. Every delegated task must therefore be self-contained.

Persistent agents retain their own Pi context across follow-up turns when the Orchestrator reuses the exact managed `tabLabel`.

## 4. Child mode disables recursion but keeps result capture

Child panes receive:

```text
HERDR_AGENT_CHILD=1
```

In child mode, the extension does not register `herdr_agent` or inject Orchestrator delegation guidance. It only registers the result-writer hook required to persist assistant output.

This prevents accidental recursive delegation while preserving reliable output collection.

## 5. `HERDR_PANE_ID` is more reliable than focus

Focus can move while a tool call is running. The focused pane in a later Herdr snapshot may therefore belong to something the user clicked, not to the Pi process executing the extension.

The extension prefers:

```text
HERDR_PANE_ID
```

and falls back to snapshot focus only when that environment value is unavailable.

## 6. Herdr's Pi integration owns lifecycle state

Herdr installs the Pi lifecycle integration at:

```text
~/.pi/agent/extensions/herdr-agent-state.ts
```

It reports `working`, `idle`, and `blocked`, and consumes:

```ts
pi.events.on("herdr:blocked", ...)
```

The delegation extension emits that event while the Orchestrator waits for a child, allowing Herdr UI to display the Orchestrator as blocked/waiting.

The official integration v6 is tracked in the dotfiles repository and symlinked into Pi so upstream changes appear in Git. A temporary custom lifecycle patch used during diagnosis was fully removed.

## 7. Old Pi executables can invalidate lifecycle diagnosis

Some child shells initially resolved an old Bun-installed Pi rather than the current installation. Herdr then failed to observe lifecycle behavior expected from the current Pi integration.

After PATH correction, child panes were verified to use Pi 0.81.1 and the official Herdr Pi integration v6 behaved correctly.

When lifecycle behavior looks impossible, verify the executable and version from inside a newly created Herdr child shell before patching Herdr or Pi integration code.

## 8. Manual polling had two completion races

Before Herdr 0.7 named-agent automation, the extension launched children through `pane run` and polled pane status.

Two failures were observed:

1. completed children could finish as `idle`, while custom code waited only for `done`;
2. a reused persistent child could still expose its previous `idle`/`done` status, causing the poller to return old output before the new prompt entered `working`.

Temporary polling guards handled those cases, including requiring an active state before accepting completion on reused targets.

Those guards no longer exist. Herdr 0.7.5 now owns prompt submission and completion atomically through:

```text
agent prompt --wait --until idle --until done
```

Re-wait uses `agent wait` and never resends the task.

## 9. Complete results should not depend on terminal scrollback

Terminal reads can lose long output or alternate-screen content. Each managed child therefore receives a private result path under:

```text
${TMPDIR}/herdr-agent-*/result.md
```

A child Pi hook overwrites that file on each non-empty finalized assistant message. Before submitting a new prompt, the parent removes any previous artifact content. After Herdr reports completion, it reads the new artifact and falls back to `agent read` when none was written.

`system.md` and `result.md` share one private `os.tmpdir()` directory. Successful one-shot cleanup removes that directory; persistent agents keep it while reusable, and `/herdr-agents` removes it when closing a managed persistent target.

## 10. Re-wait must not resend work

A large child task can outlive the Orchestrator tool call timeout. Treating the timeout as task failure and submitting the task again can duplicate work or corrupt child input.

Calling `herdr_agent` with the same `agent` and `tabLabel`, but no `task`, enters re-wait mode:

- find the existing managed pane or tab;
- send no prompt;
- call `herdr agent wait --until idle --until done`;
- read artifact or terminal fallback;
- close a recovered one-shot target after successful result collection.

## 11. Kiro's terminal wrapper can hide the shell

Kiro shell integration can replace a child login shell with a process shown as:

```text
zsh (kiro-cli-term)
```

Herdr 0.7.5 does not accept that wrapper as an available shell for `agent start`. Child panes therefore receive:

```text
PROCESS_LAUNCHED_BY_Q=1
```

This disables the wrapper only inside delegated panes; normal user terminals keep their Kiro integration.

## 12. New shells need a bounded readiness retry

`pane split` and `tab create` can return before the shell is ready. Immediate `agent start` then returns structured `agent_pane_busy`.

The extension retries only that error every 100 ms for up to five seconds. Tests showed retries were required in 4/10 tab starts and 4/5 split starts, with no final failures.

A separate 500 ms delay after successful `agent start` was tested and removed. With the correct Pi executable, immediate prompt submission passed 5/5 tab tests and 5/5 pane-split tests.

## 13. Parallel pane placement must remain serialized through registration

Originally, the placement lock was released immediately after `pane split`. During parallel tool calls, the next call could run before the previous pane completed `agent start` and entered managed state. Every call then believed it was creating the first child and split `right`, producing multiple side-by-side columns.

The lock is now held through:

```text
pane split
→ agent start
→ managed-state record
→ equal-height rebalance
→ release lock
```

A three-agent parallel smoke test confirmed one 60/40 outer `right` split and three equal-height `down` splits in the agent column.

## 14. Shared zsh history must respect child isolation

`HISTFILE` is a special zsh parameter and is not reliably imported from the process environment, so passing `--env HISTFILE=/dev/null` to Herdr did not work. The global history configuration instead derives it from the ordinary child marker:

```zsh
if [[ ${HERDR_AGENT_CHILD:-} == 1 ]]; then
  HISTFILE=/dev/null
else
  HISTFILE=${HISTFILE:-$HOME/.zsh_history}
fi
```

This preserves normal history while preventing delegated child commands from entering the shared file.

## 15. Stow must expose every extension file

After the extension was split into multiple modules, Pi initially failed to resolve sibling imports because only the old entrypoint was linked.

The `pi` Stow package now exposes the complete extension tree. After adding files, use:

```bash
stow --restow --no-folding pi
```

The official `herdr-agent-state.ts` is also repo-managed through this Stow layout.

## Current known limitations

- Temp directories can remain after startup/prompt failures or when panes are closed outside the extension; the operating system eventually cleans its temp root.
- Herdr JSON responses use targeted shape checks rather than full runtime schema validation.
- State-file locking prevents same-process lost updates but intentionally does not coordinate multiple independent Pi processes.
- Legacy agents without a saved automation name fall back to their current pane ID.

## Possible future cleanup

- Remove orphan temp directories after failed startup without deleting files still needed for debugging.
- Remove the legacy pane-ID fallback after all pre-migration persistent agents are gone.
- Add stronger runtime validation only where malformed Herdr output has produced a real failure.

## Validation references

Useful checks:

```bash
cd pi/.pi/agent/extensions/herdr-agents
bun test

bun build index.ts \
  --target node \
  --outfile /tmp/herdr-agents-check.js \
  --external @earendil-works/pi-coding-agent \
  --external @earendil-works/pi-tui \
  --external typebox
```

Tool visibility in a fresh Pi process:

```bash
PI_OFFLINE=1 pi --no-context-files --no-skills --no-prompt-templates --no-themes \
  -p 'List exact tool names available. Do not use tools.'
```

Expected output includes `herdr_agent` (or provider-visible `pi__herdr_agent` for Composer through the compatibility adapter).
