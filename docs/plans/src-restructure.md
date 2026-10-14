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

### [x] Phase 7 — split execute into phases (real refactor)

Scope after reading the Phase 6 extraction: split `tool/execute.ts` into
private, phase-oriented helpers. Keep the public `executeHerdrAgent` signature
and runtime behavior unchanged. Prefer keeping helpers in the same module;
do not add a generic pipeline, class, configuration, or barrel module.

Implementation outline:

1. Keep profile/mode validation and taskless `executeRewait` dispatch at the
   entry point, then delegate the task-bearing path.
2. Extract placement-context/workspace resolution, live-label rejection and
   parked-question reuse, and closed-history validation/claim into coherent
   helpers. Preserve every early error result and its exact payload.
3. Extract tab creation and pane creation separately, retaining malformed-output
   validation, fallback lookup, unique labels, cwd/env arguments, and ordering.
4. Extract child startup and lifecycle recording. Retain profile rediscovery
   after a closed-history claim, spawn warnings, best-effort ordinary recording,
   mandatory resumed recording, and pane rebalancing.
5. Keep one placement owner responsible for acquiring/releasing the lock and
   partial-resume cleanup. Release workspace placement after the tab is visible
   and known root-shell cleanup completes; retain pane placement through start,
   lifecycle recording, and rebalancing. Every early return releases the lock.
6. Extract prompt/wait orchestration and settled-outcome collection so each
   function stays within approximately 150 lines. Preserve artifact clearing,
   update callbacks, question-before-result ordering, detached results,
   collection claims, one-shot close, interrupt handling, and blocked-label
   cleanup in `finally`.

Use explicit small parameter groups for invocation inputs and the existing
mutable spawn/resume state only where needed across helpers. State updates must
remain visible to the cleanup owner even if a helper throws after acquiring a
claim or creating a target. Do not hide partial progress in a helper's successful
return value. Avoid sprawling generic context objects and unnecessary exports.

Verification: existing tests remain unchanged except necessary import paths;
no schema, model text, `details`, argv, or error-handling behavior changes.
Worker runs full `npm test` and the bundle check. Orchestrator reviews the diff,
runs full `npm test` plus `npm run test:e2e`, checks function sizes, and obtains
an independent review before committing. Follow-up defects, including live
handoff recovery, remain deferred until this phase is complete.

Done when: no function in `tool/execute.ts` exceeds ~150 lines; unit + e2e
green; reviewer findings resolved; commit
`refactor: split herdr_agent execute into phases`.

Completed: `executeHerdrAgent` plus ten private phase helpers in `execute.ts`;
longest function is 119 lines. The placement owner retains partial-resume
cleanup and shared progress; no additional modules or exports were needed.
Orchestrator validation: full `npm test` 291/291, `npm run test:e2e` 11/11,
rolldown bundle, formatting, function-size check, and `git diff --check` passed.
Independent `oracle` review found no blocking behavior changes; two misleading
comments were removed and redundant private-helper JSDoc was trimmed. Tests
were not changed. TypeScript compiler verification remains unavailable in the
repository; two inherited oxlint warning-comment errors remain unchanged.
All main restructure phases are complete; follow-ups below remain deferred.

## Follow-up: recover collection after a Herdr live handoff

Schedule: after the main restructure phases 1–7. Do not mix these behavior
changes into the extraction/refactor commits. Complete the investigation before
choosing a state migration or changing ownership rules.

### Incident and verified evidence

The Phase 6 worker (`worker_14ad9eb5`, label `Phase 6 execute`, pane
`w5D:p3`) continued working after the Orchestrator lost its wait. It did not
hang. Timeline on 2026-10-14 (UTC):

- `16:37:56`: Herdr accepted the task prompt.
- `16:38:50.331`: the Herdr server began a live handoff.
- `16:38:50.762`: the imported server started and the old server exited.
- `16:38:50.818`: the outstanding `agent.wait` request ended with
  `client_disconnected` in the server log.
