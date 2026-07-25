# Herdr 0.7 agent automation API migration

This document records the migration of the Pi `herdr_agent` extension from raw pane control and client-side status polling to the agent automation API available in Herdr 0.7.5.

## Why the migration was needed

The previous implementation treated a Pi child agent as a generic terminal process:

1. create a pane or tab;
2. inject a shell command with `herdr pane run`;
3. poll `herdr pane list` for `working`, `blocked`, `done`, or `idle`;
4. guard against stale status from a previous persistent-agent turn;
5. scrape recent terminal output;
6. close one-shot panes manually.

This worked, but duplicated lifecycle logic that Herdr now owns. It also introduced races around shell startup, prompt submission, stale `done` state, alternate-screen output, and pane IDs changing after layout operations.

## New workflow

A fresh delegation now follows this flow:

```text
api snapshot
    ↓
pane split / tab create
    ↓
agent start
    ↓
agent prompt (no --wait) → wait for working → wait idle/done
    ↓
read result artifact (agent read as fallback)
    ↓
close one-shot target
```

Persistent follow-up tasks reuse the named agent and submit another atomic prompt. Re-wait calls use `agent wait` without resending the task.

Later note: `agent prompt --wait` hardcodes a 5s lifecycle gate (`agent_prompt_stalled`). The extension now submits without `--wait` and owns the acceptance wait (including one `send-keys enter` recovery) so slow Pi transitions do not strand pasted prompts.

## Herdr APIs adopted

### Session discovery

```bash
herdr api snapshot
```

The snapshot replaces repeated discovery calls and supplies panes, tabs, focused IDs, layouts, agent records, protocol metadata, and version metadata in one machine-readable response.

The extension still prefers `HERDR_PANE_ID` when identifying the Orchestrator because terminal focus may move during a tool call.

### Agent startup

```bash
herdr agent start <automation-name> \
  --kind pi \
  --pane <pane-id> \
  --timeout 30000 \
  -- <pi arguments>
```

Herdr now launches and identifies Pi as an agent rather than the extension typing a full `pi ...` command through `pane run`.

Each child receives a generated automation name matching Herdr's required format:

```text
[a-z][a-z0-9_-]{0,31}
```

The automation name is separate from:

- `tabLabel` — human-readable display and persistent reuse key;
- `terminal_id` — durable plugin-state key across pane ID changes;
- `pane_id` — current terminal location.

### Atomic prompt and wait

```bash
herdr agent prompt <name-or-pane> <task> \
  --wait \
  --until idle \
  --until done \
  --timeout <milliseconds>
```

Prompt submission and lifecycle waiting now happen in one Herdr request. This removes the old race where a reused persistent agent could still report `done` from its previous task before entering `working` for the new task.

`blocked` is deliberately excluded from completion states. A blocked child normally needs approval or input and has not completed its task.

### Re-wait

```bash
herdr agent wait <name-or-pane> \
  --until idle \
  --until done \
  --timeout <milliseconds>
```

If a tool call times out or is interrupted while the child keeps working, the Orchestrator can reconnect using the same `tabLabel` with no task. The extension waits on the current agent occupant and does not send the prompt again.

### Output fallback

```bash
herdr agent read <name-or-pane> \
  --source recent-unwrapped \
  --lines 180
```

Terminal output remains a compatibility fallback, not the primary result channel.

## Result artifacts

Terminal scrollback is not a reliable transport for complete agent output:

- Pi tool results have output limits;
- full-screen/alternate-screen applications may not retain scrollback;
- long reviews can exceed the selected terminal line count.

The extension therefore creates a private result path:

```text
${TMPDIR}/herdr-agent-*/result.md
```

Child mode keeps the delegation tool disabled but registers a small Pi event hook that overwrites this artifact on each non-empty finalized assistant message. Before every prompt, the parent removes previous artifact content. It reads the new artifact after Herdr reports completion and falls back to `agent read` when no artifact was written, including compatibility with agents started before this migration.

Plugin state now stores:

- lifecycle;
- layout;
- profile name;
- human-readable label;
- Herdr automation name;
- result artifact path.

## Removed runtime complexity

The migration removed these mechanisms from active code:

- launching child Pi through `herdr pane run`;
- custom polling of `pane list` every 500 ms;
- `observeAgentWaitState`;
- `waitForAgentFinished`;
- `requireActiveFirst` stale-status handling;
- raw pane-based output reads as the primary result path;
- shell command construction for normal agent launch.

Historical explanations remain in `session-findings.md` and are explicitly marked as superseded.

## Parallel pane placement

Pane placement is serialized until the newly created child has completed `agent start`, been recorded as managed, and been included in layout rebalancing. Releasing the placement lock immediately after `pane split` allowed parallel calls to miss each other's not-yet-recorded panes, causing every child to split `right` into another column.

The corrected order is:

```text
create pane
→ agent start
→ record managed lifecycle
→ rebalance
→ release placement lock
```

A three-agent parallel test produced one right-side column with three equal-height panes: one outer `right` split followed only by nested `down` splits.

## Shell startup compatibility

### Kiro terminal wrapper

Kiro CLI shell integration replaces login `zsh` with a nested terminal wrapper whose process name is:

```text
zsh (kiro-cli-term)
```

Herdr 0.7.5 does not recognize that wrapper as an available shell for `agent start` and returns `agent_pane_busy`.

Child panes therefore receive:

```text
PROCESS_LAUNCHED_BY_Q=1
```

This prevents the Kiro wrapper only inside delegated child panes. Normal user terminals keep their Kiro integration, while Herdr sees the real `zsh` process in child panes.

### Shell readiness retry

`pane split` and `tab create` can return before the new shell is ready. `agent start` then returns transient `agent_pane_busy` even though the shell becomes available shortly afterward.

