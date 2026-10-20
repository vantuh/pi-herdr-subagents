# AGENTS.md — pi-herdr-subagents

Pi extension that adds the `herdr_agent` tool: one-shot delegation to child Pi
agents running in Herdr. A parent-only companion tool, `herdr_agent_control`,
steers or interrupts a child this session already started. Targets the installed
Pi `1.3.0`, Herdr client/server `0.9.5`, and Herdr's Pi integration `v9`; no
compatibility layer for older versions. The development dependencies
`@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` are pinned to
`1.3.0` in `package.json` and `package-lock.json`, so type-checking and the
unit/integration suites compile against the runtime SDK.
[README.md](README.md) covers usage; `docs/` covers the tool contract, runtime
flow, config and profiles. Keep those in sync when behavior changes.

## Files

- `src/index.ts` — extension wiring: events, commands, tool registration, config load.
- `src/agents.ts` — profile discovery from user and project agent directories.
- `src/agents/types.ts` — `AgentProfile`.
- `src/config.ts` — `herdr-agents.json` loading and normalization.
- `src/config/schema.ts` — layout, configuration and tolerant input schemas.
- `src/run.ts` — `/run` argument parsing and the injected user message.
- `src/prompts.ts` — Orchestrator instructions and the child-agent protocol.
- `src/json.ts` — `parseJson`: JSON parsing validated against a TypeBox schema.
- `src/artifacts.ts` — result, question and session-meta file IO.
- `src/artifacts/schema.ts` — artifact schemas: session metadata, native Pi session header, assistant message; shared non-empty-string guard.
- `src/artifacts/sessions.ts` — native Pi session-file header reading and resumable-session validation.
- `src/child.ts` — child mode: `ask_question` and the result writer.
- `src/child/control.ts` — child consumer: control-directory watch, single admission per id, steer/interrupt guards, marker before abort, ack write.
- `src/control.ts` — agent-control transport: control-directory resolution from the result file, atomic publish beside the watched directory, per-id acks, parent-only removal, the per-directory queue.
- `src/control/schema.ts` — control action, status, id, request and ack schemas.
- `src/utils.ts` — shared helpers: agent naming, title casing, error messages, best-effort state persistence.
- `src/output.ts` — child output, status-preview and spawn-warning formatting.
- `src/reports.ts` — durable result reports: agent-dir reports directory policy,
  immutable report naming and write protocol, TTL prune, report-write failure
  hook.
