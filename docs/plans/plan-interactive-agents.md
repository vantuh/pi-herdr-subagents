# Plan: interactive agents

> Historical implementation notes. See [README.md](../../README.md) and
> [flow.md](../flow.md) for the supported runtime and current behavior.

Porting ideas from [pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents)
(HazAT's fork) into `herdr-agents`. The source is an asynchronous tmux plugin; we stay on
Herdr, so we port **features**, not the architecture.

Five phases (0–4), **each ran separately and was merged separately**. The next one did not
start until the previous one passed its gate. Phases 0, 1, 2, 4 are done;
phase 3 was deliberately dropped.

The original intent "we stay on the synchronous model" did not hold: phase 4 added
asynchronous delivery. But it added it as a **second mode** — the blocking path
remained the default and nothing was removed from it.

## Order and gates

| Phase | What | Risk | State |
|---|---|:---:|---|
| 0 | Parallel agent limit 2–3 → 4–5 | low | done |
| 1 | Agent status widget | low | done |
| 2 | Bidirectional channel (`ask_question`) | medium | done |
| 4 | Async agent result delivery | medium | done |
| 3 | Loadout snapshot | low | **dropped** |

**The order was revised after phases 1–2.** Initially phase 3 sat before 4 as its
prerequisite, and phase 4 was considered a high-risk architecture change. Both
estimates turned out to be wrong:

- phase 4 does **not** depend on a loadout snapshot — delivery rests on the
  poller from phase 1 and a flag in the state file;
- phase 4 does **not** replace the blocking model, it adds a second mode, so nothing
  of the existing behavior (soft re-wait, the `wait: true` default, early question
  return) is cancelled.

Phase 3 was ultimately dropped — see its section.

## Verified APIs

Do not invent new mechanisms — everything below already exists:

- `ctx.ui.setWidget(id, lines | component, { placement: "aboveEditor" })` —
  `docs/extensions.md`, component examples in `docs/tui.md`. Cleared by
  passing `undefined`.
- `pi.sendMessage({ customType, content, display, details }, { triggerTurn: true, deliverAs: "steer" })` —
  `docs/extensions.md` (`pi.sendMessage`). Needed only in phase 4.
- `pi.registerMessageRenderer(customType, …)` — custom rendering for your own
  `customType` messages.
- `ctx.isIdle()` — the "streaming or not" guard. `deliverAs` is required only while
  streaming; `sendUserMessage` without it throws. The pattern is in
  `examples/extensions/send-user-message.ts`.
- Herdr `api snapshot` → the state of each agent (`agent_status`,
  `state_change_seq`, `interactive_ready`). Already parsed: `parseAgentSnapshot`
  (`herdr.ts`), reachable via `getAgentSnapshot` / `getSessionSnapshot`.
- The parent→child channel already exists: `promptAgent` (`herdr.ts`) → `herdr agent prompt`.

## What we deliberately do not port

- **tmux surface layer** — we have Herdr with a deterministic 60/40 layout and a
  placement lock. The fork runs `even-horizontal` after every spawn/exit.
- **`session-mode: fork`** — a deliberate decision: fresh context instead of a
  forked conversation (`docs/README.md`, "Known design choices").
- **Recursive spawn (`subagent_agents` + `PI_SUBAGENT_ALLOWED`)** — with us
  `HERDR_AGENT_CHILD=1` hard-disables delegation in the child. We do not change this.
- **`registerToolExtension`** — runtime tool registration by third-party
  extensions. There is no consumer.

---

## Phase 0 — Parallel agent limit (2–3 → 4–5)

### Current state

**There is no limit in the code.** Nowhere in the extension is the number of
simultaneous agents checked — there is no `MAX_*` constant and no guard in the tool.
"2–3 max" is text in the prompts only, so the model may ignore it or may
over-comply (limiting itself to two where four would be appropriate).

The target wording is **4–5 max**, not a hard five: the range leaves the model
free to stop at four when a fifth agent adds no independent work, and at the same time
makes 5 legal rather than a policy violation.

Three places carry the wording:

1. `constants.ts` → `GLOBAL_INSTRUCTIONS`: *"Launch parallel `herdr_agent`
   calls only for independent reads or disjoint write slices (2–3 max)"* —
   this really is injected into the Orchestrator's system prompt.
2. `docs/README.md` → **Negative policy**: *"(2–3 agents max)"*.
3. `AGENTS.md` (of the plugin) — the delegation policy table.

Plus the same appears in the repository's shared instructions:
`agents/.agents/AGENTS.md` → *"keep to 2–3 agents"*. This is **not a plugin file**, and
the repo rule (`dotfiles/AGENTS.md`) explicitly forbids editing it without need,
because it is shared by all agents. Change it only with the user's explicit
permission — otherwise the plugin and the global policy would diverge in numbers.

### What already technically supports 5

- **Placement lock** (`acquirePanePlacementLock`) serializes spawns, so
  5 parallel calls create one right column rather than 5 competing
  columns. The count does not matter for correctness.
- **Rebalance** (`buildEqualAgentSplitRatios`) computes the ratio from the actual
  number of managed panes — the formula is already general, `1/5` falls out by itself.
  Nothing is hardcoded to three.
- **State file** (`state.ts`) — the write queue is per file, the count is unlimited.

### What presses on the upper bound

- **Pane readability.** 5 agents in a 40% column = ~1/5 of the terminal height
  each. In a typical 50-row window that is ~10 rows per agent with a frame —
  at the edge of usefulness. This is the main real constraint, not the code, and that is
  exactly why the upper bound is 5 rather than 6+.
- **Parallel `agent wait`s.** Each call holds its own `execHerdr` process until
  completion. We need to confirm that Pi's limit on simultaneous tool calls
  allows 5.
- **Result size.** 5 artifacts of 180 fallback lines in one Orchestrator turn —
  a real risk of bloating the context. An argument in favor of phase 4
  (async delivery spreads results across turns).

### Decision

- **No hard guard in the code.** No `HERDR_AGENTS_MAX_PARALLEL`
  or count check in the tool — the limit stays prompt policy. Reason:
  a guard would block the legitimate case of 6 independent reads, and the cost of
  violating it is low (just cramped panes).
- **`agents/.agents/AGENTS.md` was updated** with the user's explicit permission, so
  that the plugin and the global policy do not diverge in numbers.

### Done

- [x] `constants.ts` → `GLOBAL_INSTRUCTIONS`: `(2–3 max)` → `(4–5 max)` plus
      the clarification *"the limit is independence, not count — go past 2–3 only when
      every agent has genuinely independent work"*.
- [x] `docs/README.md` → **Negative policy**: `(4–5 agents max)` + the reason
      for the upper bound (pane height in a 40% column).
- [x] `agents/.agents/AGENTS.md` → *"keep to 4–5 agents"*.
- [x] The plugin `AGENTS.md` — contains no numbers, no sync needed.
- [x] A smoke test with 5 agents passed (Herdr 0.8.2, terminal 65×272).

### Smoke test result

**Stage 1 — layout with 5 live agents.** `herdr api snapshot` showed exactly
one structure, no competing columns:

```
split_0_root   right  ratio 0.6        → Orchestrator 163 cols | column 109 cols
split_1_1      down   ratio 0.8        = 4/5
split_2_10     down   ratio 0.75       = 3/4
split_3_100    down   ratio 0.6666667  = 2/3
split_4_1000   down   ratio 0.5        = 1/2
```

The nested ratios `4/5 · 3/4 · 2/3 · 1/2` give exact fifths: all 5 panes are
`height 13` at `y = 1, 14, 27, 40, 53`, sum 65 = the full tab height. All 6
panes (Orchestrator + 5 agents) in one tab, one column (`x = 192`).

**13 rows per agent** — that is the practical limit from the section above. The estimate in
the plan was ~10 rows in a 50-row window; on a 65-row one it came out to 13. A sixth agent
would give ~11, a seventh ~9.

**Stage 2 — a full cycle of 5 parallel one-shots.** All 5 returned
`HERDR_RESULT: status: done`. After completion: only
`w2V:p1X` (the Orchestrator) remained in the tab, `splits: 0`, no leftover pane,
the state file clean — `{"version":1,"agents":{}}`.

**Incidental finding (not about the infrastructure).** Three of the five agents gave
wrong numbers: `utils.ts` 181 instead of 190, `agents.ts` 79 instead of 87,
`schema.ts` 41 instead of 37. The `scout` profile runs on
`kiro-acp/claude-haiku-4.5`, and it is unreliable at exact line counting.
Delegation worked as designed — the content was wrong, not the transport. This is empirical
confirmation of the existing rule "the Orchestrator must synthesize child results,
not blindly forward them": verify the numbers from a child report if they matter
for the decision.

### Gate — passed

Five parallel one-shot agents complete the full cycle: spawn → even
layout → 5 results → close, without orphaned panes and without competing
columns. Verified at the upper end of the range (5, not 4). Phase 0 is closed.

---

## Phase 1 — Agent status widget

### Goal

A panel above the Orchestrator's input with the state of all managed agents, so you do not
have to keep in mind who is working right now and for how long.

```
╭─ Herdr agents ───────────────────────── 2 running ─╮
│ 00:23  Scout — message-bus   working                │
│ 00:45  Reviewer              blocked · needs attach │
╰─────────────────────────────────────────────────────╯
```

### Design

The key difference from the fork: **the child writes nothing**. The fork keeps an
activity snapshot that the child updates itself, because tmux does not know the
agent's state. Herdr does — `api snapshot` already returns `agent_status` per agent.
So the widget is a purely read-only poller over data that already exists.

Sources:

- `listCurrentWorkspaceAgents` / `listManagedWorkspaceAgents` (`herdr.ts`) —
  which panes/tabs are managed;
- `loadHerdrAgentsState` (`state.ts`) — label, profile, lifecycle;
- `api snapshot` — `agent_status` + `interactive_ready`.

States to display: `starting` (the agent started, no snapshot yet), `working`,
`blocked` (Herdr returns blocked / `agent_blocked` — hint "attach"),
`waiting` (will appear in phase 2), `idle`/`done`.

### Which agents the widget shows

Not all managed agents. The widget exists to show the ones nobody
is watching, and with `wait: true` the orchestrator is anyway sitting in the tool that
renders `Waiting for Herdr agent <label>...` (plus `herdr:blocked` highlights
the orchestrator's pane in Herdr). A row in the widget would be a third copy of the same
fact, and with 4–5 parallel synchronous calls that is 5 rows above the input with no new
information.

The rule: **hide the agents the orchestrator is currently blocking on, except
those whose status is `blocked`.**

The exception. `blocked` **was supposed to** cover the case where the child sits on an
approval dialog, because a tool call does not distinguish that — it shows the same
`Waiting for…` until the timeout.

**Clarification after the status gate in phase 2: this exception does not actually
hold in practice.** The experiment showed that a session on a dialog returns
`working`, and `blocked` is set only from the `herdr:blocked` event, that is, when the
*orchestrator* is waiting for a child — inside the child itself it is never
emitted. So for managed children `blocked` is unreachable, and the filter effectively hides
**all** awaited agents, i.e. behaves as the original "async only" variant.

The `status === "blocked"` condition was kept as a safety net: it costs nothing, is correct
in meaning, and will start working on its own if Herdr ever begins detecting dialogs
or if we add our own signal. But it cannot be relied on as visibility of a stuck
child — phase 2 closes that gap with the `question.md` file,
not with a status.

The implementation is an in-process `Set` of labels (`awaitedAgentLabels` in `index.ts`), not a
field in the state: this is a property of this session's call stack, not of the agent, and that
way it is automatically correct on the re-wait path too. Blocking waiting has exactly two
entry points and two `finally`s, so the pairs are symmetric.

`herdr:blocked` is deliberately **not** used for this: its payload is a contract
consumed by the Herdr extension itself (`extensions/herdr-agent-state.ts`), so
the event stays unchanged.

Consequence for the poller: an empty visible list ≠ an empty managed list.
The poller stops only when there are no managed agents at all. If agents exist
but all are hidden, the tick continues — otherwise a transition to `blocked` would never
appear, because nothing would restart the poller.

### Files

- new `widget.ts` — row rendering + `agent_status` → caption mapping;
- new `runtime.ts` (or a section in `state.ts`) — combining managed state
  + snapshot into one `AgentRuntimeInfo` array;
- `index.ts` — timer (1000 ms), `ctx.ui.setWidget`, removing the widget when
  there are no managed agents, interval cleanup;
- new `widget.test.ts` — rendering from fixed input.

### Tasks

- [x] `types.ts`: `HerdrAgentInfo.updatedAt?: string` (passthrough from state).
- [x] `herdr.ts`: `listManagedWorkspaceAgents` returns `updatedAt`.
- [x] `widget.ts`: pure `formatElapsed`, `agentStatusView`, `truncateLabel`,
      `renderAgentWidgetLines` — no I/O.
- [x] `index.ts`: `loadAgentsForWidget` (no prune/save), `updateAgentsWidget`,
      `ensureAgentsWidget`, stopping the poller on an empty list, a `ctx.hasUI` guard,
      clearing a stale timer via `globalThis` on `/reload`.
- [x] The poller starts on `session_start` and after a pane is created in the tool.
      `session_start` also fires with `reason: "reload"`, so `/reload` brings the
      widget up without a new session.
- [x] `session_shutdown` stops the poller — it covers quit/new/resume/fork, not
      only the reload path via `globalThis`. A documented pattern for
      session-scoped resources.
- [x] Child mode does not register the poller: `HERDR_AGENT_CHILD=1` exits
      `herdrAgentsExtension` earlier.
- [x] `widget.test.ts` — 13 tests: all statuses, 0/1/2 agents, truncation,
      column alignment, missing/invalid `updatedAt`, paint.
- [x] `widget.ts`: pure `visibleWidgetAgents(agents, awaitedLabels)` —
      hides awaited ones except `blocked`.
- [x] `index.ts`: `awaitedAgentLabels` + `beginAwaitingAgent` /
      `endAwaitingAgent` in the two entry-point/`finally` pairs of blocking waiting
      (the spawn-reuse path and the re-wait path).
- [x] `index.ts`: `updateAgentsWidget` distinguishes "no managed" (stop the poller)
      from "no visible" (only clear the widget, the tick continues).
- [x] `widget.test.ts` — 5 filter tests: nobody awaited, an awaited one
      hidden, awaited + `blocked` shown, all awaited, exact label
      match without prefix matching.

### Deviations from the original idea

- **`runtime.ts` was not created.** `listManagedWorkspaceAgents` +
  `loadHerdrAgentsState` already give a ready `HerdrAgentInfo[]`, so a separate
  combining module would be an extra layer.
- **No new `startedAt` field was added.** The state already has `updatedAt`, and the tool
  rewrites it on every spawn *and* on every persistent reuse — that is exactly the
  reference point needed ("time in the current task", not "pane age").
- **No frame.** Instead of a box component with `render(width)` — a plain
  `string[]`, which `setWidget` accepts directly. Width is not needed: labels
  are truncated to 28 characters, columns align between rows.

### Verification

`bun test` — 84 pass / 0 fail (18 of them new), `bun build` builds
(61 KB), `prettier --check *.ts` clean.

The live data path was verified on **two real managed agents** (spawn via
`herdr_agent`, `lifecycle: persistent`), sampling `getCurrentContext` →
`listManagedWorkspaceAgents` → `renderAgentWidgetLines` once every 3 s:

```
Herdr agents · 2 · 1 working
 00:03 Widget alpha                  working
 00:36 Widget truncation check lon…  done
```

A few seconds later, after the work finished:

```
Herdr agents · 2
 00:06 Widget alpha                  done
 00:39 Widget truncation check lon…  done
```

Confirmed on live data:

- Real `agent_status` values map: `working` → active tone + the suffix
  `· 1 working` in the title; `done` → quiet tone, the suffix disappears.
- Time advances between samples (00:13 → 00:16 → 00:19).
- **`updatedAt` is indeed rewritten on persistent reuse:** after a second
  prompt into `Widget alpha` the counter reset from 00:36 to 00:03. This empirically
  confirms the choice of `updatedAt` over a new `startedAt` — we show "time in the
  current task", not pane age.
- Truncation and column alignment on real labels.
- After `pane close` of both agents: `0 agents` → `renderAgentWidgetLines`
  returns `[]` → `setWidget(id, undefined)` and the poller stops. The tab
  returned to `panes: 1, splits: 0`.

The decision "the widget does not prune" was incidentally confirmed: closing panes around
the plugin left two dead entries in the state file, but the widget showed `0 agents`,
because `listManagedWorkspaceAgents` filters by live panes. The next
`pruneHerdrAgentsState` against the live snapshot removed both
(`before: 2 → after: 0`). So stale entries do not leak into the display and
are cleaned up by the regular paths.

Not covered by a live run: `blocked` (requires an agent on an approval dialog) —
covered by a unit test; `status` here is a direct passthrough of `pane.agent_status`.

### Manual check

`/reload`, spawn two agents, the widget shows both with duration and status,
after closing all — it disappears.

The data path of this scenario has been exercised (see Verification), visual
confirmation in the TUI was obtained (see Gate).

### Gate — passed

- [x] The widget updates during a real `herdr_agent` call — the status
      went `working` → `done`, time advances between ticks.
- [x] It disappears after all agents are closed — `0 agents` → `setWidget(undefined)`,
      poller stop.
- [x] `bun test` green (84 pass / 0 fail), `prettier --check` clean,
      the extension loads (`pi -p` without errors).
- [x] No extra `herdr` call more often than once per tick — `widgetTicking`
      cuts off overlapping ticks, `loadAgentsForWidget` does one
      `api snapshot` per tick and does not write state.
- [x] Visual check in the TUI — confirmed by the user:
      a synchronous agent does not appear in the panel (it works in the right column, but
      there is no row, because its state is printed by the tool call); on a blocking call for
      a single managed agent the panel disappears entirely and **comes back** after
      completion with `idle` — that is, the poller survives an empty visible list.

### Risks

- The poller plus a blocking `agent wait` in one process — make sure that
  `execHerdr` from the timer does not race with the wait for the same AbortSignal.
- A tick once a second × `api snapshot` — if that is expensive, raise it to 2000 ms.

---

## Phase 2 — Bidirectional channel (`ask_question`)

### Goal

A child can ask the parent one question and **not die**: the session parks,
the parent answers, the child continues with the answer. This closes our worst
failure mode — today an agent that hits a question produces `agent_blocked`
(see `51bd683`), and the only way out is to attach by hand.

### The key difference from the fork

The fork steers into the parent's session because it is asynchronous. **With us that does not
work**: the parent sits inside its tool call (`herdr_agent` with `wait: true`) and cannot
take a new turn until the tool returns. Therefore:

> a child question ends the current `herdr_agent` call with an **early successful
> result** carrying status `question`, not with a steer.

The parent answers with the next `herdr_agent` call with the same `tabLabel` and
`task` = the answer → `promptAgent` sends it into the same session. The child stays
alive the whole time. This fully reuses the existing persistent-reuse path,
with no new transport trunk to the parent.

Consequence: `lifecycle: "oneshot"` on a question does **not close** the target — the agent
stays open until the final result. This is already consistent with the rule
"a one-shot closes only after successful completion".

**Found by a live test:** this is not enough. Pane reuse by label was
limited by `if (persistent)`, so answering a parked one-shot created a **new** agent
and orphaned the parked one forever. The condition was extended: the pane is reused also when
there is an unanswered question on disk (`persistent || answeringQuestion`). Otherwise the
channel would work only for persistent, i.e. in the minority of real delegations.

### Allowlist gate — passed

Blocking prerequisite: does an extension tool even reach the child we launch
with `--tools`. Verified empirically with a one-off probe extension
(`pi -e`, prints `getActiveTools()` / `getAllTools()` on `session_start`):

| Case | `--tools` | Result |
| --- | --- | --- |
| A | `read,probe_tool` | `active = ["read","probe_tool"]` — the extension tool is active |
| B | `read` | `active = ["read"]`, **`all = ["read"]`** — the tool is not in the registry |
| C | `read` + `setActiveTools([...active,"probe_tool"])` | unchanged: `["read"]` |
| D | `read,herdr_agent` | `["read","herdr_agent"]` — auto-discovered extensions likewise |

Conclusions that shape the design:

1. **An extension tool can be given to a child — but only by naming it in `--tools`.**
   This is under our control: `piArgs` is built in `index.ts` (~930).
2. **The child cannot enable it for itself.** `--tools` filters *before* the active
   set — the tool disappears from `getAllTools()`, and `setActiveTools` ignores
   unregistered names (case C). So the option "child mode adds `ask_question` itself"
   is out; filtering is applied after extension registration.
3. `--tools` is passed only when the profile has a non-empty `tools`
   (`if (agent.tools?.length)`). For profiles **without** a tool list there is no flag,
   so `ask_question` will be available automatically. The name must be added only in
   the branch where the list exists.

### Status gate — what Herdr actually returns

Before choosing the waiting mechanism, an experiment was run: a one-off
extension with a tool that calls `ctx.ui.confirm`, launched as a Pi agent in its own
pane (`herdr agent start qprobe --kind pi ... -e dialog.ts`).

The result — **a session sitting on the question dialog returns
`agent_status: working`**, stably (8 samples × 3 s, `state_change_seq`
does not move). A screenshot of the pane at the same time showed an open dialog with
`→ Yes / No`. No `blocked` at all.

The reason is that the status is published, not detected:
`pi/.pi/agent/extensions/herdr-agent-state.ts` returns only
`working | blocked | idle`, and `blocked` there is set **exclusively** from the
`herdr:blocked` event, i.e. when the *orchestrator* waits for a child. Next to it in the
snapshot stands `screen_detection_skipped: true` — Herdr deliberately does not guess from
the screen when the agent reports itself.

Consequences:

1. **A child will never return `blocked`.** It cannot delegate, so
   `herdr:blocked` is never emitted inside it. For managed children the status ∈
   `working | idle | done`.
2. **Variant B (`--until blocked`) is dead.** There is nothing to catch.
3. **A parked child does not become `idle`** — the turn is still active while the tool hangs
   on the dialog. So `ask_question` **must not block** the turn.

A trap was discovered separately: `herdr agent prompt` against a parked agent
completes successfully (`agent_prompted`), but `state_change_seq` does not grow, and
the keys pressed **answer the dialog** — after the second prompt the dialog
disappeared on its own. So a prompt to a parked agent silently corrupts its state. Our
prompt-acceptance check via `state_change_seq` growth (`083770e`)
guards against exactly this and turns out to be more important than described in its commit.

### Child→parent transport

The `question.md` file in the same temp set as the result file
(`createAgentTempFiles` in `utils.ts`).

Two deviations from the original idea, both in favor of simplicity:

- **`question.md`, not `question.json`.** A question is one free-form text;
  JSON would add nothing but parsing. Path validation is the same as for
  `result.md` (`isManagedAgentFile`).
- **No second marker in the prompt.** The question path is derived from
  `HERDR_RESULT_FILE:`, which the child already receives: `questionFileFor(resultFile)` takes
  the same directory. One marker — one source of truth.

The mechanics — **variant C**, simpler than both originals:

1. `ask_question` writes `question.md` and **immediately returns** (no
   dialog, no blocking).
2. `CHILD_PROTOCOL` requires the turn to end right after the question, with no
   further tool calls and no `HERDR_RESULT`.
3. The turn ends → the child becomes `idle` → the **existing**
   `herdr agent wait --until idle --until done` fires by itself.
4. Before reading the result the parent checks `question.md`: if the file exists —
   return early with status `question`, the one-shot is not closed.

So there is neither parallel polling, nor cancelling the wait, nor new flags:
the same wake-up path is used through which every normal result arrives today.
Variants A and B are dropped.

The price: a child that fell into a **real** approval dialog (not our
`ask_question`) stays `working` and is indistinguishable from a working one until the
timeout. This is not a regression — that is the state today — but phase 2 does not cure
it either.

### An empty turn after a tool result — provider behavior

In child session logs there is:

```
assistant: content:[] output:0 stopReason:"error" errorMessage:"Internal error"
assistant (retry): "<short text>"
```

kiro-acp retries, so functionally nothing breaks, but it is noise in the
pane and an extra round trip to the model.

**This is not our defect.** At first I decided the cause was the `ask_question`
wording "End your turn now", because the error came right after its
tool result (3 out of 4 calls). Checking every session disproved this: the same
error appears in sessions from August 25–26, when `ask_question` did not exist yet,
1–4 occurrences per session, and at least once — right after a `toolResult` from
`herdr_agent`. So this is a general "empty turn after a tool result" pattern in
kiro-acp, not a consequence of our instructions.

What was changed anyway and why: the wording "end your turn immediately" is ambiguous —
it can be read as "give back nothing". Now both `ask_question` and
`CHILD_PROTOCOL` ask for **one short line** of confirmation. This removes the
ambiguity and cannot hurt, but presenting it as a bug fix
would be wrong — after the change 2 of 2 calls were clean, which given the base rate
is clearly not enough to conclude anything.

The short line lands in the result artifact, but cannot hurt:
`question.md` is checked **before** the result, and the next prompt clears the
artifact.

### Parallel deliveries — batching into one turn

Verified with two agents asking simultaneously. Both questions were delivered, but
**in different turns**: the first raised a turn, the second arrived only after it
finished.

Here I was wrong twice, and both mistakes are worth recording.

The first: I checked the orchestrator log while still in that same turn, saw
one delivery and decided the second was lost. `deliverAs: "steer"` by
definition delivers **after** the current turn's tool calls finish, so at the moment of
checking it could not have been there. **Rule: delivery cannot be assessed
inside the turn it raised.**

The second: having decided this was a collision, I limited delivery to one per tick. That
does not cure the symptom — on the next tick the orchestrator is already streaming the turn raised by
the first delivery, so the second would have gone as a `steer` into the same queue
anyway.

The real reason for the spread across turns: **the very first send triggered a turn**, and
everything after it had to wait behind it. The solution is the opposite of limiting —
**batching**: all outcomes of one tick are sent together, with `triggerTurn` only
on the last one.

### What batching does not cure

Verified with two agents: both questions delivered, but again in different
turns. The reason — they finished in **different ticks**, so each batch had
one message, and the first raised a turn that the second waited behind.

So batching helps only when several outcomes are ready within one tick.
Real cases: several agents finish in the same second, or the session
starts/reloads when several detached agents are already finished — then the very
first tick sees them all.

**The general case is not cured at all.** If agents finish more than a tick
apart, the second inevitably waits for the turn raised by the first:
`steer` delivers "after the current assistant turn finishes executing its tool
calls", and that is the earliest moment available. A workaround via `followUp` would give later,
via `nextTurn` — no trigger at all. So this is Pi's ceiling, not ours.

Batching was kept, because in its case it is strictly better and has no downsides, but
the original symptom (the second outcome arriving at the end of the cycle) persists for
different ticks.

### Files

- `utils.ts` — `createQuestionFile`, `readAgentQuestion`, `clearAgentQuestion`;
- `constants.ts` — `CHILD_PROTOCOL`: when asking is allowed (ambiguous requirements,
  a decision that changes scope), what to do next, the ban on asking about trivia;
- new `child.ts` — moving child mode out of `index.ts`: result writer +
  registration of the `ask_question` tool;
- `index.ts` — add `ask_question` to the child's `--tools` **only** when
  the profile sets `tools` (otherwise there is no flag and the tool is available anyway);
  the result branch `status: "question"`;
- `herdr.ts` — the hook that cancels the wait on a question;
- `schema.ts` — clarify the `task` description: it is also the channel for answering a question;
- `widget.ts` — a marker "has an unanswered question". Taking it from `agent_status`
  **will not work**: after a question the child finishes its turn and becomes `idle`, i.e.
  indistinguishable from a persistent agent that simply waited. A separate
  flag in the state record is needed (e.g. `pendingQuestion`), set on early
  return with status `question` and cleared on the next prompt.

### Tasks

- [x] Extract child mode into `child.ts`, preserving the result writer behavior.
- [x] Register `ask_question` only with `HERDR_AGENT_CHILD=1`; the `question: string` parameter, returning the confirmation "question sent, wait for the next turn".
- [x] The child must not end the turn with a normal `HERDR_RESULT` after a question — spelled out in `CHILD_PROTOCOL`.
- [x] Add `ask_question` to `--tools` when the profile sets `tools`. The mechanics are verified (see "Allowlist gate"): there is no other path — the child cannot enable the tool itself.
- [x] `ask_question` does not block the turn: it writes the file and returns. No `ctx.ui.*` dialogs — otherwise the child would stay `working` and the parent would not wake up until the timeout.
- [x] The parent checks `question.md` **before** reading the result, in the existing branch after `waitForAgent`. Do not add a new wait.
- [x] Result format to the parent: label, profile, the question text, an explicit instruction to answer with `herdr_agent` using the same `tabLabel`.
- [x] Do not close the one-shot target on `status: "question"`.
- [x] Clear `question.md` before every prompt (like `clearAgentResult`) — so an old question does not fire twice.
- [x] Reuse of a parked one-shot: the pane is reused by label when there is an unanswered question on disk. Found by a live test, not by the tests.
- [x] Tests: question round trip via file, empty/whitespace question, absence of a channel, independence from the result file, cleanup together with the temp dir, allowlist (4 cases). Parallel questions from two agents — not covered.

### Verification

`bun test` — 95 pass / 0 fail (11 new), `prettier --check` clean, the extension
loads (`pi -p`).

The live cycle passed twice, both times without attaching by hand.

**Persistent:** an agent with a deliberately ambiguous task called
`ask_question` → the parent returned the question as an early result, the agent stayed
open → an answer with the same `tabLabel` → the agent finished with a normal
`HERDR_RESULT`. There was no repeated delivery of the question, meaning `question.md`
is correctly cleared before the prompt.

**One-shot:** the same, plus a pane identity check. After the question —
1 managed agent `w2V:p3R` with `q=yes`. After the answer — 0 managed
agents, `panes: 1 splits: 0`. Had the answer gone to a new pane, the parked one
would have remained in the list; it is not there, so reuse worked and the one-shot
closed exactly after the real completion.

The first one-shot run **failed** here: reuse was limited by
`if (persistent)`, the answer created a second pane, and the first was orphaned. The unit
tests did not see this — each part was correct on its own, the seam broke. This is
an argument for a live gate in every phase, not just for tests.

### Gate — passed

- [x] Full cycle question→answer→result on a live agent, without attaching
      by hand — for both `persistent` and `oneshot`.
- [x] No path leaves an orphaned pane after the answer (verified
      by comparing pane ids before and after).
- [x] A parked question does not close the one-shot prematurely.
- [x] `bun test` green, `prettier --check` clean, the extension loads.

### Risks

- A child can spam questions — limit it to one open question per agent.
- `--tools` allowlist: if Pi does not let an extension tool through the allowlist,
  the phase stops. Verify **as the first step**, before anything else.

---

## Phase 3 — Loadout snapshot (deliberately dropped)

**Decision: do not do it.** Reasons, in order of weight:

1. **The original justification is gone.** The phase was in the plan as a prerequisite for
   asynchronous delivery. Phase 4 was done without it — delivery rests on the
   poller and the `detached` flag, not on a loadout snapshot.
2. **The scenario is narrow.** Divergence is possible only if the agent profile is edited
   *mid-session* and then a persistent agent created before the edit is
   reused. The default `oneshot` is not affected at all — it resolves the profile
   anew every time.
3. **The cost of the mistake is small.** The agent runs with slightly older instructions rather than
   breaking. Compared with what phases 2 and 4 cured — there the result or the
   question were lost without a trace.

If it is ever needed, a cheaper option instead of the full scheme: write only the hash of the
profile file into the record and add a warning line to the tool result on
divergence. That covers most of the benefit without versioning the state schema and
migrating old state files.

### The problem it was supposed to close

Recorded so it does not have to be rediscovered. `state.ts` remembers **where** the agent is
(pane, label, lifecycle) but not **what** it was launched with. The profile is resolved once
at spawn: model, tool set, system prompt from
`~/.pi/agent/agents/<name>.md`. After that file is edited, the next reuse
prompts a process that still lives by the old prompt, while the orchestrator believes it is on
the new one. Silently, without an error.

---

## Phase 4 — Async agent result delivery

### What already exists and what does not

`wait: false` exists and works: the tool sends the prompt and immediately returns
`… is still running` with `waited: false`. So **parallelism exists, delivery does
not**.

Verified live: an agent spawned with `wait: false` did its work, wrote
318 characters into the result artifact and became `idle`. Observation for 28 s —
**nothing arrived** at the orchestrator: no tool result, no message, no turn. Completion
could be discovered only with an external shell command. The result could be picked up only
by hand: `herdr_agent` with the same `tabLabel` and no `task` (re-wait) — it returned the full
`HERDR_RESULT`.

So collection is initiated by the parent. If it forgets to re-wait, the child's work
simply disappears, and nothing reminds anyone about it. The widget from phase 1 shows the
status, but it is seen by a **human**, not the model — it does not enter the orchestrator's
context.

### Scope re-estimate

The original estimate "effectively a rewrite of `index.ts`" was written **before** phase 1 and
no longer holds. Phase 1 already provided what was missing: a **background
observer**. The widget poller ticks once a second and already knows the status of every
managed agent — and after the tool returns, nobody watches the agent
anymore.

So this is no longer an architecture change but a superstructure on the existing poller:

1. a flag in the state record "spawned as `wait: false` and not collected yet"
   (e.g. `detached: true`), set on the early return and
   cleared after delivery. In the state file, not in memory — otherwise it would not
   survive `/reload`;
2. in the poller tick: `detached` + status `idle`/`done` + a result on disk →
   deliver, clear the flag;
3. delivery via `pi.sendMessage`, closing the one-shot after delivery.

The blocking path (`wait: true`) stays as is. This matters: phase 4 no longer
**cancels** soft re-wait (`b6ee710`), the `wait: true` default and the early question
return from phase 2 — it adds a second mode instead of replacing the first. This is exactly
where the original estimate was most wrong.

### Delivery mechanics — verified facts

- `pi.sendUserMessage` **is not suitable**: it looks "as if typed by the
  user", which for an agent-completion notification is semantically
  wrong, and it always triggers a turn.
- `pi.sendMessage({ customType, content, display }, { triggerTurn: true,
  deliverAs: "steer" })` — the right tool: a custom message that
  participates in the LLM context, with its own renderer.
- `deliverAs: "steer"` (the `sendMessage` default) delivers **after the
  current assistant turn finishes its tool calls, before the next LLM call**.
  This removes the worst risk: if the orchestrator is at that moment blocked
  on another agent, the notification queues up instead of interleaving with the wait.
- The streaming guard is `ctx.isIdle()`; `deliverAs` is required only while
  streaming (`sendUserMessage` without it throws). The pattern is in
  `examples/extensions/send-user-message.ts`.

### Tasks

- [x] `state.ts`: a `detached?: boolean` field in the record; set on `wait:
      false`, cleared after delivery.
- [x] `index.ts`: `detached: !wait` is set in a single place —
      `recordAgentLifecycle` on the spawn/reuse path, not in the return branches.
- [x] Poller: detect "detached + settled + result present" → deliver. The delivery
      step stands **before** rendering, because rendering has early exits.
- [x] Delivery via `sendMessage` with `customType: "herdr_agent_result"` +
      `registerMessageRenderer` (not `registerEntryRenderer` — that one is for
      `appendEntry`, which deliberately does **not** participate in the LLM context).
- [x] Closing the one-shot after delivery, and as a consequence — the restriction
      `oneshot ⇒ wait: true` was removed. It remains only for headless (`!ctx.hasUI`), where
      there is no poller, so nobody is there to deliver or close.
- [x] Dedup: an atomic `claimDetachedAgent` — reading and clearing the flag in
      one locked read-modify-write. The claim is taken **before** sending: a failed
      delivery loses the notification, but never duplicates it.
- [x] Synchronous collection (both branches: wait and re-wait) also releases the claim.
      Otherwise a manual re-wait and the poller would deliver the result twice.
- [x] `GLOBAL_INSTRUCTIONS`: with `wait: false` the result arrives by itself; plus
      an explicit ban on starting the delegated work yourself while a detached agent is
      working on it.
- [x] A question from a detached agent is delivered through the same channel, with a separate
      type `herdr_agent_question`. The check stands **before** the result — the
      same order as in the blocking path, because the child settles after a question
      the same way it does after completion, and the artifact may already contain its text.
      The target is not closed, `question.md` stays on disk (this is what keeps reuse by
      label), the answer is a normal `task` with the same `tabLabel`.

### Verification

`bun test` — 103 pass / 0 fail (8 new: dedup, a race of three simultaneous claims,
flag persistence across reload, the settled predicate), `prettier --check`
clean, the extension loads.

Live runs:

- **Delivery without re-wait.** A one-shot with `wait: false` (previously a forbidden
  combination) did its work, the result arrived **by itself** as a new turn prefixed
  `[herdr agent]`. The pane closed: `panes: 1 splits: 0`, the state entry
  removed. Repeated on a long task (7 files) — the same.
- **Dedup.** Spawn with `wait: false`, immediately intercepted by a manual re-wait. After
  collection `detached=false`, and the result **stayed on disk** — that is, exactly the
  condition under which a wrong implementation would deliver it a second time. No second copy
  arrived.

### Gate — passed

- [x] The result of a detached agent reaches the orchestrator without any action on its
      part.
- [x] A detached one-shot closes itself after delivery.
- [x] Exactly one delivery under competition between the poller and a manual re-wait.
- [x] `bun test` green, `prettier` clean, the extension loads.

### Decision

- **`triggerTurn` is accepted.** A turn may rise while a human is typing —
  deliberately agreed, as in the fork. The price of delivery is lower than the price of a lost
  result.

### Risks

- **The guarantee "do not duplicate delegated work"** was written for the blocking model.
  With async, the orchestrator may start the same work while the child is still
  working — the instructions need clarification.
- Dedup across `/reload` — the only genuinely non-trivial part.

### What to do next

Phase 3 (loadout snapshot) is no longer a prerequisite for phase 4: delivery
rests on the poller and a state flag, not on a loadout snapshot. So the
order 3→4 can be changed, and phase 4 now has higher value than phase 3 —
it closes a real hole (a lost result), whereas phase 3 gives
a warning about profile divergence.

---

## Shared rules for all phases

- Tests: `bun test` in the extension directory; pure functions are tested, I/O is not.
- Smoke: `bun build` (the command is in phase 1) — must pass without errors.
- **A new file in the package requires `stow --restow pi` before reload.** Stow
  symlinks the `pi` package **per file**, not as a directory, so a fresh module
  exists in the repo but not in `~/.pi/agent/extensions/herdr-agents/`. Pi fails with
  `Failed to load extension: Cannot find module './<new>.ts'` and **all
  plugin tools disappear** — it looks like "the tool vanished", not like a compile
  error. Every subsequent phase adds a new file, so the sequence is always:
  `stow -d ~/dotfiles -t ~ --restow pi` → check `pi -p "reply with OK only"`
  → `/reload`.
- Extension loading must be checked headless: `pi -p "reply with OK only"`
  prints a loading error to stderr. `bun build` does not catch it, because
  `@earendil-works/*` are external host packages (`pi-tui` sits nested inside
  `pi-coding-agent/node_modules`, not installed separately).
- After changing symlinked files: `/reload` or a Pi restart.
- Update `AGENTS.md` and `docs/README.md` in the same commit that changes behavior.
- Commit format as in the plugin's history: `feat(herdr-agents): …`, `fix(herdr-agents): …`.
- Prettier with standard settings (`printWidth` 80). Commit `a4b0d7c`
  says "72-char" in the title, but in fact the files are clean under the defaults:
  `npx prettier@3 --check *.ts`.
