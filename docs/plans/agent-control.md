# Agent control: steer and interrupt one running child

Status: implementation started, revision 4. Slice 0 (SDK alignment) is done and
the slice 1 gate is resolved: the user accepted the measured late-delivery race
(option 1 of the [Gate result](#gate-result)). Slice 1's throwaway prototype is
complete — checks 1–5 pass, check 6 is re-scoped to the accepted behavior, and
check 7 is **deferred to slice 4** (it needs the parent tool to mean anything).
Measurements are recorded under [Prototype
measurements](#prototype-measurements-slice-1-a-throwaway). No feature code
exists for this tool.

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
`saveHerdrAgentsState`, `src/state/store.ts:174`):

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
11. Watch-event loss reports `unknown` (D8 selects one strategy after the gate).
12. A child running older extension code cannot be controlled.
13. The Orchestrator blocks for up to the ack deadline.

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

### Slice 1 — prototype gate (throwaway, before any product code) — A and 6 done, 7 deferred

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
7. **Request vs claim/close — deferred to slice 4.** The prototype cannot test it:
   the production poller never reads `control/request.json`, so publishing one
   during a collection proves nothing about the control path. The prototype
   variant that did this was removed. The claim belongs to slice 4's
   `contract-control.test.ts`, which has a real control call to assert that it
   claims, collects and closes nothing.

**Gate.** Resolved for check 6: it reproduced the overlap, the user accepted the
race (option 1), and the two check-6 tests assert that accepted behavior. Check 7
is not passed — it is deferred to slice 4 and must not be counted as evidence. A
failure of check 2 (in slice 1 A) or a new failure still stops implementation and
goes to the user (D5). If the watcher in check 5 loses events, choose the single
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
| 7, request file published mid-collection | **not run**: deferred to slice 4. The prototype variant was removed as vacuous — it published a file the production poller never reads, so it could not fail on a control defect |

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

`test/pi-control.test.ts` plus `test-support/control-prototype.ts`. Real
in-process Pi (`createAgentSession`, real files, MockLlm as the provider), the
real child extension under `HERDR_AGENT_CHILD=1`, and a throwaway consumer that
implements §7.2/§7.3 as test code. No product control module exists.

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
the boundary-only alternative stays rejected.

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

`test/pi-control.test.ts` lives in the `unit` project, so the real-Pi prototype
adds about 10 s to a suite that otherwise takes ~3 s. That is temporary: the
prototype is deleted in slice 3, when the product consumer replaces it.

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

### Slice 5 — e2e with real children and version capture

Capture in `test-support/e2e-harness.ts`: the **actual `pi --version`** and the
**lockfile SDK version** of `@earendil-works/pi-coding-agent`, exposed as
`harness.versions = { pi, sdk }`, and assert `versions.pi` equals the pinned
runtime version in the e2e entry point, exactly like the existing
`HERDR_INTEGRATION_VERSION=9` hard check. Extra metadata (Herdr client/protocol,
git revision) is optional and must never fail the suite.

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

Checks: `npm run test:e2e`.

### Slice 6 — docs and cleanup pass

Docs per §11; confirm no new config key, env var, state field or dependency
appeared; `npm run format`.

## 10. Tests: real versus mocked, and who owns what

- **Real Pi, real files, no Herdr** — `test/pi-control.test.ts`: real
  `AgentSession` and `MockLlm` make the steer/abort semantics real; the control
  directory and files are real. Owns behavior: settle-window acceptance, settled
  refusal, abort marker and abort ack only.
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
   status mid-continuation. The evidence sampled 37–43 ms and cannot prove absence;
   the e2e steer scenario asserts the post-steer text is delivered.
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
