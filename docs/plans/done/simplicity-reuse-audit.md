# Simplicity and reuse audit of `src/`

## Context

Requested audit: find redundant types (ones that can derive from each other),
utility functions that can be deleted or merged, and general simplicity /
reuse problems. `src/` is 6,389 lines; `tool/execute.ts` (1,180) and
`state/store.ts` (926) hold a third of it.

Hard constraint: no observable behavior change. The contract layer
(`test/contract.test.ts`, `test/schema.test.ts`) pins `details` keys, Herdr
argv, error texts, and state-file degradation, so it must stay green without
edits. Unit tests that import a helper we delete or rename need updating.

`docs/plans/done/always-detached-agents.md` is done (`e4fe500`). Do not open it.
It already deleted the blocking collection path. One pending plan still overlaps:

- `docs/plans/typebox-json-parsing.md` covers every `JSON.parse` + `typeof`
  chain (`copyAgentRecords`, `parseClosedHistory`, `parseAgentGetOutput`,
  `parseWorkspaceListOutput`, `readAgentSessionMeta`, the `tab create` /
  `pane split` parsing). This plan does **not** touch those parsers.

**Decided order:** this audit (full list), then TypeBox. Line numbers and copy
counts below describe the code before always-detached. Before each step,
re-check its findings against the current tree and drop the ones that no
longer exist. Items marked **[post-detached]** are expected to shrink or vanish.

Findings are ranked by lines saved and risk. Line numbers are approximate.

## Findings

### A. State store (`src/state/store.ts`, `src/state/closed-history.ts`)

A1. **Load-mutate-save boilerplate, 11 copies.** Every mutation repeats
`withStateFileLock(filePath, async () => { throwIfInjectedMutation(k);
const state = await loadHerdrAgentsState(filePath); signal?.throwIfAborted();
…; await saveHerdrAgentsState(state, filePath); }, signal)`.
Sites: `persistPrunedAgentsState`, `recordAgentLifecycle`,
`clearAgentSpawnWarnings`, `deleteAgentLifecycle`, `claimCollection`,
`archiveClosedOneShot`, `stageClosedOneShot`, `finalizeStagedClosedOneShot`,
`claimClosedHistory`, `releaseClosedHistory`, `markClosedHistoryInvalid`.
Add one private `mutateState(fn, { filePath, signal, inject })` in `store.ts`
where `fn(state)` returns `{ save: boolean, value }` (or `false` to skip the
save). About 80 lines.

A2. **`archiveClosedOneShot` and `stageClosedOneShot` build the same
record.** Same "find existing by id, else by owner+label" lookup, same
15-field literal, same prepend-and-dedupe. Only `status` and the live-record
link differ. Extract `upsertHistoryRecord(state, input, status)`.
`archiveClosedOneShot` has no `src/` caller (tests only). **Decided:** delete
it and move `test/state.test.ts` to `stageClosedOneShot` +
`finalizeStagedClosedOneShot` (seed a live record first, since stage requires
one). After deletion only `stageClosedOneShot` builds records, so the shared
helper may be unnecessary; inline it if so.

A3. **`loadHerdrAgentsState` has three equal branches.** The v1 migration,
the "agents missing" branch, and the normal branch all end in
`parseClosedHistory → reconcile → prune`. `parseClosedHistory(undefined)`
already returns `[]`, so `migrateV1ToV2` and the early branch collapse into
the main path: `copyAgentRecords` guards non-objects itself. About 20 lines.

A4. **`pruneClosedHistory` repeats the pinned/rest split twice** and the
`status === 'claimed' || status === 'staged'` predicate 4 times. Add
`isPinned(record)` and `capKeepingPinned(list, max)`. About 15 lines.

A5. **Dead aliases and exports.**
- `withHerdrAgentsStateLock` is a pure alias of `withStateFileLock`, used only
  in `test/state.test.ts`. Delete; tests import `withStateFileLock`.
- `runWithExclusiveLock` has one caller: inline it.
- `releaseExclusiveLock` and `abandonPartialLock` differ only in whether a
  failed `unlink` skips the `rmdir`. Keep one.
