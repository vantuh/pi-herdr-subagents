# src restructure

## Goal

Split the three oversized modules (`index.ts` 2146 lines, `herdr.ts` 1053,
`state.ts` 1056) and the `utils.ts` grab-bag into cohesive modules grouped by
concern. No behavior change: the contract, integration and e2e suites are the
safety net and must stay green without edits beyond import paths.

## Target layout

```
src/
  index.ts              # wiring only: pi.on, registerCommand, registerTool
  prompts.ts            # was constants.ts
  types.ts  config.ts  agents.ts  run.ts  child.ts   # unchanged
  artifacts.ts          # result/question/session-meta IO + child protocol constants
  utils.ts              # leftovers: titleCase, makeHerdrAgentName, normalizeTools, formatting
  tool/
    schema.ts           # was src/schema.ts
    execute.ts          # herdr_agent execute
    rewait.ts           # executeRewait
    one-shot.ts         # closeOneShot, stageClosedOneShotIfEligible, rebalance, placement lock
    child-args.ts       # buildChildPiArgs, herdrChildEnvArgs, buildChildToolArgs/Allowlist
  herdr/
    cli.ts              # execHerdr, execHerdrApi, redaction, HerdrCliError
    snapshot.ts         # snapshot, panes/tabs/workspaces, resolveAgentsWorkspace
    placement.ts        # uniqueLabel, findReusable*, listManagedWorkspaceAgents, split ratios
    agent.ts            # start/prompt/wait/read
  state/
    store.ts            # records, lock, load/save/migrate/prune, test failure hooks
    closed-history.ts   # archive/stage/finalize/claim/release/find
  ui/
    widget.ts           # was src/widget.ts (pure rendering)
    poller.ts           # widget poller, deliverDetachedOutcomes, awaited-label state
    manager.ts          # /herdr-agents dialog
    renderers.ts        # result/question message renderers + message type constants
```

## Rules for every phase

- Pure moves: cut/paste code, change only `import`/`export` lines. Logic edits
  belong to phase 7 only.
- No barrel `index.ts` re-export files; callers import from the real module.
- Constants stay next to their only consumer. Only constants shared across
  modules move (`RESULT_FILE_MARKER`, `ASK_QUESTION_TOOL`, `SESSION_META_ENV`,
  `SESSION_META_FILE_NAME` → `artifacts.ts`).
- Module-level mutable state moves together with every function that touches
  it; no state is split across two modules.
- Dependency direction stays acyclic:
  `index → tool/execute → ui → tool/one-shot → herdr/state → artifacts/utils/types`.
  `state` never imports `herdr`.
- Tests are not split or rewritten. Update import paths only. Rename a test file
  only when its module is renamed 1:1 (`constants.test.ts` → `prompts.test.ts`).
  `test/state.test.ts` builds child scripts from `'../src/state.ts'` by path
  (lines ~914, ~969, ~1073); update those strings too.
- Each phase ends green and is committed. Phases 1–6 are pure moves, so the
  worker runs only the fast checks: the rolldown bundle check from `AGENTS.md`
  and the fast unit subset (`AGENTS.md` → Tests). The Orchestrator then runs the
  full `npm test` (plus `npm run test:e2e` for phases 5–7) once before
  reporting; a failure there resumes the worker. Phase 7 changes logic, so its
  worker runs the full `npm test` itself.
- Docs updated in the same phase as the move they describe: `AGENTS.md` Files
  section, `docs/agent-profiles.md`, `docs/tool.md`, `docs/flow.md` source refs.

## Phases

Status: `[x]` done (commit), `[~]` in progress, `[ ]` not started.

### [x] Phase 1 — prompts and artifacts (`3997ba1`)

- `constants.ts` → `prompts.ts`; `test/constants.test.ts` → `test/prompts.test.ts`.
- New `artifacts.ts` from `utils.ts`: protocol constants, `ChildSessionMeta`,
  `PiSessionHeader`, temp/result/question/session-meta file helpers
  (`createAgentTempFiles` … `readAgentResult`, `findResultFileMarker`,
  `assistantText`), session header validation.
- `utils.ts` keeps: `buildChildToolAllowlist`, `buildChildToolArgs`,
  `makeHerdrAgentName`, `titleCase`, `normalizeTools`, `formatAgentOutput`,
  `formatSpawnWarnings`, wait-interrupt helpers.
- Update imports: `child.ts`, `herdr.ts`, `index.ts`, `test/utils.test.ts`,
  `test/child.test.ts`, `test-support/fake-herdr.ts`.

Done when: `utils.ts` has no file IO; tests green; commit
`refactor: split prompts and artifacts modules`.