- `16:38:50.820`: the Orchestrator received
  `herdr agent wait worker_14ad9eb5 --until idle --until done --timeout 600000 failed: Error: Custom { kind: Other, error: EmptyResponse }`.
- `16:38:55`: taskless re-wait with the same label returned
  `No running Herdr agent named "Phase 6 execute" found to re-wait on.`
- `16:51:12`: the worker persisted its final assistant response. Its session
  shows continued edits and tests after the wait failed.
- Subsequent read-only inspection found the named worker alive and idle,
  with its result artifact and session metadata intact, but no live managed
  record in `herdr-agents-state.json`.

Evidence locations:

- Herdr log: `~/.config/herdr/herdr-server.log`, around lines 10198–10216
  at investigation time; use the timestamps above if the log rotates.
- Worker session:
  `~/.pi/agent/sessions/--Users-vantuh-projects-personal-pi-herdr-subagents--/2026-10-14T16-37-53-914Z_01a13b47-0a7a-757e-9eae-7659d86682d9.jsonl`.
- Worker artifacts at investigation time:
  `/var/folders/s6/tp19nj5j46ndywvct64rt9480000gn/T/herdr-agent-WPhYp4/`;
  temporary files may disappear and must not become implementation dependencies.
- Installed client and server were both Herdr `0.9.5` when inspected; do not
  assume the package's documented `0.9.4` target describes this incident.

### Confirmed extension gaps versus unresolved cause

- `src/herdr/agent.ts` delegates waiting to `execHerdr`; a CLI transport error
  rejects before result collection.
- `src/utils.ts:isRecoverableWaitInterrupt` recognizes aborts and timeouts,
  not this `EmptyResponse`. The error escapes `src/tool/execute.ts` and
  `src/tool/rewait.ts` without recovery or an artifact read.
- This invocation used `wait: true`, so its lifecycle had `detached: false`.
  The widget poller does not automatically collect such a result after the
  synchronous waiter disappears. This explains the missing final delivery.
- Label lookup requires managed state and matching ownership in
  `src/herdr/placement.ts`; a visible Pi pane alone is insufficient.
- The exact time and cause of the missing managed record remain unverified.
  Terminal-ID changes during handoff, pruning against a transient snapshot,
  cross-server pruning, or a failed lifecycle save are hypotheses, not findings.
  The first spawn's `agent_pane_busy` is separate from the later wait failure.

### Work sequence after phase 7

1. **Reproduce and identify state loss before modifying identity rules.**
   - Use an isolated Herdr server and test state file, never the live session.
   - Capture the worker and owner terminal IDs, pane/tab IDs, automation name,
     label, lifecycle record, and server/socket identity before and after handoff.
   - Observe the snapshots consumed by pruning and the state writes around the
     disconnect. Determine whether the record was never saved, was deleted, or
     remains present but fails an ownership/lookup predicate.
   - Check whether handoff preserves terminal IDs and whether snapshots can
     temporarily omit live panes. Do not claim either without evidence.
   - Track the server-side interrupted-wait behavior separately if a Herdr fix
     is required; the extension still needs a safe recovery path.

2. **Recover an interrupted wait without duplicating work.**
   - Share the smallest suitable recovery path between initial execution and
     taskless re-wait. Limit recovery to identified wait transport failures;
     do not retry arbitrary CLI mutations or broadly swallow errors.
   - Refresh the known automation target's live status after reconnecting.
     Retry only the read/wait operation with bounded attempts and the original
     abort signal and remaining timeout budget. Never resend the task, spawn a
     replacement, or close a still-working child because a connection failed.
   - Check question before result when collecting, preserving the parked-child
     contract. An existing intermediate result artifact is not proof that the
     turn completed; require authoritative settled/completion evidence.
   - If recovery cannot complete, return an explicit child-preserving recovery
     outcome with actionable target/label guidance rather than only a raw CLI
     error. Keep ordinary cancellation and timeout behavior intentional.

