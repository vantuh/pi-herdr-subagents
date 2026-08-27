# AGENTS.md — herdr-agents extension

This extension belongs to the dotfiles repo and is symlinked into `~/.pi/agent/extensions/herdr-agents` via the `pi` stow package.

## Purpose

`herdr-agents` gives Pi a `herdr_agent` tool for one-shot or persistent delegation through Herdr panes or tabs. Layout is internal configuration and is not part of the tool schema.

The intended model behavior:

- The main Pi session is the Orchestrator.
- When isolated context helps, the Orchestrator calls `herdr_agent` instead of raw `herdr` CLI commands.
- `herdr_agent` starts a Pi process in a named Herdr target using an agent profile from `~/.pi/agent/agents/*.md`.
- Use `lifecycle: "oneshot"` for one-shot tasks; the extension closes that agent target after a successful result.
- Use `lifecycle: "persistent"` when a role should stay available for follow-up tasks or accumulate context; the extension reuses a matching target automatically.
- The Orchestrator waits for the child result, reads it, and synthesizes the answer.
- With `wait: false` nobody waits: the record is marked `detached` and the widget poller delivers the outcome once the agent settles — a result as `herdr_agent_result`, or a question as `herdr_agent_question` (checked first, same order as the blocking path). One-shot targets are closed only when they actually finished. `claimDetachedAgent` clears the flag in one locked read-modify-write, and synchronous collection releases it too, so delivery happens exactly once.
- A child may instead call `ask_question`, which writes `question.md` beside the result artifact and returns. The child ends its turn and goes idle, the existing wait fires, and the Orchestrator returns the question early while leaving the target open — one-shots included. The answer is a normal `task` with the same `tabLabel`; parked targets are reusable by label whatever their lifecycle.

## Delegation policy

Global `agents/.agents/AGENTS.md` is authoritative for **when** to delegate. Role matrix, lifecycle examples, and negative policy live in `docs/README.md`. Orchestrator mechanics are in `constants.ts` (`GLOBAL_INSTRUCTIONS`).

| Situation | `agent` | Delegate? |
|---|---|:---:|
| Unknown code / flows / "where-how" | scout | when needed |
| External docs / APIs / facts | researcher | when needed |
| Known single-file edit | — | no |
| Multi-file plan | planner | after scout |
| Isolated implementation | worker | after plan |
| Non-trivial / risky diff | reviewer | when needed |

## Files

- `index.ts` — Pi extension entrypoint and `herdr_agent` tool registration.
- `agents.ts` — loads agent profiles from user/project Pi agent directories.
- `herdr.ts` — Herdr CLI/API wrappers, snapshot discovery, layout helpers, and named-agent lifecycle commands.
- `schema.ts` — TypeBox schema for tool parameters.
- `constants.ts` — injected Orchestrator instructions and child-agent protocol.
- `utils.ts` — agent-name generation, title casing, result artifacts, and temp prompt files.
- `types.ts` — shared TypeScript interfaces.
- `test-support/` — test harnesses: `mock-extension.ts` (shared mock `ExtensionAPI` host, env and profile fixtures), `fake-herdr.ts` (in-process Herdr simulator), `herdr-shim.mjs` (executable `herdr` stand-in), `harness.ts` (integration harness), `mock-llm.ts` (scripted `openai-completions` server), `e2e-harness.ts` (hermetic real Herdr server), `link-deps.sh` (peer-dep symlinks).
- `e2e/` — end-to-end scenarios against a real Herdr server and real Pi children.
- `docs/` — detailed implementation and session notes.

## Important behavior

- Child panes start with `HERDR_AGENT_CHILD=1` and `PROCESS_LAUNCHED_BY_Q=1`: delegation tools stay disabled, final responses are persisted, zsh selects `HISTFILE=/dev/null` from the child marker, and Kiro's terminal wrapper cannot hide the real shell from `herdr agent start`.
- `HERDR_PANE_ID` is preferred over focused pane detection. Focus can move while a tool is running.
- New agents start through `herdr agent start`; prompts use atomic `herdr agent prompt` (no `--wait`), then wait for a newer `state_change_seq` with `working`/`blocked` (or settled idle/done), with one Enter nudge only while idle and `interactive_ready`, before `herdr agent wait --until idle --until done`. This avoids Herdr's hardcoded 5s `agent_prompt_stalled` gate. Abort / Herdr wait timeout returns a soft re-wait hint (child stays); re-wait uses `herdr agent wait` only.
- `lifecycle: "oneshot"` requires `wait: true`, because the Orchestrator must wait before closing the one-shot pane or tab.
- Layout defaults to `pane`. Set `HERDR_AGENTS_LAYOUT=tab` before starting Pi to use the legacy tab layout; the model receives no layout parameter.
- Pane mode splits the Orchestrator 60/40 on the first spawn and stacks additional agents down the right column. The placement lock is held through `agent start`, managed-state recording, and rebalancing so parallel calls cannot create competing right columns.
- Persistent agent reuse is label-based: the default label is the title-cased agent profile name unless `tabLabel` is provided. Reuse requires an exact managed-agent label match. Managed agents also receive a short unique Herdr automation name; legacy panes fall back to pane IDs.
- While waiting, the extension emits `pi.events.emit("herdr:blocked", ...)` so Herdr can mark the Orchestrator pane as blocked/waiting.