The extension retries only that structured error for up to five seconds with a 100 ms interval. Other errors fail immediately.

This retry is evidence-based:

- tab-create test: 4 of 10 starts required a retry;
- pane-split test: 4 of 5 starts required a retry;
- no final startup failures occurred.

### No post-start delay

A temporary 500 ms delay after `agent start` was evaluated and removed.

After correcting the child Pi executable/version, immediate prompt tests passed:

- 5 of 5 tab-based launches;
- 5 of 5 pane-split launches.

Herdr's documented `agent start` readiness guarantee is therefore used directly. Only the pre-start shell-readiness retry remains.

## Shell history isolation

The old `pane run` workflow inserted long child-launch commands into shared zsh history.

Passing `HISTFILE=/dev/null` through Herdr's child environment was tested but proved ineffective because `HISTFILE` is a special zsh parameter and zsh initializes it independently. The zsh history configuration now uses the ordinary `HERDR_AGENT_CHILD` environment marker:

```zsh
if [[ ${HERDR_AGENT_CHILD:-} == 1 ]]; then
  HISTFILE=/dev/null
else
  HISTFILE=${HISTFILE:-$HOME/.zsh_history}
fi
```

Normal shells continue to use `~/.zsh_history`; delegated child shells do not persist commands.

## Pi and Herdr integration compatibility

The child process must resolve the current Pi version. During migration, some child shells resolved an old Bun-installed Pi, which did not cooperate correctly with the current Herdr Pi lifecycle integration.

After PATH correction, child panes were verified to run:

```text
Pi 0.81.1
```

Herdr's official Pi integration v6 now reports lifecycle transitions correctly. The official integration file is tracked in the dotfiles repository:

```text
pi/.pi/agent/extensions/herdr-agent-state.ts
```

and linked into:

```text
~/.pi/agent/extensions/herdr-agent-state.ts
```

Running `herdr integration install pi` preserves the symlink and writes through it, so future upstream integration changes appear as a normal Git diff.

A temporary custom lifecycle patch was tested during diagnosis and fully removed. The tracked file represents the official v6 integration.

## Error handling and safety

Herdr CLI failures are represented by `HerdrCliError`, preserving structured error codes such as:

- `agent_pane_busy`;
- `agent_prompt_stalled`;
- `agent_not_running`;
- `timeout`;
- `not_found`.

Prompt text is redacted from error messages so a failed CLI call does not echo the delegated task into logs or tool output.

All Herdr subprocesses continue to receive Pi's `AbortSignal`. Interrupting the Orchestrator wait stops the local CLI wait but intentionally leaves the child pane available for re-wait and debugging.

## Lifecycle behavior

### One-shot

- always waits for completion;
- reads artifact or terminal fallback;
- closes its pane/tab after successful result collection;
- removes lifecycle state;
- rebalances pane layout;
- leaves the target open after timeout, abort, or execution failure for inspection/re-wait.

### Persistent

- reuses an exact managed `tabLabel`;
- keeps Pi context alive between tasks;
- targets the agent by saved automation name;
- keeps the pane/tab open after completion.

### Legacy compatibility

Agents without a saved automation name fall back to their current pane ID. New agents always receive and persist a Herdr automation name.

## Verification performed

### Automated checks

```text
59 tests passed
0 failed
```

The extension also bundles successfully with Bun, `git diff --check` passes, and the zsh history file passes `zsh -n`.

### End-to-end smoke test

Verified:

```text
agent start
→ immediate first prompt
→ working lifecycle
→ idle/done lifecycle
→ result artifact returned
→ one-shot pane closed
→ no shared history entry
```

### Repeated API tests

Without a post-start delay:

```text
Tab workflow:   5/5 prompt cycles passed
Split workflow: 5/5 prompt cycles passed
```

Shell readiness:

```text
Tab workflow:   6/10 first-try starts, 4/10 retried, 0 failures
Split workflow: 1/5 first-try starts, 4/5 retried, 0 failures
```

## Improvements achieved

- Herdr owns agent lifecycle and atomic waiting.
- Persistent-agent prompts no longer race stale completion state.
- Stable automation names survive ordinary pane targeting changes.
- Result collection no longer depends solely on terminal scrollback.
- Parallel pane placement produces one balanced right-side agent column instead of competing right splits.
- Re-wait is explicit and cannot resend a task accidentally.
- Structured errors are actionable and sensitive prompts are redacted.
- Child launch commands no longer pollute shared shell history.
- Kiro shell integration remains enabled normally but no longer blocks child startup.
- Session discovery requires fewer CLI calls.
- One-shot cleanup and pane rebalancing remain automatic.
- The implementation is smaller conceptually: layout belongs to pane APIs, lifecycle belongs to agent APIs, and complete output belongs to the result artifact.

## Result-artifact follow-up completed

`system.md` and `result.md` now share one private `${TMPDIR}/herdr-agent-*` directory. The parent clears `result.md` before each prompt, preventing stale persistent-agent output, and removes the directory after successful one-shot cleanup or when `/herdr-agents` closes a managed persistent target.

Optional low-priority cleanup:

- clean orphan temp directories after failed starts without removing files needed for debugging;
- remove the legacy pane-ID fallback after all pre-migration persistent agents are gone.

## References

- [Herdr agent automation](https://herdr.dev/docs/agent-automation/)
- [Herdr CLI reference](https://herdr.dev/docs/cli-reference/)
- [Herdr integrations](https://herdr.dev/docs/integrations/)
- [Herdr agents and status authority](https://herdr.dev/docs/agents/)
- [Herdr socket API](https://herdr.dev/docs/socket-api/)
- [Pi extension events](https://pi.dev/docs/latest/extensions)