- `src/herdr/schema.ts` — Herdr CLI/API schemas: pane, created pane, tab, workspace, named agent, session snapshot.
- `src/herdr/types.ts` — runtime projections: `HerdrContext`, `ReusableAgentTab`, `HerdrAgentInfo`.
- `src/herdr/cli.ts` — Herdr CLI/API process wrappers, argument redaction, error parsing.
- `src/herdr/snapshot.ts` — session snapshot, pane/tab/workspace discovery, subagents-workspace resolution.
- `src/herdr/placement.ts` — label uniqueness, reusable tab/pane lookup, managed-agent listing.
- `src/herdr/layout.ts` — split-ratio computation, pane-column rebalance, `layout.export` / `layout.set_split_ratio` calls.
- `src/herdr/layout/schema.ts` — `PortableLayoutNode`, `ExportedLayoutResponse`, `PaneLayout`.
- `src/herdr/agent.ts` — `herdr agent start`, `prompt` and `read` wrappers.
- `src/tool/schema.ts` — tool parameter schema.
- `src/tool/execute.ts` — the `herdr_agent` entry: profile resolution, TUI/config guards, resume-argument guards, dispatch to status or the spawn flow.
- `src/tool/status.ts` — taskless status check and the resume-over-live-agent decision.
- `src/tool/control.ts` — `herdr_agent_control`: parameter schema, ordered guards including session ownership, status texts, ack wait without retry.
- `src/tool/one-shot.ts` — one-shot close, collected spawn-warning cleanup, state cleanup.
- `src/tool/spawn/types.ts` — spawn types: invocation, settings, shared spawn state, placement, target results.
- `src/tool/spawn/schema.ts` — Herdr tab-create, pane-split and pane-layout response schemas.
- `src/tool/spawn/flow.ts` — `runAgentTask`: placement lock, spawn rollback, temp-file sequencing, prompt handoff; `openClosedAgent` for the overlay.
- `src/tool/spawn/targets.ts` — placement resolution, tab creation, pane split/rename.
- `src/tool/spawn/continuation.ts` — parked-question reuse, live-label refusal, closed-history resume claim.
- `src/tool/spawn/lifecycle.ts` — child start/record with mandatory resumed persistence, and the task prompt turn.
- `src/tool/spawn/placement-lock.ts` — pane placement lock serializing spawn placement.
- `src/tool/child-args.ts` — child Pi argv/env and tool allowlist.
- `src/tool/result.ts` — `textResult` helper.
- `src/state/schema.ts` — state-file schemas: live agent record/input, closed-history status/record/input, `HerdrAgentsState`, `StateEnvelope`.
- `src/state/store.ts` — state file IO: path resolution, load/save, quarantine of unreadable files, the locked load-mutate-save transaction and failure injection hooks.
- `src/state/lock.ts` — in-process state-file queue and the cross-process exclusive lock directory.
- `src/state/history-policy.ts` — closed-history parsing, TTL/cap policy, reconciliation and pruning.
- `src/state/live-records.ts` — live-record ownership and snapshot pruning.
- `src/state/lifecycle.ts` — lifecycle record writes, spawned-warning cleanup and the detached-delivery claim.
- `src/state/closed-history.ts` — archive and claim of closed one-shots for `resumeClosed`.
- `src/ui/detached-outcomes.ts` — detached outcome delivery: result/question formatting, fresh settled-status recheck, claim, notification and one-shot close.
- `src/ui/poller.ts` — per-second poller: widget lifecycle and the tick that hands agents to delivery.
- `src/ui/widget.ts`, `src/ui/manager.ts`, `src/ui/renderers.ts` — widget, `/herdr-agents` overlay, message renderers.
- `src/ui/agent-models/command.ts` — `/herdr-agent-models`: profile/model snapshots and save/refresh wiring.
- `src/ui/agent-models/picker.ts` — two-step agent/model overlay with filtering and save status.
- `src/ui/agent-models/write.ts` — atomic, symlink-preserving profile `model:` edits.
- `test-support/` — test harnesses and fixtures (see Tests). `fake-herdr/`
  holds the simulator's own types and pure pane-tree operations.

## Structure

- Organize types, schemas and helpers by their owning feature, not in global buckets.
- Prefer composition of shared TypeBox fields and types derived with `Static` over
  repeated declarations or schema inheritance. Keep each schema with its derived type.
- Keep raw, legacy and normalized schemas separate when their validation rules differ.
- Split modules at responsibility boundaries; line count is a signal, not a hard limit.

## Invariants

Easy to break and not obvious from one file:

- Every call returns once the prompt is submitted. Prompts use
  `herdr agent prompt` without `--wait`, and the extension never calls
  `herdr agent wait`: Herdr's fixed 5s `agent_prompt_stalled` gate would fail
  long tasks.
- The poller delivers each outcome exactly once: `claimDetachedAgent` clears the
  `detached` flag in one locked read-modify-write. A question is checked before
  a result. A one-shot closes only after it wrote a result artifact; a child that
  asked a question stays open. Before claiming, the poller re-reads the live
  agent status: a tick's snapshot can predate the prompt, and a stale `idle`
  would deliver partial text and close a working child.
- Status checks read the result artifact, never the pane.
- A child appends every assistant message of a task to `result.md`; the parent
  clears it before each prompt. Overwriting lost answers that a model split
  across messages. Manual user/steering continuations retain the result channel;
  a new valid marker replaces it, while `session_start` clears it.
- Each managed run writes an `interrupted` marker before work starts. Only
  successful `agent_before_settle` removes it; Escape skips that boundary, so
  aborted runs stay blocked. The poller must not claim or close partial results.
  The parent clears old result/interruption artifacts before a new task.
- `herdr_agent` refuses to run outside TUI mode before any Herdr call, because
  only the TUI poller delivers outcomes.