## Loading

This extension is loaded from the symlinked Pi extension directory:

```text
~/.pi/agent/extensions/herdr-agents/index.ts
```

A global `/parallel-review` Pi prompt uses this extension's `herdr_agent` tool, but the prompt itself is maintained outside this extension.

## Tests

```bash
cd pi/.pi/agent/extensions/herdr-agents
bun run test              # unit + integration (fast, no real Herdr)
bun run test:unit         # pure helpers only, no subprocesses
bun run test:integration  # full herdr_agent flow against a fake Herdr
bun run test:e2e          # real Herdr server + real Pi children (~50s)
bun run test:all          # everything
```

`bun run test` first runs `test-support/link-deps.sh`, which symlinks the Pi
packages from the globally installed `pi` into a local (gitignored)
`node_modules`. The extension has no install step of its own, so without those
links `index.ts` cannot be imported.

Three layers:

- **Unit** (`*.test.ts` next to their module) — pure helpers: arg builders,
  snapshot parsing, layout ratios, state records, widget rendering, profile
  discovery precedence, and the child-mode contract. `imports.test.ts` walks
  every module's relative imports, which is the one failure (a dangling sibling
  import) that breaks Pi at load time without failing any other test.
- **Integration** (`integration.test.ts`) — the real extension, loaded through a
  mock `ExtensionAPI`, driving a fake Herdr. `HERDR_BIN_PATH` points at
  `test-support/herdr-shim.mjs`, which forwards argv over a socket to the
  `FakeHerdr` instance inside the test, so every `herdr` call is a real
  subprocess against a simulated server with a real pane/tab/layout tree.
  `HERDR_SOCKET_PATH` serves `layout.export` / `layout.set_split_ratio`.
  Simulated children write the same `result.md` / `question.md` artifacts a real
  Pi child would.
- **Contract** (`contract.test.ts`, `schema.test.ts`) — the behavior lock for
  rewrites. Same harness as the integration layer, but instead of the flows an
  Orchestrator normally drives it pins the rest of the observable surface: the
  `details` keys, the exact Herdr argv, every failure path, the widget and
  command behavior, artifact permissions, and the model-facing parameter schema.
  Start here when refactoring: if these stay green, callers keep working.
- **E2E** (`e2e/flow.test.ts`) — a real `herdr server`, real pane splits, and
  real `pi` child processes that load this extension in child mode. Only the
  model and the Orchestrator's own Pi process are simulated: `MockLlm` serves
  `openai-completions` from a hermetic `models.json`, and the extension is
  driven through the same mock `ExtensionAPI`. The server runs with its own
  `HOME` and `HERDR_SOCKET_PATH`, and children inherit its hermetic
  `PI_CODING_AGENT_DIR` / `TMPDIR`, so the live session is untouched.

Both harnesses redirect `TMPDIR`, `HERDR_AGENTS_STATE_PATH` and
`PI_CODING_AGENT_DIR` per test, so the live session, its state file and its temp
artifacts are never touched.

Covered by the integration layer: one-shot spawn/collect/close, scrollback
fallback, persistent reuse by label, the `ask_question` round trip (parked
one-shot answered by label), parallel spawns serialized into one agent column
with rebalancing, `agent_pane_busy` retry, `agent_kind_mismatch` recovery, the
single Enter nudge for a stalled prompt, timeout/abort soft re-wait plus the
re-wait path, detached result and question delivery through the widget poller
(exactly once), the tab layout, and the injected Orchestrator / `/run`
instructions.

Regressions from `docs/session-findings.md` that used to be checked by hand and
now have tests, with the finding they came from:

