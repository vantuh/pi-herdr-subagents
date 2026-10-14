# Vitest test runner

## Context

Tests already use `node:test` and `node:assert/strict`. Bun is only the runner (`bun test` in `package.json`). Move that runner to Vitest, with two commands: the fast suite and e2e.

Node on this machine is v26.11.1. It runs the generated `.ts` lock scripts in `test/state.test.ts` via `process.execPath`. Those scripts import `src/state.ts`, which already uses `.ts` specifiers and erasable types. No Bun-only test API (`bun:test`, `Bun.*`) exists.

## Approach

Add Vitest as a devDependency and two projects in `vitest.config.ts`:

- `unit` — `test/**/*.test.ts`, 30s timeout. This is today's `test:unit` plus `test:integration` (`integration.test.ts`, `contract.test.ts`).
- `e2e` — `e2e/**/*.test.ts`, 180s timeout.

Scripts:

- `test` — `vitest run --project unit`
- `test:e2e` — `vitest run --project e2e`
- `test:all` — `vitest run`

Drop `test:unit` and `test:integration`. One non-e2e command replaces both. File layout stays; only the launch split changes.

Keep `node:assert/strict`. Swap the runner import only:

- `import test from 'node:test'` → `import { test } from 'vitest'`
- `import { describe, it } from 'node:test'` → `import { describe, it } from 'vitest'`
- `import test, { after } from 'node:test'` and `test.after` → `afterAll` from `vitest`

`pool: 'forks'` on the unit project. `state.test.ts` mutates `process.env` and spawns child processes; forks match the current process-per-file isolation.

Do not rewrite assertions, do not move test files, do not change `bun build` smoke checks. Historical notes in `docs/plans/` stay as written.

`test/config.test.ts` keeps the lazy temp-dir helpers. Top-level await before `test()` still skips registration. Update the two comments so they no longer name Bun.

## Files to modify

- `package.json` — scripts; add `vitest` devDependency (`package-lock.json` follows `npm install`)
- `vitest.config.ts` — new
- every `test/**/*.test.ts` and `e2e/flow.test.ts` — `node:test` import only
- `test/state.test.ts` — `after` → `afterAll`
- `test/config.test.ts` — `test.after` → `afterAll`; comment text
- `e2e/flow.test.ts` — comment that names `bun run test:e2e`
- `README.md` — prerequisites and Development commands
- `AGENTS.md` — Tests section commands and the "three layers" wording that describes separate scripts

## Reuse

- Existing `node:assert/strict` calls. Vitest runs them as-is.
- Existing timeouts: 30000 for `test/`, 180000 for `e2e/`.
- `test/state.test.ts` child spawn already passes `process.execPath` a `.ts` file with a `.ts` import. Node 26 executes that. No `tsx` dependency.
- `test-support/e2e-harness.ts` already isolates each scenario with its own `HOME` and `HERDR_SOCKET_PATH`. Tests inside one file stay sequential (Vitest default).

## Steps

- [x] Add `vitest` and `vitest.config.ts` with `unit` and `e2e` projects (`pool: 'forks'` on unit).
- [x] Point `test`, `test:e2e`, and `test:all` at `vitest run`. Remove `test:unit` and `test:integration`.
- [x] Replace `node:test` imports. Map `after` / `test.after` to `afterAll`.
- [x] Update the Bun runner comments in `test/config.test.ts` and `e2e/flow.test.ts`.
- [x] Update `README.md` and `AGENTS.md` so the documented commands are the two Vitest projects plus `test:all`. Drop Bun as a test prerequisite. Leave the `bun build` smoke check.

## Verification

- `npm test` — former unit and integration files, no real Herdr.
- `npm run test:e2e` — real Herdr and Pi, same scenarios as now.
- `npm run test:all` — both projects.
- Confirm `test/state.test.ts` lock-spawn cases pass under Node (the `process.execPath` + `.ts` path).
