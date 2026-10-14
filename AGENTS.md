# AGENTS.md — pi-herdr-subagents

Actively maintained Pi package for Herdr-backed delegation. Target Pi `1.2.0`,
Herdr client/server `0.9.4`, and Herdr's official Pi integration `v9`.
See [README.md](README.md) for loading and usage.

## Purpose

`herdr-agents` gives Pi a `herdr_agent` tool for one-shot delegation through Herdr panes or tabs. Layout is internal configuration and is not part of the tool schema.

The intended model behavior:

- The main Pi session is the Orchestrator.
- When isolated context helps, the Orchestrator calls `herdr_agent` instead of raw `herdr` CLI commands.
- `herdr_agent` starts a Pi process in a named Herdr target using an agent profile from `~/.pi/agent/agents/*.md`. Every agent is a one-shot: the target closes after a successful result.
- Continuation with accumulated context goes through `resumeClosed: true` with the same `tabLabel`: the archived child session is reopened, so the resumed agent keeps the prior conversation. A live agent is never resumed over: working agents are re-waited (omit `task`), parked questions are answered in place, settled detached results are collected first.
- The Orchestrator waits for the child result, reads it, and synthesizes the answer.
- With `wait: false` nobody waits: the record is marked `detached` and the widget poller delivers the outcome once the agent settles — a result as `herdr_agent_result`, or a question as `herdr_agent_question` (checked first, same order as the blocking path). One-shot targets are closed only when they actually finished. `claimDetachedAgent` clears the flag in one locked read-modify-write, and synchronous collection releases it too, so delivery happens exactly once. Detaching is the default only in TUI mode (`ctx.mode === "tui"`); RPC, JSON, and print sessions default to `wait: true` because nobody would collect a detached result, and an explicit `wait: false` there is rejected.
- A child may instead call `ask_question`, which writes `question.md` beside the result artifact and returns. The child ends its turn and goes idle, the existing wait fires, and the Orchestrator returns the question early while leaving the target open — one-shots included. The answer is a normal `task` with the same `tabLabel`; the parked target is reachable by label.

## Delegation policy

Global `agents/.agents/AGENTS.md` is authoritative for **when** to delegate. Role matrix, continuation examples, and negative policy live in `README.md`. Orchestrator mechanics are in `prompts.ts` (`GLOBAL_INSTRUCTIONS`).

| Situation | `agent` | Delegate? |
|---|---|:---:|
| Unknown code / flows / "where-how" | scout | when needed |
| External docs / APIs / facts | researcher | when needed |
| Known single-file edit | — | no |
| Multi-file plan | planner | after scout |
| Isolated implementation | worker | after plan |
| Non-trivial / risky diff | reviewer | when needed |

## Files

- `src/index.ts` — Pi extension entrypoint and `herdr_agent` tool registration.
- `src/agents.ts` — loads agent profiles from user/project Pi agent directories.
- `src/config.ts` — layout config loading.
- `src/run.ts` — `/run` arg parsing and injected user messages.
- `src/herdr/cli.ts` — Herdr CLI/API process wrappers, argument redaction, and CLI error parsing.
- `src/herdr/snapshot.ts` — session snapshot, pane/tab/workspace discovery, and Agents workspace resolution.
- `src/herdr/placement.ts` — label uniqueness, reusable-tab/pane lookup, managed-agent listing, and split-ratio layout helpers.
- `src/herdr/agent.ts` — named-agent start, prompt, wait, and read wrappers with their snapshot parsers.
- `src/tool/schema.ts` — TypeBox schema for tool parameters.
- `src/prompts.ts` — injected Orchestrator instructions and child-agent protocol.
- `src/tool/one-shot.ts` — one-shot close/staging, pane-placement lock, collected-output formatting, and best-effort state cleanup helpers.
- `src/tool/rewait.ts` — re-wait on a running agent and the resume-closed live-agent decision.
- `src/tool/child-args.ts` — child Pi argv/env construction, the child tool allowlist, and the orchestrator identity.
- `src/artifacts.ts` — result/question/session-meta file IO and child protocol constants.
- `src/utils.ts` — agent-name generation, title casing, tool-name normalization, and output/wait formatting helpers.
- `src/types.ts` — shared TypeScript interfaces.
- `src/state/store.ts` — managed-agent lifecycle records, state lock, load/save/migrate/prune, and the pure closed-history parser/reconciler.
- `src/state/closed-history.ts` — closed one-shot archive/stage/finalize/claim/release/find.
- `src/ui/widget.ts` — agents widget rendering.
- `src/ui/poller.ts` — the per-second widget poller, awaited-label state, and detached result/question delivery.
- `src/ui/manager.ts` — the `/herdr-agents` dialog.
- `src/ui/renderers.ts` — result/question message renderers and their message type constants.
- `src/child.ts` — child-mode `ask_question` and result writer.
- `test-support/` — test harnesses: `mock-extension.ts` (shared mock `ExtensionAPI` host, env and profile fixtures), `fake-herdr.ts` (in-process Herdr simulator), `herdr-shim.mjs` (executable `herdr` stand-in), `harness.ts` (integration harness), `mock-llm.ts` (scripted `openai-completions` server), `e2e-harness.ts` (hermetic real Herdr server), `state-path-guard.ts` (per-run state-path pin and its sentinel teardown).
- `e2e/` — end-to-end scenarios against a real Herdr server and real Pi children.
- `docs/` — detailed implementation and session notes.

