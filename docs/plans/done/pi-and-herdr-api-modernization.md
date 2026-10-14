# Pi and Herdr API modernization

## Context

- Repository: `@vantuh/pi-herdr-subagents`, currently marked retired in `AGENTS.md`.
- Verified behavioral baseline: `4065e3c`, 2026-09-04 (one-shot agents and session resume). All current `src/*.ts` files are byte-identical to the baseline counterparts; subsequent test changes only adjust imports.
- Installed and latest stable upstream versions agree: Pi `1.2.0` (October 12); Herdr client/server `0.9.4` (October 13), private protocol `22`, endpoint protocol generation `1`, compatible, no restart needed. Target these APIs without older-version branches.
- Latest upstream stable releases available when the baseline commit was made: Pi `0.85.0` (released September 4 at 10:18:28 UTC, before the commit at 12:15:18 UTC) and Herdr `0.8.2` (August 19). Historical migration docs mentioning Pi `0.81.1` / Herdr `0.7.5` are older implementation notes, not evidence of the versions actually installed on September 4.
- Concurrent user work was observed: lockfile and plan-ignore commits, plus changes to `docs/README.md` and a new `docs/agent-profiles.md`. Preserve these changes and re-read their latest contents before implementation.
- October 14 commits renamed/repackaged the extension and moved sources without changing their contents. September 4 is the verified behavioral baseline, not the latest commit date.
- Goal: compare upstream Pi and Herdr changes since that baseline and recommend the smallest complete modernization.
- Planning only: no code changes, installs, commits, or live-session mutations.

## Approach

Keep the existing Herdr-backed TUI architecture and public `herdr_agent` parameters. Modernize the Pi event/prompt contracts first, restore restricted-profile tool selection, then delete redundant Herdr input/startup recovery and legacy persistent support. Keep result artifacts, durable session archives, ownership, and interprocess locking.

Use current APIs directly. Do not add version switches, feature-detection ladders, new dependencies, a replacement orchestration framework, or a transport rewrite. Validate deletions against isolated real Pi/Herdr before calling them complete.

## Files to modify

- `src/child.ts`: current event union, guaranteed session-manager methods, question termination/exposure.
- `src/index.ts`: structured prompt sections, user-only `/run` handling, TUI-specific manager/widget gates, child tool arguments, one-shot-only collection.
- `src/herdr.ts`: completion identity, removal of Enter nudge and duplicated startup retry, current structured error wording.
- `src/utils.ts`, `src/constants.ts`: child-tool selection and question protocol text.
- `src/state.ts`, `src/types.ts`, `src/widget.ts`: remove persistent-only branches/types/comments, preserving current one-shot state/history data.
- `test/child.test.ts`, `test/herdr.test.ts`, `test/utils.test.ts`, `test/state.test.ts`, `test/constants.test.ts`, `test/integration.test.ts`, `test/contract.test.ts`: behavioral regressions and updated current-API expectations.
- `test-support/link-deps.sh`: resolve host peer package roots through Node resolution rather than assuming nested `pi-coding-agent/node_modules`.
- `test-support/mock-extension.ts`, `test-support/fake-herdr.ts`, `test-support/e2e-harness.ts`, `test-support/mock-llm.ts`, `e2e/flow.test.ts`: real event shapes, completion sequences, current integration fixture, fast/delayed/error scenarios.
- `AGENTS.md`, `docs/README.md`, `docs/agent-profiles.md`, `docs/flow.md`; add a short root `README.md` for supported versions, local loading, configuration, and tests.
- `src/agents.ts` and `package.json` need no API-driven rewrite: existing exported skill discovery and the explicit Pi manifest remain valid. Host peer ranges `"*"` match Pi's packaging guidance; document the tested runtime baseline rather than introducing runtime version branches.

## Reuse

- `src/herdr.ts`: `execHerdr`, `getSessionSnapshot`, `startAgent`, `promptAgent`, `waitForAgent`, `readAgent`, workspace discovery, layout ratio helpers.
- `src/state.ts`: `withHerdrAgentsStateLock`, `claimDetachedAgent`, closed-session archives. Preserve interprocess locking and exactly-once detached delivery.
- `src/agents.ts`: `resolveProfileSkills` already supports package discovery with an explicitly read-only resolver; preserve skill precedence and diagnostics.
- `test-support/harness.ts`, `test-support/fake-herdr.ts`, `test-support/herdr-shim.mjs`: existing integration boundaries. `test/contract.test.ts` and `test/schema.test.ts` pin public behavior.

