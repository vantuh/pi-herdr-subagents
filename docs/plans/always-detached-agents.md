# Always-detached `herdr_agent`

## Context

`herdr_agent` currently has two collection paths:

- **Blocking** (`wait: true`, default outside TUI): the tool call waits on
  `herdr agent wait`, collects the result/question itself, emits
  `herdr:blocked`, hides the agent from the widget poller, and returns soft
  re-wait hints on abort/timeout.
- **Detached** (`wait: false`, default in TUI): the tool returns right after
  `herdr agent prompt`; the widget poller (`src/ui/poller.ts`) claims and
  delivers `herdr_agent_result` / `herdr_agent_question` exactly once and closes
  finished one-shots.

Goal: remove `wait` and the blocking path entirely. Every call is detached, the
Orchestrator never blocks on a subagent, and outcomes arrive only as
poller-delivered messages. The package is used only in the terminal (TUI).

## Decisions

1. **Non-TUI sessions (rpc / print / json): `herdr_agent` is rejected.** No
   collector exists there (`ensureAgentsWidget` starts only for
   `ctx.mode === 'tui'`). The tool returns `isError` with a short "requires TUI
   mode" message before any Herdr call.
2. **Taskless call (omit `task`) becomes a read-only status check.** It looks
   up the live agent by `tabLabel` (existing lookup in `rewait.ts`), reads
   `herdr agent get` status and the recent scrollback via `readAgent`, and
   returns them. It never waits, never claims, never collects, never closes, and
   never resurrects a closed agent. Delivery stays the poller's job.
3. **The `detached` state flag stays.** Every new record writes
   `detached: true`; `claimDetachedAgent` keeps exactly-once delivery and old
   records keep loading.
4. **`herdr:blocked` disappears.** It only ever wrapped blocking waits.
5. **`waited`, `interrupted`, `interruptReason` detail keys are dropped.** They
   are constant or unreachable once nothing waits. Remaining details keep their
   current names (`tabId`, `paneId`, `tabLabel`, `reused`, `agent`, resume and
   spawn-warning keys); the status check adds `status` (Herdr agent status).

Known consequence, kept as-is: a detached agent that settles **without** a
result artifact still keeps its claim in the poller (today only a blocking
re-wait could read its scrollback). After this change the status check shows
that scrollback and says the agent finished without a result; the user closes
it via `/herdr-agents`. No automatic scrollback delivery is added.

## Approach

Delete the blocking branches rather than adapting them. `execute.ts` keeps one
path: resolve profile → TUI guard → (no task ? status check : spawn/reuse,
prompt, record `detached: true`, return immediately). `rewait.ts` is rewritten
as the status check (rename to `src/tool/status.ts`). Everything only reachable
from the blocking path is removed together with its unit tests.

## Files to modify

| File | Change |
|---|---|
| `src/tool/schema.ts` | Drop `wait`. Rewrite `task`, `tabLabel`, `resumeClosed` descriptions: omit `task` = status check; no "re-wait". |
| `src/tool/execute.ts` | Drop `wait` / `timeoutMs` / `DEFAULT_WAIT_TIMEOUT_MS`; replace mode selection + `wait:false` rejection (`~188-235`) with a single non-TUI rejection; remove the blocking branch (`~997-1071`: `herdr:blocked`, `beginAwaitingAgent`/`endAwaitingAgent`, interrupt handling) and `collectSettledTurn` (`~1074+`); always record `detached: true`; route taskless calls to the status check. Drop `waited` from all details. Update the `resumeClosed` live-agent rejection text ("working agents must be re-waited" → "check status / wait for delivery"). |
| `src/tool/rewait.ts` → `src/tool/status.ts` | Keep the lookup and the `collected`/parked-question branch; replace the `!wait` / blocking tail (`~195-345`) with: `getAgentSnapshot(target)` + `readAgent(target)`, return status + recent output + spawn warnings. Keep "resumeClosed live-agent decision" helpers that `execute.ts` imports. |
| `src/herdr/agent.ts` | `promptAgent(target, prompt, signal)` without options; remove `waitForAgent`, `waitForPromptAcceptance`, `promptAcceptanceObserved`, `buildAgentWaitArgs` if no other caller remains. Keep `getAgentSnapshot`, `readAgent`. |
| `src/tool/one-shot.ts` | Remove `readSettledAgentOutput`, `formatCollectedOutput`, `refreshAgentLifecyclePane` if unused after the cut (verify with grep). |
| `src/state/store.ts` | Remove `claimAgentCollection` (only blocking callers). Keep `detached`, `claimDetachedAgent`. |
| `src/utils.ts` | Remove `isRecoverableWaitInterrupt`, `waitInterruptReason`, `formatWaitInterrupted`; keep the rest. |
| `src/ui/poller.ts` | Remove `awaitedAgentLabels`, `beginAwaitingAgent`, `endAwaitingAgent` and their use in `updateAgentsWidget`; update comments that mention `wait: true` / re-wait. |
| `src/ui/widget.ts` | `visibleWidgetAgents` loses the awaited-label filter (or is removed if it becomes identity); fix comments referencing the blocking path. |
| `src/prompts.ts` | Rewrite `GLOBAL_INSTRUCTIONS` (see below). `buildRunTurnInstructions` needs no change. |
| `test-support/harness.ts` | `call()` no longer injects `wait: true`; remove `callRaw` or make it an alias; add `collect(label?)` that waits for the next `herdr_agent_result`/`herdr_agent_question` message in `host.messages`. |
| `test-support/fake-herdr.ts` | Drop `agent wait` handling only if no test still needs it. |
| Tests | `test/integration.test.ts`, `test/contract.test.ts`, `test/schema.test.ts`, `test/ui-boundary.test.ts`, `test/prompts.test.ts`, `test/herdr.test.ts`, `test/utils.test.ts`, `e2e/flow.test.ts`. |
| Docs | `README.md`, `AGENTS.md`, `docs/tool.md`, `docs/flow.md`. `docs/plans/session-findings.md` stays as history. |

