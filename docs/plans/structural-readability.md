# Structural readability refactor

## Goal and constraints

Make runtime logic easier to follow by giving contracts and cohesive operations
explicit feature owners. Preserve behavior, tool details, Herdr argv, persisted
formats, permissive input handling, comments explaining constraints, and all
existing test scenarios. Do not add dependencies, compatibility re-exports,
generic helper frameworks, or a hard line-count rule.

Prefer shared TypeBox field composition and `Static`-derived types. Raw, legacy,
and normalized schemas remain distinct where their validation differs.

## Sequence

Each implementation step is a separate reviewed and verified commit. Update the
file map in `AGENTS.md` and affected documentation/imports with each step.

- [x] 1. Give contracts feature owners. Replace `src/types.ts` with focused
  profile types, Herdr schemas/runtime types, configuration schemas and state
  schemas. Move the state/history schemas out of `store.ts`. Preserve names and
  validation semantics; update every source/test importer without compatibility
  re-exports. Leave compact single-parser schemas alone unless needed by the move.
- [x] 2. Extract layout operations from `herdr/placement.ts` and output formatting
  from `utils.ts`. Put spawn warning formatting/details with output formatting,
  and move the placement lock out of one-shot closing into spawn-owned code.
- [x] 3. Separate state locking, history normalization/reconciliation/pruning and
  live-agent lifecycle operations from store IO/transactions. Keep one locked
  load-mutate-save boundary and avoid runtime imports back into the store from
  pure schema/policy modules.
- [x] 4. Split tool execution into dispatch and cohesive spawn phases: flow and
  rollback, target placement, continuation/reuse, and start/prompt lifecycle.
  Keep internal types/schemas beside the spawn feature. Preserve partial-progress
  cleanup, pane/workspace lock release points and resume-claim durability.
- [ ] 5. Extract detached outcome delivery from widget polling. Preserve question
  precedence, fresh status checks, durable claims, notification/close ordering,
  batching and awaited shutdown.
- [ ] 6. Align test organization with the new boundaries. First extract the fake
  Herdr's pure layout model/operations. Split oversized scenario suites by
  existing topics only where this improves navigation; update Vitest project
  selection and retain state-path isolation and all test scenarios. Keep real
  and fake harnesses separate.

## Verification

- For every source step: `npm run typecheck`, `npm run lint`,
  `npm run test:unit` and `npm run test:integration`.
- For layout, spawning and delivery steps: also `npm run test:e2e`.
- Independent review before each implementation commit; the orchestrator reads
  the diff and runs the relevant checks itself.
- At completion: all five checks, import-cycle/dangling-import inspection, source
  size summary and a clean working tree. Move this plan to `docs/plans/done/`.

## Baseline

Audit baseline: 26 source files, 5,631 lines, five source files above 300 lines;
no cycles detected among static relative imports. Typecheck, lint, 190 unit tests
and 127 integration tests pass. E2E has not yet been run for this task.

## Progress

- Recorded the agreed schema composition rule in `AGENTS.md`.
- Step 1: moved contracts to feature-owned modules and removed `src/types.ts`.
  Independent review found no blocking issues; corrected a test-only type import
  and a migration-oriented comment. All 15 moved public TypeBox schemas compare
  exactly with their pre-refactor values. Typecheck, lint, 190 unit tests,
  127 integration tests and all 13 E2E tests pass.
- Step 2: extracted layout operations/schemas, output formatting and placement
  locking. Independent diff review found no issues. Typecheck, lint, 190 unit,
  127 integration and 13 E2E tests pass; named relative imports also resolve to
  real exports across source and test files.
- Step 3: split locking, history policy, pure live-record logic and lifecycle
  mutations from store IO. `store.ts` is now 208 lines. Independent diff review
  confirmed equivalent bodies and transaction ordering. Typecheck, lint,
  190 unit, 127 integration and 13 E2E tests pass.
- Step 4: reduced `execute.ts` to a 92-line dispatcher and moved cohesive spawn
  phases, contracts and response schemas beside it. Independent diff review
  confirmed unchanged bodies, lock scope and rollback ordering. Typecheck,
  lint, 190 unit, 127 integration and 13 E2E tests pass.
- E2E runs use installed Pi `1.2.0` and Herdr `0.9.5`; the documented Herdr
  `0.9.4` binary is not installed, so that exact version remains unverified.