- A delivered result is copied to an immutable report under
  `<getAgentDir()>/herdr-agents-results` between the claim and the close, so the
  temp artifact never holds the only plain-text copy. Delivery truncates only
  when that report exists: a failed save delivers the full text with a warning.
  The directory is a real `0700` directory (never a symlink leaf), reports are
  `0600` created with `wx`, and pruning removes only own names stamped 30 days
  back — never by a timer, and never a name it cannot date.
- `HERDR_PANE_ID` identifies the Orchestrator pane, not the focused pane: focus
  can move while a tool runs.
- Every child starts with `--session-dir <getAgentDir()>/herdr-agent-sessions`,
  so child sessions stay out of the default project sessions tree the
  Orchestrator's `/resume` picker reads. `resumeClosed` still reopens an archived
  child by its explicit `--session` path.
- Children start with `HERDR_AGENT_CHILD=1`, which registers only
  `ask_question` and the result writer, so children cannot delegate. They also
  get `PROCESS_LAUNCHED_BY_Q=1`, so Kiro's terminal wrapper does not hide the
  real shell from `herdr agent start`.
- An agent's logical label comes from managed state, never from a tab title the
  user may rename. A task sent to the label of a live agent is rejected.
- In pane layout, the placement lock is held through `agent start`, the state
  write and rebalancing, so parallel calls cannot build competing right columns.
- Only the session that owns a child's live record can control it: the managed
  lookup is terminal-scoped, so `herdr_agent_control` additionally requires
  `ownerSessionId` to equal this session's id. A missing owner, or a legacy
  record without one, is refused.
- A control call never spawns, resumes, prompts, claims, collects, closes, or
  deletes a child's result, question or session artifacts. It publishes
  `control/request.json` beside `result.md` and reads `ack.<id>.json`. One
  operation is outstanding per child: the parent is the sole remover of both
  files, inside a per-directory queue, while the child writes only its own ack
  and admits each id once, reserving it after the read and before any further
  `await`. An ack counts only for the exact published id.
- A steer is applied only with the child's `active` flag true, `ctx.isIdle()`
  false and no `await` between that check and `pi.sendMessage`, using
  `deliverAs: 'steer'` and never `triggerTurn`. `queued` is not `applied`: an
  interrupt drops the queued message.
- An interrupt writes the `interrupted` marker before `ctx.abort()` and again on
  `agent_settled.aborted`, because an abort can land while `agent_before_settle`
  runs and that boundary clears the marker. This is ordinary-path protection
  only: a collection tick that already read the marker can still deliver the run
  and close the pane, which is accepted, and an interrupt never retracts an
  already-written question.
- A control call never retries. A missed ack is `unknown`, the transport files
  stay in place, and the next operation's pre-clean removes them. The poller,
  delivery, reports, closed history and widget are untouched by control, and a
  live child running older extension code writes no ack, so it reports
  `unknown`.
- `herdr-agents.json` is read once at extension load; edits apply on `/reload`.
- `session_shutdown` stops the poller and awaits the tick in flight, so no tick
  writes state after shutdown.
- Stored `persistent` records from older versions are kept but never reused,
  claimed or closed.

## Plans

Write each plan to `docs/plans/<short-task-name>.md`, never a generic name like
`PLAN.md`. Revise a plan in the same file. When it is finished, move it to
`docs/plans/done/`. Files in `docs/plans/done/` are history: do not implement
them unless the user names the file.

## Commands

```bash
npm ci --ignore-scripts   # install locked dev dependencies
npm run typecheck         # tsc over src/ only; tests are not type-checked
npm run lint              # oxlint
npm run format            # oxfmt (Markdown is excluded)
npm run test:unit         # pure helpers, ~3s
npm run test:integration  # extension against a fake Herdr, ~30s
npm run test:e2e          # real Herdr server and real Pi children; needs pi and herdr on PATH
npx vitest run test/herdr-cli.test.ts  # one file
```

There is no aggregate `npm test`; each project runs on its own.

- While iterating: `typecheck`, `lint`, `test:unit`.
- Before committing a change to behavior, Herdr argv, tool `details` or flow:
  also `test:integration`.
- When the change touches spawning, delivery or layout: also `test:e2e`.

To check that a real Pi loads the working copy and exposes the tool (calls the
configured model):

```bash
pi -e ./src/index.ts --no-context-files --no-skills --no-prompt-templates --no-themes \
  -p 'List exact tool names available. Do not use tools.'
```