## Steps

Implement in this order, one verified concern per commit:

- [x] **0. Repair the current-install test prerequisite.** `test-support/link-deps.sh` assumes Pi's peers live inside `pi-coding-agent/node_modules`; those paths do not exist in the installed `1.2.0` managed release. Resolve `@earendil-works/pi-tui` and `typebox` through Node from the detected Pi package root, locate their owning package directories, and keep the existing symlink setup. No install-layout compatibility branches or dependency installation. Verify the script against the actual managed release before running the unchanged baseline suite.
- [x] **1. Restore supported-package documentation.** Remove retired/not-loaded notices and Chezmoi archive assumptions from maintained pages. Use root-relative `src/`, `test/`, and `e2e/` paths. Document Pi `1.2.0`, Herdr `0.9.4`, and official Pi integration `v9`. Preserve historical migration notes, clearly labeled historical. Preserve the distinct meaning of archived *child sessions*.
- [x] **2. Adopt the current Pi event and prompt contract.** In the child, parse the result marker only for `event.messageType === "user"`; custom-message starts must not throw or erase the active channel. Use the guaranteed `ctx.sessionManager.getCwd()` rather than an old-API capability check. In the parent, set one named `event.systemPromptOptions.sections.herdr_agents` section instead of returning the whole `systemPrompt`. Apply global orchestration guidance on both user and custom starts, but consume `pendingRunDelegation` only on user starts. Do not replace Pi's other sections/tools.
- [x] **3. Preserve tool restrictions under codemode/MCP.** Keep `herdr_agent` direct, so current codemode can orchestrate independent calls without another wrapper. Mark `ask_question` model-only. Preserve `ask_question` in restricted child profiles. For a restricted profile, explicitly exclude MCP tools not intentionally allowed by its names/patterns; `--tools` alone is not a universal allowlist. Keep unrestricted profiles unchanged and correct the old universal-allowlist comment. No claim that a tool profile is an OS sandbox.
- [x] **4. Simplify the question round trip.** Return `terminate: true` on a successfully persisted question; remove the request for a redundant assistant 'waiting' response. Failure results must not terminate. Retain the instruction to call `ask_question` alone: Pi terminates only when every completed tool in the batch agrees. Preserve question-first collection and leave the parked one-shot open. Verify with real Pi that no extra model request occurs for a question-only batch.
- [x] **5. Simplify Herdr prompt/start coordination.** Remove the extra `send-keys enter` nudge: current `agent prompt` guarantees text-plus-Enter submission, and another Enter risks unintended input. Keep the longer acceptance timeout and `agent prompt` without `--wait`: the upstream five-second activity gate still exists. Accept observed newer `working`/`blocked`, or a newer actual `completion_seq` for a fast settled turn; a mere newer idle/session-change sequence must not count as accepted work. Treat absent/null completion identity as 'no completed work', not as an older-server fallback.
- [ ] **6. Remove duplicate startup retry and obsolete persistent support.** Let `herdr agent start` own initializing-shell retries and terminal-identity checks; delete the outer five-second `agent_pane_busy` loop after isolated cold-shell checks pass. Preserve current `agent_kind_mismatch` recovery unless an isolated current Kiro-ACP scenario proves it unnecessary; this is current-provider error handling, not old-version support. Remove persistent-only parsing/branches and stale wording. Keep one-shot label collision checks, archived history, and all owned-target safeguards. Do not purge old state files or foreign panes automatically.
- [ ] **7. Use the correct UI boundary and run the release gate.** Gate the custom `/herdr-agents` terminal overlay and TUI widget with `ctx.mode === "tui"`, not merely `ctx.hasUI` (RPC can report true). Non-TUI calls default to blocking and reject explicit detach unless a collector is actually implemented; no RPC collector is added here. Use current official integration in the hermetic E2E setup, verify detached batching on real Pi, and refresh docs/contracts for deliberate changes.