| Behavior | Finding |
|---|---|
| Child mode registers `ask_question` only — never `herdr_agent`, commands, renderers or instruction injection | §4 |
| Child persists each finalized assistant message to the artifact; ignores blank and non-assistant messages | §4, §9 |
| `ask_question` refuses to strand the child when no channel exists | §4 |
| Project profile overrides a user profile of the same name; unusable files are skipped | §2 |
| Split targets `HERDR_PANE_ID`, not the pane Herdr reports as focused | §5 |
| A reused agent's previous settled state is not accepted as this turn's result | §8 |
| A child that finishes as `done` rather than `idle` is still collected | §8 |
| One-shot cleanup removes the managed temp dir; a persistent agent keeps it | §9 |
| `agent_pane_busy` retry is bounded and gives up without closing anything | §12 |
| `/herdr-agents` focuses, closes (with temp cleanup), and reports an empty workspace | §9 |
| Two detached outcomes in one poller tick arrive as one batch, only the last triggering a turn | index.ts |
| Every relative import resolves | §15 |

Pinned by the contract layer: the `details` key set and profile payload of a
successful call; the `agent read` fallback window; a collected result surviving a
failed pane close (with `closeError`); malformed `pane split` / `tab create` /
`api snapshot` output; refusing to act when the current pane is unidentifiable;
the whole flow still completing when the state file is unusable; `wait: false`
re-wait; detached persistent delivery without closing; a settled detached agent
with no artifact keeping its claim; tab reuse by label and the `tab list`
fallback when `tab create` omits the id; widget appear/hide/clear including the
poller stopping; `/run` busy, empty and completion behavior; `/herdr-agents`
non-TUI and failure notifications; both message renderers; no layout churn for a
lone agent; state pruning; and `0600` on the state file and artifacts.

Covered by the e2e layer: a real child produces a real result artifact and its
pane is really closed; a persistent child keeps its context across two tasks
(asserted on the model's request history); a real `ask_question` tool call
travels from a tools-restricted child back to the Orchestrator and the answer
finishes it; two real agent panes stack into one right column with the
Orchestrator held at 60%; a detached real child is delivered and closed by the
poller with nobody waiting.

Not covered: the Orchestrator's own Pi process (the extension is driven
directly, not through a real model emitting `herdr_agent` tool calls), the zsh
`HISTFILE` child guard (§14, it lives in the `zsh` package), and multi-process
state-file coordination (intentionally out of scope).

One e2e-specific constraint worth knowing: `MockLlm` stalls ~1.5s before its
content chunk on purpose. Herdr samples the pane for agent state, so an instant
reply can start and finish a turn without Herdr ever reporting `working`, and
the extension's prompt-acceptance wait would never see the lifecycle change.

Writing a scenario:

```ts
await withHarness({}, async (harness) => {
  harness.fake.setBehavior((turn) => ({ result: `done ${turn.turn}` }));
  const result = await harness.call({ agent: "scout", task: "..." });
  assert.equal(result.details.closed, true);
  harness.fake.callsMatching("pane", "split"); // recorded argv
});
```

`FakeHerdr` hooks: `setBehavior` (per-prompt child outcome — `result`,
`question`, `transcript`, `delayMs`, `stalled`, `neverSettle`, `settleStatus`,
`staleWindowMs`), `queueStartFailures` / `failEveryStart` (fail `agent start`
with a Herdr error code), `failCommand` / `malformCommand` (fail or corrupt any
`herdr <group> <command>`), `omitCreatedTabId`, `holdChildren` /
`releaseChildren` (settle several children at once, for one-tick batching),
`focusedPaneId`, `completeAgent`, `callsMatching`, `layoutFor`, `ratioUpdates`.

The `/herdr-agents` overlay is driven with `dialogInputs`: keystrokes per
`ctx.ui.custom` call (`"\r"` selects, `"d"` closes), and a call with no entry
left cancels, which ends the manager loop.

## Validation

Useful smoke checks:

```bash
# Parse/bundle the extension modules.
bun build pi/.pi/agent/extensions/herdr-agents/index.ts \
  --target node \
  --outfile /tmp/herdr-agents-check.js \
  --external @earendil-works/pi-coding-agent \
  --external @earendil-works/pi-tui \
  --external typebox

# Confirm the tool is visible to a fresh Pi model.
PI_OFFLINE=1 pi --no-context-files --no-skills --no-prompt-templates --no-themes \
  -p 'List exact tool names available. Do not use tools.'
```

After changing symlinked files, restart Pi or run `/reload` in the active session.