- Unexport (no outside user): `DEFAULT_STATE_LOCK_WAIT_MS`,
  `DEFAULT_CLOSED_CLAIM_LEASE_MS`, `getStateLockWaitMs`,
  `getClosedClaimLeaseMs`, `ClosedHistoryStatus`, `StateMutationKind`,
  `ClaimClosedHistoryResult`, `ArchiveClosedOneShotInput`.

A6. **`persistPrunedAgentsState` positional args.** Callers pass
`(panes, undefined, undefined, signal, agents)` 8 times. Change to
`persistPrunedAgentsState(snapshot: { panes; agents? }, opts?: { signal;
filePath; serverSocketPath })`. See B1 for the bigger fix.

A7. **`recordAgentLifecycle` metadata type is a hand-copied subset** of
`HerdrAgentStateRecord`. Use
`Partial<Omit<HerdrAgentStateRecord, 'lifecycle' | 'paneId' | 'collected' |
'updatedAt'>>`. The five "keep existing if metadata omits it" spreads become
one loop over `['ownerPaneId', 'ownerTerminalId', 'ownerSessionId',
'ownerSessionFile', 'closedHistoryId', 'closedHistoryGeneration']`.

A8. **Server-socket ownership check written 3 times**
(`record.serverSocketPath && record.serverSocketPath !== process.env.HERDR_SOCKET_PATH`
in `isAgentOwnedBy`, `claimCollection`, `pruneHerdrAgentsState`) and the
"live pi agent with this automation name" predicate twice (`store.ts`
`pruneHerdrAgentsState`, `placement.ts` `findUnresolvedOwnedAgent`). One
helper each in `store.ts`.

### B. Context + state loading (cross-module)

B1. **"Snapshot, then prune state" sequence copied 8 times.**
`getCurrentContext(signal)` followed by
`bestEffort(emptyHerdrAgentsState(), () => persistPrunedAgentsState(current.panes, …, current.agents))`
appears in `execute.ts` (twice: `resolveAgentPlacement` **and** again in
`claimClosedHistoryForResume`), `rewait.ts`, `poller.ts` (`loadCurrentAgents`
and `loadAgentsForWidget`, which differ only by the signal),
`one-shot.ts` (`rebalanceCurrentPaneAgents`, `refreshAgentLifecyclePane`).
Add `loadContextWithState(signal?)` next to `persistPrunedAgentsState`.
Merge `loadCurrentAgents` and `loadAgentsForWidget` into one function with an
optional signal. `claimClosedHistoryForResume` reuses `placement.state`
instead of pruning a second time.

### C. Artifacts and file IO (`src/artifacts.ts`)

C1. **ENOENT-tolerant read written 6 times** (`readAgentQuestion`,
`readAgentResult`, `readAgentSessionMeta`, `loadHerdrAgentsState`, …).
`readAgentQuestion` and `readAgentResult` are identical except for the path.
Add `readTrimmedIfExists(path)`.

C2. **Private 0600 write with `mkdir -p` written 4 times**
(`writeAgentSessionMeta`, `writeAgentQuestion`, `writeAgentResult`,
`createAgentTempFiles`). Add `writePrivateFile(path, text)`.

C3. **`questionFileFor` and `sessionMetaFileFor` are the same function** with a
different file name. One `siblingArtifact(resultFile, name)`; keep the two
names as one-liners only if tests need them.

C4. **`createResultFile` duplicates the `mkdtemp` of `createAgentTempFiles`.**
Share one `makeAgentTempDir()`.

C5. Unexport `isManagedResultFile`, `isManagedSessionMetaFile`,
`SESSION_META_FILE_NAME`, `ChildSessionMeta`, `PiSessionHeader` (no
outside user). `assertResumableSessionDir` returns an error string, not an
assertion: rename `resumableSessionDirError`.

### D. Tool layer (`src/tool/execute.ts`, `rewait.ts`, `one-shot.ts`, `ui/poller.ts`)

D1. **Tool result literal copied ~30 times.**
`{ content: [{ type: 'text', text }], details, isError: true }` in
`execute.ts`, `rewait.ts`, `child.ts`. Add `textResult(text, details,
isError?)` in `tool/one-shot.ts` (or a new `tool/result.ts`). About 150 lines.

