# AGENTS.md — pi-herdr-subagents

Pi extension that adds the `herdr_agent` tool: one-shot delegation to child Pi
agents running in Herdr. Targets Pi `1.2.0`, Herdr client/server `0.9.4`, and
Herdr's Pi integration `v9`; no compatibility layer for older versions.
[README.md](README.md) covers usage; `docs/` covers the tool contract, runtime
flow, config and profiles. Keep those in sync when behavior changes.

## Files

- `src/index.ts` — extension wiring: events, commands, tool registration, config load.
- `src/agents.ts` — profile discovery from user and project agent directories.
- `src/config.ts` — `herdr-agents.json` loading.
- `src/run.ts` — `/run` argument parsing and the injected user message.
- `src/prompts.ts` — Orchestrator instructions and the child-agent protocol.
- `src/json.ts` — `parseJson`: JSON parsing validated against a TypeBox schema.
- `src/artifacts.ts` — result, question and session-meta file IO.
- `src/child.ts` — child mode: `ask_question` and the result writer.
- `src/utils.ts`, `src/types.ts` — shared helpers and types.
- `src/herdr/cli.ts` — Herdr CLI/API process wrappers, argument redaction, error parsing.
- `src/herdr/snapshot.ts` — session snapshot, pane/tab/workspace discovery, subagents-workspace resolution.
- `src/herdr/placement.ts` — label uniqueness, reusable tab/pane lookup, managed-agent listing, split ratios.
- `src/herdr/agent.ts` — `herdr agent start`, `prompt` and `read` wrappers.
- `src/tool/schema.ts` — tool parameter schema.
- `src/tool/execute.ts` — the `herdr_agent` body: profile resolution, spawn, prompt, immediate return.
- `src/tool/status.ts` — taskless status check and the resume-over-live-agent decision.
- `src/tool/one-shot.ts` — one-shot close, placement lock, output formatting, state cleanup.
- `src/tool/child-args.ts` — child Pi argv/env and tool allowlist.
- `src/tool/result.ts` — `textResult` helper.
- `src/state/store.ts` — managed-agent records, state lock, load/save/migrate/prune.
- `src/state/closed-history.ts` — archive and claim of closed one-shots for `resumeClosed`.
- `src/ui/poller.ts` — per-second poller: delivers results and questions, closes finished one-shots.
- `src/ui/widget.ts`, `src/ui/manager.ts`, `src/ui/renderers.ts` — widget, `/herdr-agents` overlay, message renderers.
- `test-support/` — test harnesses (see Tests).

## Invariants

Easy to break and not obvious from one file:

- Every call returns once the prompt is submitted. Prompts use
  `herdr agent prompt` without `--wait`, and the extension never calls
  `herdr agent wait`: Herdr's fixed 5s `agent_prompt_stalled` gate would fail
  long tasks.
- The poller delivers each outcome exactly once: `claimDetachedAgent` clears the
  `detached` flag in one locked read-modify-write. A question is checked before
  a result. A one-shot closes only after it wrote a result artifact; a child that
  asked a question stays open.
- Status checks read the result artifact, never the pane.
- `herdr_agent` refuses to run outside TUI mode before any Herdr call, because
  only the TUI poller delivers outcomes.
- `HERDR_PANE_ID` identifies the Orchestrator pane, not the focused pane: focus
  can move while a tool runs.
- Children start with `HERDR_AGENT_CHILD=1`, which registers only
  `ask_question` and the result writer, so children cannot delegate. They also
  get `PROCESS_LAUNCHED_BY_Q=1`, so Kiro's terminal wrapper does not hide the
  real shell from `herdr agent start`.
- An agent's logical label comes from managed state, never from a tab title the
  user may rename. A task sent to the label of a live agent is rejected.
- In pane layout, the placement lock is held through `agent start`, the state
  write and rebalancing, so parallel calls cannot build competing right columns.
- `herdr-agents.json` is read once at extension load; edits apply on `/reload`.
- `session_shutdown` stops the poller and awaits the tick in flight, so no tick
  writes state after shutdown.
- Stored `persistent` records from older versions are kept but never reused,
  claimed or closed.

## Plans

