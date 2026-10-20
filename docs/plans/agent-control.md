# Agent control: steer and interrupt one running child

Status: implementation slices 0–5 done, docs slice 6 open, revision 10. Slice 0
(SDK alignment) is done and the slice 1 gate is resolved: the user accepted the
measured late-delivery race
(option 1 of the [Gate result](#gate-result)). Slice 1's throwaway prototype is
complete — checks 1–5 pass, check 6 is re-scoped to the accepted behavior, and
check 7 is done in slice 4, which is where a real control call exists.
Measurements are recorded under [Prototype
measurements](#prototype-measurements-slice-1-a-throwaway). Slices 2 and 3
landed the transport (`src/control.ts`, `src/control/schema.ts`) and the child
consumer (`src/child/control.ts`, wired from `src/child.ts`). Slice 4 landed the
parent tool (`src/tool/control.ts`), its parent-only registration, the prompt
guidance, the simulated child control consumer and both control suites. Slice 5
landed the real steer/interrupt e2e and the version capture; evidence is under
[Slice 5 progress](#slice-5-progress). Slice 6 (docs) is still open.

Revision 10 changes (slice 5 review): the Pi/SDK version gate now runs before
the harness allocates its temp root, mock LLM or server, because a throwing
harness factory cannot be disposed by `withE2e`. The pre-existing Herdr integration
v9 gate still follows installation into the fixture HOME. A real
question-on-a-steered-continuation scenario was added after the review showed the
plan's "a real child cannot be interrupted while its question is undelivered"
claim to be false (scenario 3); the queued-steer body scan moved after the
completed recovery run; and the status observation is narrowed to the initial live
run, with post-steer transitions left explicitly unmeasured. Details under [Slice
5 progress](#slice-5-progress).

Revision 2 changes: session ownership guard, the double steer guard
(`active && !ctx.isIdle()` adjacent to the call), the synchronous enqueue
correction, a single-remover/id-reserved transport with per-id acks, a
prototype gate that includes a real poller overlap test, conservative interrupt
semantics without a marker-clear recovery path, best-effort (not absolute)
timestamp freshness, a single post-gate consumer strategy, and corrected
continuation instructions for an interrupted live child. Details in
[§15](#15-review-findings-and-their-resolution).

Revision 3 changes: the slice 1 B gate reproduced the marker/collection overlap
and the user accepted it ([Gate result](#gate-result)). `interrupt` therefore
promises only ordinary-path behavior, the acceptance criteria and the interrupt
status texts no longer promise "no result" or "pane stays open" on a race path,
and the two real-poller tests assert the accepted late delivery instead of the
originally intended safety.

Revision 4 changes (prototype review): the vacuous check-7 prototype test was
removed and check 7 is deferred to slice 4; the "marker still on disk" claim is
gone (the close deletes the temp directory, marker included); the latency figures
are labelled as upper bounds quantized by the parent's 25 ms poll; the
freshness, late-ack and shutdown paths the prototype did not exercise are
recorded as slice 3 carry-overs.

Revision 5 changes (slice 3): the child consumer is product code and the
prototype consumer is deleted. Two measured findings change the transport and
the watcher's risk profile: the atomic publish writes its temp file beside the
watched `control/` directory, because a temp file inside it can be coalesced
with the rename into a single event and lose the publish; and `fs.watch` can
lose a publish made inside a freshly installed watcher's startup window, which
the slice 3 tests wait out. Details under [Slice 3
progress](#slice-3-progress).

Revision 7 changes (slice 4): the parent tool is implemented exactly as D2–D11
describe. It first claimed check 7 with a test that only showed non-interference
(a marker written before the control call, removed after it returned, so no
collection ever overlapped the tool); revision 8 replaced that with a forced
overlap. Two implementation corrections
against the earlier slices: the whole publish–wait–clean operation now holds the
per-directory queue (D6 only required the pre-clean inside it), because the
success cleanup outside the queue let a parallel call's pre-clean remove the
acknowledgement of the operation still finishing; and the tool validates ack
action/status compatibility, reporting an acknowledgement that names the other
action's outcome as `unknown` instead of a success. Details under [Slice 4
progress](#slice-4-progress).

Revision 8 changes (parent-tool review): four findings fixed before the slice 4
commit. P1: the cancellation check is repeated after the awaited pre-clean and
before publication, with a gated cancel-during-cleanup test. P1: the gate-7
claim was false — the old test removed the marker *after* the control call
returned, so no collection ever overlapped it. Gate 7 is now a forced overlap in
`test/integration-control.test.ts` using the existing poller read seam. P2: the
simulated control consumer's promises go through the fake's existing `track`
machinery, are fenced on close and drained on `stop()`, with a close-during-
consume regression. P2: a per-child queue entry is removed only when the map
still points at that operation's own tail, so a queued operation is never
bypassed. Evidence and mutation checks under [Slice 4
progress](#slice-4-progress).

Revision 9 changes (slice 5): the e2e harness captures the actual `pi --version`
and the lockfile SDK version, exposes them as `harness.versions` and hard-gates
the run on the pinned `1.3.0`, next to the existing Herdr integration v9 check;
the real steer and real interrupt scenarios exist and pass. One measurement is
worth carrying forward: an `idle` child status was observed mid-run in every
sampled run, which is why the scenario samples status instead of asserting its
absence. Details under [Slice 5 progress](#slice-5-progress).

Revision 6 changes (slice 3 review): shutdown is fenced at every stage that spans
an `await` (watcher install, interrupt marker write) and already-started ack
publishes are drained, each with a deterministic gated test; the temp-file
assertions that the transport move had invalidated now inspect the agent
directory, and a direct ack test pins that a missing control directory is not
recreated; mock fixtures close their watcher through `session_shutdown`; and the
startup-window loss is documented as **reachable** (the spawn tool returns on
prompt submission with no readiness delay), with a separate no-wait regression
test instead of an unreachability claim.

## 1. Goal and agreed scope

Add **one** new Orchestrator tool that acts on a child that is already running:

```
herdr_agent_control {
  tabLabel: string,                       // exact label of a live child owned by this session
  action: 'steer' | 'interrupt',
  message?: string                        // required for steer, rejected for interrupt
}
```

Agreed scope, treated as the contract:

- One new tool. **No** additions or changes to the existing `herdr_agent`
  parameter schema, its results, or its flow.
- Targets only a child this Orchestrator **session** owns (see D2) that is
  **live**. No spawn, no resume, no status check, no close, no
  answer-a-question.
- **One** child-side file transport: a request file the child watches
  (`fs.watch` candidate) and an acknowledgement file the parent waits for.
  No Herdr PTY/`send-keys`/`agent read` fallback, no new dependency, no server,
  no workflow engine, no queue/retry framework, no config key, no overlay, no
  lifecycle locking framework.
- `steer` is guarded by the child's own active-run state **and** by Pi's live
  idle predicate, and is delivered with
  `pi.sendMessage(custom, { deliverAs: 'steer' })` **without** `triggerTurn`.
  A queued acknowledgement is never reported as "applied". Idle refuses.
  Compaction is a documented limitation without recovery.
- `interrupt` calls `ctx.abort()`. The acknowledgement is derived from Pi's
  `agent_settled.aborted` flag. The interrupted-marker / result-append barrier is
  kept, but it is ordinary-path behavior and not a guarantee: the prototype gate
  measured a collection tick already in flight delivering the aborted run's text,
  and the user accepted that race (D5, [Gate result](#gate-result)).
- Request id is echoed in the ack; one outstanding control operation per child;
  a timeout means "outcome unknown" with **no** automatic retry.
- Reuse the existing artifact path guards, the existing owner lookup, and the
  existing state/lifecycle machinery. No new state field, no new Herdr command
  kind, and no control-specific state mutation beyond the discovery/pruning the
  reused helper already performs (D2, §7.4).

Non-goals are listed in [§14](#14-non-goals).

## 2. Facts, proposals, and what is still unverified

Tags: **fact** (read from source or measured, source named), **proposal** (this
plan's design), **verify** (must be proven by the slice that owns it).

### 2.1 Pi 1.3.0 and Herdr facts

Pi runtime is the managed install
`/Users/vantuh/.pi/agent/install/releases/1.3.0/node_modules/@earendil-works/pi-coding-agent`
(`install/current-version` holds `1.3.0`), resolved through the `pi` launcher at
`~/.pi/agent/bin/pi`, not through this repo's `node_modules`. Herdr is
`herdr 0.9.5`.

**Steer path**

- **fact** `sendCustomMessage(message, options)`
  (`dist/core/agent-session.js:1815-1834`) branches in this order:
  `deliverAs: 'nextTurn'`; else `isStreaming && options.triggerTurn !== false` →
  `this.agent.steer(msg)` (or `agent.followUp`); else `options.triggerTurn` →
  start a run; else `isStreaming` → defer to end of turn; else append with no
  run. **The steer branch contains no `await` before `this.agent.steer(...)`,
  so the enqueue happens synchronously inside the call**, even though the
  function is `async` and `ExtensionAPI.sendMessage` returns `void`
  (`dist/core/extensions/types.d.ts:1258`, host wiring in
  `agent-session.js` `_bindExtensionCore`). A `void` public API is not by itself
  an asynchronous enqueue.
- **fact** `get isStreaming()` returns `_isAgentRunActive`
  (`agent-session.js:1053`), true from the start of `_startRun` (before
  `before_agent_start`, `:1391`) until `_emitAgentSettled()` clears it (`:687`).
- **fact** `_emitAgentSettled()` clears `_isAgentRunActive` **before** awaiting
  extension `agent_settled` handlers (`:684-691`). A child-side `active` flag set
  from those events therefore stays true while earlier settle handlers are still
  running, even though Pi is already idle. **Consequence:** `active` alone can
  make the child take Pi's idle append branch and then ack `queued` falsely.
- **fact** `get isIdle()` is `!_isAgentRunActive && !isCompacting`
  (`:1057-1058`, `:1209-1213`): it is also false during a standalone compaction
  or branch summary with no active run. **Consequence:** `!ctx.isIdle()` alone is
  not sufficient either; both checks are needed (D3).
- **fact** The run loop always reaches the settle boundary while the steering
  queue is non-empty: `_runBeforeSettleBoundary()` returns
  `result.continue || this.agent.hasQueuedMessages()` (`:1549`); with no handler
  registered it returns `hasQueuedMessages()` (`:1539`). A steer enqueued inside
  a run is consumed by that run's continuation.
- **fact** An abort breaks the loop before that boundary
  (`:1426`), which is why an aborted run does not run the child's
  `agent_before_settle` handler and the `interrupted` marker written at
  `before_agent_start` survives — the existing invariant in
  [AGENTS.md](../../AGENTS.md) and [flow.md](../flow.md).
- **fact** In TUI mode `ctx.abort()` is bound to
  `restoreQueuedMessagesToEditor({ abort: true })`
  (`dist/modes/interactive/interactive-mode.js:1479`), which calls
  `session.clearQueue()` — dropping queued steering and follow-up messages into
  the child's editor — then `session.abort()` (`:3893`, `:3862`). Escape uses the
  same path (`:2420`). The installed Pi docs state the same rule
  (`docs/how-pi-works.md`, "Agent loop"): "Aborting stops the current run and
  returns queued messages to the editor."
- **fact** `session.abort()` itself does not touch the queues
  (`dist/core/agent-session.js:1942-1952`): the clearing is the TUI binding's, not
  the session's. An in-process `ctx.abort()` therefore stops the run without
  proving that a queued steer was discarded (§9 slice 1 A4).
- **fact** `agent_settled` carries `aborted`, set from `_agentRunAbortRequested`
  (`:689`; `AgentSettledEvent` in `dist/core/extensions/types.d.ts`).
- **fact** `ExtensionContext` contexts are created per handler invocation with
  getters that resolve at call time (`dist/core/extensions/runner.js:609-680`),
  and every access calls `assertActive()`, which throws once the runtime has been
  replaced (`:488-492`). A context captured earlier stays live until a
  reload/replacement, then throws.
- **fact** `ExtensionAPI.sendMessage` is fire-and-forget; an enqueue failure is
  reported as `extension_error`, not to the caller.

**Collection and ownership**

- **fact** `deliverDetachedOutcomes` checks the `interrupted` marker **once**
  (`src/ui/detached-outcomes.ts:138-142`), then reads the result and claims the
  agent (`:146-149`). It never re-reads the marker, and the claim is a state
  mutation, not a file check: a marker write that lands after that read does not
  prevent delivery. The poller and the child's marker writes are not serialized.
- **fact** The question branch runs before the result branch and **does not**
  consult the marker (`src/ui/detached-outcomes.ts:95-110`). An already-written
  `question.md` is delivered regardless of an interrupt.
- **fact** Herdr's Pi integration publishes `idle` from its own `agent_settled`
  handler with `ctx.isIdle() === true`, through an async fire-and-forget send
  (`~/.pi/agent/extensions/herdr-agent-state.ts:201-209`, `:253-259`). Pi awaiting
  extension settle handlers does not mean Herdr waits for another handler's
  marker write.
- **fact** `listManagedWorkspaceAgents` does not enforce session ownership: it
  delegates to `isAgentOwnedBy`, which checks `ownerTerminalId` and the pane's
  tab (`src/herdr/placement.ts:187-195`, `src/state/live-records.ts:41-53`). A
  different Pi session in the same terminal therefore sees the previous session's
  child. `HerdrAgentInfo` does expose `ownerSessionId`.
- **fact** `loadContextWithState` is not read-only: it runs
  `getCurrentContext` and then `persistPrunedAgentsState`
  (`src/herdr/snapshot.ts:207-217`), i.e. Herdr discovery plus state pruning.
- **fact** A task addressed by label to a live child is refused unless the child
  is parked on a question (`src/tool/spawn/continuation.ts:73-88`).
  `/herdr-agents` closes only a settled agent with no parked question
  (`src/ui/manager.ts:243-246`) and stages resumable history through
  `closeOneShot`. So for a live, non-question child the only in-session
  continuation paths are a manual turn in its pane, or close-then-`resumeClosed`.
- **fact** The `1.2.0 → 1.3.0` public extension type surface is unchanged:
  `dist/core/extensions/types.d.ts` is byte-identical between this repo's
  `node_modules` (1.2.0) and the installed 1.3.0 release; the only
  `agent-session.d.ts` delta is two doc comments. Other dist files differ
  (settings, model resolver, prompt templates, renderers).

### 2.2 Probe evidence (`.herdr-steer-idle-evidence/`, untracked, preserved)

13 scenarios against a real isolated Herdr server with real `pi` children and a
simulated parent (`summary.json`). Status sampled every 37–43 ms, 166–287
samples per run. Treat the traces as read-only; do not modify or delete them.

| Case | Shape | Observed |
|---|---|---|
| C1 mid-turn steer | steer while working | queued into the run (`custom_consumed` 7 ms later); the next model request body carries it (`steerInBody=true`); no idle published; delivered after the real settle |
| C2 before-settle steer | steer inside `agent_before_settle` (outcome `completed`) | continuation started 1 ms later; no idle published; delivered after the real settle |
| C3 before-settle steer + 400 ms handler delay | same, widened | same: queued, continuation ran, no idle published |
| C4 idle steer | after `settled` | message appended only; 1 model request; no new run; child stayed idle; normal delivery |
| C5 delay 0/200 ms, C7 natural ×3 | `triggerTurn:true` inside `agent_settled` | idle published at `agent_settled`, next run started 0–2 ms later; the 1 s poller never landed in that window |
| C5 600/1200 ms, C6 800/1500 ms | `triggerTurn:true` + widened await | **premature collection reproduced**: idle published while the settle-boundary handler was still awaiting, marker already cleared at `before_agent_settle outcome=completed`, poller claimed, saved the report and closed the pane before the deferred run; only the first turn's text was delivered |

In C1 the child timeline shows `interrupted:true` while working, cleared at the
first `before_settle outcome=completed`, and set again on the next run — the
marker barrier behaves as designed in these traces.

Evidence limits, stated precisely:

- **fact** The probe's instrumentation code is **not** in the evidence directory.
  `index.json`/`analysis.json` reconstruct the call arguments: the traces record
  only that a steer was sent (`steer-fire`, `steer-sent`). Whether C1/C4 omitted
  `triggerTurn` or passed `false` explicitly cannot be verified from the evidence,
  and the `triggerTurn: true` values for C5/C6/C7 are equally a reconstruction.
- **fact** `summary.json` asserts `pi 1.2.0` for the children. No captured
  `pi --version`, manifest, or install-path output exists in the evidence, so that
  version is the probe author's assertion, not evidence.
- **verify** The 37–43 ms sampling cannot prove the absence of an idle window in
  the natural case; only 3 in-contract cases (C1, C2, C3) were sampled, and the
  natural window measured 0–2 ms in 4 samples.
- **fact** The C5/C6 failures required out-of-contract `triggerTurn:true` at idle.
  They are not evidence that the proposed steer closes a working child too early.
- **fact** The probe never exercised a file transport, and the parent's own
  `ctx.isIdle()`-based delivery was not exercised (mock host).

So: **the file transport, the double guard, the single-remover protocol, and the
poller overlap are untested.** Slice 1 exists to test exactly that.

## 3. User-visible flow

Today a running child can only be waited for, status-checked, or (if parked on a
question) answered.

After this change:

1. A child is running (spawned by `herdr_agent`, or resumed via `resumeClosed`),
   owned by this Orchestrator session.
2. The Orchestrator calls `herdr_agent_control` with the child's exact `tabLabel`:
   - `action: 'steer'`, `message: '<correction>'` — the correction enters the
     child's current run at its next turn boundary. The child's accumulated
     assistant text still arrives later as one normal `herdr_agent_result`.
   - `action: 'interrupt'` — the child's run is aborted and the interrupted
     marker is set. On the ordinary path its partial text is not delivered and the
     child stays open. A collection tick that already passed its marker read can
     still deliver that run's text and close the pane; that race is accepted
     ([Gate result](#gate-result)).
3. The call returns with an exact status (§5.2). `idle` means the child is not in
   a run; `unknown` means no ack arrived and the effect is unknown.
4. Recovery after an interrupt: the child is **live**, and a live child cannot
   take a new `herdr_agent` task (`continuation.ts:73-88`, except when it is
   parked on a question). The Orchestrator therefore either asks the user to
   continue the child manually in its pane, or closes it with `/herdr-agents` and
   continues it with `resumeClosed: true` and the same `tabLabel`. If a collection
   in flight won the race instead, the aborted run's text arrives as a normal
   `herdr_agent_result` and the one-shot pane may already be closed; the
   Orchestrator ignores a result for work it interrupted.
5. The widget, poller, delivery messages and `/herdr-agents` are otherwise
   unchanged.

Control outcomes are returned from the tool call; they are never pushed as
messages. A late ack after a timeout is discarded.

## 4. Decisions

### D1 Transport lives in a `control/` directory beside `result.md`

**(proposal)** `controlDirFor(resultFile) = path.join(dirname(resultFile), 'control')`,
guarded by the existing managed-temp-path rule and the `result.md` basename.

Why: the child already derives `question.md`, `interrupted` and `session.json`
from the single `HERDR_RESULT_FILE:` marker (`src/artifacts.ts:95`
`siblingArtifact`). One marker, one spelling, and `removeAgentTempFiles` removes
the whole directory on close.

Alternatives rejected: a `HERDR_AGENT_CONTROL_DIR` env var (a second path that
must agree with the derived one); top-level control files (mixes transport with
result artifacts); Herdr `send-keys`/`agent read` (out of scope, unproven).

The **child** creates the directory (`mkdir recursive, mode 0o700`) when it first
resolves the result file, because it must exist to be watched; the parent also
`mkdir`s it (idempotent, mode `0o700`) before publishing.

### D2 Target resolution and session ownership

**(proposal)** Reuse the existing lookup, then require session ownership:

```ts
const { context, state } = await loadContextWithState(signal);
const agent = listManagedWorkspaceAgents(context, state)
  .find((item) => item.tabLabel === tabLabel);
if (!agent) → guard error (no live agent with that label)
const ownerSessionId = ctx.sessionManager?.getSessionId()?.trim();
if (!ownerSessionId || agent.ownerSessionId !== ownerSessionId) → guard error
```

The extra check is required because the existing lookup is terminal-scoped, not
session-scoped (`placement.ts:187-195`, `live-records.ts:41-53`): without it a new
Pi session in the same Herdr pane could control the previous session's child.
Missing ownership (no session id, or a legacy record without `ownerSessionId`) is
rejected for this tool. The rule lives in the tool because it is used once; a
shared placement helper is the alternative if it is ever needed twice.

`loadContextWithState` runs Herdr discovery and state pruning
(`snapshot.ts:207-217`). That is reused as-is: this tool adds no Herdr command
kind and no control-specific state mutation.

### D3 Consume-time admission and guard: `active` **and** `!ctx.isIdle()`, adjacent to the call

**(proposal)** The child **admits** a request exactly once, before any guard: it
reads `request.json` (an asynchronous read is allowed), validates the schema and
the managed control directory, returns immediately if the id is already reserved,
and otherwise **reserves the id synchronously — after the read, before any
subsequent `await`**. Duplicate watch callbacks and repeated reads therefore
cannot admit the same request twice.

After admission, the child applies a steer only when all of these hold, evaluated
with **no `await` between the last check and `pi.sendMessage`**:

- **G1** its own `active` flag is true (`agent_start` → true, `agent_settled` →
  false; continuations fire `agent_start` again without an intervening settle, so
  it stays true across continuations — fact, C2 trace);
- **G2** the most recently captured `ExtensionContext.isIdle()` is false.

G1 alone is stale while earlier `agent_settled` handlers run, because Pi clears
`_isAgentRunActive` before emitting them (fact §2.1); without G2 the child could
take Pi's idle append branch and ack `queued` falsely. G2 alone is wrong because
Pi's idle predicate is also false during a standalone compaction with no active
run (fact §2.1); without G1 that state would look controllable. Both are needed,
and the synchronous enqueue (fact §2.1) is what makes the adjacent check sound.

- **G3** best-effort stale-request rejection, evaluated as
  `request.createdAt < runStartedAt` → refuse with `idle`, otherwise accept.
  `runStartedAt` is recorded in `before_agent_start` (which fires once per run and
  not for continuations — fact, C2 trace). The comparison is a heuristic, not run
  identity: an equal-millisecond timestamp or a wall-clock adjustment can make a
  stale request look fresh, in which case it can be applied to the run active at
  consume time (§6 failure matrix).
- Admission is not repeated here: the request was validated and the id reserved in
  the step above, so these guards cannot reject a request by the id it just
  reserved. A request refused by G1–G3 is acked `idle`, and its id stays reserved
  so a re-read cannot re-admit it.

The captured context is the most recent one seen in any handler; values resolve at
call time, and after a runtime replacement it throws (`runner.js:488-492`,
`:609-680`). A throw is treated as a refusal (`idle`), never as success.

**What is not claimed:** no run identity, no guarantee that the steer lands in the
turn the Orchestrator imagined, no guarantee it is read.

### D4 Steer semantics

**(proposal)** After the D3 guard, with no intervening `await`:

```ts
pi.sendMessage(
  { customType: 'herdr_agent_steer', content: message, display: false, details: { requestId: id } },
  { deliverAs: 'steer' },   // never triggerTurn
);
```

then ack `queued`. "Queued" is the strongest truthful claim: `sendMessage` returns
`void`, the enqueue is synchronous but the message enters the provider request only
at the next turn boundary, and an interrupt can drop it (fact §2.1). `display:
false` keeps the child's transcript clean; `details.requestId` makes the child's
session file self-describing.

**Fact** the steer is not captured as child output: `message_end` appends only
`role === 'assistant'` messages (`src/child.ts:83`) and a steered message has
`role: 'custom'`.

### D5 Interrupt semantics: ordinary-path behavior, not a proof

**(proposal)** The child:

1. Re-checks the D3 guard; refuses with `idle` otherwise.
2. Writes the `interrupted` marker (`setAgentResultInterrupted(resultFile, true)`).
3. Calls `ctx.abort()` on the captured context. In the child's real TUI mode that
   clears the steer queue and then calls `session.abort()`; in-process it calls
   `session.abort()` alone, which does not clear queues (fact §2.1, slice 5 for the
   discard assertion).
4. Waits for its own `agent_settled` up to `CONTROL_ABORT_OBSERVE_MS`.
5. Acks `aborted` when that settle carried `aborted === true`, otherwise
   `requested`.

Additionally the child sets the marker in its `agent_settled` handler when
`event.aborted === true`. This covers the one path where the marker was cleared
before the abort landed: an abort arriving while the child's
`agent_before_settle` handler runs clears the marker (outcome `completed`) and
then makes that boundary return `false` (`_abortDuringBeforeSettle`,
`agent-session.js:1547`).

**What is not claimed (reviewer P1).** These two writes make the ordinary paths
safe; they are **not** a proof that an interrupted run's text can never be
delivered as a success:

- the poller reads the marker once and then reads and claims the result without
  serialization (fact §2.1), so a marker write that lands after that read loses;
- Herdr publishes `idle` from its own settle handler asynchronously (fact §2.1),
  so "Pi awaited all settle handlers" does not mean the pane's idle signal waits
  for the child's marker write;
- an already-written `question.md` is delivered regardless of the marker
  (fact §2.1): **an interrupt does not retract a question**.

The prototype gate (slice 1 B, `test/integration-control.test.ts`) exercised
these overlaps with the **real poller**, the real claim and the real close,
including a marker write delayed past the poller's marker read. It delivered the
interrupted partial result as a success and closed the one-shot pane. The user
chose option 1 of the [Gate result](#gate-result) — accept the race.

**Accepted semantics (user decision, option 1):**

- `interrupt` stops the child's work. It does **not** retract a delivery already
  begun, and it does not keep the pane open when that delivery wins.
- The interrupted marker stays best-effort ordinary-path protection. No new state
  field, lock, marker re-check or poller change was authorized; the poller stays
  untouched (D11).
- The Orchestrator ignores a result of work it cancelled.
- Rejected alternatives: a poller/marker guard (scope expansion), and dropping
  `interrupt` from the tool.

**No marker-clear recovery path.** A conservative `requested` outcome is kept
instead of a `already-settled` classification that would clear the marker again:
one status fewer, no second write path, and the accepted cost is that an
interrupt that raced a clean finish leaves a complete-but-undelivered result
blocked until the agent is continued or closed (limitation 5, §6).

### D6 One outstanding operation, one remover, reserved ids, per-id acks

**(proposal)**

- Serialize operations per control directory with an in-process promise queue
  (the pattern in `src/state/lock.ts:24`, minus the lock directory). This is a
  parent-side wait discipline, **not** a reliable queue and **not** a claim about
  the child's completion order.
- The **parent is the sole remover** of the published request and its ack files:
  at op start (inside the queue) it removes `request.json` and every
  `ack.*.json`; on a successful ack it removes `request.json` and
  `ack.<ownId>.json`; on timeout it removes nothing.
- The **child never deletes or rewrites a shared path.** It writes only
  `ack.<id>.json` for the id it consumed.
- The **child admits a request once**: read `request.json`, validate it, reject a
  duplicate id, then reserve the id synchronously — after the asynchronous read,
  before any subsequent `await`. A reserved request is never re-admitted, so
  duplicate watch callbacks and repeated reads cannot apply it twice.
- Per-id acks remove the reviewer's overwrite race: a late ack for an old id can
  never replace a newer operation's ack, because it writes a different file. The
  parent trusts only the ack whose filename id equals the id it published.

Why this closes the reported ordering (reviewer P1): child reads A → parent times
out A and publishes B → A finishes and writes `ack.<A>.json`. B's request file is
never deleted by A's consumer, and B's ack is never overwritten, so B either gets
its own ack or honestly reports `unknown`. A's late application remains "unknown",
which is what the status means.

Accepted limitation: two Orchestrator *processes* on one session can interleave
(last writer wins). Ownership scopes children to one session, so this needs a
second Pi window on the same session — out of contract, documented, not defended.

### D7 Timeouts: unknown, no retry, late ack discarded

**(proposal)** `CONTROL_STEER_ACK_TIMEOUT_MS = 2000`,
`CONTROL_INTERRUPT_ACK_TIMEOUT_MS = 3000`, ack poll every 25 ms, child
`CONTROL_ABORT_OBSERVE_MS = 2000`. **verified in slice 1 A**: measured ack
latency 27–78 ms (median 54 ms), so the deadlines stay as written; the interrupt
deadline is dominated by the child's own settle observation, not the transport.

On deadline: report `unknown`, leave the request and any ack in place, delete
nothing, never retry automatically. A late ack is discarded by the next
operation's pre-clean; there is no async ack delivery path and no new message
type.

### D8 One consumer strategy, chosen after the gate

**(proposal)** The candidate is `fs.watch` on the control directory, installed
lazily when the child first resolves the result file, re-targeted if the marker's
directory changes, and closed idempotently on `session_shutdown` (Pi's lifecycle
rule: watchers start outside the factory). The parent polls for its ack inside its
bounded wait; a parent-side watcher buys nothing.

The alternative — consuming only at event boundaries (`turn_end`,
`agent_before_settle`) — is a **prototype alternative, not a pre-approved
fallback**. Slice 1 measures the watcher (event loss, ack latency); exactly **one**
strategy ships. Shipping watcher-plus-boundary machinery by default is explicitly
rejected. **Measured in slice 1 A:** every publish was consumed through the
watcher — 9 acks measured across the checks, with no poke or re-read fallback in
the suite, so a missed event would have failed a test — and the watcher is the
strategy.

### D9 Compaction: documented limitation, no recovery

**(proposal)** A steer that lands while an in-run auto-compaction is happening
still takes the steering-queue path (`isStreaming` is true for the whole run) and
the run's continuation consumes it. What Pi then hands the model may be a
post-compaction context in which the steer's referent was summarized, and Pi may
replace a failed response and retry. None of that is detected, reported, or
repaired. No hook into `session_compact`/`session_before_compact` is added.

### D10 Tool surface

**(proposal)** `herdr_agent_control`, `exposure` default (`direct`), registered in
the parent branch of `src/index.ts` only — children cannot steer each other
(`registerChildMode` returns before registration). Statuses, `details` keys and
texts: [§5](#5-behavior-contract).

### D11 The poller, claims and closes are untouched

**(proposal)** A control call never claims, collects, closes, or prompts. The only
interaction with collection is the `interrupted` marker, which
`deliverDetachedOutcomes` already checks. A steer does not create a post-settle
continuation (`triggerTurn` is never used and idle is refused), so the mechanism
that produced the C5/C6 premature collection is absent from this path. This
decision is **conditional** on the slice-1 real-poller overlap check: if it
fails, implementation stops and the user decides (D5). Revising this plan alone
does not authorize weakening the guarantee or expanding scope.

## 5. Behavior contract

### 5.1 Parameters and guards

```ts
Type.Object({
  tabLabel: Type.String({ description: 'Exact label of a live Herdr agent owned by this session. Required.' }),
  action: Type.Union([Type.Literal('steer'), Type.Literal('interrupt')]),
  message: Type.Optional(Type.String({ description: 'Correction to inject at the next turn boundary of the running agent. Required for steer.' })),
})
```

Guards, in order, before any filesystem write:

| # | Condition | Result |
|---|---|---|
| 1 | blank `tabLabel` | error `tabLabel is required.` |
| 2 | `steer` with blank/absent `message` | error `action "steer" requires a non-empty message.` |
| 3 | `interrupt` with non-blank `message` | error `action "interrupt" takes no message; a steer cannot be combined with an interrupt.` |
| 4 | `ctx.mode !== 'tui'` | error `herdr_agent_control requires TUI mode.` (same gate as `herdr_agent`) |
| 5 | no live managed agent with that label | error `No running Herdr agent named "<label>" found for this session. Pass its exact label; do not start a new agent to steer.` |
| 6 | `agent.ownerSessionId !== ctx.sessionManager.getSessionId()` (including missing either side) | error `Herdr agent "<label>" is not owned by this Orchestrator session, so it cannot be controlled.` |
| 7 | record has no managed `resultFile` | error `Herdr agent "<label>" has no control channel recorded. Check its status before retrying.` |

### 5.2 Statuses and texts

`details` is exactly one of:

- guard failure: `{ tabLabel, action }` with `isError: true`
- attempted operation: `{ tabLabel, paneId, action, status, requestId }`,
  `isError` omitted, **including** `status: 'unknown'`.

| action | status | Text (model-facing) |
|---|---|---|
| steer | `queued` | `Steer queued for Herdr agent <label> (<paneId>). It enters the run at its next turn boundary; queuing is not proof the agent has read it. Its answer still arrives with the final result — do not re-send it as a task.` |
| steer | `idle` | `Herdr agent <label> (<paneId>) did not apply the steer: it was not in an active run, or the request was already stale. Check its status with the same tabLabel: answer a parked question with a task, or wait for its result.` |
| steer | `unknown` | `No acknowledgement from Herdr agent <label> (<paneId>) within 2000 ms. The steer may or may not be applied; do not retry it. Check its status before deciding what to send next.` |
| interrupt | `aborted` | `Herdr agent <label> (<paneId>) aborted its run, so no result from that run should normally arrive and the agent stays open. A collection already in flight can still deliver that run's text and close the pane; ignore a result for work you interrupted. A live agent cannot take a new task: continue it manually in its pane, or close it with /herdr-agents and then continue it with resumeClosed and the same tabLabel.` |
| interrupt | `requested` | `Interrupt sent to Herdr agent <label> (<paneId>); the child did not report a settled abort within 2000 ms, so the run may have already finished on its own. On the ordinary path expect no result from that run, but a collection already in flight can still deliver its text; ignore a result for work you interrupted. Check its status, then continue it manually in its pane or close it with /herdr-agents and continue it with resumeClosed.` |
| interrupt | `idle` | `Herdr agent <label> (<paneId>) is not in an active run, so there was nothing to interrupt. Check its status; its result may still arrive.` |
| interrupt | `unknown` | `No acknowledgement from Herdr agent <label> (<paneId>) within 3000 ms. The interrupt may or may not have been applied; do not retry it. Check its status before assuming it stopped.` |

Herdr CLI failures while resolving the target throw, as elsewhere in the
extension; they are not converted into a status. `idle` is one status for both
refusal causes (G1–G3), so its text names both. No text instructs the model to
send a task to a live child.

### 5.3 Transport files and ordering

In `<temp dir>/control/`, all `0600`, published atomically (write
`<name>.<pid>.<random>.tmp`, then `rename`; same protocol as
`saveHerdrAgentsState`, `src/state/store.ts:174`). The temp file is written one
level up, in the agent temp dir, not inside `control/`: a temp file in the
watched directory can have its event coalesced with the rename into one event
that names only the temp file, so the publish is lost (measured in slice 3,
1 in 40):

```jsonc
// request.json — one outstanding request per child
{ "id": "<uuid>", "action": "steer", "message": "<text>", "createdAt": 1792160700675 }

// ack.<uuid>.json — per-id, written only by the child
{ "id": "<uuid>", "action": "steer", "status": "queued", "at": 1792160700681 }
```

Both sides validate with `parseJson` + TypeBox (`src/json.ts`). No version field:
child and parent are the same working copy, and a child that predates this code
writes no ack at all (D7 covers it). The parent accepts only the ack whose
filename id and payload id both equal the request id it published; anything else
is "not yet acked".

Ordering:

- **Parent** (inside the per-dir queue): `mkdir` the control dir (idempotent,
  mode `0o700`) → remove `request.json` and every `ack.*.json` → publish
  `request.json` → poll for `ack.<id>.json` until the deadline → on ack: remove
  `request.json` and `ack.<id>.json` (best effort) → on timeout: remove nothing.
- **Child**: watch event → **admit** (read `request.json` asynchronously,
  validate, return if the id is already reserved, else reserve the id
  synchronously with no `await` after it) → evaluate G1–G3 → apply (D4/D5) → write
  `ack.<id>.json`. It never deletes `request.json` and never rewrites another id's
  ack.
- The child's handled-id set is cleared at `session_start` and `session_shutdown`.
  A consumed request file stays on disk until the next parent operation cleans it;
  re-applying it is prevented by the reservation, and across a child restart by
  the D3 guards (best effort).

### 5.4 Injected instructions

Add to `GLOBAL_INSTRUCTIONS` (`src/prompts.ts`) and to the tool's
`promptSnippet`/`promptGuidelines`:

> Steer a running agent with `herdr_agent_control` (`action: "steer"`) only when a
> correction must reach work already in progress. Do not use it to check progress.
> Interrupt (`action: "interrupt"`) only when the user or a decision requires
> stopping the run. A steer is queued at the next turn boundary and can be dropped
> by an interrupt. If the call reports `idle`, check the agent's status instead of
> sending it a task. Never repeat a control call that reported `unknown`.

## 6. Invariants, order, failures, accepted limitations

Invariants:

1. A control call never spawns, resumes, prompts, claims, collects, closes, or
   deletes a child's result/question artifacts.
2. Only a child whose record `ownerSessionId` equals the calling session id is
   controllable (D2).
3. A steer is applied only with `active === true`, `ctx.isIdle() === false`, no
   intervening await, and (best effort) `createdAt >= runStartedAt` (D3).
4. An aborted run's ordinary paths keep the marker set: before the abort is
   issued, and again on `agent_settled.aborted` (D5). This is not a guarantee:
   the slice-1 real-poller test measured a marker write that loses to a collection
   tick already in flight, and the user accepted that race.
5. An ack is accepted only for the exact published id, from its own per-id file.
6. At most one outstanding control operation per child directory within one Pi
   process; the parent is the sole remover of published request/ack files, and the
   child admits each id once (duplicate rejected, id reserved synchronously after
   the read) (D6).
7. Child processes register no control tool.
8. `/reload` of the parent changes nothing about a live child; a child running
   older extension code writes no ack and is reported `unknown`.

Failure matrix:

| Failure | Behavior |
|---|---|
| child idle / not in a run | ack `idle`; nothing applied; no retry |
| request explicitly stale (`createdAt < runStartedAt`) | ack `idle`; nothing applied |
| timestamp heuristic misses a stale request (equal-millisecond timestamps, wall-clock adjustment) | may be applied to the run active at consume time; documented limitation (G3) |
| ack never written | parent reports `unknown` after the deadline; files left in place |
| ack written after the parent gave up | discarded; cleaned by the next operation |
| malformed/torn request | child ignores it; parent reports `unknown` |
| malformed ack or wrong id | treated as not acked → `unknown` |
| abort not observed within the child's window | ack `requested`; marker stays set |
| `writeFile`/`rename`/`watch` throws | `bestEffort` where the outcome is already unknown; otherwise the error surfaces from the tool call |
| child exits between publish and consume | `unknown` |
| no record for the label | guard error naming the label |

Accepted limitations:

1. No steering an idle child.
2. `queued` is not `applied`; an interrupt can drop a queued steer; no confirmation
   that the model complied.
3. `unknown` may still be applied later; no cancellation, no retry.
4. A steer created in the milliseconds between `before_agent_start` and
   `agent_start` is refused as `idle` (conservative; recoverable by waiting or by
   asking the user).
5. An interrupt that races a clean finish leaves a complete-but-undelivered result
   blocked until the agent is continued manually or closed and resumed; `requested`
   is the honest status.
6. A marker/collection race can deliver an interrupted run's text as a success and
   close its pane; measured in slice 1 B and accepted by the user (D5, D11). The
   Orchestrator ignores a result for work it interrupted.
7. An interrupt does not retract an already-written question.
8. Compaction may invalidate the steer's referent; no detection or recovery (D9).
9. Cross-process contention: last writer wins (D6).
10. A steered answer is not labelled separately in the delivered result.
11. Watch-event loss reports `unknown`: a publish that lands inside a freshly
    installed watcher's startup window was lost in 1 of 20 measurements
    (slice 3), and FSEvents coalescing is a second loss path. The window is
    reachable: the spawn tool returns as soon as Herdr accepts the prompt
    (`promptAgent` never uses `--wait`), so the Orchestrator can call the control
    tool while the child's watcher has only just been installed. A lost event is
    honest `unknown`, never a false ack, and there is no retry, readiness
    handshake or second consumer strategy.
12. Herdr's status can read `idle` at the start of a live run: samples taken
    right after the first provider request, before any steer, saw `idle, working`
    in every e2e run (slice 5) — status publication lags Pi's run start. Nothing
    in the tool consults the status, but a status observation alone is not
    evidence that a child settled. Status transitions after a steer are not
    measured at all.
13. A child running older extension code cannot be controlled.
14. The Orchestrator blocks for up to the ack deadline.

## 7. Approach

### 7.1 `src/control/schema.ts` (new)

`ControlAction`, `ControlRequest`, `ControlStatus`, `ControlAck` as TypeBox values
plus `Static` types. `ControlStatus` is the union of the child-written statuses:
`queued`, `aborted`, `requested`, `idle`.

### 7.2 `src/control.ts` (new)

Transport helpers, no tool or Herdr knowledge:

```ts
controlDirFor(resultFile: string | undefined): string | undefined
writeControlRequest(dir, request): Promise<void>
readControlRequest(dir): Promise<ControlRequest | undefined>
writeControlAck(dir, ack): Promise<void>            // ack.<id>.json
awaitControlAck(dir, id, timeoutMs, signal?): Promise<ControlAck | undefined>
removeControlArtifacts(dir): Promise<void>          // request.json + ack.*.json
withControlDirQueue<T>(dir, fn): Promise<T>         // D6
```

`controlDirFor` needs the managed-result-file guard, currently private in
`src/artifacts.ts:86`: **export `isManagedResultFile`** instead of duplicating the
`result.md` basename literal.

### 7.3 `src/child/control.ts` (new) and `src/child.ts` (wiring)

`registerChildControl(pi, state)` owns the watcher lifecycle, the reserved-id set,
consumption, the D3 decision, `pi.sendMessage` for steer, the marker +
`ctx.abort()` + settle observation for interrupt, and ack writing. `state` is the
child-owned run state it reads:

```ts
interface ChildRunState {
  resultFile?: string;                 // from the HERDR_RESULT_FILE marker
  active: boolean;                     // agent_start .. agent_settled
  runStartedAt: number;                // before_agent_start
  context?: ExtensionContext;          // most recent context seen in any handler
  lastSettle?: { aborted: boolean; at: number };
}
```

`src/child.ts` wires the events it already handles and adds `agent_start`
(active = true, capture context), `agent_settled` (active = false, record
`aborted`, set the marker when `aborted`), the marker-change hook in the existing
`before_agent_start`, and a `session_shutdown` close. `registerChildControl` runs
only under `HERDR_AGENT_CHILD=1`, like `registerChildMode`.

### 7.4 `src/tool/control.ts` (new) and `src/index.ts`

`executeHerdrAgentControl(pi, params, signal, ctx)`:

1. validate parameters (§5.1, guards 1–4);
2. `loadContextWithState(signal)` → `listManagedWorkspaceAgents` → find by exact
   `tabLabel` → **session ownership check** (D2, guards 5–7);
3. `controlDirFor(agent.resultFile)`;
4. `withControlDirQueue(dir, …)`: clean leftovers, publish the request, await its
   ack, map the status to text/details;
5. no new Herdr command kind and no control-specific state mutation: the only
   discovery/pruning is what `loadContextWithState` already does; no claim, no
   close, no prompt.

`src/index.ts` registers the tool next to `herdr_agent` (parent branch only) with
description, `promptSnippet`, `promptGuidelines`, and the parameters from
`src/tool/control.ts`.

### 7.5 SDK alignment (prerequisite slice, §9 slice 0)

`package.json` declares `@earendil-works/pi-coding-agent`,
`@earendil-works/pi-tui` and `typebox` as `peerDependencies: "*"`; npm
auto-installs the peers, so `package-lock.json` pins the whole Pi SDK at **1.2.0**
(`"peer": true`) while the runtime is **1.3.0**. Slice 0 adds exact devDependencies
for the two SDK packages used by the suites, keeps the wildcard peers as the
runtime contract, and rewrites the lock:

```jsonc
"devDependencies": {
  "@earendil-works/pi-coding-agent": "1.3.0",
  "@earendil-works/pi-tui": "1.3.0"
}
```

then `npm install` (not `ci`) plus the full check set. Docs must not claim
alignment before the lockfile and the suites agree.

## 8. Files to modify

| File | Change |
|---|---|
| `src/control/schema.ts` | new: request/ack/status schemas + types |
| `src/control.ts` | new: control dir derivation, atomic publish, per-id ack wait, cleanup, per-dir queue |
| `src/child/control.ts` | new: child watcher, reserved ids, D3 decision, steer/interrupt, ack writing |
| `src/child.ts` | run state, `registerChildControl`, shutdown close |
| `src/tool/control.ts` | new: params, guards (incl. session ownership), execute, statuses, texts |
| `src/index.ts` | register the tool (parent branch) |
| `src/prompts.ts` | control paragraph in `GLOBAL_INSTRUCTIONS` |
| `src/artifacts.ts` | export `isManagedResultFile` |
| `package.json`, `package-lock.json` | slice 0: SDK pinned to 1.3.0 |
| `test/control.test.ts` | new: transport unit tests |
| `test/child-control.test.ts` | new: child consumer tests (mock host, real files) |
| `test/pi-control.test.ts` | new: real in-process Pi behavior (settle window, abort) |
| `test/contract-control.test.ts` | new: integration contract (guards, ownership, `details` keys, exact texts, timeout) |
| `test/integration-control.test.ts` | new: flows + real-poller overlap check |
| `test-support/fake-herdr.ts`, `test-support/fake-herdr/types.ts` | simulated child answers control requests (`ChildOutcome.controlAck`) |
| `test-support/harness.ts` | `callTool(name, …)` reaches the second registered tool; `call`/`callRaw` delegate to it |
| `test-support/e2e-harness.ts` | capture Pi + SDK versions; steer/interrupt helpers |
| `e2e/flow.test.ts` | real steer and real interrupt scenarios |
| `README.md`, `docs/tool.md`, `docs/flow.md`, `AGENTS.md` | tool contract, transport, invariants, continuation guidance |

Untouched on purpose: `src/tool/execute.ts`, `src/tool/schema.ts`,
`src/tool/status.ts`, `src/tool/spawn/*`, `src/ui/*`, `src/state/*`,
`src/herdr/*` (read-only reuse), `docs/plans/done/*` (history).

## 9. Implementation slices with checks

Run `npm run typecheck && npm run lint && npm run test:unit` while iterating; add
`npm run test:integration` before treating a slice as done; `npm run test:e2e` for
slices 1, 3 and 5.

### Slice 0 — prerequisite: SDK alignment

Change `package.json` (§7.5), `npm install`, lock rewritten, docs caveats
(`README.md:40-45`, `AGENTS.md:6-9`, `docs/flow.md:3`) removed in the same commit.

Checks: `npm ls @earendil-works/pi-coding-agent` prints `1.3.0`; `typecheck`,
`lint`, `test:unit`, `test:integration` green;
`test/pi-contract.test.ts` and `test/pi-events.test.ts` now exercise 1.3.0 = the
runtime. Gate: fix any breakage here, never by relaxing types or tests.

#### Progress

Slice 0: **done**.

- `package.json`: added exact devDependencies `@earendil-works/pi-coding-agent`
  `1.3.0` and `@earendil-works/pi-tui` `1.3.0`. Wildcard peers unchanged. Reading
  the installed 1.3.0 `docs/packages.md` ("Declare dependencies"): host-provided
  packages belong in `peerDependencies` with `"*"`, never in `dependencies`, so
  `devDependencies` is the permitted place for a local compile/test pin.
- `npm install` (not `ci`) rewrote `package-lock.json`: `pi-agent-core`,
  `pi-ai`, `pi-codemode`, `pi-coding-agent`, `pi-mcp`, `pi-telemetry`, `pi-tui`
  moved `1.2.0 → 1.3.0`; the `"peer": true` flags on that tree became
  `"dev": true`; the lock root gained `"license": "MIT"`. `npm install` also
  re-resolved 14 transitive `@aws-sdk/*` patch/minor versions inside their existing
  semver ranges (pulled by `pi-ai`); no new top-level dependency.
- Evidence: `npm ls @earendil-works/pi-coding-agent` prints `1.3.0` (and
  `pi-tui@1.3.0` deduped). `diff -rq` of `dist/` for `pi-coding-agent` and
  `pi-tui` between `node_modules` and
  `~/.pi/agent/install/releases/1.3.0/node_modules/@earendil-works/` reports no
  differences, so the test SDK is the runtime SDK. `pi --version` prints `1.3.0`.
  `npm run typecheck`, `npm run lint` (exit 0), `npm run test:unit` (33 files, 289
  tests) and `npm run test:integration` (22 files, 155 tests) pass with no source
  change. An optional `npm run test:e2e` baseline produced no test summary before
  the command timed out after 120 seconds; e2e is not verified (not required for
  slice 0).
- Docs: the version-mismatch caveat was removed from `README.md`, `AGENTS.md` and
  `docs/flow.md`; they now state that the SDK dev dependencies are pinned to
  `1.3.0`.
- Residual: `typebox` stays the root `1.3.37` (peer auto-install) while the SDK
  packages nest `typebox@1.3.27`, as before slice 0; no suite failed on it. Not
  changed (the exact-pin scope covers only the two SDK packages).

### Slice 1 — prototype gate (throwaway, before any product code) — A, 6 and 7 done

Two harnesses, because neither alone is enough.

**A. Real in-process Pi** (`test/pi-control.test.ts`, the `test/pi-events.test.ts`
pattern: real `createAgentSession`, `MockLlm` provider, real files):

1. **Steer accepted in the before-settle window.** Send a request after
   `agent_before_settle` (outcome `completed`) and before the settle: the child
   must apply it (C2-like continuation) and ack `queued`.
2. **Steer refused once Pi has settled, despite a stale `active`.** Hold an
   earlier `agent_settled` handler open (registered before the child's), send the
   request in that window: `active` is still true, but `ctx.isIdle()` is true, so
   the child must refuse with `idle` and append nothing.
3. **Steer into a live run** (no `triggerTurn`): the next provider request body
   contains the steer text; the steer text is absent from the result artifact; the
   ack is `queued`.
4. **Abort after a queued steer** (in-process): queue a steer, request an
   interrupt, assert the `interrupted` marker exists, `agent_settled.aborted ===
   true` was observed, the session becomes idle, and the ack reflects it. The
   test removes the marker the child extension wrote at `before_agent_start`
   before it requests the interrupt, so the surviving marker proves the
   *consumer's* write rather than the extension's. **Do not assert that the
   queued steer was discarded here**: in-process `ctx.abort()` calls
   `session.abort()`, which does not clear the queues (§2.1). The discard is
   asserted in the real-TUI e2e interrupt scenario (slice 5).
5. **Watcher, atomic publish, ack, reservation.** Publish with `tmp + rename`
   while a slow reply holds the run; duplicate watch events and a re-read must
   yield exactly one application and one `ack.<id>.json`; record the ack latency
   distribution (this sets D7's numbers).

**B. Real poller overlap** (`test/integration-control.test.ts` with the existing
integration harness: the real extension, the real per-second poller, the real
claim/close path, and a simulated child that can delay marker writes):

6. **Marker/collection overlap.** A child that settles cleanly while a control
   interrupt is in flight, with the marker write delayed past the poller's marker
   read, is delivered as a success; accepted by the user (option 1). The test
   asserts the measured behavior: the marker read returned ENOENT, then exactly
   one delivery of the aborted run's text, the pane closed and the record pruned.
   The close deletes the temp directory, so a surviving marker file is not part of
   the evidence. A control run with the marker already present before the poller's
   read stays undelivered — that is the ordinary-path protection still in force.
7. **Request vs claim/close — done in slice 4.** The prototype cannot test it:
   the production poller never reads `control/request.json`, so publishing one
   during a collection proves nothing about the control path. The prototype
   variant that did this was removed. The claim belongs to slice 4's
   `contract-control.test.ts`, which has a real control call to assert that it
   claims, collects and closes nothing; see [Slice 4 progress](#slice-4-progress).

**Gate.** Resolved for check 6: it reproduced the overlap, the user accepted the
race (option 1), and the two check-6 tests assert that accepted behavior. Check 7
was not evidence in slice 1; slice 4 passed it. A failure of check 2 (in slice 1
A) or a new failure still stops implementation and goes to the user (D5). If the watcher in check 5 loses events, choose the single
consumer strategy (D8) using the measurement — do not ship both. Record the
measurements in this file.

#### Gate result

**GATE RESOLVED — check 6 reproduced the overlap, the user accepted it
(option 1).**

Measured on the real extension, the real timer-driven poller (started by the
`herdr_agent` call), the real `claimDetachedAgent`, `closeOneShot`, report save
and `pi.sendMessage` delivery against `FakeHerdr`
(`test/integration-control.test.ts`, throwaway). The only seam is a test-only
`vi.spyOn(fs.promises, 'readFile')` that calls the real read, then pauses the
single read made from `src/ui/detached-outcomes.ts` (identified by the call
stack) until the test releases it. Each test asserts the interception hit the
production poller: the recorded read names the consumer, the file, and — for the
marker read — returned ENOENT, i.e. the poller saw the marker as absent.

Command: `npx vitest run --project integration test/integration-control.test.ts`.

| Test | Result |
|---|---|
| marker exists before the poller's read | pass: nothing delivered, pane open, record kept, `result.md` intact |
| 6, marker written **after the poller's marker read** (that read saw absent) | measured: **delivered**; `herdr_agent_result`, pane closed, record pruned |
| 6, marker written **after the poller's result read**, before the claim | measured: **delivered**, same shape |
| 7, request file published mid-collection | **not run in slice 1**: deferred to slice 4, which passed it with a real control call (see [Slice 4 progress](#slice-4-progress)). The prototype variant was removed as vacuous — it published a file the production poller never reads, so it could not fail on a control defect |

Observed delivery (verbatim content of the delivered message):
`Herdr agent Scout (scout) finished on its own:`

`partial text of an interrupted run`

`Full report saved to <agent-dir>/herdr-agents-results/<stamp>-scout-<id>.md`

Cause: `deliverDetachedOutcomes` reads the marker once, then reads the result and
claims, with no re-check; a marker write landing between that read and the claim
does not stop delivery. The child's marker-before-abort ordering therefore does
not protect against a poller tick that already passed its marker read.

**User decision: option 1** — accept the late success delivery racing the
interrupt. `interrupt` stops the child's work but does not retract a delivery
already begun, and the pane may close when that delivery wins. The Orchestrator
ignores a result of work it cancelled. Existing marker behavior stays best-effort
and no new state field, lock or poller change is added. Rejected: a poller/marker
guard (option 2), and dropping `interrupt` (option 3).

Re-scoped tests (asserting the accepted behavior, not suppressed or skipped):
the two check-6 tests assert the marker write happened after the poller's own
read returned ENOENT, exactly one delivery of the aborted run's text, the closed
pane and the pruned record — the close removes the temp directory, marker
included, which is why the surviving marker is not the evidence. The
ordinary-path test (marker present before the read) keeps asserting that nothing
is delivered across several ticks.

Slice 1 A (`test/pi-control.test.ts`) then ran under these semantics; its
measurements are recorded under [Progress](#progress).

#### Prototype measurements (slice 1 A, throwaway)

Historical record of slice 1, before any product control module existed:
`test/pi-control.test.ts` plus `test-support/control-prototype.ts`, real
in-process Pi (`createAgentSession`, real files, MockLlm as the provider), the
real child extension under `HERDR_AGENT_CHILD=1`, and a throwaway consumer that
implemented §7.2/§7.3 as test code. The prototype consumer is deleted in slice 3
and the file now drives the product consumer; the numbers below are slice 1's
and are not re-measured.

| Check | Result |
|---|---|
| 1. steer published inside `agent_before_settle` | pass: ack `queued`; the continuation ran (2 provider requests); the steer text is in request 2; the completed boundary cleared the marker |
| 2. steer after Pi settled with a stale `active` | pass: the guard's recorded decision is `active: true, idle: true` → ack `idle`; no provider request, no application, nothing appended |
| 3. steer into a live run, no `triggerTurn` | pass: ack `queued`; the next provider request carries the steer text; the text is absent from `result.md` (custom role is not appended) |
| 4. interrupt after a queued steer (in-process) | pass: ack `aborted`; `agent_settled.aborted === true`; the `interrupted` marker is on disk; Pi reports idle after the abort |
| 5. atomic publish, watcher, ack, reservation | pass: the watcher consumed the publish, no `.tmp` left behind, one `ack.<id>.json`, and two forced overlapping reads applied the id exactly once |
| 5b (D8) four sequential publishes | pass: all four acked through the watch path, each applied once, one ack file each; 10 duplicate watch reads were rejected by the reservation |

Measured ack latency, publish → `ack.<id>.json`, n = 9 over the checks:
`27, 29, 31, 54, 54, 55, 55, 55, 78` ms (min 27, median 54, max 78). **These are
upper bounds, not a latency distribution**: the parent-side wait polls every
25 ms, so the values are the 25 ms grid plus the watcher and write cost, and they
move between runs (`26…76` in the reviewer's run, `25…56` in a later one; macOS
only, no Linux claim). The figures bound the ack, which is all D7 needs.

Watcher: 2–3 watch events per publish (15 for four publishes in one run), and
**0 missed publishes**. The suite has no poke fallback: a missed event leaves the
wait without an ack and fails the test. The repeats are absorbed by the id
reservation, which is what check 5 asserts.

D7 impact: the provisional 2000 ms steer / 3000 ms interrupt deadlines are at
least 25 times the measured ack latency upper bound, so they stay as written;
they are dominated by the child's own work (the interrupt waits for its own
`agent_settled`), not by the transport.

D8 impact: one strategy ships — the child-side `fs.watch` on the control
directory, with the parent polling for its ack. No missed event was observed, so
the boundary-only alternative stays rejected. Slice 3 found two loss paths and
kept the single strategy: the transport no longer writes its temp file inside the
watched directory (§5.3), and a publish inside a freshly installed watcher's
startup window can be lost (limitation 11) — it reports `unknown`, which the
strategy already covers.

`fs.watch` detail worth keeping: the watcher must come from `node:fs`, not
`fs.promises`, whose `watch` returns an async iterator and delivers no
callbacks (the first prototype draft silently observed nothing).

Installed 1.3.0 docs consulted for this slice (`docs/extensions.md`,
`docs/message-types.md`, `docs/sdk.md`, `docs/how-pi-works.md`,
`docs/compaction.md`): the lifecycle rule "do not start watchers in the factory;
start them from `session_start` or the tool that needs them, close idempotently
on `session_shutdown`" (extensions.md) matches D8. The child only learns the
control directory at the first `before_agent_start` (the `HERDR_RESULT_FILE`
marker), so slice 3 installs the watcher there and closes it on
`session_shutdown`, as the prototype does. `sdk.md` confirms `abort()` stops the
active operation and waits for the session to become idle, which is what check 4
observes; `how-pi-works.md` restates the abort/queue rule that slice 5's e2e
discard assertion depends on.

Suites after the prototype review fixes: `typecheck`, `lint`, `test:unit` (34
files, 295 tests) and `test:integration` (23 files, 158 tests) pass. The
integration count dropped by one because the vacuous check-7 test was removed.
`npm run test:e2e` passed 16 of 16 in the reviewer's run (118.58 s); it is not
rerun for this documentation-only change. Slice 5 still owns the real
steer/interrupt e2e scenarios.

`test/pi-control.test.ts` lives in the `unit` project, so a real-Pi suite adds
seconds to it. The prototype cost about 10 s; the product suite measures ~4.3 s
(6 tests) because the four-publish check no longer maintains prototype
counters. The file stays in the `unit` project as the product suite; the
prototype's consumer is gone (slice 3).

#### Slice 3 carry-overs from the prototype review

The prototype did not exercise these paths; slice 3 owns them:

- **Freshness (G3) is untested.** No test covers `createdAt < runStartedAt`
  (refused `idle`), the equal-millisecond limit, or the stale `request.json` that
  survives a child restart: `session_start` clears the reserved ids, so a leftover
  request is refused only if the heuristic catches it, and is otherwise applied.
- **Late ack and timeout are untested here.** The parent's deadline path (report
  `unknown`, leave the files, no retry) and the late `ack.<oldId>.json` that must
  not satisfy a newer operation belong to slice 2's unit tests; the prototype
  never reached a deadline.
- **Ack write after the temp dir is gone.** `closeOneShot` removes the whole
  `herdr-agent-*` directory, so a watch callback that lands after a close makes
  the ack write throw `ENOENT`. The prototype's `void consume()` would turn that
  into an unhandled rejection. Slice 3 must contain the failure per request and
  never let a background consume reject.
- **Shutdown.** The watcher close on `session_shutdown` is exercised only by the
  harness teardown; slice 3 asserts an in-flight consume after shutdown neither
  writes an ack nor throws.

### Slice 2 — transport module

`src/control/schema.ts`, `src/control.ts`, `isManagedResultFile` export. Unit
tests (`test/control.test.ts`): `controlDirFor` accepts only
`TMPDIR/herdr-agent-*/result.md` and rejects traversal, wrong basename and
non-managed temp paths; atomic publish leaves no torn file; `awaitControlAck`
returns undefined on timeout, on a wrong-id file and on malformed JSON; a late
`ack.<oldId>.json` never satisfies a new id and never overwrites a new ack; the
per-dir queue serializes two overlapping operations.

Checks: `test:unit`.

#### Progress

Slice 2: **done**.

- `src/control/schema.ts`: `ControlAction`, `ControlStatus`, `ControlRequest`,
  `ControlAck` as TypeBox values with their `Static` types, plus a shared
  `ControlId` (`^[A-Za-z0-9-]{1,64}$`) reused by both schemas — the id is
  validated in the schema rather than at each call site because it becomes part
  of an ack file name.
- `src/control.ts`: the §7.2 helper set. `controlDirFor` reuses the exported
  `isManagedResultFile` guard (no duplicated `result.md` literal). Every helper
  also requires a `control` basename inside a managed temp path, which is the
  shared `isManagedHerdrTempPath` policy: only the first segment under
  `os.tmpdir()` must start with `herdr-agent-`, so a nested spelling such as
  `<tmp>/herdr-agent-X/sub/control` is accepted exactly like every other sibling
  artifact path. That looseness is deliberate reuse of the existing policy, not
  a second, stricter rule (the review follow-up left it unchanged and corrected
  this note instead). Publish is `tmp + rename` (the state-store protocol): 0600
  files in a 0700 directory created idempotently, and a failed write or rename
  removes its own `.tmp` best-effort while the original error keeps propagating.
  `awaitControlAck` polls every 25 ms, accepts only an ack whose payload id
  equals the published id, and keeps normal `AbortSignal` semantics: a
  pre-aborted signal throws the abort reason from `throwIfAborted`, a mid-wait
  abort rejects through the sleep timer, and neither removes anything (an abort
  leaves the request for the next operation's pre-clean, like a timeout).
  `removeControlArtifacts(dir)` is the pre-operation clean (the request plus
  every ack); `removeControlArtifacts(dir, id)` is the successful-operation clean
  (the request plus that id's own ack), which is what §5.3's two removal moments
  need — the optional `id` parameter is the only shape added to §7.2. An id that
  cannot name an ack file is never turned into a path. `withControlDirQueue` keys
  on `path.resolve(dir)`, so `dir` and `dir + '/'` serialize, and mirrors the
  in-process half of `withStateFileLock` without the lock directory; it takes no
  signal, so a queued operation is cancelled by its own caller checking its
  signal before it publishes, not while it waits. It releases in `finally`.
- `src/artifacts.ts`: `isManagedResultFile` exported; no behavior change.
- Evidence: `npx vitest run --project unit test/control.test.ts` → 17 tests
  pass. Full suites after the change: `typecheck` and `lint` exit 0, `test:unit`
  35 files / 312 tests (was 34 / 295), `test:integration` 23 files / 158 tests
  (unchanged), `oxfmt --check` clean on the touched files. The slice 1 prototype
  (`test/pi-control.test.ts`, `test-support/control-prototype.ts`) stays until
  slice 3 replaces it.
- Mutation checks, each reverted: writing the request directly instead of
  `tmp + rename` fails the torn-publish test; accepting an ack whose payload id
  differs fails the published-id test; dropping the `ControlId` check in
  `removeControlArtifacts` fails the traversal test (its sentinel sits exactly
  where `ack./../../victim.json` lands); running `fn()` without the queue fails
  the serialization test; keying the queue on the raw `dir` fails the
  trailing-separator test; dropping the `fs.rm` of the failed publish's temp file
  fails the failed-publish test; dropping `signal.throwIfAborted()` fails the
  pre-abort test (the reason stops being the caller's).
- Residual for slice 3/4: the D7 deadlines, the tool's status mapping and child
  consumption are not covered here; `awaitControlAck` is exercised with test
  timeouts (40–250 ms, one background write) and a 10 s deadline that only the
  abort tests cut short, not the 2000/3000 ms deadlines. No arbitrary message
  length bound is added. No test asserts the nested
  `<tmp>/herdr-agent-X/sub/control` acceptance, because it is the shared managed
  path policy rather than a control-specific rule.

### Slice 3 — child consumer

`src/child/control.ts` + `src/child.ts`. Tests:

- `test/child-control.test.ts` (mock host, real files): `idle` refusal; a stale
  request (`createdAt < runStartedAt`) refused and a same-millisecond stale request
  documented as the heuristic's limit; admission reserves the id synchronously
  after the read (two concurrent watch events → one application, one ack); ack id
  echo; the child never deletes `request.json`; watcher re-target on a marker
  directory change; watcher closed on `session_shutdown`; the marker set before
  abort and again on `aborted`; a context from a replaced runtime (throwing
  `assertActive`) is treated as a refusal, not a success.
- `test/pi-control.test.ts` (real Pi): keep checks 1–5 from slice 1.

Checks: `test:unit`, then `test:e2e` with a real child in a real pane, because
`ctx.abort()` through the TUI binding is only real there (**verify**).

#### Slice 3 progress

Slice 3: **done**, with two transport findings and the review follow-up
(shutdown fences, transport-assertion fixes, reachability correction) below.

- `src/child/control.ts` (new): the watcher lifecycle, the reserved-id set, the
  D3 admission/guard, `pi.sendMessage(..., { deliverAs: 'steer' })` without
  `triggerTurn`, the marker + `ctx.abort()` + settle-observation interrupt, and
  the per-id ack writer. The module registers its own `session_start`,
  `before_agent_start` (watcher install/retarget), `agent_settled` (settle
  observation) and `session_shutdown` handlers; it is registered **last** by
  `registerChildMode`, so its settle observation runs after the child's
  interrupted-marker write. A background consume never rejects: the watch
  callback contains every failure of the consume, so an ack write that fails
  after a close removed the temp directory (ENOENT) produces neither an
  unhandled rejection nor a recreated directory. One containment point, not one
  per step. Shutdown is fenced at every stage that spans an `await`: a directory
  creation and an interrupt's marker write each re-check `closed` before
  installing the watcher or starting the abort, and an acknowledgement publish
  that already started is drained by `session_shutdown` through a
  `Promise.allSettled` over the in-flight set, so no ack rename lands after
  shutdown returns. Three gated tests hold exactly those stages open (see
  below); no lifecycle framework was added for it.
- `src/child.ts`: the result file and the new run state live in one
  `ChildRunState` (`resultFile`, `active`, `runStartedAt`, `context`) instead of
  a second local variable; new `agent_start` (active, context) and `agent_settled`
  (inactive, marker on `aborted`) handlers; `before_agent_start` records
  `runStartedAt` and the context. Result append, the question tool, manual
  continuations and the completed-boundary marker clear are unchanged. §7.3's
  sketch also had `lastSettle` in that state; it is not added, because the
  consumer owns its own settle waiters and nothing else reads the value.
- `src/control.ts` (transport fixes, each required by a measured failure):
  1. the atomic publish writes its temp file **beside** the watched `control/`
     directory instead of inside it. A temp file in the watched directory can
     have its event coalesced with the rename into a single event naming only the
     temp file, so the request is never read: a bare `fs.watch` probe lost 1
     publish in 40 with the temp file inside the directory and 0 in 60 with it
     one level up. The move keeps the same filesystem, the same 0600 mode and
     the managed agent temp dir, so rename atomicity and cleanup are unchanged.
     It removed one loss path, not all of them — see the startup window below.
  2. `writeControlAck` no longer creates the control directory. The parent
     creates it before publishing and the child creates it to watch it, so a
     missing directory means the agent's temp dir is gone; the ack then fails
     (contained) instead of recreating the removed tree and leaving an orphan ack
     behind. This is the slice 1 carry-over "ack write after the temp dir is
     gone", made observable.
- `test-support/control-prototype.ts`: **deleted** (325 lines). Its consumer was
  test-only code implementing §7.3; `test/pi-control.test.ts` now drives the real
  extension in child mode.
- `test/pi-control.test.ts` (rewritten as the product consumer's real-Pi suite,
  checks 1–5+5b kept): test factories are now registered **before** the
  extension, which is what keeps the child's `active` flag true while Pi already
  reports idle in check 2 — with the prototype the consumer itself owned that
  flag, so the window only existed because the consumer registered last. The
  consumer's internal counters are gone; the same facts are asserted on real
  artifacts instead: one `ack.<id>.json` per publish, `request.json` still on
  disk, no `.tmp` beside the control directory, and the append-once property read
  from the child session's custom messages (`herdr_agent_steer`, one per id in
  publish order) rather than a counter. The 1500 ms four-publish check now
  asserts each `STEER_<id>` reached a later provider request.
- `test/child-control.test.ts` (new, mock host, real files): idle refusal with a
  stale `active`; standalone compaction (`active` false, `isIdle()` false)
  refused; stale request refused and the equal-millisecond request accepted as
  the documented heuristic limit; one publish applies and acks once however many
  watch events it raises; ack id echo; `request.json` never removed; watcher
  retarget on a marker-directory change (the old directory then goes unread);
  `session_shutdown` closes the watcher and an in-flight consume that resumes
  after shutdown neither acks nor applies anything; the marker lands before
  `abort` and is restored by an aborted settle; `requested` after the 2 s
  observation window with the marker still set; a throwing `isIdle()` (stale
  context) refuses without aborting or marking; a failing ack publish is
  contained and the next operation still works.
- `test-support/mock-extension.ts`: `isIdle` accepts a function (so a test can
  flip it mid-handler) and `onAbort` records `ctx.abort()`. Two options, no new
  testing API: the tests still drive the extension through its own handlers.
- `test/child-control.test.ts` shutdown fences (review P1, deterministic, one
  gated stage each; the gate pauses the real `fs` call until released):
  directory creation paused → shutdown → resume installs no watcher, proven both
  by the watcher count (the test first counts a normal installation, so an
  unexpected resource name cannot pass silently) and by a publish that nothing
  consumes; marker write paused → shutdown → resume starts no abort, writes no
  ack and applies nothing; ack temporary-file write paused → shutdown does not
  resolve until released, and the drained publication completes with its ack
  renamed and no temp file left. The existing admission-read pause and the
  fixture teardown were re-expressed on the same gate helper, and the fixture now
  fires `session_shutdown` in `finally` before restoring the environment, so no
  test leaves a watcher to be cleaned up by directory removal.
- Transport-assertion follow-up (review P2): after the temp file moved beside
  `control/`, the "no temp file left behind" assertions in `test/control.test.ts`
  (successful and failed publish) and in `test/pi-control.test.ts` inspected the
  wrong directory and passed vacuously. They now read the agent directory:
  `agentTempFiles()` in the transport suite, `path.dirname(resultFile)` in the
  real-Pi check. A direct test also pins that `writeControlAck` for a missing
  control directory rejects with `ENOENT`, does not recreate the directory and
  leaves no temp file — the behaviour the consumer's containment relies on.
- Evidence: `test:unit` 36 files / 328 tests (was 35 / 312 before slice 3; the new
  file adds 15 and the rewritten real-Pi suite keeps 6, `test/control.test.ts`
  gains 1), `test:integration` 23 files / 158 tests (unchanged), `typecheck` and
  `lint` exit 0, `oxfmt --check` clean on the touched files, `test:e2e` 16 of 16
  (119.06 s and 121.08 s, plus 119.90 s and 121.22 s before the review fixes;
  baseline held; the real
  steer/interrupt e2e scenarios remain slice 5). `test/pi-control.test.ts` now
  takes ~4.3 s instead of ~10 s, because the four-publish check no longer waits
  on the prototype's per-publish bookkeeping.
- Measured watcher startup window (**reachable risk**, limitation 11): after the
  transport change the suite still lost publishes, so the remaining path was
  measured directly. A publish that lands immediately after `watch()` is
  installed was lost in 1 of 20 runs, and never when the write waited 25 ms —
  macOS FSEvents starts its stream asynchronously. The window is **reachable in
  production**: `promptAgent` returns on prompt submission without `--wait`
  (`src/herdr/agent.ts`, `src/tool/spawn/lifecycle.ts`), so an Orchestrator can
  call the control tool in the same second the child's `before_agent_start`
  installed its watcher. There is no readiness handshake and no retry, by design
  (D7/D8): a lost event reports `unknown`. Every other test in
  `test/child-control.test.ts` waits 100 ms before publishing, which isolates
  consumer behavior from this transport window and is **not** evidence about
  production; the separate `a publish inside the watcher startup window ...`
  test publishes with no wait and accepts either documented outcome (`queued`
  applied once, or `unknown` with nothing applied and no ack), so the window is
  a measured regression, not an assumption. If slice 5's real-child e2e loses a
  publish, this is the first thing to check.
- Mutation checks, each reverted: dropping `!state.active` lets the compaction
  case apply a steer; dropping `isIdle() !== false` makes the stale-`active`
  refusal fail (the steer is appended with no run); dropping the freshness
  comparison applies the stale request; reserving the id after the guard instead
  of right after the read lets concurrent watch events apply the same request
  twice; dropping the `closed` checks makes the post-shutdown consume write an
  ack; writing the interrupt marker after `abort()` fails the marker-order
  assertion; dropping the watcher callback's `.catch` turns the failing-ack test
  into a reported unhandled rejection. Review follow-up fences: dropping the
  `closed` re-check after the directory creation fails the watcher-install fence
  test (the watcher count goes up after shutdown); dropping the re-check after
  the marker write fails the interrupt fence test (an abort runs after shutdown);
  dropping the `session_shutdown` drain fails the ack-drain test (shutdown
  resolves before the ack is renamed); dropping the failed publish's temp-file
  cleanup now fails both the failed-publish test and the missing-directory ack
  test, where before the assertion fix it passed vacuously.

### Slice 4 — parent tool

`src/tool/control.ts`, `src/index.ts`, `src/prompts.ts`. Tests:

- `test/contract-control.test.ts` (integration harness + FakeHerdr): exact
  `details` keys and exact texts for every status; guards 1–7 with **no request
  file written**; ownership rejected for a child whose record has the same owner
  terminal but a different `ownerSessionId`; `idle` and `unknown` behavior; two
  parallel calls against one child serialized (one request file at a time).
  Extend `FakeHerdr` with `ChildOutcome.controlAck: 'queued' | 'idle' | 'none' |
  'aborted' | 'requested'`.
- `test/integration-control.test.ts`: a steer during a long simulated run keeps
  the child working and still yields exactly one delivered result containing the
  post-steer text; an interrupt yields no delivered result on the ordinary path
  (the simulated child writes no result), the pane stays open, the live record
  stays, and a pre-written question may still be delivered.

Checks: `test:unit`, `test:integration`.

#### Slice 4 progress

Slice 4: **done**, including the four parent-review findings (revision 8), with
check 7 passed as a forced overlap.

- `src/tool/control.ts` (new): the three parameters, guards 1–7 in the plan's
  order with no control-channel write before all of them pass (the reused
  `loadContextWithState` still does its own state pruning, which D2 allows), and
  the executor (§7.4). Discovery and pruning are the reused
  `loadContextWithState`; the session-ownership rule stays in the tool as D2
  decided, using
  `ownerSessionId` from `orchestratorIdentity`. The target's label comes from
  the managed list, its pane id from the same record. A call publishes one
  request, waits for `ack.<id>.json` with the D7 deadlines (2000 ms steer,
  3000 ms interrupt), and returns exactly one status; on a trusted ack it
  removes the request and its own ack, on `unknown` it removes nothing and
  starts no timer, retry or background task. `details` is `{ tabLabel, action }`
  for a guard failure and `{ tabLabel, paneId, action, status, requestId }` for an
  attempt. Texts are the §5.2 sentences verbatim, with the deadlines
  interpolated from the same constants the parent waits with
  (`CONTROL_ABORT_OBSERVE_MS` is imported from the child module, so the
  `requested` text cannot drift from the child's observation window).
- Cancellation is fenced at both awaits that precede publication. The
  pre-clean `await removeControlArtifacts(dir)` can take long enough for the
  caller to be cancelled; without a second `signal.throwIfAborted()` the request
  was still published afterwards, so a child could receive a command its caller
  had already abandoned. The gated test pauses the pre-clean's `fs.rm`, aborts
  the caller, releases, and asserts the call rejects with the caller's reason,
  no `request.json` exists, and the next call runs immediately (the queue entry
  was released). Mutation: dropping the second check publishes the request and
  fails that test.
- Acknowledgement compatibility at the tool boundary: an ack whose `action` is
  not the requested one, or whose status is not reachable for that action
  (steer: `queued`/`idle`; interrupt: `aborted`/`requested`/`idle`), is reported
  as `unknown` and its files are left in place. Reading e.g. an interrupt's
  `queued` as `aborted` would claim an abort nobody observed; `unknown` is the
  honest answer, and D7 already gives it the right consumer guidance.
- The per-child queue map drops an entry only when the map still points at that
  operation's own tail promise. Deleting unconditionally at the end of the first
  operation would let a third call read a resolved entry and run concurrently
  with the operation already queued, whose request it would then clean away.
  Tested with three operations while the second's acknowledgement is held: the
  third publishes only after the held operation finishes, and all three report
  `queued`. Mutation: the unconditional delete fails that test.
- The whole publish–wait–clean operation holds `withControlDirQueue`, not just
  the pre-clean. Measured while implementing the serialization contract test:
  with the success cleanup outside the queue, a parallel operation's pre-clean
  could remove the acknowledgement of the operation that was still finishing
  (two `rm`s of the same ack file between the two publishes). D6's words only
  required the pre-clean inside the queue; the correction keeps the parent as
  the sole remover of one atomic operation and makes the ordering test
  deterministic.
- `src/index.ts`: `herdr_agent_control` is registered in the parent branch only,
  next to `herdr_agent`, with description, `promptSnippet`, `promptGuidelines`
  (§5.4) and the parameters from `src/tool/control.ts`. Children still return
  from `registerChildMode` before that branch. The existing `herdr_agent`
  registration and its `session_start` re-registration are untouched.
- `src/prompts.ts`: the §5.4 control paragraph appended to `GLOBAL_INSTRUCTIONS`.
- `test-support/fake-herdr.ts`, `test-support/fake-herdr/types.ts`: the simulated
  child consumes its control directory the way `src/child/control.ts` does — it
  reads `control/request.json`, applies each id once, and answers
  `ack.<id>.json` — driven by `ChildOutcome.controlAck`. `queued` records the
  steer message and appends it to the run's result text (a steer enters the run
  at a turn boundary); `aborted`/`requested` write the `interrupted` marker and
  `aborted` also settles the simulated run; `idle` refuses; `none` never
  answers. The consumer lives as long as the agent, is retargeted when the
  result file moves, and is stopped on pane removal and on `stop()`, so an idle
  child can still answer `idle` and no interval outlives a test. Each poll's
  promise goes through the fake's existing `track` machinery, so `stop()` drains
  a consume that is already running instead of letting it write after teardown;
  a consumer closed by a pane removal re-checks that fence after each step that
  spans an await (directory read, marker write) and refuses to write, and the
  tracked rejection swallows the `ENOENT` a close-produced missing directory
  raises. The
  regression holds the marker write while the agent temp directory is removed
  (`closeOneShot`'s effect): no unhandled rejection, no recreated directory, and
  teardown completes. Mutation: replacing `this.track(...)` with `void ...` lets
  the `ENOENT` escape and fails that test.
- `test-support/harness.ts`: `callTool(name, params, options)` calls any
  registered tool through the same mock host; `call`/`callRaw` now delegate to
  it for `herdr_agent`. Needed because the harness had no way to reach a second
  tool; existing suites are unchanged.
- `test/contract-control.test.ts` (19 tests, integration harness + FakeHerdr):
  guards 1–7 with the exact sentence and exact `details` keys and no
  `control/request.json` written; guard 6 with the same owner terminal and a
  different `ownerSessionId`; every status of both actions with its exact text;
  the timeout case asserting `unknown`, the request left in place, one publish
  only and no second write after the call returns; the cross-action ack case
  reported as `unknown` with both files kept; two parallel calls serialized (one
  operation's own ack removal happens between the two request publishes); a
  cancellation that lands inside the pre-clean publishing nothing while the
  queue still releases; a third call staying behind the operation that still owns
  the queue entry; and a control call leaving a pending outcome untouched and
  unable to duplicate its delivery.
- Check 7 now forces the overlap instead of describing a sequence
  (`test/integration-control.test.ts`, real extension, real poller, real claim
  and close): the production poller is paused *after* its marker read returned
  ENOENT; a real `herdr_agent_control` interrupt publishes its request while that
  collection is still held (asserted: request on disk, no delivery yet); the
  collection is released while the tool is still in its ack wait (asserted via a
  settled flag set only when the tool resolves, which has not happened yet at
  delivery time); exactly one `herdr_agent_result` is delivered and exactly one
  `pane close` runs, both the poller's, with no `agent prompt|read|wait` from the
  control call; the tool then returns `unknown` (the channel's agent is gone),
  the record is pruned by the poller's claim, and neither the removed agent temp
  directory nor its `control/` is recreated while the tool finishes.
- `test/integration-control.test.ts` also keeps the slice 1 gate-6 tests and the
  slice 4 flows: a steer during a 1.5 s run keeps the child `working` and the
  single delivered result contains both the run's text and the steer text; an
  interrupt leaves the run undelivered with the pane open, the live record and no
  pane close across several poller ticks and past the simulated settle; a
  question written before an interrupt is still delivered while the interrupted
  run's text is not; and a simulated control write that loses to a close stays
  contained (no unhandled rejection, missing directory not recreated, consumer
  drained by `stop()`).
- Evidence: `typecheck` and `lint` exit 0; `test:unit` 36 files / 328 tests
  (unchanged); `test:integration` 24 files / 182 tests (was 23 / 158 before slice
  4; slice 4 added 17 contract tests plus 3 flows, and the review fixes added 2
  contract tests and 2 integration tests); `test:e2e` 16 of 16 twice (120.98 s and
118.91 s) in the final state (one
  earlier run failed the unrelated `current Herdr starts Pi with one CLI call
  during cold-shell initialization` test with `agent_pane_busy: agent target pane
  w1:p2 is not an available shell`; it passes in isolation and on the rerun, so
  it is the known cold-shell pane-readiness flake, not this change). The gate
  6/7 and close-during-consume tests passed 4 repeated runs each, and the
  cancellation/queue-entry/serialization trio passed 3 repeated runs.
  `oxfmt` clean on the touched files.
- Mutation checks, each reverted: dropping the `ownerSessionId` comparison fails
  the guard 6 test; returning the ack status without the action/status
  compatibility check fails the cross-action ack test (an interrupt reads
  `queued` as a success); moving the success cleanup outside the per-directory
  queue fails the serialization test; dropping the post-pre-clean
  `throwIfAborted` publishes a request for a cancelled call and fails the
  cancellation test; deleting the queue entry unconditionally (instead of only
  when it is still this operation's tail) lets a third call overtake the queued
  one and fails the queue-entry test; dropping `this.track(...)` around the
  simulated consume lets the close-race `ENOENT` escape as an unhandled rejection
  and fails the containment test.
- Two test-only flakes found by running the unit and integration suites
  concurrently, both fixed in the suite, not by weakening it: rewriting the
  state file with a plain write let a poller tick read it mid-truncation,
  quarantine it and leave the tool with no state (the guard 7 test then saw
  "no running agent"), so the suite now replaces the file with `tmp + rename`;
  and the serialization assertion compared against call order, while the
  per-directory queue admits whichever call finishes its lookup first, so it now
  asserts that exactly one operation's own ack removal lands between the two
  request publishes, without assuming which call published first. Three
  concurrent unit+integration runs are green afterwards.
- Remaining, honest:
  - Slice 5 is not implemented at this point: the real steer/interrupt e2e
    scenarios, the `pi --version` + SDK version capture (acceptance criterion 10)
    and the TUI-queue-discard assertion (acceptance criterion 4) were still open,
    so criteria 3, 4 and 10 were unproven then. Slice 5 closed them — see
    [Slice 5 progress](#slice-5-progress).
  - Slice 6 docs are untouched: `README.md`, `docs/tool.md`, `docs/flow.md`,
    `docs/config.md` and the `AGENTS.md` Files/invariants lists do not mention
    `herdr_agent_control` yet. The tool is registered but undocumented there.
  - Residual risks unchanged: a marker/collection race can still deliver an
    interrupted run (accepted, D5); a lost watch event reports `unknown`
    (limitation 11); an interrupt that races a clean finish leaves a complete
    result blocked until recovery (limitation 5).

### Slice 5 — e2e with real children and version capture

Capture in `test-support/e2e-harness.ts`: the **actual `pi --version`** and the
**lockfile SDK version** of `@earendil-works/pi-coding-agent`, exposed as
`harness.versions = { pi, sdk }`, and assert `versions.pi` equals the pinned
runtime version in the e2e entry point, exactly like the existing
`HERDR_INTEGRATION_VERSION=9` hard check. The version gate runs **before** the
harness allocates anything (revision 10): a harness factory that throws has no
`dispose()` to call, so a failing gate must not start a server, a mock LLM, or a
temp root. The v9 gate cannot move — it reads the file `herdr integration install
pi` writes into the fixture HOME — and is the pre-existing check, not a new
failure path. Extra metadata (Herdr client/protocol, git revision) is optional and
must never fail the suite.

Scenarios in `e2e/flow.test.ts`:

1. **Real steer**: spawn a child whose first reply holds, steer it, assert the
   child's next real provider request contains the steer text, the delivered
   result contains the post-steer text, delivery happens once, and the pane closes
   only after the real settle.
2. **Real interrupt, including the TUI queue clearing.** Spawn, wait until
   working, queue a steer, then interrupt. Assert: the ack status; no
   `herdr_agent_result` was delivered on the ordinary path (the child's own marker
   write is not raced here); the pane is still open and the live record
   intact; and the **queued steer was discarded**, which only the real TUI binding
   can show (`clearQueue`, §2.1). The discard means no later consumption, not just
   silence while the run is aborted: after the interrupt, drive one more run in
   that child (a direct `herdr agent prompt` on its pane — the equivalent of the
   documented manual continuation) and assert the steer text appears in no
   provider request from that child, before or after that run. A question written
   before the interrupt may still be delivered; assert that explicitly instead of
   promising silence. Scan the recorded request bodies directly
   (`harness.llm.requests`), not only `requestsMentioning`, so a steer appended as
   a custom message cannot slip past a last-user-text filter.
3. Sample the child's status (as in the evidence) and report whether `idle` was
   ever observed mid-run — an observation, never an assertion of absence.
4. **Question on a steered continuation** (added in revision 10, after the review
   disproved the plan's earlier impossibility claim): hold a reply, queue a steer
   into it, let the terminating `ask_question` tool run, hold the steered
   continuation, interrupt it, and assert the already-written question is
   delivered exactly once while the interrupted marker stays set and no result of
   the aborted run arrives.

Checks: `npm run test:e2e`.

#### Slice 5 progress

Slice 5: **done**, after the slice 5 review (revision 10). One measured
observation bounds the status evidence (limitation 12 below, with post-steer
transitions unmeasured), and one plan claim was wrong: a real child *can* hold an
undelivered question while its run stays active (scenario 3).

- `test-support/e2e-harness.ts`: the actual `pi --version` of the installed
  launcher and the lockfile version of
  `node_modules/@earendil-works/pi-coding-agent` are captured once per process,
  exposed as `harness.versions = { pi, sdk }`, and hard-gated in
  `createE2eHarness` exactly like the Herdr Pi integration v9 check: the run
  throws unless both equal the pinned `1.3.0`. The report line
  `[e2e] pi 1.3.0, sdk 1.3.0` goes to stdout directly because the default
  reporter hides `console` output of passing tests, and criterion 10 asks the run
  to report the versions. `run()` grew an optional binary argument (`pi
  --version` versus `herdr`), and one `executeTool` helper resolves
  `herdr_agent`/`herdr_agent_control` per call (both must be registered; `/reload`
  replaces them), so `call`, `callRaw` and the new `control` reach either tool
  through the same mock host. No other harness behavior changed, and `MockLlm`
  needed no change: the existing async `setScript` holds a reply.
- Version-gate cleanup (review P1): the version gate now runs at the very top of
  `createE2eHarness`, before `mkdtemp`, `MockLlm` and the Herdr server, because
  `withE2e` can only dispose a harness it received — the new mandatory failure
  path otherwise stranded a started server, its socket and the temp root. The
  Herdr integration v9 gate cannot move the same way: it reads the file that
  `herdr integration install pi` writes into the fixture HOME, so it needs the
  server and its env, and it is the pre-existing check (not a new failure path).
  Verified deterministically without adding a test: with a fake `pi` printing
  `9.9.9` first on `PATH`, `createE2eHarness()` rejects with
  `E2E requires Pi 1.3.0: pi --version says 9.9.9, the lockfile pins SDK 1.3.0.`
  and the `/tmp/herdr-agents-e2e-*` set is unchanged — no root, so nothing to
  leak. The throwaway check file was deleted after the run.
- Scenario 1 (`e2e/flow.test.ts`, steer): the barrier is the held first provider
  reply (`Promise.withResolvers`), so the run is live until the test releases it
  and the steer cannot be applied as a new run. The steer is published only after
  request 1 exists, which also puts it outside the watcher startup window
  (limitation 11). Asserted: ack `queued`; nothing delivered and the pane still
  open while the reply is held; after release the real child's second request body
  carries the steer text (the whole message list stringified, so the
  custom-to-user conversion cannot hide it); exactly one delivered result,
  carrying `ANSWER_BEFORE_CORRECTION` then `ANSWER_AFTER_CORRECTION`; the pane
  closes and the live record is pruned only after that delivery.
- Scenario 2 (`e2e/flow.test.ts`, interrupt): the deterministic hold is a child
  tool call (`printf started > interrupt-tool-started; sleep 30`), so no turn
  boundary can consume the queued steer before the abort lands; the test waits for
  that file, not for a delay. Asserted: the steer acks `queued`; the interrupt
  acks `aborted` (not `requested`, because the abort cannot lose to a finished
  run here) and reports the child's own `paneId`; after 2.2 s (more than two
  poller ticks) nothing was delivered, the `interrupted` marker exists,
  `result.md` still holds `PARTIAL_BEFORE_INTERRUPT`, the child's pane is open and
  its live record still has the same `paneId` with `detached: true`; a manual
  continuation through the real `herdr agent prompt` on that pane (the documented
  recovery) reaches the model, the continued run delivers
  `PARTIAL_BEFORE_INTERRUPT\n\nANSWER_AFTER_INTERRUPT` once, closes the pane and
  prunes the record, and only then — after the recovery run finished, delivered,
  closed and pruned (review P2) — the full `harness.llm.requests` scan runs. It
  covers every body of the completed recovery run rather than only the request
  that carried the task, and it pins that the child made exactly two requests.
- Scenario 3 (`e2e/flow.test.ts`, question on a steered continuation, added by
  the review): the earlier claim that a real child cannot be interrupted while
  its question is undelivered was **false**. `ask_question` returns
  `terminate: true`, but Pi refetches the steering queue after the terminating
  tool batch (`pi-agent-core/dist/agent-loop.js`: `hasMoreToolCalls ||
  pendingMessages.length > 0`), so a queued steer continues the run with the
  question already on disk (`_runBeforeSettleBoundary` returns
  `result.continue || hasQueuedMessages()`). The scenario uses only real
  barriers: the first reply is held while the steer is queued (ack `queued`),
  then released as an `ask_question` tool call; the steered continuation request
  is held forever, because the interrupt destroys its socket and no reply is due;
  the question file is asserted on disk before the interrupt is sent. Asserted:
  the continuation body carries the steer; the interrupt acks `aborted`; the
  question arrives exactly once as `herdr_agent_question` with its text; the
  `interrupted` marker is still set; no `herdr_agent_result` ever arrives and
  `result.md` stays empty; after 2.2 s of further poller ticks there is still
  exactly one delivered message, the child's pane is open and its live record
  keeps the same `paneId` with the parked question still on disk. The tick that
  delivers the question is deliberately **not** asserted: delivery needs a
  settled status, Herdr publishes status asynchronously (limitation 12), and the
  claim is "once, despite the marker", not a specific tick.
- Honest bound on the discard evidence: the child writes its `queued` ack only
  after `pi.sendMessage(...)` returned, and the model context of no recorded
  request ever carried the text. The harness cannot see the child's editor, so the
  run proves "never consumed by this child", not which internal path dropped the
  text (`clearAllQueues` plus the editor restore, and whatever the later
  `herdr agent prompt` does with an editor that held it). No stronger claim is
  made, and the plan's wording is not extended beyond no-consumption.
- The accepted D5 late delivery is never asserted absent: the ordinary-path
  assertions of scenarios 2 and 3 rest on the child's own marker write finishing
  before the abort, which the held barrier guarantees in both.
- Measured observation (limitation 12), narrowed by the review: 10 status samples
  at 50 ms intervals, all taken **before the steer is submitted** and after
  request 1 exists, produced the set `idle, working` in every run — so `idle` was
  observed while a live, held run overlapped the sample window. The set records
  neither order nor timestamps, and nothing was sampled after the steer, so this
  is evidence of initial status-publication lag during a held live run and
  **not** of a `working → idle` regression or of an idle window during the steer
  continuation; post-steer transitions are unmeasured. The scenario therefore
  asserts only that `working` was seen at least once (risk 4 in §13).
- Versions and checks at the final state (revision 10): `pi --version` `1.3.0`,
  lockfile SDK `1.3.0`, Herdr client/server `0.9.5`, Herdr Pi integration v9
  (existing hard check). `typecheck` and `lint` exit 0; `test:unit` 36 files /
  328 tests; `test:integration` 24 files / 182 tests (unchanged by this slice).
  The worker's `test:e2e` run: **18 of 19 passed, 131.21 s**, with the
  unrelated `current Herdr starts Pi with one CLI call during cold-shell
  initialization` failing in 0.6 s with `agent_pane_busy: agent target pane
  w1:p2 is not an available shell`. That failure is external and intermittent,
  not this change: the same test failed the same way in the orchestrator's own
  earlier full run (17/18) and in its isolated rerun, and in the scout's isolated
  repro; the review's full run was 18/18 green. The test and its cold-shell
  harness setup are untouched by slice 5, no retry or suppression was added, and
  that run was reported blocked rather than claimed green. The orchestrator's
  final verification after `npm run format` passed **19 of 19 in 140.03 s**;
  the intermittent cold-shell readiness failure remains a known external risk.
  The three control
  scenarios passed in that same run and in three targeted repeats of all three
  (5.7–6.8 s each, 3/3 every time, same status samples); scenario 3 has five
  green runs in total. The last repeat ran after a comment-only correction in the
  two touched files, so it is the final-state check. `oxfmt --check` clean on
  both files.
- No product change was needed: no dependency, config key, env var, state field
  or Herdr command kind was added, and only `test-support/e2e-harness.ts` and
  `e2e/flow.test.ts` changed.
- Residual boundaries: the version gate trusts that the `pi` on `PATH` is the
  runtime the children get (they inherit the server's `PATH`, so gate and
  children agree); the status sample is an observation window over the initial
  live run, not a monitor and not a post-steer measurement; scenario 3 does not
  prove which tick delivered the question; and no scenario forces the accepted
  marker/collection overlap, which stays slice 1 B and slice 4 evidence.

### Slice 6 — docs and cleanup pass

Docs per §11; confirm no new config key, env var, state field or dependency
appeared; `npm run format`.

## 10. Tests: real versus mocked, and who owns what

- **Real Pi, real files, no Herdr** — `test/pi-control.test.ts`: real
  `AgentSession` and `MockLlm` make the steer/abort semantics real; the control
  directory and files are real. Owns behavior: settle-window acceptance, settled
  refusal, abort marker and abort ack, and the watcher's publish → ack →
  apply-once path inside Pi's own run. Runs the product consumer (slice 3).
- **Mock host, real files** — `test/child-control.test.ts` drives the child's
  handlers directly (the `test/child.test.ts` pattern). Owns child-side edge
  cases.
- **Fake Herdr integration** — `test/contract-control.test.ts` owns exact texts,
  `details` keys, guards and ownership; `test/integration-control.test.ts` owns
  flows and the real-poller overlap check. Behavior suites must not re-assert the
  exact sentences.
- **e2e** — real Herdr server, real panes, real `pi` children, real extension code
  on both sides; only the model and the Orchestrator's own Pi process are
  simulated. The only place where the TUI `ctx.abort()` binding runs, so the only
  place where the queued-steer discard is asserted; the in-process suite cannot
  show it (§2.1).

Not covered, named as residual risk: a child started before `/reload`, a second
Orchestrator process on one session, and zsh history isolation (pre-existing).

## 11. Docs updates

- `docs/tool.md`: new section for `herdr_agent_control` — parameters, guards
  (including session ownership), the status table with exact texts, `details`
  keys, the no-retry rule, "queued is not applied", and the recovery paths for a
  live interrupted child (manual pane turn, or close with `/herdr-agents` then
  `resumeClosed`). Update the TUI-requirement wording to cover both tools.
- `docs/flow.md`: "Control" subsection — the `control/` directory beside
  `result.md`, single-remover/per-id-ack protocol, D3 guards, the marker rule and
  its non-absolute guarantee, the question non-retraction, and the compaction
  limitation.
- `README.md`: one feature bullet and the tool parameter row.
- `AGENTS.md`: new files in the Files list; invariants (session ownership, one
  outstanding op with parent as sole remover, per-id acks, adjacent double guard,
  marker before abort and on `aborted`, poller untouched, no retry on timeout);
  slice-0 SDK statements updated.
- `docs/config.md`: state that agent control has no config key.
- Do not touch `docs/plans/done/*`.

## 12. Acceptance criteria

1. `herdr_agent_control` exists with exactly the three parameters in §5.1 and
   `herdr_agent`'s schema is unchanged.
2. Every status in §5.2 is reachable in a test with its exact text asserted in the
   contract suite.
3. A steer into a running real child reaches its model context at a turn boundary
   and its answer arrives in the single normal result (e2e).
4. An interrupt of a running real child aborts it, and the documented recovery
   paths work (e2e). On the ordinary path the run's text is not delivered as a
   result and the child stays open; a collection already in flight can still
   deliver it and close the pane, which is accepted (D5, [Gate
   result](#gate-result)). A steer queued before the interrupt is discarded by
   the TUI abort binding (no provider request ever carries it, including a later
   run).
5. Steer acceptance before the settle and refusal after Pi settled (stale `active`)
   are both proven in the real-Pi suite.
6. Session ownership is enforced: a child with the same owner terminal but a
   different `ownerSessionId` is rejected, and no request file is written.
7. The real-poller overlap is measured, not assumed: the slice 1 B tests assert
   the accepted late delivery (D5, D11, [Gate result](#gate-result)), and no
   absolute "never delivered" claim ships. Ordinary-path protection — a marker
   present before the poller's read blocks delivery — is asserted in the same
   file.
8. A missing ack yields `unknown`, leaves the request in place, and starts no
   retry, timer or background task; a late ack for an old id cannot satisfy or
   overwrite a newer operation.
9. No new dependency, config key, env var, state field or Herdr command kind, and
   no control-specific state mutation beyond the discovery/pruning that
   `loadContextWithState` already performs.
10. `typecheck`, `lint`, `test:unit`, `test:integration`, `test:e2e` pass, and the
    e2e run reports the captured Pi and SDK versions.
11. Slice 0 is complete: `npm ls @earendil-works/pi-coding-agent` shows 1.3.0 and
    the docs no longer describe a mismatch.

## 13. Risks and open decisions

Risks:

1. **Marker/collection overlap** delivers an interrupted run's text as a success
   and closes its pane (D5). Reproduced by slice 1 B and accepted by the user
   (option 1, [Gate result](#gate-result)); `interrupt` promises ordinary-path
   behavior only.
2. **`fs.watch` event loss** turns a steer into `unknown`; D8 selects one strategy
   after measurement.
3. **Abort semantics drift in a future Pi**: `agent_settled.aborted`, the TUI
   `ctx.abort()` binding and the synchronous enqueue branch are load-bearing. The
   e2e interrupt scenario and the real-Pi suite are the tripwires.
4. **A steer's continuation collected early** if Herdr ever reported a settled
   status mid-continuation. The evidence sampled 37–43 ms and cannot prove absence,
   and the e2e sampling does not close that gap: it covers only the initial live
   run before the steer, where an `idle` status **was** observed (limitation 12),
   and it records neither order nor timestamps. Post-steer status transitions are
   unmeasured. What the steer scenario does prove is the behavior that matters:
   delivery happened once, after the real settle, carrying the post-steer text —
   the poller, not a status reading, gates delivery.
5. **Conservative interrupt cost**: an interrupt that races a clean finish leaves a
   complete result undelivered until recovery (limitation 5).
6. **Timeout tuning** (D7): measured in slice 1 A (ack latency 27–78 ms), so the
   2000/3000 ms deadlines stay; only the child's own abort observation can consume
   most of the interrupt deadline.
7. **SDK alignment churn** is isolated in slice 0 so it never mixes with control
   work.

Open decisions, with defaults: the D7 numbers (resolved: slice 1 measured
27–78 ms, so the values stay as written); whether a shared placement helper replaces the in-tool ownership
check (default: keep it in the tool); whether a readiness handshake for stale
children is worth one more file (default: no).

## 14. Non-goals

- Controlling a child that is not running; starting, resuming, answering, or
  closing an agent; sending a task to a live child.
- Any change to `herdr_agent`, its schema, the spawn flow, the poller, delivery,
  reports, closed history, or the widget.
- Multiple concurrent control operations per child, ordered queues, priorities,
  retries, backoff, or control outcomes delivered as messages.
- Retracting an already-written question, or any change to the question channel.
- A Herdr PTY/`send-keys`/`agent read` fallback, a socket, an IPC server, a
  workflow engine, a shared daemon, a new dependency, or a marker/poller locking
  framework.
- A config key, env var, or state-file field for control.
- Cross-Orchestrator coordination or a capability handshake for stale children.
- Detecting or recovering from compaction, provider errors, or auto-retry inside
  the child.

## 15. Review findings and their resolution

| Finding | Resolution |
|---|---|
| P1 ownership: terminal-scoped lookup | D2 adds `ownerSessionId === ctx.sessionManager.getSessionId()`; guards 5–7; contract test with same terminal, different session |
| P1 `active` alone can ack an idle append as `queued` | D3 requires `active && !ctx.isIdle()` adjacent to `sendMessage` with no await; real-Pi check 2 holds an earlier settle handler open |
| P1 "enqueue is asynchronous" wording | §2.1 corrects it: the steer branch runs synchronously before any await; `void` return is not async enqueue |
| P1 timeout permits an old consumer to delete a newer request | D6: parent is sole remover, child never deletes, admission reserves the id synchronously after the read and before any subsequent `await`, per-id `ack.<id>.json` files; unit test for the late-old-ack case |
| P1 prototype gate demanded refusal in the before-settle window | Slice 1 A: acceptance before settle, refusal only after Pi settled; slice 1 B adds the real-poller overlap checks |
| P1 interrupt guarantees exceed the marker protocol | D5 states ordinary-path behavior and the TOCTOU/Herdr-idle facts; slice 1 B gates it; explicit stop-and-revise instead of a locking framework; question non-retraction documented |
| P2 timestamp freshness overclaimed | D3 G3 renamed to a best-effort heuristic; "can never" claims removed |
| P2 "no state write / no Herdr call" contradiction | D2 and §7.4 state the reused discovery/pruning explicitly; acceptance criterion 9 reworded |
| Optional: D7 another consumption hook | D8: prototype alternative, one strategy ships |
| Optional: drop `already-settled` | Dropped; conservative `requested` with limitation 5 |
| Optional: version capture scope | Slice 5 captures Pi + SDK (mandatory, asserted); other metadata optional |
| Optional: exact texts asserted everywhere | §10 splits ownership: contract suite owns texts/details, behavior suites own behavior |
| Evidence version and option claims | §2.2: instrumentation absent, `triggerTurn` values reconstructed, `pi 1.2.0` is an assertion without a captured version |
| Continuation instruction wrong for a live child | §3 step 4 and the §5.2 interrupt texts use manual pane continuation or close-then-`resumeClosed`; grounded in `continuation.ts:73-88` and `manager.ts:243-246` |
| P1 interrupt guarantees exceed the marker protocol (measured) | Slice 1 B reproduced the late delivery; the user accepted it (option 1). D5 records the accepted semantics: interrupt stops work, does not retract a delivery in flight; tests assert the measured behavior |
| P1 parent review: cancellation during the pre-clean still published | Second `signal.throwIfAborted()` between the pre-clean and `writeControlRequest`; gated cancel-during-cleanup test also asserts the queue released |
| P1 parent review: gate 7 claimed an overlap it never forced | Replaced with a forced overlap: the real poller is paused after its marker read, a real `herdr_agent_control` call publishes and waits, the collection is released while the tool is in flight, and exactly one poller delivery/close plus an honest `unknown` are asserted. The old, marker-after-return test is kept only as "a control call leaves a pending outcome untouched" |
| P2 parent review: simulated control consume could reject unhandled and outlive teardown | Consumer promises go through `this.track(...)`; consumers are fenced on close and drained by `stop()`; close-during-consume regression added |
| P2 parent review: per-child queue entries never left memory | Entry removed in `finally` only when the map still points at that operation's tail; three-operation test added |
| P1 slice 5 review: version-gate failures leaked a started harness | Both hard gates moved to the top of `createE2eHarness`, before the temp root, mock LLM and Herdr server; verified with a fake `pi` on `PATH` that the gate rejects and creates no harness root |
| P1 slice 5 review: "question overlap is impossible" was false | `ask_question` terminates its turn, but Pi refetches the steering queue after the terminating tool batch, so a queued steer continues the run with the question on disk. Scenario 3 added: held reply → queued steer → held continuation → interrupt → exactly one question delivery with the marker still set and no result |
| P2 slice 5 review: full body scan ran before the recovery run finished | The scan moved after the recovery result was delivered, the pane closed and the record pruned, so it covers every request body of the completed recovery run |
| P2 slice 5 review: status samples overinterpreted as reaching the steer continuation | All samples precede the steer; limitation 12 and §13 risk 4 now describe initial status-publication lag during a held live run and state that post-steer transitions are unmeasured |