### [x] Phase 2 — state (`83a07b6`)

- `state.ts` → `state/store.ts` (lines 1–613: records, env, lock, load/save,
  migrate, prune, ownership, lifecycle record ops, `claimDetachedAgent`,
  test failure hooks).
- `state/closed-history.ts` (lines 789–1056: archive, stage, finalize, claim,
  release, invalidate, find).
- `store.ts` exports the lock/load/save primitives `closed-history.ts` needs.
  The store's load/save path calls `parseClosedHistory`,
  `reconcileHerdrAgentsState` and `pruneClosedHistory`, so those stay in
  `store.ts`: the pure history helpers live in the store and
  `closed-history.ts` holds only the locked operations. The dependency is
  one-way (`closed-history → store`); `store.ts` never imports
  `closed-history.ts`.
- Update imports: `herdr.ts`, `index.ts`, `test/state.test.ts` (including the
  path strings), `test/herdr.test.ts`, `test/integration.test.ts`,
  `test-support/harness.ts`, `test-support/e2e-harness.ts`.

Done when: no import cycle (`imports.test.ts` green); commit
`refactor: split state into store and closed history`.

### [x] Phase 3 — herdr (`f1eb899`)

- `herdr/cli.ts`: `HerdrCliError`, `delay`, redaction/sanitize, `parseHerdrError`,
  `execHerdr`, `execHerdrApi`.
- `herdr/snapshot.ts`: `getSessionSnapshot` … `resolveAgentsWorkspace`,
  `buildAgentFinishedNotificationArgs`.
- `herdr/placement.ts`: `uniqueLabel`, `choosePaneForTab`, `findReusable*`,
  `listManagedWorkspaceAgents`, layout types, split ratio helpers,
  `exportPaneLayout`, `setLayoutSplitRatio`, `chooseAgentColumnSplitTarget`.
- `herdr/agent.ts`: start/prompt/wait/read and their parsers and constants.
- Update imports: `child.ts`, `index.ts`, `test/herdr.test.ts`,
  `e2e/flow.test.ts`.

Done when: `src/herdr.ts` is gone; tests green; commit
`refactor: split herdr wrappers by concern`.

### [x] Phase 4 — UI out of index (`370bb53`)

- `widget.ts` → `ui/widget.ts`.
- `ui/renderers.ts`: `AGENT_RESULT_MESSAGE_TYPE`, `AGENT_QUESTION_MESSAGE_TYPE`,
  `registerAgentBlockRenderer` and its two registrations (as an exported
  `registerAgentMessageRenderers(pi)`).
- `ui/poller.ts`: `WidgetTimerHolder`, `widgetTicking`, `awaitedAgentLabels`,
  `begin/endAwaitingAgent`, `stopAgentsWidgetPoller`, `themeWidgetPaint`,
  `loadCurrentAgents`, `loadAgentsForWidget`, `deliverDetachedOutcomes`,
  `updateAgentsWidget`, `ensureAgentsWidget`.
- `ui/manager.ts`: `showNoAgentsDialog`, `AgentMenuAction`, `pickAgentAction`,
  `showHerdrAgentsManager`.
- Shared helpers they need from `index.ts` (`bestEffort`, `errorMessage`,
  `closeOneShot`, `readSettledAgentOutput`, …) move first to their phase-5 home
  if the dependency forces it; otherwise phase 5 picks them up. The poller and
  the manager call `closeOneShot`, `formatCollectedOutput`, `bestEffort`,
  `readSettledAgentOutput`, `spawnWarningDetails` and
  `dropCollectedSpawnWarnings`, so those one-shot helpers moved into
  `tool/one-shot.ts` in this phase instead of phase 5.
- `index.ts` re-exports the two message type constants only if
  `test/contract.test.ts` cannot be pointed at `ui/renderers.ts`; prefer
  updating the test import.

Done when: `index.ts` has no TUI component imports except via `ui/`; unit + e2e
green; commit `refactor: move widget, poller and manager into ui`.

### [x] Phase 5 — tool helpers out of index (`3fb7bbb`)

- `schema.ts` → `tool/schema.ts`.
- `tool/child-args.ts`: `herdrChildEnvArgs`, `orchestratorIdentity`,
  `buildChildPiArgs`, plus `buildChildToolAllowlist` / `buildChildToolArgs`
  from `utils.ts`.
- `tool/one-shot.ts`: already holds `bestEffort`, `independentCleanupSignal`,
  `errorMessage`, `rebalanceCurrentPaneAgents`, `closeOneShot`,
  `stageClosedOneShotIfEligible`, `formatCollectedOutput`,
  `readSettledAgentOutput`, `spawnWarningDetails` and
  `dropCollectedSpawnWarnings` (moved in phase 4); phase 5 adds the placement
  lock (`panePlacementQueue`, `acquirePanePlacementLock`) and timeout constants.
