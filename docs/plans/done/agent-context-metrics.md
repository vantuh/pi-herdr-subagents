# Plan: absolute context metrics for the widget and the agent list

Approved scope: show the child's **current** context as absolute tokens over the
model's capacity (`ctx 38k / 200k`) in the above-editor widget and in the live
`/herdr-agents` rows, replacing the pane/cwd description there. No percent, no
cumulative usage or cost, no detail panel, no new timing schema, no new
dependency or config, no change to navigation, focus, close, spawn, or delivery.

## Sources verified

- Pi `1.3.0` `dist/core/extensions/types.d.ts`: `ctx.getContextUsage()`
  returns `ContextUsage { tokens: number | null; contextWindow: number; percent:
  number | null }` or `undefined`; `tokens` is `null` after compaction until the
  next LLM response.
- Pi `1.3.0` `dist/core/agent-session.js`: `message_end` extension handlers run
  before `sessionManager.appendMessage(event.message)` (persistence), while
  `turn_end` (the `finishTurn` boundary) requires the assistant message to be
  persisted already. So `message_end` would sample the context **before** the
  finished turn lands in the projection; `turn_end` samples it after.
- `docs/research/agent-panel-metrics.md` is guidance only; its proposal
  (percentages, cumulative session tokens, assignment durations) is out of
  scope. This plan implements the current-context subset.

## Data channel (existing, extended)

`ChildSessionMeta` (`src/artifacts/schema.ts`) gains an optional
`context: ContextMetrics` with `tokens: number | null` (non-negative) and
`contextWindow: number` (positive). Reading uses a separate tolerant
`ChildSessionMetaInput` whose `context` is `unknown`, and
`readAgentSessionMeta` (`src/artifacts.ts`) reconstructs its result object
passing the sample through explicitly — the schema alone would drop it. The
sample is validated on its own with `Value.Check(ContextMetrics, …)`, so a bad
sample leaves the session identity and path that close and resume need intact
instead of failing the whole read. `before_agent_start` writes the interruption
marker before the display publish, because a failed publish must not leave the
run unguarded.

`src/child.ts` publishes the sample over the existing private meta artifact:

| Child event | Action |
| --- | --- |
| `session_start` | clear the sample, publish metadata (a resumed/forked session must not inherit the old value) |
| `before_agent_start` (`messageType: 'user'`) | clear the sample, publish (a new assignment invalidates the previous turn's measurement) |
| `message_end` | result text only — **no** metrics (runs before persistence) |
| `turn_end` | sample `ctx.getContextUsage()`, publish (safe finalized boundary) |
| `session_compact` | keep the known window, set `tokens: null`, publish (Pi reports unknown tokens at this boundary) |
| `ask_question` | keep the existing path publish, now including the last sampled value |

The last sampled value lives in the child's closure, and every metadata write
republishes it, so a path-only publish (ask_question) cannot erase it.

## Parent surfaces

- `HerdrAgentInfo` (`src/herdr/types.ts`) gains an optional `context` set only
  by hydration; nothing is persisted into live/closed state, and closed history
  gains no metrics.
- New feature-owned module `src/ui/agent-context.ts`:
  `attachAgentContext(agents)` reads each agent's meta through
  `readAgentSessionMeta` under `bestEffort` (one bad artifact leaves that row at
  `ctx —`, it never fails the widget or the list), plus
  `formatContextLabel` / `formatTokenCount`.
- `src/ui/widget.ts` adds a `context` column after the status, painted dim by
  `src/ui/poller.ts`, which hydrates before rendering.
- `src/ui/manager.ts` hydrates the live list and builds rows through the
  extracted pure `agentMenuItems`: live rows become
  `status:<state> • ctx 38k / 200k`, closed rows keep `closed • <date>` and drop
  the cwd.

## Display contract

- `ctx 38k / 200k` — measured estimate and known capacity.
- `ctx — / 200k` — capacity known, tokens unknown (right after compaction).
- `ctx —` — nothing published (new agent, cleared sample, unreadable artifact).
- `ctx 0 / 200k` — a real measured zero.

## Checks

`npm run typecheck`, `npm run lint`, `npm run test:unit`,
`npm run test:integration`, `npm run test:e2e`, formatting check, `git diff
--check`. Tests: child publish/clear/compaction/zero/nullable and the
message_end-versus-turn_end boundary; artifact reader roundtrip; widget
formatting and unknown values; hydration isolation; widget plus manager plumbing
against the fake Herdr.