D2. **[post-detached] Settled-turn collection exists 3 times.** `collectSettledTurn`
(`execute.ts`), the wait branch of `executeRewait`, and
`deliverDetachedOutcomes` all do: refresh pane → read question/result →
claim → (question: keep open) / (result: `closeOneShot`) → format with spawn
warnings → `dropCollectedSpawnWarnings`. Extract
`collectSettledAgent(target)` returning
`{ kind: 'claimed-elsewhere' } | { kind: 'question', question } |
{ kind: 'result', text, closed, closeError }` and let each caller map it to
its own `details`. After always-detached only the poller copy should remain:
then skip the extraction and only check that the remaining collector reuses
`closeOneShot` / the spawn-warning helpers.

D3. **[post-detached] Wait wrapper and interrupt result copied twice.** `herdr:blocked`
emit + `beginAwaitingAgent` / `endAwaitingAgent` in `try/finally`, and the
`isRecoverableWaitInterrupt` → `formatWaitInterrupted` result, appear in both
`runAgentTurn` and `executeRewait`. Add `withAwaitedAgent(pi, label, fn)` and
`interruptedResult(label, error, warnings, details)`. Expected to vanish with
the blocking path; also check whether `beginAwaitingAgent` /
`awaitedAgentLabels` in `poller.ts` still have a writer and delete them if not.

D4. **Common `details` block copied 5 times** in `execute.ts`:
`{ tabId, paneId, tabLabel, reused, ...resumedDetails(resumed), agent,
...spawnWarningDetails(warnings) }`. One local `turnDetails(spawn, target)`.
`resumedDetails` then becomes local to `execute.ts`; today it lives in
`rewait.ts`, which never uses it.

D5. **`claimClosedHistoryForResume` duplicates `claimClosedHistory`'s
checks** ("already being resumed", profile mismatch, "no closed one-shot")
with the same texts. Keep only the pre-claim session-file validation; let
`claimClosedHistory` report the rest. Must keep the exact error texts, which
it already returns.

D6. **Small duplicates.**
- Close argv `layout === 'pane' ? ['pane','close',paneId] : ['tab','close',tabId]`
  in `execute.ts` catch and `closeOneShot`. One `closeTargetArgs()`.
- "Could not identify Herdr tab or pane" check runs twice
  (`prepareSpawnTarget` end and `runAgentTask`). Return the ids from
  `prepareSpawnTarget` instead.
- `formatCollectedOutput` (`one-shot.ts`) only composes two `utils.ts`
  formatters. Fold `formatAgentOutput` + `formatSpawnWarnings` into it in
  `utils.ts`.
- `orchestratorIdentity` returns `{ sessionId, sessionFile }`, then
  `execute.ts` renames both to `ownerSessionId` / `ownerSessionFile` with
  conditional spreads. Return the owner field names directly and spread.
- `bestEffort` lives in `one-shot.ts` but is used everywhere: move to
  `utils.ts` (also fixes the odd `export // comment` placement).
- `acquirePanePlacementLock` (`one-shot.ts`) and `stateFileQueues`
  (`store.ts`) are the same promise-chain mutex. Optional: one
  `createSerialQueue()` in `utils.ts`.

### E. Herdr wrappers (`src/herdr/*`)

E1. **`delay` (`cli.ts`) re-implements `setTimeout` from
`node:timers/promises`**, which `store.ts` already uses. Replace it.
Risk: rejection changes from `Error('Aborted')` to an `AbortError`;
`isRecoverableWaitInterrupt` accepts both, but check the contract tests that
match message text.

E2. **`idle || done` written 4 times** (`widget.ts`, `manager.ts`,
`agent.ts` twice). Move `isSettledAgentStatus` to `herdr/agent.ts` and use it
everywhere.

E3. **Workspace label lookup written 3 times** in `snapshot.ts`.
`resolveAgentsWorkspace` should call the existing `findAgentsWorkspaceId`.

E4. **`findReusableAgentTab` parses `terminal:` back out of the state key**,
the inverse of `paneStateKey`. Match with
`context.panes.find((pane) => paneStateKey(pane) === key)`.