3. **Fix lookup/state continuity according to the reproduced failure.**
   - If identities change, reconcile only against a verified server, agent,
     and owner identity. If pruning is responsible, prevent deletion from the
     demonstrated invalid/transient snapshot. Coordinate with the separate
     cross-server pruning follow-up below.
   - Never adopt an arbitrary same-label pane, weaken ownership checks, or
     resurrect a closed copy over a live child.
   - Preserve enough owned target information for retry/re-wait when the normal
     managed-state path is unavailable. Define any record migration and legacy
     behavior only after confirming which identity fields remain stable.
   - A failed lookup must distinguish inability to identify an owned target
     from evidence that no child exists. Do not encourage duplicate spawns.

4. **Define collection ownership after synchronous recovery is exhausted.**
   - Prefer retaining the synchronous collector while bounded recovery works.
   - If handing off to the TUI poller, explicitly persist the detached claim
     only when no synchronous collector still owns delivery. Non-TUI sessions
     cannot rely on a widget and must retain a usable explicit re-wait path.
   - Keep result/question delivery exactly once, including a race between
     explicit re-wait and poller collection. Close and archive a one-shot only
     after its final outcome is collected; questions keep it open.

### Regression checks and acceptance

- [x] Integration: inject the actual `EmptyResponse` wait failure while the child
  stays live, then recover and collect its eventual final artifact. Assert one
  task prompt and one child start, no premature close, and exactly one result.
- [x] Integration: repeat the failure during taskless re-wait; preserve the same
  target and collect without another prompt.
- [x] Integration: keep an intermediate artifact while the child is working;
  recovery must not deliver it or close the child.
- [x] Integration: child asks a question across reconnect; return the question
  once, leave the child open, and finish when answered by the same label.
- [x] Regression for the verified state-loss cause: handoff identity change,
  transient snapshot, failed save, or another demonstrated condition. Include
  a foreign same-label agent to prove ownership remains enforced.
- [x] Check abort/timeout during reconnect and repeated transport failures:
  bounded work, child retained, and actionable recovery guidance.
- No synchronous-to-poller handoff is needed: the bounded synchronous collector remains responsible. RPC tests have no widget; attached and detached concurrent re-waits share a durable outcome claim with the poller.
- [x] Isolated real-Herdr reproduction: hand off a server while its child is
  working; verify collection, context preservation, and eventual one-shot close.
  Check handoff capability in the installed CLI before using it. Do not update,
  restart, or hand off the user's live server to run this test.
- [x] Run full `npm test`, `npm run test:e2e`, bundle check, and diff review. Independent delegated review was not run because this follow-up explicitly forbids delegation.

Done when: a live handoff cannot silently strand a running or completed owned
worker; interrupted waits remain recoverable without duplicate prompts or
spawns, ownership remains enforced, and results/questions are collected once.

### Follow-up implementation and investigation evidence

Isolated reproduction on installed Herdr 0.9.5, protocol 22, official Pi integration v9:

- Discovered `server.live_handoff` and `ServerLiveHandoffParams` from `herdr api schema --json`. Called this API only on the harness socket with its isolated HOME, Pi directory, state file and artifacts. No update, live-server restart, external configuration edit or production archive repair was performed.
- The original macOS TMPDIR path caused `path must be shorter than SUN_LEN` before handoff. The e2e harness now uses a short `/tmp` root on macOS, preserving per-test isolation and avoiding Herdr's additional handoff socket suffix exceeding the Unix socket limit.
- Before handoff: owner `w1:p1`, terminal `term_65dd15aabb27c1`; child `w1:p2`, terminal `term_65dd15aabf7192`, automation name `scout_741fe2b8`, status `working`. The lifecycle record was saved, stamped with the harness socket, and attached (`detached: false`).
- After handoff: pane/tab IDs, automation name, Pi child session path, and `working` status remained stable. Owner terminal changed to `term_65dd15aea79b51`; child terminal changed to `term_65dd15aea79e52`. `state_change_seq` reset from 2 to 0. The saved state was initially unchanged. Calling the same snapshot-based pruning path then removed the child record. The outstanding wait returned the incident's exact `Error: Custom { kind: Other, error: EmptyResponse }`.
- This confirms terminal-ID replacement followed by pruning as a reproduced state-loss cause, not an assumption. The historical production incident has no captured state-write history, so its exact deletion cannot be proven retrospectively; cross-server pruning and outliving ticks were independently demonstrated risks already fixed above.

