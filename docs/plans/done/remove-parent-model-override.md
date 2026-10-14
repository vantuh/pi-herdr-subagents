# Remove parent model override and /council

## Context

`herdr_agent` takes an optional `model`. On a new child (fresh spawn and `resumeClosed`) that string replaces the profile frontmatter model in the child's `--model`. The Orchestrator can therefore run a profile on a model the profile did not declare.

`/council` is the only caller. It reads `council.json` and injects a user message that tells the Orchestrator to pass `model` once per listed model. The command is unused. Remove it with the parameter.

Intended outcome: the parent cannot set the child's model. The only model source is the agent profile (`model:` in the user or project agent file). Omit it and the child uses Pi's default. `/council` is gone. A leftover `council.json` in the Pi agent dir is not read and is not deleted.

## Approach

Delete the tool parameter and the spawn branch that reads it. Keep `AgentProfile.model`. `buildChildPiArgs` passes `--model` from the profile only.

Delete the `/council` command, its message formatters, and `readCouncilConfig`. `/run` stays.

Council-only code is that surface plus `modelOverride`. Nothing else branches on council:

- The handler's TUI check (`/council requires TUI mode...`) is a copy of the tool's `wait: false` rejection. It goes away with the command. The tool check stays: detached delivery is how normal agents return results.
- `formatCouncilUserMessage` tells the model to ignore the 4–5 parallel cap. That exception is prompt text, not a code path. `GLOBAL_INSTRUCTIONS` keeps the cap.
- `uniqueLabel`, the placement lock, and same-profile `#2` suffixes serve every parallel spawn. Leave them.
- `pendingRunDelegation` and `before_agent_start` exist for `/run` only. Council never set that flag; it only called `sendUserMessage`. Leave the `/run` path.
- The integration assertion that the system prompt does not contain `/council round table` has no matching producer. Deleting the council tests removes it.

Do not edit historical plans (`docs/plans/done/plan-upstream-parity.md` and the rest). They record past decisions.

## Files to modify

- `src/schema.ts` — drop `model` from `buildHerdrAgentParams`.
- `src/index.ts` — `buildChildPiArgs`: remove `modelOverride`; use `options.agent.model`. Stop reading `params.model` at the spawn site (~1894). Delete `pi.registerCommand('council', ...)`. Drop unused imports: `readCouncilConfig`, `formatCouncilUserMessage`, `parseCouncilArgs`, and `getAgentDir` (only the council handler uses it).
- `src/run.ts` — delete `parseCouncilArgs` and `formatCouncilUserMessage`. Keep `/run` helpers.
- `src/config.ts` — delete `CouncilConfig` and `readCouncilConfig`.
- `test/schema.test.ts` — parameter keys and the `model` type assertion.
- `test/integration.test.ts` — replace `model override replaces the profile model...` with a call that still sends `model: "opus-5"` and asserts `--model` stays the profile value (`sonnet`). Delete both `/council` tests and `writeHarnessCouncilConfig`.
- `test/run.test.ts` — delete the `parseCouncilArgs` and `formatCouncilUserMessage` blocks.
- `test/config.test.ts` — delete the council tests, `councilTmp`, `councilDir`, and `writeCouncilConfig`.
- `test/ui-boundary.test.ts` — delete the `runCommand('council', ...)` assertion. The non-TUI check for `/herdr-agents` stays.
- `README.md` — drop the override bullet, the `model` row, and the `/council` command.
- `docs/tool.md` — delete the "different model" example and the paragraph that says `model` replaces the profile model.
- `docs/agent-profiles.md` — in the `model` row, delete the sentence that the tool parameter overrides the profile for a fresh spawn. Keep "Passed as `--model`. Omitted: Pi's default."
- `AGENTS.md` — drop the `model` override bullet, the `/council` bullets, and the file-list mentions of `council.json` and `/council`.

## Reuse

- Profile load already stores `model` (`src/agents.ts`, frontmatter `model`).
- `buildChildPiArgs` already appends `--model` when a model string is set (`src/index.ts`). After the change that string is `agent.model` only.
- Integration test `passes profile model and tool allowlist...` already locks the profile path. Keep it.

## Steps

- [x] Remove `model` from the TypeBox object.
- [x] Remove `modelOverride` from `buildChildPiArgs` and the call site. Do not read `params.model` even if a caller still sends it.
- [x] Delete the council command, formatters, config reader, and their tests.
- [x] Update README, `docs/tool.md`, `docs/agent-profiles.md`, and `AGENTS.md`.
- [x] Run `npm test`.

## Verification

- `npm test`. Schema keys are `agent`, `resumeClosed`, `tabLabel`, `task`, `wait`. A call with profile `model: sonnet` plus a stray `model: opus-5` still starts the child with `--model sonnet`. No `council` command is registered. `/run` tests still pass.
- No e2e change: e2e children use the harness model, not the tool override, and no e2e scenario calls `/council`.
