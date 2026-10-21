# Fix: answering a parked question re-delivers the question and swallows the result

## Evidence (live, 2026-10-21)

Live smoke run: `agent_spawn scout` named `SmokeQuestion`, child asked once, the
question was delivered, `agent_send` answered it with `LIVE_ANSWER_20261021`.
Result: the same question was delivered a second time, the child's final answer
never reached the Orchestrator, and `agent_status` reported the run as already
collected.

Collected facts:

- Orchestrator session
  `~/.pi/agent/sessions/.../2026-10-21T14-08-59-221Z_01a15ecb-...jsonl`:
  - `15:37:44.631` `agent_question` "Which token should I return…" (first
    delivery).
  - `15:37:58.183` `agent_send { name: "SmokeQuestion", message: "Return exact
    token LIVE_ANSWER_20261021…" }`.
  - `15:37:58.748` tool result "Answer sent to agent SmokeQuestion".
  - `15:37:58.750` the **same** `agent_question` delivered again.
  - No `agent_result` for `SmokeQuestion` after that point.
  - `15:38:06.361` a later `agent_send` was refused with "did not take the
    message: it is not in an active run…".
- State record `terminal:term_65e5b8619a4432ee`:
  `collected: true`, no `detached`, `updatedAt: 2026-10-21T15:37:58.218Z`.
- Child artifacts `/var/folders/.../herdr-agent-GLfwGQ/`: `result.md` holds
  `LIVE_ANSWER_20261021` + `AGENT_RESULT: done`; `question.md` is gone; no
  `interrupted` marker. So the child never re-asked, and the answer did reach it.
- Pane `w87:p19` is still open, so the one-shot was never closed.

`claimDetachedAgent` sets `collected = true` and deletes `detached` without
touching `updatedAt`, so the record's `updatedAt` (`15:37:58.218Z`) is the last
`recordAgentLifecycle` write — the answer tool's own, ~0.5 s before it returned.
The claim that produced the second question message therefore happened after
that write.

## Root cause

`runAgentTask` (answer mode) writes the lifecycle record before it clears the
previous turn's artifacts:

1. `startAndRecordAgent` → `recordAgentLifecycle({ detached: true, … })`, which
   clears `collected` and re-arms delivery.
2. `runAgentTurn` → `clearAgentResult`, `clearAgentQuestion`, then the prompt.

Between 1 and 2 the state says "this child's outcome is pending", the child is
still parked (`idle`, so `isSettledAgentStatus` passes), and `question.md` from
the previous turn is still on disk. Any poller tick that loads its state snapshot
in that window reads the stale question, claims the run and delivers the question
again. The claim marks `collected` and drops `detached`, so the real answer that
arrives later is never delivered (the poller skips the agent: `!agent.detached`),
the one-shot is never closed, and no closed-history record is written.

The same window exists for `result.md`: a stale result could be delivered and the
pane closed before the answer prompt is sent.

Confirmed by the regression test below: with the artifacts cleared only after the
lifecycle write, a poller tick inside the held window claims the run for the stale
question (`collected: true`, `detached` gone), delivers the question a second
time, and the result that follows is never delivered, so the one-shot stays open
and nothing is archived.

## Fix

Clear both artifacts *before* the lifecycle write that re-arms delivery, in
`runAgentTask`'s preparation step immediately before `startAndRecordAgent`.

The tick's decision to look at an agent comes from one state read; the question
read happens strictly after it in program order. Once the clear precedes the
`detached` write, any snapshot that sees `detached: true` necessarily reads the
artifacts after they were cleared, so a stale artifact can no longer be claimed.
Exactly-once is unchanged: the claim is still the single locked read-modify-write,
and question-before-result ordering in the poller is untouched.

Implemented in `src/tool/spawn/flow.ts` (`prepareSpawnTarget`, guarded by
`invocation.task !== undefined`); the clears moved out of `runAgentTurn` in
`src/tool/spawn/lifecycle.ts`. The window cannot reopen without a second poller
in another process, which the control transport already documents as unsupported.

## Regression test

`test/integration-questions.test.ts`: park a one-shot on a question, answer it
while a FakeHerdr `layout.export` call holds the answer path inside the window
(between the lifecycle write and the prompt), and assert that the only outcome
for the label is the final answer, delivered once, with the pane closed and the
run archived. On the unfixed code this fails: a second `agent_question` arrives
and no result is ever delivered.

The second pane-layout agent exists only because the answer path rebalances the
layout between the two steps, and `FakeHerdr.holdApi` (new, mirroring
`holdCommand`) holds `layout.export` to pin that window; the test then waits for
the `agent get` a poller pass issues against the re-armed record, so no fixed
sleep stands in for the tick.

Evidence:

- Red without the fix: `the answered question must not be delivered again`
  (a second `agent_question` for `Scout` inside the held window).
- Green with the fix: one `agent_result`, the pane closed, the run archived, and
  no question after the first.
- `typecheck`, `lint`, 324 unit, 188 integration, 19 e2e all pass.