Decisions and behavior:

- New records also stamp child `paneId` and `ownerPaneId`. Before pruning, a same-socket snapshot's exact automation name, Pi kind, recorded child pane, live terminal and recorded owner pane permit rekeying the child and owner terminal identities. The owner session stamp and logical label remain unchanged. No visible title or arbitrary same-label pane is adopted; a foreign same-label target regression remains unclaimed.
- A stamped record whose exact automation target remains live but lacks identity metadata is retained, not deleted or adopted. Re-wait and task-bearing calls from its stamped owner session return an explicit diagnostic naming the target and forbidding replacement. Unstamped legacy records retain the scope-pruning behavior defined below. Existing archives are unchanged. Fresh spawn or normal parked-question reuse stamps the new identity fields; no manual historical migration is attempted.
- `waitForAgent` is shared by initial execution and taskless re-wait. Only the reproduced `EmptyResponse` failure retries read/wait: at most three reconnect retries after the initial call, 100ms spacing, one original timeout deadline and the original abort signal. The known named target is read before waiting again. Neither task prompt nor startup is retried by this path; artifacts are read only after Herdr's wait establishes settlement.
- Exhaustion returns `interruptReason: connection` with child-preserving, same-label taskless re-wait guidance. Abort and timeout remain separate. RPC/non-TUI collection remains synchronous and does not depend on the widget.
- Collection refreshes the lifecycle pane after waiting so close/archive uses the reconciled terminal. A durable `collected` outcome claim now serializes both attached and detached collection (including concurrent RPC re-waits); a new lifecycle turn clears it. Initial execution retains the existing best-effort lifecycle-save contract when recording itself failed. Parked questions remain open, can be answered by the original label, and an explicit later re-wait reports their parked status without redelivering the already-claimed outcome.

Validation: failing tests first reproduced cross-handoff pruning, raw wait transport escape, and duplicate attached/detached concurrent re-wait output. Focused tests cover final-versus-intermediate artifacts, question-first reconnect, same-child answer, exhaustion, abort, remaining timeout, foreign labels, and incomplete legacy identity. `npm run typecheck` passed. Final full `npm test`: 312/312 across 16 files. Final `npm run test:e2e`: 12/12, including live handoff, unchanged child session metadata, single model task, owned state continuity, collection and real pane close. The unchanged direct-CLI cold-shell test failed twice earlier with `agent_pane_busy` and passed in the latest full runs; no retries/skips were added to that test and no claim is made that its timing variability was fixed. Bundle and `git diff --check` passed before commit.

Residual limits: recovery intentionally does not retry mutations, arbitrary CLI failures, or prompt-acceptance transport errors. Handoff with missing identity metadata or a server snapshot that transiently omits a live named agent is not proven recoverable by the isolated complete-snapshot reproduction. All Orchestrators sharing state should reload the new extension: an older runtime can still strip additive fields or run its old global pruning algorithm.

## Follow-up: scope state pruning to one Herdr server

Not part of the restructure; tracked here so it is not lost.

The state file (`~/.pi/agent/herdr-agents-state.json`) is shared by every
Orchestrator on the machine, but `pruneHerdrAgentsState` deletes any record
whose terminal is missing from the *current* Herdr server's snapshot. Two Herdr
sessions with different sockets therefore delete each other's live records,
which makes those agents invisible to the poller (no detached delivery, no
close) and to label lookup (re-wait reports no running agent).

