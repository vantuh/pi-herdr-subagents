# Agent panel metrics: what comparable subagent UIs show

Research report, not an implementation plan. It answers what the seven reference
projects actually render in comparable panels, and which of those fields fit our
`/herdr-agents` row if cwd and pane ID are dropped.

## Scope and method

- Inspection date: **2026-10-18**. Static source only.
- Evidence: three supplied research reports (subagent panels, interactive panels,
  Herdr-oriented panels) plus two completed scoped audits over the same pinned
  commits, all reading upstream source through read-only GitHub APIs, plus local
  source verified in this repository.
- The audits verified renderer and collection behavior for the two interactive
  forks and for the three Herdr-oriented projects. They confirmed the central
  comparison, corrected Amos's status glyphs, and narrowed completion and context
  claims. They did not audit mavam/pi-agents or badlogic/pi-subagent, so those
  sections rest on the supplied report alone.
- Not verified here: the SDK formula behind a context percentage, whether recorded
  cost corresponds to billing, native Herdr Agents-view columns, and any runtime or
  screenshot behavior. No upstream project was executed, no TUI was launched, and
  no screenshot was taken; refresh cadences, colors, and terminal fitting come from
  code.
- Local claims cover only named local files; private Pi session contents were not
  read.

## Source pins

All upstream claims below refer to these revisions.