## Verification

Planning checks completed: Git baseline/content comparison, installed versions and compatible server status, GitHub release dates, current CLI help/schema, Pi declarations/docs/examples, and Herdr `v0.9.4` source/integration. No tests or builds ran during planning because they can write non-Markdown files.

After approval:

```bash
bun run test
bun run test:e2e
bun build src/index.ts --target node --outfile /tmp/pi-herdr-subagents-check.js \
  --external @earendil-works/pi-coding-agent \
  --external @earendil-works/pi-tui --external typebox
git diff --check
```

Required behavior checks:

- User and custom `before_agent_start` events; custom starts retain the child channel and cannot consume a pending `/run` request.
- Herdr prompt section survives detached-result-triggered runs, tool calls, `/reload`, and resumed sessions without replacing unrelated sections.
- Restricted profiles cannot reach unlisted MCP tools through codemode/tool search; explicitly allowed MCP patterns still work. Unrestricted profiles and the question channel retain their behavior.
- Question-only tool batch causes no redundant provider call; answer by label continues the same child. Mixed batches retain Pi's documented termination semantics.
- Fast first turn finishes before polling sees `working`; newer session/idle transitions without `completion_seq` do not count as acceptance.
- Slow transition beyond five seconds still works; stalled prompts send no second Enter and are never resubmitted. Timeout/abort leaves live work reachable for re-wait.
- Cold shell startup delegates retries to Herdr; genuine occupied pane fails without typing/closing anything. Test the Kiro-ACP mismatch case before deleting its recovery.
- Two detached outcomes arrive once in one model context; start-in-progress concurrency causes no second run. Use a focused real-Pi/MockLlm scenario because the mock host does not implement Pi's scheduling.
- Existing resume, ownership, concurrent claim, stage-before-close, cleanup failure, artifact permissions, and pane-column geometry tests stay intact.
- TUI manager works; RPC/JSON/print never call unsupported custom UI or silently detach without a collector.

Use the existing hermetic server harness. Never run experiments against the user's active Herdr server, overwrite home integrations, or approve project trust implicitly.

## Upstream evidence collected

- GitHub releases confirm latest stable Pi `1.2.0` (2026-10-12) and Herdr `0.9.4` (2026-10-13), matching installed versions.
- Pi `0.86.0` (September 19): transcript-backed system-prompt/tool changes and `pi.on()` unsubscribe; use structured prompt sections instead of forcing an opaque full prompt.
- Pi `0.87.0` (September 21): actionable `agent_before_settle` and canonical SessionManager context; `agent_settled` existed before September and must not be presented as new.
- Pi `0.99.0` (September 29): codemode/MCP, tool exposure, structured tool output, and nested tool execution APIs.
- Pi `1.1.0` (October 7): native OSC 7501 program status and `agent_settled.aborted`.
- Pi `1.2.0`: `before_agent_start` now includes custom-message-triggered runs; `prompt` exists only for `messageType: "user"`. Current child handler reads `event.prompt` unconditionally, so migration is necessary.
- Herdr `0.9.0` (September 7): `agent prompt` guarantees ordered text and Enter submission, while the five-second `--wait` activity gate remains. This supports investigating removal of the extra Enter nudge, not blind removal of the acceptance guard.
- Herdr `0.9.2` (September 29): completion identity (`completion_seq` absent from `v0.9.1` agent schema/docs and present in `v0.9.2`), first-turn completion fixes, event-overrun errors, native agent resume commands, and `TERM_PROGRAM=herdr`.
- Current managed Pi install puts host peer packages beside `pi-coding-agent`, not inside it. Read-only checks confirmed the harness's assumed nested directories are absent while Node resolves both peers successfully from the Pi root.
- Herdr subscriptions are not durable; snapshots and events have no shared sequence boundary. A subscription rewrite introduces reconciliation complexity and is not automatically a simplification.
- Current Herdr CLI already retries initializing shells for two seconds with terminal-identity checks; this existed in `0.8.2` too. The package's outer five-second retry is duplicate orchestration, not a newly released feature.
- Official Pi integration shipped by Herdr `0.9.4` is version `9`; it still consumes `herdr:blocked` and waits for `agent_settled`. Do not replace it with Pi's native OSC 7501 without confirmed Herdr support.
- Current Pi documents an MCP exception to `--tools`: non-named MCP tools remain registered and may be reachable through codemode/tool search. The package's comment describing `--tools` as a strict universal allowlist is no longer accurate. Restricted child profiles must explicitly exclude unlisted MCP tools.
- Existing Pi APIs `terminate: true`, `ctx.mode`, and `systemPromptOptions` predate the baseline. They remain useful cleanup opportunities but are not new September–October APIs.