## Plans

Write each plan to `docs/plans/<short-task-name>.md`. The filename names the work, as in `herdr-0.7-agent-api-migration.md`. Do not use `PLAN.md` or any other generic name: a later plan would overwrite it. Revisions of one plan stay in that same file so Plan Diff keeps the history.

## Important behavior

- Child panes start with `HERDR_AGENT_CHILD=1` and `PROCESS_LAUNCHED_BY_Q=1`: delegation tools stay disabled, final responses are persisted, zsh selects `HISTFILE=/dev/null` from the child marker, and Kiro's terminal wrapper cannot hide the real shell from `herdr agent start`.
- `HERDR_PANE_ID` is preferred over focused pane detection. Focus can move while a tool is running.
- New agents start through `herdr agent start`; prompts use atomic `herdr agent prompt` (no `--wait`), then wait for newer `state_change_seq` activity with `working`/`blocked` or an actual newer `completion_seq` while settled, before `herdr agent wait --until idle --until done`. This avoids Herdr's hardcoded 5s `agent_prompt_stalled` gate. Abort / Herdr wait timeout returns a soft re-wait hint (child stays); re-wait uses `herdr agent wait` only.
- Explicit `wait: false` is rejected outside TUI mode, including taskless re-waits. RPC can report `hasUI: true` but has no widget collector. TUI defaults to detaching; its poller delivers outcomes and closes completed one-shots.
- `session_shutdown` stops the widget interval and then awaits the tick already in flight, so shutdown resolves only once nothing of that instance is still pruning the state file or calling Herdr. A tick that outlived the session was how a test process reached the real state file after the harness restored the env.
- Layout defaults to `workspace`, configured via `herdr-agents.json` in the Pi agent dir (`layout: "pane"` or `"tab"` for the legacy layouts); the model receives no layout parameter.
- Workspace mode keeps every agent tab in a dedicated subagents workspace (label from `herdr-agents.json` → `workspace.label`, default `subagents`), so the Orchestrator's screen never gains splits or tabs. The workspace is re-resolved from `herdr workspace list` on every spawn and recreated if the user closed it. `/herdr-agents` lists agents across workspaces and focuses them via `tab focus` (workspace-qualified ids). A detached agent that finishes unseen also raises a native `herdr notification show`.
- Pane mode splits the Orchestrator 60/40 on the first spawn and stacks additional agents down the right column. The placement lock is held through `agent start`, managed-state recording, and rebalancing so parallel calls cannot create competing right columns; in workspace mode the same lock serializes the subagents-workspace lookup within one Orchestrator process and is released once the agent's tab is visible to the next `listTabs` (label uniqueness is computed client-side by `uniqueLabel`). Across separate Orchestrator processes a duplicate workspace creation degrades gracefully: lookups take the first label match and managed records stay ownership-scoped. Changing `layout` in `herdr-agents.json` while agents are live orphans them (they stay visible/closable via `/herdr-agents`); close live agents before switching.
- Historical `persistent` records stay stored but unmanaged: no reuse, detached claim, conversion, or automatic closing.
- Parked one-shot reuse is label-based: the default label is the title-cased agent profile name unless `tabLabel` is provided. Reuse requires an exact managed-agent label match. Managed agents also receive a short unique Herdr automation name; legacy panes fall back to pane IDs.
- While waiting, the extension emits `pi.events.emit("herdr:blocked", ...)` so Herdr can mark the Orchestrator pane as blocked/waiting.

## Loading

The package manifest loads `src/index.ts`. For development, run
`pi -e ./src/index.ts` inside Herdr. For persistent loading, install this local
package with `pi install .` and reload Pi.