### New `GLOBAL_INSTRUCTIONS` content (paragraphs 4–6 replaced)

- Every call returns as soon as the prompt is submitted; the result or a
  question is delivered to you as a message once the agent finishes. Do not
  start the delegated work yourself meanwhile; end the turn or do unrelated
  work.
- A question is answered with the same `tabLabel` and `task` set to the answer.
- To see what a live agent is doing, call `herdr_agent` with its `tabLabel` and
  no `task`: it returns its status and recent output and never re-sends work.
  Do not poll it in a loop; delivery is automatic.
- Keep `resumeClosed` guidance; replace "omit task to re-wait" with "check
  status".

## Reuse

- Live-agent lookup: `executeRewait` lookup block (`src/tool/rewait.ts:100-183`) — `findReusableAgentTab`, `findReusableAgentPane`, `findUnresolvedOwnedAgent`, `persistPrunedAgentsState`.
- Status/output: `getAgentSnapshot`, `readAgent` (`src/herdr/agent.ts`).
- Delivery and close: poller `deliverDetachedOutcomes` + `closeOneShot` (unchanged).
- Output formatting: `formatSpawnWarnings`, `spawnWarningDetails`, `formatAgentOutput` (`src/utils.ts`, `src/tool/one-shot.ts`).

## Steps

- [ ] 1. Schema + prompts: drop `wait`, rewrite descriptions and `GLOBAL_INSTRUCTIONS`; update `test/schema.test.ts` (delete the wait-description assertion, add "no `wait` property") and `test/prompts.test.ts`.
- [ ] 2. `execute.ts`: TUI guard, remove mode selection/blocking branch/`collectSettledTurn`, always `detached: true`, drop `waited`.
- [ ] 3. Status check: `rewait.ts` → `status.ts`, read-only status + recent output; wire from `execute.ts`.
- [ ] 4. Dead code sweep: `herdr/agent.ts`, `one-shot.ts`, `store.ts` (`claimAgentCollection`), `utils.ts`, `poller.ts`, `widget.ts`; delete their unit tests in `test/herdr.test.ts`, `test/utils.test.ts`. Confirm with `grep` + `npm run typecheck`.
- [ ] 5. Harness: drop `wait: true` injection, add `collect()`.
- [ ] 6. Integration/contract tests:
  - Convert sync flows to `call` + `collect` (spawn/collect/close, scrollback fallback → status check shows scrollback, question round trip, fast completion, contract details/close-failure/malformed/unusable-state).
  - Delete: blocking-in-headless default, `wait:false` non-TUI rejection, soft re-wait on timeout/abort, EmptyResponse wait recovery, RPC wait/reconnect tests, `herdr:blocked` assertion, "re-wait with wait: false" contract.
  - Add: non-TUI rejection (rpc/print) in `test/ui-boundary.test.ts`; status check returns status + recent output and does not claim/close/prompt (assert no `agent prompt`/`agent wait`/`pane close` argv, record still `detached`); status check on unknown label errors; status on a parked question reports the question.
  - Remove explicit `wait: false` from all remaining calls.
- [ ] 7. E2E: convert sync scenarios in `e2e/flow.test.ts` to await widget delivery; drop `wait: false` from detached ones.
- [ ] 8. Docs: README, AGENTS.md (Purpose bullets, "Important behavior", test coverage lists), `docs/tool.md`, `docs/flow.md`.
- [ ] 9. Commit per concern (e.g. `feat!: make herdr_agent always detached`, `test: ...`, `docs: ...`).

## Verification

```bash
npm run typecheck
npx vitest run --project unit --exclude test/integration.test.ts --exclude test/contract.test.ts
npm test
npm run test:e2e        # spawning/waiting behavior changes
npx rolldown src/index.ts --file /tmp/herdr-agents-check.js --platform node \
  --external @earendil-works/pi-coding-agent,@earendil-works/pi-tui,typebox --no-codeSplitting
grep -rn "wait: true\|wait: false\|params.wait\|herdr:blocked\|re-wait" src test e2e test-support README.md AGENTS.md docs/tool.md docs/flow.md
```

Last grep must return nothing (or only intentional history). Manual check in a
real TUI: `pi -e ./src/index.ts`, delegate a scout, confirm the call returns
immediately, the result message arrives on its own, a taskless call shows
status + output, and `pi -p` rejects `herdr_agent`.