## Tests

Three Vitest projects in `vitest.config.ts`:

- **unit** — `test/*.test.ts` except the files below. Pure helpers, schemas,
  state records (`state-*.test.ts`), Herdr parsing/placement (`herdr-*.test.ts`),
  widget rendering, profile discovery, child mode, the control transport
  (`control.test.ts`), the child consumer (`child-control.test.ts`), the
  steer/abort semantics against a real `AgentSession` and real files without
  Herdr (`pi-control.test.ts`), and the Pi SDK boundary. `imports.test.ts`
  catches a dangling relative import, which breaks Pi at load time and fails
  nothing else.
- **integration** — `integration-*.test.ts` (user-facing flows, one file per
  topic), `contract-*.test.ts` (exact `details` keys, Herdr argv, failure paths,
  file permissions) and `ui-boundary.test.ts`. For the control tool,
  `contract-control.test.ts` owns the exact texts, `details` keys, guards and
  session ownership; `integration-control.test.ts` owns the flows and the
  real-poller overlap. The real extension runs through a
  mock `ExtensionAPI` against `FakeHerdr`: `HERDR_BIN_PATH` points at
  `test-support/herdr-shim.mjs`, which forwards each `herdr` call over a socket to
  the fake server inside the test. Simulated children write the same
  `result.md` / `question.md` artifacts as real ones. Start here when
  refactoring: if the `contract-*.test.ts` files stay green, callers keep
  working.
- **e2e** — `e2e/flow.test.ts`: a real `herdr server` and real Pi children. Only
  the model (`MockLlm`, an `openai-completions` server) and the Orchestrator's
  own Pi process are simulated. It is the only place the TUI abort binding runs,
  so the real steer and interrupt scenarios live there, including the assertion
  that a queued steer is never consumed after an interrupt.

Isolation: the harnesses redirect `TMPDIR`, `HERDR_AGENTS_STATE_PATH` and
`PI_CODING_AGENT_DIR` per test. `test-support/state-path-guard.ts` also pins the
state path to a sentinel file for the whole run and fails the run if anything
wrote to it.

Writing an integration test: `test/integration-*.test.ts` imports `withHarness`
from `test-support/integration-harness.ts`, which clears injected state-save
failures before `dispose()`; `test/contract-*.test.ts` imports its own
`withHarness` from `test-support/contract-harness.ts`, which only disposes. Both
wrap `createHarness` from `test-support/harness.ts`. State-file suites use
`createTempStateFixture` and the `pane`/`history` fixtures from
`test-support/state-fixture.ts`, which keeps every temp dir registered for that
file's single teardown.

```ts
await withHarness({}, async (harness) => {
  harness.fake.setBehavior((turn) => ({ result: `done ${turn.turn}` }));
  const result = await harness.call({ agent: 'scout', task: '...' });
  assert.equal(result.details.closed, true);
  harness.fake.callsMatching('pane', 'split'); // recorded argv
});
```

`FakeHerdr` hooks:

- `setBehavior`: per-prompt child outcome (`result`, `question`, `delayMs`,
  `stalled`, `neverSettle`, `settleStatus`, `staleWindowMs`).
- `queueStartFailures`, `failEveryStart`: fail `agent start` with a Herdr error code.
- `failCommand`, `malformCommand`: fail or corrupt any `herdr <group> <command>`.
- `holdChildren`, `releaseChildren`: settle several children in one poller tick.
- `omitCreatedTabId`, `focusedPaneId`, `completeAgent`.
- Inspection: `callsMatching`, `layoutFor`, `ratioUpdates`.

The `/herdr-agents` overlay is driven by `dialogInputs`: keystrokes per
`ctx.ui.custom` call (`"\r"` focuses, `"d"` closes); running out of entries
cancels.

`MockLlm` waits 1.5s per response by default, so e2e tests can observe a live
pane before the child finishes. Fast-completion scenarios set the delay to zero.

Not covered: the Orchestrator's own Pi process driven by a real model, the zsh
`HISTFILE` guard for children (it lives in the user's zsh config), a child
started before `/reload` (older child code writes no ack), and a second
Orchestrator process on one session (the control transport is last-writer-wins).