A global `/parallel-review` Pi prompt historically used this extension's
`herdr_agent` tool; the prompt itself was maintained outside this extension.

## Tests

```bash
npm ci --ignore-scripts
npm test                  # unit project: helpers, integration, contract (no real Herdr, ~60s)
npx vitest run --project unit --exclude test/integration.test.ts --exclude test/contract.test.ts  # fast subset (~3s)
npx vitest run test/herdr.test.ts  # one file
npm run test:e2e          # e2e project: real Herdr server + real Pi children (~50s)
npm run test:all          # both projects
```

`integration.test.ts` (~57s) and `contract.test.ts` (~19s) take nearly all of
`npm test`. While iterating, and for import-only moves, run the fast subset plus
the rolldown bundle check (Validation). Run the full `npm test` once before
committing any change to behavior, Herdr argv, `details`, or tool flow; run
`npm run test:e2e` only when the change touches spawning, waiting, or layout.

Run `npm ci --ignore-scripts` once to install local development dependencies
from `package-lock.json`. Pi supplies the host peers when loading the extension;
unit and integration tests use the local packages. E2E additionally requires
`pi` and `herdr` on `PATH`.

The unit project runs the helper, integration, and contract files together. E2E is the other project:

- **Unit** (`test/*.test.ts`) — pure helpers: arg builders,
  snapshot parsing, layout ratios, state records, widget rendering, profile
  discovery precedence, and the child-mode contract. `imports.test.ts` walks
  every module's relative imports, which is the one failure (a dangling sibling
  import) that breaks Pi at load time without failing any other test.
- **Integration** (`integration.test.ts`) — the real extension, loaded through a
  mock `ExtensionAPI`, driving a fake Herdr. `HERDR_BIN_PATH` points at
  `test-support/herdr-shim.mjs`, which forwards argv over a socket to the
  `FakeHerdr` instance inside the test, so every `herdr` call is a real
  subprocess against a simulated server with a real pane/tab/layout tree.
  `HERDR_SOCKET_PATH` serves `layout.export` / `layout.set_split_ratio`.
  Simulated children write the same `result.md` / `question.md` artifacts a real
  Pi child would.
- **Contract** (`contract.test.ts`, `schema.test.ts`) — the behavior lock for
  rewrites. Same harness as the integration layer, but instead of the flows an
  Orchestrator normally drives it pins the rest of the observable surface: the
  `details` keys, the exact Herdr argv, every failure path, the widget and
  command behavior, artifact permissions, and the model-facing parameter schema.
  Start here when refactoring: if these stay green, callers keep working.
- **E2E** (`e2e/flow.test.ts`) — a real `herdr server`, real pane splits, and
  real `pi` child processes that load this extension in child mode. Only the
  model and the Orchestrator's own Pi process are simulated: `MockLlm` serves
  `openai-completions` from a hermetic `models.json`, and the extension is
  driven through the same mock `ExtensionAPI`. The server runs with its own
  `HOME` and `HERDR_SOCKET_PATH`, and children inherit its hermetic
  `PI_CODING_AGENT_DIR` / `TMPDIR`, so the live session is untouched.

Both harnesses redirect `TMPDIR`, `HERDR_AGENTS_STATE_PATH` and
`PI_CODING_AGENT_DIR` per test, so the live session, its state file and its temp
artifacts are never touched. On top of that, `vitest.config.ts` pins
`HERDR_AGENTS_STATE_PATH` to a throwaway file for the whole run
(`test-support/state-path-guard.ts`), seeded with a sentinel record: work that
escapes a harness teardown writes there instead of the live file, and the run's
teardown fails if that file is no longer unchanged.

Covered by the integration layer: one-shot spawn/collect/close, scrollback
fallback, the `ask_question` round trip (parked one-shot answered by label),
rejection of label-addressed tasks to live agents, parallel spawns serialized
into one agent column
with rebalancing, `agent_kind_mismatch` recovery, the
delayed and fast prompt acceptance without duplicate Enter, timeout/abort soft re-wait plus the
re-wait path, detached result and question delivery through the widget poller
(exactly once), the tab layout, the injected Orchestrator / `/run`
instructions, and closed one-shot archive/resume (`resumeClosed`, session
JSONL, ownership, concurrent claim, question after resurrection).

Regressions from `docs/plans/session-findings.md` that used to be checked by hand and
now have tests, with the finding they came from:

| Behavior | Finding |
|---|---|
| Child mode registers `ask_question` only — never `herdr_agent`, commands, renderers or instruction injection | §4 |
| Child persists each finalized assistant message to the artifact; ignores blank and non-assistant messages | §4, §9 |
| `ask_question` refuses to strand the child when no channel exists | §4 |
| Project profile overrides a user profile of the same name; unusable files are skipped | §2 |
| Split targets `HERDR_PANE_ID`, not the pane Herdr reports as focused | §5 |
| A reused agent's previous settled state is not accepted as this turn's result | §8 |
| A child that finishes as `done` rather than `idle` is still collected | §8 |
| One-shot cleanup removes the managed temp dir; a running detached agent keeps it | §9 |
| Startup CLI failures propagate without retrying or closing the pane | §12 |
| `/herdr-agents` focuses, closes (with temp cleanup), and reports an empty workspace | §9 |
| Two detached outcomes in one poller tick arrive as one batch, only the last triggering a turn | index.ts |
| Every relative import resolves | §15 |

Pinned by the contract layer: the `details` key set and profile payload of a
successful call; the `agent read` fallback window; a collected result surviving a
failed pane close (with `closeError`); malformed `pane split` / `tab create` /
`api snapshot` output; refusing to act when the current pane is unidentifiable;
the whole flow still completing when the state file is unusable; `wait: false`
re-wait; detached one-shot delivery closing the agent; a settled detached agent
with no artifact keeping its claim; tab labels staying unique across spawns and the `tab list`
fallback when `tab create` omits the id; widget appear/hide/clear including the
poller stopping; `/run` busy, empty and completion behavior; `/herdr-agents`
non-TUI and failure notifications; both message renderers; no layout churn for a
lone agent; state pruning; and `0600` on the state file and artifacts.

Covered by the e2e layer: a real child produces a real result artifact and its
pane is really closed; a resumed one-shot keeps its context across tasks
(asserted on the model's request history); a closed one-shot can be resumed
with `resumeClosed` and still sees prior context; a real `ask_question` tool call
travels from a tools-restricted child back to the Orchestrator and the answer
finishes it; two real agent panes stack into one right column with the
Orchestrator held at 60%; a detached real child is delivered and closed by the
poller with nobody waiting; real result/question batching uses one turn trigger.
The SDK boundary test verifies both custom messages reach one real Pi model
request with orchestration guidance.

Not covered: the Orchestrator's own Pi process (the extension is driven
directly, not through a real model emitting `herdr_agent` tool calls), and the zsh
`HISTFILE` child guard (§14, it lives in the `zsh` package).

`MockLlm` defaults to a 1.5s response delay so live-pane assertions can run
before detached completion. Fast-completion scenarios explicitly use zero
delay and rely on authoritative `completion_seq`. The E2E harness installs
official Pi integration v9 into its isolated HOME.

Writing a scenario:

```ts
await withHarness({}, async (harness) => {
  harness.fake.setBehavior((turn) => ({ result: `done ${turn.turn}` }));
  const result = await harness.call({ agent: "scout", task: "..." });
  assert.equal(result.details.closed, true);
  harness.fake.callsMatching("pane", "split"); // recorded argv
});
```

`FakeHerdr` hooks: `setBehavior` (per-prompt child outcome — `result`,
`question`, `transcript`, `delayMs`, `stalled`, `neverSettle`, `settleStatus`,
`staleWindowMs`), `queueStartFailures` / `failEveryStart` (fail `agent start`
with a Herdr error code), `failCommand` / `malformCommand` (fail or corrupt any
`herdr <group> <command>`), `omitCreatedTabId`, `holdChildren` /
`releaseChildren` (settle several children at once, for one-tick batching),
`focusedPaneId`, `completeAgent`, `callsMatching`, `layoutFor`, `ratioUpdates`.

The `/herdr-agents` overlay is driven with `dialogInputs`: keystrokes per
`ctx.ui.custom` call (`"\r"` selects, `"d"` closes), and a call with no entry
left cancels, which ends the manager loop.

## Validation

Useful smoke checks:

```bash
# Parse/bundle the extension modules.
npx rolldown src/index.ts \
  --file /tmp/herdr-agents-check.js \
  --platform node \
  --external @earendil-works/pi-coding-agent,@earendil-works/pi-tui,typebox \
  --no-codeSplitting

# Confirm the tool is visible to a fresh Pi model.
PI_OFFLINE=1 pi --no-context-files --no-skills --no-prompt-templates --no-themes \
  -p 'List exact tool names available. Do not use tools.'
```

Run checks from the repository root. When this package is loaded in Pi,
`/reload` refreshes the extension runtime.