Write each plan to `docs/plans/<short-task-name>.md`, never a generic name like
`PLAN.md`. Revise a plan in the same file. When it is finished, move it to
`docs/plans/done/`. Files in `docs/plans/done/` are history: do not implement
them unless the user names the file.

## Commands

```bash
npm ci --ignore-scripts   # install locked dev dependencies
npm run typecheck         # tsc over src/ only; tests are not type-checked
npm run lint              # oxlint
npm run format            # oxfmt (Markdown is excluded)
npm run test:unit         # pure helpers, ~3s
npm run test:integration  # extension against a fake Herdr, ~2min
npm run test:e2e          # real Herdr server and real Pi children; needs pi and herdr on PATH
npx vitest run test/herdr.test.ts  # one file
```

There is no aggregate `npm test`; each project runs on its own.

- While iterating: `typecheck`, `lint`, `test:unit`.
- Before committing a change to behavior, Herdr argv, tool `details` or flow:
  also `test:integration`.
- When the change touches spawning, delivery or layout: also `test:e2e`.

To check that a real Pi loads the working copy and exposes the tool (calls the
configured model):

```bash
pi -e ./src/index.ts --no-context-files --no-skills --no-prompt-templates --no-themes \
  -p 'List exact tool names available. Do not use tools.'
```

## Tests

Three Vitest projects in `vitest.config.ts`:

- **unit** — `test/*.test.ts` except the files below. Pure helpers, schemas,
  state records, widget rendering, profile discovery, child mode, and the Pi SDK
  boundary. `imports.test.ts` catches a dangling relative import, which breaks
  Pi at load time and fails nothing else.
- **integration** — `integration.test.ts` (user-facing flows),
  `contract.test.ts` (exact `details` keys, Herdr argv, failure paths, file
  permissions) and `ui-boundary.test.ts`. The real extension runs through a mock
  `ExtensionAPI` against `FakeHerdr`: `HERDR_BIN_PATH` points at
  `test-support/herdr-shim.mjs`, which forwards each `herdr` call over a socket to
  the fake server inside the test. Simulated children write the same
  `result.md` / `question.md` artifacts as real ones. Start here when
  refactoring: if `contract.test.ts` stays green, callers keep working.
- **e2e** — `e2e/flow.test.ts`: a real `herdr server` and real Pi children. Only
  the model (`MockLlm`, an `openai-completions` server) and the Orchestrator's
  own Pi process are simulated.

Isolation: the harnesses redirect `TMPDIR`, `HERDR_AGENTS_STATE_PATH` and
`PI_CODING_AGENT_DIR` per test. `test-support/state-path-guard.ts` also pins the
state path to a sentinel file for the whole run and fails the run if anything
wrote to it.

Writing an integration test: `test/integration.test.ts` and
`test/contract.test.ts` each define a local `withHarness` around
`createHarness` from `test-support/harness.ts`.

```ts
await withHarness({}, async (harness) => {
  harness.fake.setBehavior((turn) => ({ result: `done ${turn.turn}` }));
  const result = await harness.call({ agent: 'scout', task: '...' });
  assert.equal(result.details.closed, true);
  harness.fake.callsMatching('pane', 'split'); // recorded argv
});
```

`FakeHerdr` hooks:

- `setBehavior`: per-prompt child outcome (`result`, `question`, `delayMs`,
  `stalled`, `neverSettle`, `settleStatus`, `staleWindowMs`).
- `queueStartFailures`, `failEveryStart`: fail `agent start` with a Herdr error code.
- `failCommand`, `malformCommand`: fail or corrupt any `herdr <group> <command>`.
- `holdChildren`, `releaseChildren`: settle several children in one poller tick.
- `omitCreatedTabId`, `focusedPaneId`, `completeAgent`.
- Inspection: `callsMatching`, `layoutFor`, `ratioUpdates`.

The `/herdr-agents` overlay is driven by `dialogInputs`: keystrokes per
`ctx.ui.custom` call (`"\r"` focuses, `"d"` closes); running out of entries
cancels.

`MockLlm` waits 1.5s per response by default, so e2e tests can observe a live
pane before the child finishes. Fast-completion scenarios set the delay to zero.

Not covered: the Orchestrator's own Pi process driven by a real model, and the
zsh `HISTFILE` guard for children (it lives in the user's zsh config).