1. **mavam/pi-agents** — `adae290d038ec150439638a510c73a31f6d5b71c` (`v0.34.0`), 2026-10-16 08:53:09 UTC:
   [format.ts](https://github.com/mavam/pi-agents/blob/adae290d038ec150439638a510c73a31f6d5b71c/src/ui/format.ts#L190-L335),
   [panel.ts](https://github.com/mavam/pi-agents/blob/adae290d038ec150439638a510c73a31f6d5b71c/src/ui/panel.ts#L1-L115),
   [commands.ts](https://github.com/mavam/pi-agents/blob/adae290d038ec150439638a510c73a31f6d5b71c/src/pi/commands.ts#L70-L300).
2. **badlogic/pi-subagent** — `4fc1fe5178d1a2b474794a5ee39e7295844e9d3c`, 2026-09-30 11:06:44 UTC:
   [index.ts widget and timer](https://github.com/badlogic/pi-subagent/blob/4fc1fe5178d1a2b474794a5ee39e7295844e9d3c/index.ts#L120-L190).
3. **amosblomqvist/pi-interactive-subagents** — `c3e8b53c0754ae5ccc19fdab5a7481ec039bc2f7`, 2026-08-24T23:21:20Z:
   [index.ts widget](https://github.com/amosblomqvist/pi-interactive-subagents/blob/c3e8b53c0754ae5ccc19fdab5a7481ec039bc2f7/pi-extension/subagents/index.ts#L723-L774),
   [result card](https://github.com/amosblomqvist/pi-interactive-subagents/blob/c3e8b53c0754ae5ccc19fdab5a7481ec039bc2f7/pi-extension/subagents/index.ts#L2358-L2459),
   [session aggregation](https://github.com/amosblomqvist/pi-interactive-subagents/blob/c3e8b53c0754ae5ccc19fdab5a7481ec039bc2f7/pi-extension/subagents/session.ts#L553-L625).
4. **HazAT/pi-interactive-subagents** — `c100577ebf7393a11d098ad9810ec6c269dcfc30` (`v3.7.2`), 2026-05-12T22:21:02Z:
   [index.ts widget](https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L599-L649),
   [result renderer](https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L2014-L2082).
5. **IgorWarzocha/howaboua-pi-stuff (`pi-shepherdr`)** — `187a70d621ccc99b119166e55fcd568e5b4f605e`, 2026-10-16 09:29:03 UTC:
   [widget.ts](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/187a70d621ccc99b119166e55fcd568e5b4f605e/packages/pi-shepherdr/src/widget.ts#L1-L111).
6. **boadij/pi-herdsman** — `36ea3f9f8e78f3fce169d4a8e3f91df397d4aee4`, 2026-10-18 17:26:42 UTC:
   [presentation.ts `buildStatusRows`, `renderStatusLine`, `renderRunningOptions`, `renderCompletionMessage`](https://github.com/boadij/pi-herdsman/blob/36ea3f9f8e78f3fce169d4a8e3f91df397d4aee4/extension/presentation.ts),
   [managed-agent-runtime.ts](https://github.com/boadij/pi-herdsman/blob/36ea3f9f8e78f3fce169d4a8e3f91df397d4aee4/extension/managed-agent-runtime.ts),
   [agent-controller.ts](https://github.com/boadij/pi-herdsman/blob/36ea3f9f8e78f3fce169d4a8e3f91df397d4aee4/extension/agent-controller.ts).
7. **giuseppecrj/pi-herdr-agents** — `e03378c851a3cb554b62c95b8ccba9ae1b84c421`, 2026-10-16 16:47:51 UTC:
   [index.ts `renderSubagentWidgetLines`, `formatLifecycleWidgetLabel`](https://github.com/giuseppecrj/pi-herdr-agents/blob/e03378c851a3cb554b62c95b8ccba9ae1b84c421/pi-extension/subagents/index.ts).

The two interactive forks are not interchangeable: their `index.ts`, `session.ts`,
and `activity.ts` blobs differ, while `status.ts` matches exactly
(`970dbe63ef7eafcfb0698f5ceebd66974a03f899`). Amos alone added completed-card
metrics.

## Three surfaces, not one

Comparable projects render three different things, and mixing them produces wrong
conclusions: the live widget above or below the editor, the list or selector used
to focus, attach, or close one, and the completed card or tool result. Observed
placement of metrics:

| Project | Live widget | List/selector | Completed card |
|---|---|---|---|
| mavam/pi-agents [1] | unfocused: status counts only. Focused panel: per-agent status, name, dependency note, profile, model, elapsed while working, cumulative tokens and cost, activity text, queued-result note | `/agents` overlay, a different renderer: name, profile/ad-hoc, short model, runtime always (idle and closed too), tokens+cost, queued note; cwd only in the selected-detail header | receipt rows: outcome, name, profile/model, usage; no elapsed, no context% |
| badlogic/pi-subagent [2] | `name:state` only | attach selector: name, handle, state, provider/model, thinking; read once at open | CLI only (`list`, `status`, `wait`) |
| amosblomqvist [3] | elapsed `MM:SS`, name, profile, activity label + duration; glyph per state | none separate (widget is the list) | initial Pi completion: optional session-derived model, tool count, elapsed, tokens, cost, context%; Claude-backed and resumed cards lack stats |
| HazAT [4] | elapsed `MM:SS`, name, profile, activity label; no per-row glyph | none separate | outcome, elapsed, summary only |
| pi-shepherdr [5] | machine, name, status, cwd basename or pane ID | `/herdr` status list is machines, not agents | tool result: target/name + state |
| pi-herdsman [6] | definition, label, state, elapsed, model, thinking, context%; header carries separate current-pane tool metadata | Running selector option labels: tree, definition, label, state; task help supplied separately | outcome, elapsed, context%; cumulative tokens/cost only in an on-demand session-stats notification |
| pi-herdr-agents [7] | elapsed `MM:SS`, name, profile, model\|thinking, lifecycle/activity label + duration | none | outcome, elapsed, model, summary, resume reference |

Where the metrics actually live:

- **Elapsed time**: mavam's focused panel, both interactive forks, pi-herdsman, and
  giuseppecrj/pi-herdr-agents; badlogic and pi-shepherdr show none. **Context
  percentage**: one live row (pi-herdsman) and pi-herdsman's completion card,
  nowhere else live. **Activity text**: mavam's focused panel, both interactive
  forks, and pi-herdr-agents; descriptive rather than a completion percentage.
- **Cumulative tokens and cost**: mavam's focused panel and its `/agents` list. pi-herdsman keeps them outside live rows in an on-demand
  notification; Amos adds them to eligible completion cards, while HazAT does not.

## Strongest examples

- **pi-herdsman live row** — the closest match to the requested field set:
  `⠋ scout research ● working 1m 5s claude-sonnet high 42% Inspect renderer`. Field
  order: connector, spinner, definition, label, marker+state, elapsed, model,
  thinking level, integer context percent, optional inactivity, optional task
  preview; pane/session IDs stay in row data and are not printed. Responsive
  layouts drop task, then elapsed, then context, so fields are available, not
  guaranteed visible at every width.
  [presentation.ts](https://github.com/boadij/pi-herdsman/blob/36ea3f9f8e78f3fce169d4a8e3f91df397d4aee4/extension/presentation.ts#L110-L680)
- **mavam focused panel** — the only live display with cumulative tokens and cost,
  and it suppresses runtime once the agent stops:
  `◉ reviewer explorer terra 1m32s 15.5k $0.040 Using grep`. Tokens are
  `input + output + cacheRead + cacheWrite` from durable usage state plus the
  uncommitted streaming message; zero totals are omitted, not shown as unknown. Its
  `/agents` overlay is a different renderer that always formats runtime, never
  appends live activity, and prints cwd only in the selected-detail header.
  [format.ts](https://github.com/mavam/pi-agents/blob/adae290d038ec150439638a510c73a31f6d5b71c/src/ui/format.ts#L190-L335),
  [derive.ts](https://github.com/mavam/pi-agents/blob/adae290d038ec150439638a510c73a31f6d5b71c/src/agents/derive.ts#L95-L150)
- **Amos completed card** — the only completed-surface token/context/cost example,
  and conditional: `↑3.2k ↓850 R45k W1.2k $0.123 18.0%/200k`. Stats are collected at
  initial Pi completion; Claude-backed completions collect none, and the
  resumed-result delivery path omits `stats` although its watcher computes them.
  [session.ts](https://github.com/amosblomqvist/pi-interactive-subagents/blob/c3e8b53c0754ae5ccc19fdab5a7481ec039bc2f7/pi-extension/subagents/session.ts#L553-L625)
- **badlogic widget** — the minimal live surface: `subagents: scout:busy |
  reviewer:idle`, first five active runs with `+N` overflow, cleared when none
  remain. [index.ts](https://github.com/badlogic/pi-subagent/blob/4fc1fe5178d1a2b474794a5ee39e7295844e9d3c/index.ts#L120-L190)

The row we want to move away from is the sibling `pi-shepherdr` widget:
`│ ◉ Local / scout working · project` — status plus cwd basename with pane ID
fallback, no time, model, tokens, or context.
[widget.ts](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/187a70d621ccc99b119166e55fcd568e5b4f605e/packages/pi-shepherdr/src/widget.ts#L1-L111)

## Exact semantics to keep straight

**Elapsed time** has three meanings and three formats:

- mavam focused panel and `/agents`: lifetime wall time, `now - createdAt` while
  working or waiting and `(endedAt ?? stateSince) - createdAt` otherwise, clamped at zero,
  floored to seconds (`8s`, `1m32s`, `2h03m`); a resumed counter jumps across the
  pause. The overlay's "started … ago" is recomputed age, a different value from
  the frozen runtime on the same agent.
- pi-herdsman: per-assignment elapsed formatted `59s`, `1m 5s`, `1h 2m`; missing,
  invalid, negative, or future timestamps omit the field.
- Both interactive forks and giuseppecrj/pi-herdr-agents: per-assignment elapsed as
  zero-padded `MM:SS`, minutes able to exceed 59 (`120:05`).

**Cumulative tokens are not context occupancy.** mavam's figure is accumulated
consumption and spend. Amos's percentage is a heuristic: the **last positive**
recorded `usage.totalTokens` over a hardcoded model-family window (`claude` 200k,
`gpt-4.1`/`gpt-4o` 128k, `gemini` 1M, else raw tokens), not Pi's authoritative
current-context measurement; a model change can pair an older total with the
newer model's assumed window. Amos sums assistant usage across the whole session
file, including copied parent entries in fork mode, so totals are not necessarily
this child task's consumption. Its tool count counts emitted `toolCall` blocks,
not verified successful executions.
[fork copying](https://github.com/amosblomqvist/pi-interactive-subagents/blob/c3e8b53c0754ae5ccc19fdab5a7481ec039bc2f7/pi-extension/subagents/session.ts#L35-L81)

**Context percentage.** pi-herdsman delegates estimation to Pi: the child samples
`ctx.getContextUsage()` at `turn_end`, rounds `percent`, clamps it to 0–100, and
publishes it through `herdr pane report-metadata`; the parent accepts an integer
0–100. Unknown or null clears the field, and a new assignment clears the previous
value. Live metadata clamps while the completion card only rounds, so identical
displayed percentages are not guaranteed, and widget refresh is not measurement
refresh. Raw `tokens` and `contextWindow` exist in the completion details, but the
renderer prints only the percentage.

**Activity and tool metadata.** mavam maps a running tool slot to `Using <tool>`
and a reasoning headline, with `no activity for <duration>` after 60s, truncated to
120 characters; its comment says this is not a completion percentage. The
bracketed tools in pi-herdsman's header are the **current pane's** active-tool
metadata, not a per-agent tool count.

**Stalled and idle.** HazAT and Amos mark `stalled` after 60 seconds of missing,
invalid, or wrong-ID activity observations, while a healthy `active` snapshot still
classifies as active; `done` renders briefly as `waiting · done`. giuseppecrj/
pi-herdr-agents produces `stalled` only after authoritative pane inspection fails
for 60 seconds, never from missing enrichment alone. No 60-second stalled rule was
verified for pi-herdsman or pi-shepherdr. badlogic's `idle` is the recorded state
of a completed-but-running child and its `exited` derives from a missing tmux
session: state mappings, not observation artefacts.

**Refresh cadence** (code-derived): mavam 1000ms panel and 500ms overlay while
working; badlogic 1000ms; HazAT/Amos 1000ms widget and status with 500ms throttled
activity writes; pi-herdsman 120ms animation invalidation with 10s reconciliation;
giuseppecrj/pi-herdr-agents 1000ms widget and status, 500ms writes. None sample
context every tick.

## Unknown and limitations

Missing values are part of each project's contract, and the set is inconsistent:

- mavam: missing or non-finite usage becomes zero and zero totals are omitted, so a missing usage field is indistinguishable from genuine zero usage.
- Amos: `null` statistics hide the metric line; zero categories are omitted; a missing
  elapsed duration displays `?`. HazAT likewise prints `?` for a missing duration and
  has no token or context metrics to be unknown.
- pi-herdsman: missing model, thinking, context, elapsed, or task fields are
  omitted; failed refresh keeps the previous snapshot flagged `stale`, and a first
  failure says `unavailable`; `ctx.getContextUsage()` can return `tokens: null`
  after compaction until the next LLM response.
- giuseppecrj/pi-herdr-agents: activity enrichment is optional, so a row can degrade to `running…` or a generic
  Herdr `agent working`; the recorder disables itself after three consecutive write failures.
- pi-shepherdr: connectivity replaces status (`offline`, `(last seen)`) and adds
  `monitoring incomplete` / `monitoring unavailable` lines. badlogic has no
  placeholder, because these metrics are not collected at all.

Preserve **omitted (not collected) vs unknown (collected but unavailable) vs a real
zero**, where only the last may render as `0`. The set has no shared marker for the
middle case: HazAT and Amos print `?` for a missing duration, pi-herdsman omits
empty fields and flags a stale snapshot, and mavam erases the difference by
turning missing usage into an omitted zero. Timestamps likewise have two roles:
badlogic stores `createdAt`/`updatedAt` and cwd as non-UI data, and mavam's stored
runtime is display state, whereas archival timestamps do not reliably measure
execution duration.

## Our local baseline

Verified by reading local files, not inferred from upstream:

- `/herdr-agents` (`src/ui/manager.ts`, `pickAgentAction`) renders `label (agent)`
  rows with description `status:<colored> • pane:<paneId> • <cwd>` for live agents
  and `closed • <localized closedAt> • <cwd>` for closed history. This overlay has
  **no selected-detail area**: the description is the only place those values
  appear, beside the focus and close actions.
- `src/ui/widget.ts` (`renderAgentWidgetLines`, `elapsedLabel`) renders elapsed,
  label, and a mapped status, printing `--:--` when the stamp is absent or unparsable.
- That elapsed comes from the state record `updatedAt`, which is mutable
  bookkeeping rather than an assignment start. Writers: `recordAgentLifecycle`
  (`src/state/lifecycle.ts`, called from the spawn flow, restamping on every spawn
  and question continuation) and `stageClosedOneShot` (`src/state/closed-history.ts`,
  setting `live.updatedAt = now` while archiving). `src/state/store.ts` defaults a
  missing value to `1970-01-01T00:00:00.000Z` for older state,
  `src/herdr/placement.ts` passes it through, and `src/state/live-records.ts`
  prunes and rekeys records on pane moves without touching it, and finalizing
  deletes the live record; the widget's elapsed is a hint, not a verified
  per-assignment duration.
- `src/child.ts` (`captureChildSessionMeta`) publishes
  `ChildSessionMeta { sessionId, cwd, sessionFile?, updatedAt? }`
  (`src/artifacts/schema.ts`) through `writeAgentSessionMeta` (`src/artifacts.ts`,
  `HERDR_AGENT_SESSION_META`) at `session_start`, after every assistant
  `message_end`, and on `ask_question`: a per-message publish channel with **no
  metric fields today**.
- Closed-history records (`src/state/schema.ts` `ClosedAgentHistoryRecord`) carry
  `createdAt`/`closedAt`, and finalizing rewrites `closedAt`: archival stamps, where
  neither measures task duration and nothing stores a per-assignment start/end pair.
- Installed Pi **1.3.0** exposes `ctx.getContextUsage(): ContextUsage | undefined`
  (`ContextUsage { tokens: number | null; contextWindow: number; percent: number | null }`)
  and returns `undefined` when no model or context window is known. Pi's
  `getSessionStats()` lives on `AgentSession`, **not** on the extension context,
  which reaches session entries through `ctx.sessionManager.getEntries()`.
- Pi's cumulative totals (its `getSessionStats` loop) add usage from standalone
  `usage` entries, `compaction` and `branch_summary` entries carrying `usage`,
  `toolResult` messages carrying `usage`, and every assistant message's `usage`;
  total is `input + output + cacheRead + cacheWrite`. A local implementation must
  use that same rule set, or the number will disagree with Pi's own session totals.

## Proposal (not implemented)

Labeled proposal only; no code, schema, or test change accompanies this report.

Primary rows, live then closed:

```text
01:05  scout            working                42% ctx   ·  128k session
01:47  reviewer         blocked · attach       —         ·  64k session
02:31  research         done · 2026-10-18 18:12   38% ctx  ·  210k session
```

Fields, in order: assignment elapsed from a dedicated persisted assignment start
(closed rows show the frozen final duration); the label from managed state; status
via `agentStatusView` including the `blocked · attach to unblock` hint; last known
context percentage from `ctx.getContextUsage().percent`; cumulative session tokens
for the whole child session.

Rules, so the row stays honest:

- cwd and pane ID leave the primary row. The overlay has no selected-detail area
  today, so this deliberately removes them from that surface; their identifiers
  stay in managed state for focus, close, and pane placement. Adding a details view
  is a separate decision, not part of this proposal.
- Unknown context or tokens render as `—`, never `0`; a displayed `0` means a
  measured zero. Context percentage always comes from `ctx.getContextUsage()`, not
  from a hardcoded model-window table like Amos's. Do not reuse `updatedAt` as the
  assignment start, or the archival `createdAt`/`closedAt` as duration.
- Cumulative tokens are cumulative **session** usage, labeled as such where the row
  could be read as task usage; on resume the number includes prior assignments, so
  the row should say session, not task. Active execution time is not derivable from
  anything stored, so elapsed must not be presented as execution time.
- Do not add cost, tool counts, task previews, or progress percentages here:
  separate decisions, and the seven projects do not agree on them.

Data sources, should it be accepted later: context percent and cumulative session
tokens published through the existing `captureChildSessionMeta` path (extending
`ChildSessionMeta`), the latter computed from the child's own session entries with
the rule set Pi's session statistics use; assignment elapsed from a new persisted
assignment-start stamp written when a task is sent, with an end timestamp and final
duration frozen at settle, so a closed row reports task duration, not pane lifetime
or archive time.

## Limitations of this report

- Static source only; no runtime, provider, billing, or terminal-layout check.
- The two audits covered the interactive forks and the three Herdr-oriented
  projects at the pinned commits; mavam/pi-agents and badlogic/pi-subagent claims
  rest on the supplied report alone and were not re-derived here.
- The SDK formula behind a context percentage, correspondence between recorded cost
  and billing, and native Herdr Agents-view columns remain unverified.
- Local reasoning covers only the named files; session-file contents were not read,
  and the proposal is a design sketch, not a verified implementation.