E5. **Misplaced or test-only builders.** `buildAgentFinishedNotificationArgs`
lives in `snapshot.ts` but is only used by the poller: move it there.
`buildAgentRenameArgs` / `buildAgentPromptArgs` are one-line array literals
exported for tests that the contract layer already pins via argv: inline.
Unexport `listWorkspaces`, `getAgentSnapshot`, `choosePaneForTab`,
`HerdrAgentSnapshot`, `PortableLayoutNode`, `SplitRatioUpdate`.

E6. `HerdrCliError` args `['agent','prompt',target,'<prompt>']` built 2 times
in `agent.ts`. Leave unless D/E work touches that code.

### F. Types (`src/types.ts` and local interfaces)

F1. **`HerdrAgentInfo` repeats 12 fields of `HerdrAgentStateRecord`.**
Define it as
`Pick<HerdrAgentStateRecord, 'automationName' | 'resultFile' | 'spawnWarnings'
| 'detached' | 'ownerSessionId' | 'ownerSessionFile' | 'closedHistoryId' |
'closedHistoryGeneration' | 'updatedAt'> & { tabId; tabLabel; paneId; agent;
status; lifecycle?: 'oneshot'; layout?; cwd?; terminalId? }`.
`listManagedWorkspaceAgents` then spreads a picked record instead of 9
conditional spreads. Requires moving `HerdrAgentStateRecord` into
`types.ts` (or importing it from `store.ts`).

F2. **`HerdrContext` repeats `HerdrSessionSnapshot`.** Use
`Pick<HerdrSessionSnapshot, 'panes' | 'agents'> & { currentPane }`.
`workspaceId` and `currentTab` only mirror `currentPane.workspace_id` /
`tab_id`; dropping them touches ~35 sites. Recommend keeping them (churn > gain).

F3. **Unused fields.** `HerdrSessionSnapshot.protocol`, `version`,
`focused_tab_id`, `focused_workspace_id`; `TabInfo.focused`,
`TabInfo.agent_status`; `WorkspaceInfo.focused` (parsed, never read). Delete.
`SystemPromptMode` is used once: inline it.

F4. **Layout validation twice:** `normalizeLayout` (`config.ts`) and
`isLayout` (`store.ts`). Export one `isHerdrAgentLayout` from `types.ts`.
`getHerdrAgentsLayout` re-normalizes a config that `loadHerdrAgentsConfig`
already normalized: reduce to `config.layout ?? DEFAULT`.

F5. **Agent-get snapshot types.** `StartedAgentSnapshot`, `ParsedAgentGet`,
`HerdrAgentSnapshot` describe one response. Defer to the TypeBox plan.

F6. **`ArchiveClosedOneShotInput`** is a subset of
`ClosedAgentHistoryRecord`: `Pick<…> & { id?: string }`.

F7. `manager.ts` `AgentMenuAction` vs the inline `{ action; tabId }` custom
result: share the `action` union.

### G. Utilities (`src/utils.ts`) and misc

G1. **[post-detached] `isRecoverableWaitInterrupt` and `waitInterruptReason`
inspect the same codes and messages.** If always-detached removed their
callers, delete both plus `formatWaitInterrupted`. Merge into
`waitInterruptReason(error): 'aborted' | 'timeout' | 'connection' | undefined`
(`undefined` = not recoverable). Callers do one call instead of two.

G2. **`errorMessage(error)` written inline 12 times**; `one-shot.ts` already
has a private copy. Export it from `utils.ts` and reuse.

G3. **`normalizeTools`** lives in `utils.ts` but only `agents.ts` uses it:
move it.

G4. **Agent name list copied 3 times**: `run.ts` `DEFAULT_AGENT_NAMES`,
`index.ts` `/run` completions, and prose in `prompts.ts`. Export the
`run.ts` constant and use it in `index.ts` completions (prose stays).

G5. `manager.ts` close branch has a stray `{ … }` block and a redundant
`continue`; status colours duplicate `agentStatusView` tones. Cosmetic.

## Out of scope

- JSON parsing / validation rewrites (TypeBox plan).
- Removing the blocking path (always-detached plan, lands before this one).
- Splitting `execute.ts` into more files: the helpers above shrink it enough.

## Steps

Prerequisite: `always-detached-agents` is merged. Order: low-risk mechanical
first, one commit per step, `npm test` green after each. Every step starts by
re-checking its findings against the current tree.

