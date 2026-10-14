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
  `index → tool → ui/herdr/state → artifacts/utils/types`.
  `state` never imports `herdr`.
- Tests are not split or rewritten. Update import paths only. Rename a test file
  only when its module is renamed 1:1 (`constants.test.ts` → `prompts.test.ts`).
  `test/state.test.ts` builds child scripts from `'../src/state.ts'` by path
  (lines ~914, ~969, ~1073); update those strings too.
- Each phase ends green and is committed:
  `npm test` + the rolldown bundle check from `AGENTS.md`. Phases 5–7 also run
  `npm run test:e2e`.
- Docs updated in the same phase as the move they describe: `AGENTS.md` Files
  section, `docs/agent-profiles.md`, `docs/tool.md`, `docs/flow.md` source refs.

## Phases

### Phase 1 — prompts and artifacts

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

### Phase 2 — state

- `state.ts` → `state/store.ts` (lines 1–613: records, env, lock, load/save,
  migrate, prune, ownership, lifecycle record ops, `claimDetachedAgent`,
  test failure hooks).
- `state/closed-history.ts` (lines 614–1056: parse/reconcile/prune history,
  archive, stage, finalize, claim, release, invalidate, find).
- `store.ts` exports the lock/load/save primitives `closed-history.ts` needs.
  If `reconcileHerdrAgentsState` / history parsing is called from
  `loadHerdrAgentsState`, keep the call direction `store → closed-history` for
  parsing only and verify no cycle; otherwise move the parser into `store.ts`.
- Update imports: `herdr.ts`, `index.ts`, `test/state.test.ts` (including the
  path strings), `test/herdr.test.ts`, `test/integration.test.ts`,
  `test-support/harness.ts`, `test-support/e2e-harness.ts`.

Done when: no import cycle (`imports.test.ts` green); commit
`refactor: split state into store and closed history`.

### Phase 3 — herdr

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

### Phase 4 — UI out of index

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
  if the dependency forces it; otherwise phase 5 picks them up.
- `index.ts` re-exports the two message type constants only if
  `test/contract.test.ts` cannot be pointed at `ui/renderers.ts`; prefer
  updating the test import.

Done when: `index.ts` has no TUI component imports except via `ui/`; unit + e2e
green; commit `refactor: move widget, poller and manager into ui`.

### Phase 5 — tool helpers out of index

- `schema.ts` → `tool/schema.ts`.
- `tool/child-args.ts`: `herdrChildEnvArgs`, `orchestratorIdentity`,
  `buildChildPiArgs`, plus `buildChildToolAllowlist` / `buildChildToolArgs`
  from `utils.ts`.
- `tool/one-shot.ts`: `bestEffort`, `independentCleanupSignal`, `errorMessage`
  (or `utils.ts` if UI also uses them), `rebalanceCurrentPaneAgents`,
  `closeOneShot`, `stageClosedOneShotIfEligible`, `formatCollectedOutput`,
  `readSettledAgentOutput`, placement lock (`panePlacementQueue`,
  `acquirePanePlacementLock`), timeout constants.
- `tool/rewait.ts`: `executeRewait`, `resumedDetails`, `spawnWarningDetails`,
  `dropCollectedSpawnWarnings`, `resumeClosedLiveDecision`.
- Update imports: `test/schema.test.ts`, `test/pi-contract.test.ts`,
  `docs/agent-profiles.md`.

Done when: `index.ts` holds only wiring, `pendingRunDelegation`, and
`registerHerdrAgentTool` with its inline `execute`; unit + e2e green; commit
`refactor: move tool helpers out of index`.

### Phase 6 — execute out of index

- Move the `execute` body verbatim into `tool/execute.ts` as
  `executeHerdrAgent(pi, params, signal, onUpdate, ctx)`; `registerHerdrAgentTool`
  calls it. Still a pure move.

Done when: `index.ts` is wiring only (target < 300 lines); unit + e2e green;
commit `refactor: move herdr_agent execute into tool module`.

### Phase 7 — split execute into phases (real refactor)

The only phase that changes code shape. Scope is decided after phase 6 by
reading `tool/execute.ts`; candidate seams: resolve profile/config/mode →
resume-closed claim → spawn or reuse target → prompt → wait/collect/detach.
The plan for this phase is written into this file as a revision before coding,
and the diff gets a `reviewer` pass.

Done when: no function in `tool/execute.ts` exceeds ~150 lines; unit + e2e
green; reviewer findings resolved; commit
`refactor: split herdr_agent execute into phases`.

## Out of scope

- Splitting or rewriting test files.
- Changing any model-facing text, schema, `details` keys or Herdr argv.
- Moving the `state.ts` test failure hooks out of production code.
