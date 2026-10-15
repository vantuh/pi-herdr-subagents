# Closed agents in `/herdr-agents`

## Context

`/herdr-agents` (`src/ui/manager.ts`) lists only live managed agents
(`loadCurrentAgents`). Once a one-shot closes, the user cannot see what it did.
Closed one-shots are already archived in state as `closedHistory` records
(`src/state/schema.ts`): `tabLabel`, `profileName`, `childSessionFile`, `cwd`,
`closedAt`, `ownerSessionId`, `status`. Retention: 90 days, 32 per owner
(`src/state/history-policy.ts`).

Goal: the overlay also lists closed agents of the current Orchestrator session;
selecting one reopens it in Herdr through the existing `resumeClosed` spawn
path (same layout, placement, `pi --session <childSessionFile>`), but without
sending a task. The user reads the transcript in the reopened Pi pane/tab and
closes it with `d` as usual, which re-archives it.

## Approach

### Overlay

- Rows: live agents (unchanged) followed by closed agents.
- Closed rows: `state.closedHistory` where `ownerSessionId` is the current
  session id (`orchestratorIdentity(ctx)`), `status === 'resumable'`, and no
  live agent references it (`liveAgentForHistory`). Newest first
  (`historyRecency`). `stageClosedOneShot` already keeps one record per
  owner+label, so no dedup is needed.
- Closed row label: `${tabLabel} (${profileName})`, description
  `closed • <closedAt local time> • <cwd>`.
- `enter` on a closed row: open it (below), then focus it with the existing
  focus code. `d` on a closed row: no-op.
- "No managed Herdr agents" dialog only when both lists are empty.
- Footer hint: `enter focus/open`.

### Opening a closed agent (reuse spawn flow, skip the turn)

`runAgentTask` (`src/tool/spawn/flow.ts`) already does everything for
`resumeClosed`: placement lock, `reuseParkedAgent` label guard,
`claimClosedHistoryForResume` (claim, session-file validation, invalidation),
temp files, tab/pane creation, `startAndRecordAgent` with
`--session <childSessionFile>` and mandatory live record with
`closedHistoryId`/`closedHistoryGeneration`, rollback on failure, rebalancing.
Only `runAgentTurn` (the prompt) must be skipped.

- Make the task optional on `TaskInvocation`: when `task` is absent,
  `runAgentTask` returns after placement and does not call `runAgentTurn`.
- Record the reopened agent with `detached: false`: no outcome is pending, so
  the poller must not treat it as an undelivered run, and the Orchestrator's
  `resumeClosed` on that label gets the existing "still open" rejection.
- New command-side entry (e.g. `openClosedAgent` in `src/tool/spawn/flow.ts` or
  `src/ui/manager.ts`): resolve the profile with `discoverAgents(record.cwd)`
  by `profileName`, read config/layout from the already-loaded
  `configPromise` (pass it to `showHerdrAgentsManager` from `src/index.ts`),
  build `SpawnSettings` with `resumeClosed: true`,
  `baseLabel: record.tabLabel`, `owner: orchestratorIdentity(ctx)`, and call
  `runAgentTask` with `params: { agent, tabLabel, resumeClosed: true }`.
  An error result is shown with `ctx.ui.notify(..., 'error')`.
- `TaskInvocation.ctx` is `ExtensionToolContext`; widen to the type both tool
  and command contexts satisfy if the command context does not fit.

### Lifecycle after open (no new code expected)

- History record stays `claimed` while the live agent references it with the
  matching generation (`reconcileHerdrAgentsState`).
- The child is started fresh, so its `session_start` clears any result
  channel; typing into the reopened pane does not write `result.md`, and the
  poller never delivers or auto-closes it.
- `d` in the overlay: settled + no question passes, `closeOneShot` stages with
  the same `closedHistoryId` and finalizes it as `resumable` again.
- Typing into the reopened Pi does extend the child session; a later
  `resumeClosed` continues from that extended history. Accepted (option A).

## Files to modify

- `src/ui/manager.ts` — closed rows, open action.
- `src/index.ts` — pass `configPromise` to the manager.
- `src/tool/spawn/flow.ts`, `src/tool/spawn/types.ts` — optional task, skip turn.
- `src/tool/spawn/lifecycle.ts` — `detached` only when a task will be sent.
- Possibly a small read helper for owned resumable history next to
  `findOwnedClosedHistory` in `src/state/closed-history.ts`.
- `README.md` (`/herdr-agents` section), `docs/flow.md` / `docs/tool.md` where
  `/herdr-agents` and `resumeClosed` interplay are described.
- Tests: `test/integration-commands.test.ts`.

## Reuse

- `runAgentTask`, `prepareSpawnTarget`, `claimClosedHistoryForResume`,
  `startAndRecordAgent` — `src/tool/spawn/*`
- `findOwnedClosedHistory` pattern, `liveAgentForHistory`, `historyRecency` —
  `src/state/closed-history.ts`, `src/state/history-policy.ts`
- `loadContextWithState` — `src/herdr/snapshot.ts` (state + live agents in one read)
- `orchestratorIdentity` — `src/tool/child-args.ts`
- `discoverAgents` — `src/agents.ts`; `getHerdrAgentsLayout` — `src/config.ts`
- Focus logic and `closeOneShot` already in `src/ui/manager.ts`

## Steps

- [x] Optional task in spawn flow; skip `runAgentTurn`; `detached` only with a task.
- [x] `openClosedAgent` command-side entry building settings from the record.
- [x] Overlay: load owned resumable history, render closed rows, `enter` opens + focuses, `d` ignored.
- [x] Pass `configPromise` from `src/index.ts`.
- [x] Integration tests (`test/integration-commands.test.ts`):
  - closed one-shot appears in the overlay; history of another owner session does not;
  - `enter` on it starts a child with `--session <childSessionFile>`, sends no prompt, records live state with `closedHistoryId` and `detached: false`, history is `claimed`;
  - poller does not deliver or close the reopened agent;
  - `d` on the reopened agent re-archives it as `resumable` under the same id;
  - invalid/missing session file: error notify, record marked `invalid`, no pane left.
- [x] Docs: README + docs.

## Verification

- `npm run typecheck`, `npm run lint`, `npm run test:unit`, `npm run test:integration`
- `npm run test:e2e` (touches spawning and delivery).
- Manual: run a one-shot, let it close, `/herdr-agents` → closed row → `enter`
  shows the child transcript; `d` closes it; `/herdr-agents` lists it again.