Sources: [Pi changelog](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/CHANGELOG.md), [Pi releases](https://github.com/earendil-works/pi/releases), [current extension contracts](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/extensions.md), [current CLI tool selection](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/cli.md#tools), [Herdr releases](https://github.com/herdrdev/herdr/releases), [Herdr stable documentation index](https://herdr.dev/llms.txt), [Herdr agent automation](https://herdr.dev/docs/agent-automation/), [Herdr socket API](https://herdr.dev/docs/socket-api/), [current Herdr startup CLI source](https://github.com/herdrdev/herdr/blob/v0.9.4/src/cli/agent.rs), [official Pi integration v9](https://github.com/herdrdev/herdr/blob/v0.9.4/src/integration/assets/pi/herdr-agent-state.ts).

## Keep unchanged / deliberately excluded

- **No full SDK/RPC rewrite.** SDK and stdio RPC are supported, but replacing interactive Pi children would change visible panes, questions, lifecycle integration, and resume. The experimental Pi server/client stack was removed in `1.2.0` and is not a migration target.
- **No subscription/cache layer.** Keep the existing widget poller. Herdr's `events_lost` handling and subscribe-before-snapshot reconciliation would add a second state machine.
- **Keep `herdr:blocked`.** Official integration v9 still consumes it. Native Pi OSC 7501 is new, but Herdr support sufficient to replace this channel was not established.
- **Keep raw socket calls for precise layout ratios.** Current CLI has pane resize/layout operations, but no equivalent command was found for exact `layout.set_split_ratio`. Do not replace exact geometry with approximate resizing.
- **Keep result/session artifacts and closed-history state.** Herdr's `resume_argv` restores a live pane after server restart; it does not replace an extension-owned closed-one-shot archive. Terminal reads remain a fallback, not a complete result transport.
- **Keep read-only skill discovery.** `DefaultResourceLoader` exists, but extension contexts do not expose the same complete resource loader, and `reload()` has broader discovery/loading effects. Replacing the current exported resolver is not a demonstrated simplification.
- **No opportunistic state-path migration.** The hardcoded default in `src/state.ts` is inconsistent with `getAgentDir()`, but changing it can strand existing state. Leave it for a separate explicit data-location task; preserve the env override now.
- **No monolith split, output-schema framework, extra configuration, remote-machine delegation, or dependency additions.** These are not required for current-API support.

## Upgrade constraints and risks

Finish or deliberately close managed live children before upgrading. Do not reinterpret old persistent records as closable one-shots. Preserve current one-shot history and leave unsupported historical data untouched; no old-version compatibility path or automatic destructive cleanup.

Prompt/startup deletions require real current-runtime verification. Keep the documented five-second upstream gate in mind. `completion_seq` proves completed work, not an arbitrary prompt ID; live-working agents must still reject new tasks, except an explicit parked-question answer.

Document intentional UI/tool-reachability changes. Existing CLI-argv tests should change only where the new contract is deliberate; do not weaken lifecycle/security tests to make the rewrite pass.

## Research execution note

Both researchers failed before producing results: `ERR_MODULE_NOT_FOUND` for `/Users/vantuh/.pi/agent/npm/node_modules/pi-subagents/runner-peer-preload.mjs`. Direct research completed with operator authorization. No repair, installation, alternate child launch, tests, or live-server mutation was attempted.

## Decisions

- Revive this package for active use; remove unsupported/retired wording and obsolete archive paths from maintained documentation.
- Support current Pi and Herdr only. Do not add version branches or backward-compatibility layers.
- Continue upstream research directly in the parent session after the delegated researchers failed; do not repair the delegation installation as part of this task.