- [x] 1. Types and dead code: F3, F4, F6, A5, C5, E5 unexports.
- [x] 2. `utils.ts`: G1, G2, G3, G4, move `bestEffort`, fold
      `formatCollectedOutput` (D6), E1, E2.
- [x] 3. Artifacts IO: C1–C4.
- [x] 4. Store: A1, A3, A4, A7, A8, then A2.
- [x] 5. Context loading: A6 + B1.
- [x] 6. Tool results: D1, D4, D5, D6 rest, E3, E4.
- [x] 7. Leftovers from the blocking path: D3, D2, G1 — delete what lost its
      callers, extract only what still has 2+ copies.
- [x] 8. F1 (`HerdrAgentInfo` from the state record).

## Verification

- `npm run typecheck`
- Fast subset while iterating:
  `npx vitest run --project unit --exclude test/integration.test.ts --exclude test/contract.test.ts`
- Full `npm test` before each commit. `contract.test.ts` and `schema.test.ts`
  must pass **without edits**; only unit tests that import removed or renamed
  helpers change.
- Rolldown bundle check from `AGENTS.md`.
- `npm run test:e2e` once after steps 5 and 7 (they touch spawn/collect flow).
- Report `wc -l src/**/*.ts` before and after.

## Result

All eight steps landed as one commit each (`c9f5924`…`b8b9ab7`). `src/` went
from 5,725 to 5,506 lines; `execute.ts` 983 → 879, `store.ts` 902 → 838.
`npm test` (unit + integration + contract, 289 tests) is green after every
step; `contract.test.ts` and `schema.test.ts` were not edited. Rolldown bundles.

Already done by `always-detached-agents` before this plan started: F3, F4, F6,
C5, most of A5/E5, and all of step 7 (D3, D2, G1 had no remaining callers).

Deviations and skipped optional items:

- B1 put `loadContextWithState` in `herdr/snapshot.ts`, not next to
  `persistPrunedAgentsState`: importing `herdr/cli.ts` into `state/store.ts`
  broke the Node strip-only lock subprocesses in `state.test.ts` (TS parameter
  properties are unsupported there).
- D6 `createSerialQueue` was skipped as optional: the two queues stay local,
  their abort semantics differ.
- G5 fixed only the stray block and redundant `continue`; the manager's status
  colours were left alone (they intentionally differ from the widget's tones).
- Follow-up review corrected the B1/D5 resume regressions. An empty placement
  state now fails closed instead of allowing a later claim to bypass validation.
  `claimClosedHistory` rejects claimed/wrong-profile records before session-file
  validation. Validation uses the successfully claimed record and invalidation
  is generation-guarded. Release runs only when that invalidation failed, so a
  successful invalidation clears the claim with no extra state read that could
  mask the missing-session error.
- Follow-up review corrected E1 cancellation compatibility. Both startup retry
  delays still use `node:timers/promises`, but translate cancellation back to
  `Error('Aborted')` rather than exposing `AbortError('The operation was aborted')`.
- Added five integration regressions: placement-state save failure, missing
  sessions on claimed/wrong-profile history, and both invalidation outcomes
  (no release after a successful invalidation, release after a failed one),
  plus two startup delay cancellation tests. Five of them fail against the
  unfixed code — the no-release one rethrows an injected `EACCES` state read
  that used to mask the missing-session error; the invalidation-failed one pins
  the new release branch. Focused resume/startup integration checks passed (30
  tests) plus the 177-test fast subset and `npm run typecheck`. The contract and
  schema tests remain unchanged; `oxlint` reports only the ten pre-existing lint
  errors. Final Orchestrator validation passed: typecheck, all 296 unit/integration/
  contract tests, all 13 E2E tests on rerun, Rolldown bundle, and `git diff --check`.
  The first follow-up E2E run passed 12/13, with the same direct-CLI cold-shell
  `agent_pane_busy` failure; the unchanged full rerun passed 13/13.
- `npm run test:e2e`: 12/13. The direct-CLI cold-shell test failed with
  `agent_pane_busy` again — the documented intermittent external failure in
  `docs/plans/done/src-restructure.md`, unrelated to this extension.