- `tool/rewait.ts`: `executeRewait`, `resumedDetails`,
  `resumeClosedLiveDecision`.
- Update imports: `test/schema.test.ts`, `test/pi-contract.test.ts`,
  `docs/agent-profiles.md`.

Done when: `index.ts` holds only wiring, `pendingRunDelegation`, and
`registerHerdrAgentTool` with its inline `execute`; unit + e2e green; commit
`refactor: move tool helpers out of index`.

### [x] Phase 6 — execute out of index

- Move the `execute` body verbatim into `tool/execute.ts` as
  `executeHerdrAgent(pi, params, signal, onUpdate, ctx)`; `registerHerdrAgentTool`
  calls it. Still a pure move.

Done when: `index.ts` is wiring only (target < 300 lines); unit + e2e green;
commit `refactor: move herdr_agent execute into tool module`.

Validation: Orchestrator verified the execute body matches HEAD modulo whitespace
and trailing commas; `index.ts` is 167 lines. Full `npm test`: 291/291;
`npm run test:e2e`: 11/11; rolldown bundle and `git diff --check`: passed.
Independent review via `oracle` found no actionable findings (the `reviewer`
profile was blocked by HTTP 429).

### [ ] Phase 7 — split execute into phases (real refactor)

The only phase that changes code shape. Scope is decided after phase 6 by
reading `tool/execute.ts`; candidate seams: resolve profile/config/mode →
resume-closed claim → spawn or reuse target → prompt → wait/collect/detach.
The plan for this phase is written into this file as a revision before coding,
and the diff gets a `reviewer` pass.

Done when: no function in `tool/execute.ts` exceeds ~150 lines; unit + e2e
green; reviewer findings resolved; commit
`refactor: split herdr_agent execute into phases`.

## Follow-up: scope state pruning to one Herdr server

Not part of the restructure; tracked here so it is not lost.

The state file (`~/.pi/agent/herdr-agents-state.json`) is shared by every
Orchestrator on the machine, but `pruneHerdrAgentsState` deletes any record
whose terminal is missing from the *current* Herdr server's snapshot. Two Herdr
sessions with different sockets therefore delete each other's live records,
which makes those agents invisible to the poller (no detached delivery, no
close) and to label lookup (re-wait reports no running agent).

- Record the owning Herdr server (e.g. `HERDR_SOCKET_PATH`) on each agent record.
- Prune only records that belong to the server whose snapshot is being used;
  records without the field keep today's behavior.
- Test: two simulated servers sharing one state file keep each other's records.

## Follow-up: issues found during the restructure

Not part of the restructure; tracked here so they are not lost.

- [x] Tests pruned the live state file through a widget tick that outlived
  `session_shutdown` (`552343d`, bounded wait `e1c4e8e`).
- [ ] Cancel the widget tick instead of a timed wait. Today
  `settleAgentsWidgetPoller` races the in-flight tick against an arbitrary 3s
  timeout (Pi awaits `session_shutdown` handlers with no timeout of its own);
  if it fires, the tick keeps running after shutdown. Replace with an
  `AbortController` owned by the poller: shutdown aborts, the tick passes the
  signal to `execHerdr` and checks it before each side effect (prune, delivery,
  close), then shutdown awaits the tick without a timer. `withStateFileLock`
  does not take a signal yet: add one, or keep a fallback cap only for the lock
  wait (precedent: `RESUME_CLEANUP_TIMEOUT_MS` + `independentCleanupSignal`).
  The same aborted signal covers the poller-restart case: a `herdr_agent` call
  still running at shutdown can call `ensureAgentsWidget` and start a new
  interval after shutdown; `ensureAgentsWidget` refuses once aborted.
- [ ] No retry on `agent_pane_busy`: `herdr agent start --pane <new pane>` can
  fail because the new pane's shell is not ready yet, and the failed spawn
  leaves an empty shell pane behind. Decide between a short bounded retry for
  this error code and closing the pane on this specific failure (today startup
  failures intentionally keep the pane, see `AGENTS.md` regressions table;
  revisit that rule only for panes this call created).
- [ ] Truncated detached result: the Phase 3 worker was delivered as
  "Now the test file imports." (an intermediate assistant message) instead of
  its final report. Possibly a consequence of the state-file wipe above, not
  verified. Reproduce before fixing.

## Out of scope

- Splitting or rewriting test files.
- Changing any model-facing text, schema, `details` keys or Herdr argv.
- Moving the `state.ts` test failure hooks out of production code.