- [x] Record `serverSocketPath` from `HERDR_SOCKET_PATH` on new lifecycle records; parse it on reload. Socket path identifies a server endpoint, not a server process generation, so handoff at the same socket retains scope.
- [x] Prune only stamped records belonging to the inspected socket. Legacy records without a stamp retain snapshot-based pruning until restamped; no historical production repair or state-version bump. When socket identity is unavailable, stamped records are preserved. Ownership checks reject foreign stamped records as well.
- [x] Regression: two simulated server snapshots sharing one state file preserve each other's records, then independently prune their own missing children. The test failed before the fix (server A deleted child B). Additional checks cover legacy pruning and foreign ownership.
- Validation: `npm run typecheck` passed; `npm test` passed 300/300 tests across 16 files. Bundle and diff checks recorded below before commit.

## Follow-up: issues found during the restructure

Not part of the restructure; tracked here so they are not lost.

- [x] Tests pruned the live state file through a widget tick that outlived
  `session_shutdown` (`552343d`, bounded wait `e1c4e8e`).
- [x] Cancel the widget tick instead of a timed wait. Previously
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
  Implementation: each extension API instance owns a poller/controller/tick; shutdown aborts before awaiting the actual tick, without a timeout race. Herdr reads, notifications, closing, staging/finalization, warning cleanup, pruning, and both state-lock queues accept cancellation. A cancelled queued mutation never runs after its predecessor releases. File writes already started are awaited, not abandoned. A durable detached claim commits delivery: shutdown cancels new claims and closes, but the tick flushes its already-claimed batch before resolving to avoid losing results.
  Evidence: the held-snapshot regression failed before the fix; after cancellation shutdown finishes while the server response remains held, without pruning, delivery, or restart from a subsequent ensure call. Added exclusive-lock and in-process-queue cancellation regressions. `npm run typecheck` passed; full `npm test` passed 302/302. E2E batching fixture now models a fresh extension reload rather than restarting a shut-down instance.
  `npm run test:e2e`: 10/11 passed; the unchanged direct-CLI cold-shell scenario fails with `agent_pane_busy` on installed Herdr 0.9.5. It bypasses extension startup recovery entirely. This external-server prerequisite blocks a fully green e2e gate; no skip/retry or test weakening was added. All extension-driven e2e scenarios passed. Bundle/diff checks passed before commit.
- [x] Restore `agent_pane_busy` recovery removed in `773a80d`. A new pane may
  exist before its shell reaches the prompt. Retry this pre-launch rejection
  every 100ms for up to 5s, retaining the same pane and automation name, honoring
  abort, and never resubmitting a task. Other startup failures still propagate;
  exhausted retries leave the pane open for inspection. Regression checks cover
  transient busy shells, exhausted retries, and cancellation.
- [x] Keep logical agent labels independent of tab titles. Live testing with
  `herdr-tab-watcher.ts` reproduced a parked question agent's archive changing
  from `ProdQuestionWorker-1757` to `pi`, breaking resume by its original label.
  Re-wait also returned `pi` as its recovery label. Reuse and re-wait now retain
  the managed label, visible titles cannot alias an existing managed identity,
  uniqueness reserves live managed labels, and missing tab IDs resolve by pane
  ID instead of title. Regression checks cover tab/workspace layouts, label
  collisions, and create-time renaming; real-Herdr e2e covers rename, question,
  re-wait, answer, archive, and resume with preserved context. Validation:
  typecheck, 298 unit/integration/contract tests, 11 e2e tests, and bundle passed.
- [ ] Truncated detached result: the Phase 3 worker was delivered as
  "Now the test file imports." (an intermediate assistant message) instead of
  its final report. Possibly a consequence of the state-file wipe above, not
  verified. Reproduce before fixing.

## Out of scope

- Splitting or rewriting test files.
- Changing any model-facing text, schema, `details` keys or Herdr argv.
- Moving the `state.ts` test failure hooks out of production code.
