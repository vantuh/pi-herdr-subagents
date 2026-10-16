# Bounded result delivery with durable full reports

## Context

A collected result is delivered to the Orchestrator as the complete text of
`result.md`, in one custom message (`herdr_agent_result`). The text goes into
the model's context whole, and the per-agent temp artifact under
`TMPDIR/herdr-agent-*` that held it is deleted by `closeOneShot`
(`src/artifacts.ts` `removeAgentTempFiles`, called at the end of `closeOneShot`
in `src/tool/one-shot.ts`) as soon as the pane closes.

The child's source text is not lost outright: it is also inside the child's
native Pi session file, which the closed-history record keeps as
`childSessionFile` and which `resumeClosed` or `/herdr-agents` can reopen. But
nothing surfaces it as a standalone result. The JSONL transcript can be read,
but extracting the completed task's accumulated text needs additional parsing.

Two consequences:

- A child that writes a large report (review, audit, recon dump) injects tens of
  kilobytes into the context of every delivered result, and up to 4 parallel
  delegations per turn multiply that.
- There is no durable, plain-text copy of a delivered result.

Goal: bound the delivered text — the full text when it is small, a deterministic
head/tail excerpt with an explicit omission marker when it is large — and keep
the complete result on disk as a durable, immutable report file readable with
the `read` tool.

Current relevant flow (facts):

1. The per-second poller (`src/ui/poller.ts`) hands managed agents to
   `deliverDetachedOutcomes` (`src/ui/detached-outcomes.ts`), which re-checks the
   settled status, reads `question.md` before `result.md`, and claims the agent
   with `claimDetachedAgent` (`src/state/lifecycle.ts`): a locked
   read-modify-write that sets `collected` and clears `detached`, so an outcome is
   delivered exactly once.
2. After the claim: Herdr notification, then `closeOneShot` (stages closed
   history, closes the pane/tab, deletes the temp dir), then the message is
   pushed via `pi.sendMessage`. Status checks (`src/tool/status.ts`) only preview
   the text — last 30 lines / 2 000 chars, marked `… (truncated)`
   (`formatAssistantPreview`, `src/output.ts`) — and never deliver, claim, or
   close.

Pi facts this plan relies on (verified in the installed package):

- `getAgentDir()` from `@earendil-works/pi-coding-agent` returns
  `process.env.PI_CODING_AGENT_DIR` (tilde-expanded) or `~/.pi/agent`
  (`dist/config.js`, exported from `dist/index.d.ts`). It is the same helper
  `src/config.ts` already uses for `herdr-agents.json`. It reads the environment
  on every call.
- The `read` tool truncates to 2 000 lines or 50 KB, whichever comes first, and
  pages with `offset`/`limit` (`dist/core/tools/read.js`,
  `dist/core/tools/truncate.js`). A report file is readable in full through
  ordinary paging.

## Decisions

Chosen defaults, each escapable if the user prefers the alternative.

1. **Report directory**: `<agent dir>/herdr-agents-results/`, i.e.
   `~/.pi/agent/herdr-agents-results/` by default, resolved through
   `getAgentDir()` so `PI_CODING_AGENT_DIR` and test harnesses apply. Not under
   `TMPDIR` (the OS reclaims TMPDIR; the point is durability). Not configurable.
2. **What is saved**: the full, trimmed result text of every delivery the
   extension makes for a completed managed delegation — one file per delivered
   outcome, so a `resumeClosed` turn or a steered continuation writes its own
   additional file. Small results are saved too (same rule, no branching).
3. **Retained-source budget, not an output budget**: characters (UTF-16 code
   units, `String.length`) — the unit the existing preview already uses, not
   bytes. A result of at most 6 000 units is delivered whole; above that, the
   excerpt retains at most 4 000 units from the start and 2 000 from the end.
   These bound the *retained source text only*: the body also carries the
   omission marker and the path line (~150–200 chars together), so a 6 001-unit
   input produces a body slightly **longer** than the source. No claim is made
   about total body length or token cost; the guarantee is that at most 6 000
   units of an arbitrarily long report reach the context, plus that fixed
   overhead. A 4:2 split keeps the report's opening (findings, verdicts as
   written) and its closing (`HERDR_RESULT:` line, final answer) while dropping
   the middle. Alternative: 8 000/4 000.
4. **Path line on small results too**: `Full report saved to <path>` is appended
   even when nothing was truncated, so the file is discoverable from the message
   itself. This is not a compaction guarantee: compaction may replace or drop the
   message and the path with it, and nothing re-injects it. The excerpt is
   therefore written to stand alone, and the report is an extra, not a crutch.
5. **Retention hint**: the truncated case also states `(kept 30 days)`, because a
   long session can outlive the file. The small case stays bare.
6. **Immutability**: a report is written once and never rewritten or appended.
   Names carry a millisecond timestamp, a slugged label, and a random suffix;
   collisions are retried with a new suffix, never resolved by overwriting, and a
   collision file is never unlinked.
7. **TTL 30 days from save**, read from the timestamp in the file name, not from
   `mtime`/`atime`. Reading does not extend retention by construction (and Pi's
   `read` never touches `mtime`). This retention is independent of
   closed-history retention (90 days / 32 per owner,
   `src/state/history-policy.ts`); they are different data.
8. **Cleanup** is opportunistic, best-effort, never a timer: once when the
   extension loads (main session only, not children), and after each successful
   report save. It removes only own expired reports; it never creates the
   directory and never traverses a symlinked one (Approach 1).
9. **Directory policy**: `herdr-agents-results/` is ours and must be a real
   directory with mode `0700`. `fs.mkdir(..., { recursive: true, mode: 0o700 })`
   does not repair an existing directory, so the leaf is checked after the
   `mkdir`: a real directory with another mode is `chmod`ed to `0700`, while a
   symlink or a non-directory makes the save fail (delivery degrades to the full
   text). Never `chmod` or write through a symlink; a symlinked *parent* (an
   agent dir that is itself a symlink) is followed normally.
10. **Write protocol**: `fs.open(path, 'wx', 0o600)`. Ownership of the file
    begins only when that open succeeds; a partial file is unlinked only on a
    write/close failure of the handle this call opened. `wx` is the immutability
    guarantee, and it means a name collision can never be clobbered or removed.
11. **Failure rule**: if the report cannot be written, the message carries the
    complete result plus an explicit warning. Truncation is only allowed when the
    full text exists on disk.
12. **Questions are not reports**: an `ask_question` outcome is delivered
    unchanged, parks the one-shot, and writes no report. A partial or interrupted
    result (`interrupted` marker present) is neither delivered nor saved — the
    existing rule that only a complete result is collected still decides what a
    "completed delegation" is.
13. **No new `details` key**: the report path lives in the message content, which
    is what the model reads. `details` stays exactly as the contract tests assert
    it. Alternative: add `details.reportPath` for the expanded UI view.

## Behavior contract

Delivered completion message body (after the existing
`Herdr agent <label> (<agent>) finished on its own:` header):

Small result (≤ 6 000 source units), report saved:

```text
<full result>

Full report saved to /Users/me/.pi/agent/herdr-agents-results/20260214T093105123Z-scout-1a2b3c4d.md
```

Large result, report saved:

```text
<first ≤ 4000 retained units, ending at a line boundary>

… 41230 characters omitted …

<last ≤ 2000 retained units, starting at a line boundary>

Full report saved to /Users/me/.pi/agent/herdr-agents-results/20260214T093105123Z-scout-1a2b3c4d.md (kept 30 days) — read it when you need the omitted part.
```

Report write failed:

```text
<full result>

Warning: failed to save the full report for Herdr agent <label>: <error>. Delivering the full result instead.
```

`41230` is exact: the source units present in neither the retained head nor the
retained tail (`result.length - head.length - tail.length`, always ≥ 1 in the
excerpt case).

Existing suffixes keep their order after the body: the close warning
(`Warning: failed to close one-shot Herdr agent <label>: <error>`) and the
`Spawn warnings:` block.

Unchanged by this feature:

- Exactly-once delivery, the claim before send, question-before-result,
  the fresh settled-status recheck, and batching with a single turn trigger.
- One-shot close and temp-artifact cleanup; close failure still returns the
  collected output with a warning.
- Non-blocking prompts: nothing here waits for the child.
- Status checks, their 30-line/2 000-char preview, and the `herdr_agent` tool
  parameters and `details`.
- The Herdr notification body (already capped at 400 chars), questions, closed
  history, resume validation, layouts, and child arguments.

Files on disk: directory mode `0700`, report files mode `0600`, plain UTF-8
Markdown, absolute path reported to the Orchestrator. Reports are pruned 30 days
after they are written; a `read` of a pruned path returns ENOENT, which is
accepted (the excerpt in context still carries the answer).

## Approach

### 1. `src/reports.ts` (new)

One module, no schema file — a report is plain text, so TypeBox adds nothing.

```ts
export const HERDR_AGENTS_REPORTS_DIR = 'herdr-agents-results';
export const REPORT_TTL_DAYS = 30;

export function herdrAgentReportsDir(agentDir: string = getAgentDir()): string;

/** Writes the full result once, then prunes expired reports. */
export async function saveAgentReport(input: {
  text: string;
  tabLabel: string;
  now?: Date;              // tests
  reportsDir?: string;     // tests; defaults to herdrAgentReportsDir()
  suffix?: () => string;   // tests; defaults to 4 random bytes as hex
}): Promise<string>; // absolute path of the written report

/** Removes owned reports older than the TTL. Never throws, never mkdir. */
export async function pruneExpiredReports(options?: {
  now?: Date;
  ttlDays?: number;
  reportsDir?: string; // defaults to herdrAgentReportsDir()
}): Promise<number>; // number of removed reports

/** Test hook, same shape as setFailNextStateMutation: fires once per count. */
export function setFailNextReportWrites(count: number): void;
```

The optional inputs on `saveAgentReport` exist for tests; production
callers pass only `text` and `tabLabel`.

- **One clock per save.** `const now = input.now ?? new Date()` is captured once
  and used for both the file name and the sweep that follows, so a save cannot
  date its file with one instant and prune against another.
- **Name**: `<YYYYMMDDThhmmssSSSZ>-<label slug>-<8 hex>.md`, e.g.
  `20260214T093105123Z-scout-1a2b3c4d.md`. The timestamp token is formatted from
  UTC parts, so there is no locale or colon/Windows hazard; the suffix comes from
  `randomBytes(4).toString('hex')` (`node:crypto`), matching
  `makeHerdrAgentName` in `src/utils.ts`.
- **Slug**: lower-cased, `[^a-z0-9_-]` runs collapse to `-`, trimmed, cut to 32
  chars, `agent` when empty. It carries no `.` and no separators, so a hostile
  label cannot escape the directory. The label is never used to derive
  uniqueness.
- **Directory** (decision 9): `mkdir(reportsDir, { recursive: true, mode: 0o700 })`
  then `lstat(reportsDir)`; `!isDirectory()` or `isSymbolicLink()` → throw;
  `mode & 0o777 !== 0o700` → `chmod(reportsDir, 0o700)`, and a failing `chmod`
  throws. Every failure here is a save failure, so the delivery falls back to the
  full text.
- **Write** (decision 10): up to 3 attempts of
  `const handle = await fs.open(path, 'wx', 0o600)`. `EEXIST` → new suffix,
  retry; a third `EEXIST` → throw. After a successful open:

  ```ts
  const handle = await fs.open(path, 'wx', 0o600); // ownership starts here
  try {
    await handle.writeFile(text, 'utf8');
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(path, { force: true }).catch(() => {}); // owned partial only
    throw error;
  }
  ```

  The `rm` targets exactly the path this call created; a collision file, a
  directory that happens to carry the name, or any other entry is never
  unlinked. Nothing is written before the open succeeds, so no path creates an
  unowned file.
- **No temp-file+rename**: nothing rewrites a report, `wx` already gives
  create-once semantics, and the caller degrades safely when the write fails.
- **Prune** (decision 8): `lstat` the reports dir first — missing, not a
  directory, or a symlink → return 0 without traversing; then `readdir` with
  `withFileTypes`, keep only regular files whose name matches the strict pattern,
  parse the timestamp, and `rm(path, { force: true })` when
  `now - savedAt >= ttl`. A name of the right shape with an invalid date (month
  `13`) is left alone — never delete what cannot be dated. The whole function is
  wrapped so it cannot throw: a missing directory, a `ENOTDIR` leaf, and per-file
  unlink failures all become a lower count. It never calls `mkdir`.
- **After a successful write**, `saveAgentReport` runs
  `await pruneExpiredReports({ reportsDir, now })`. No `bestEffort` wrapper:
  prune already never throws. Rationale for pruning here: the save is the only
  moment the extension touches this directory, and one call site is less code
  than a separate sweep trigger in the delivery path.
- **Failure injection**: `setFailNextReportWrites(count)` throws immediately
  after a successful open, which is exactly the "owned partial file" case. The
  count is consumed when it fires. Tests must reset it during teardown even if
  the expected save never occurs; the integration harness must clear it before
  disposal, following the existing state-failure hook pattern.

### 2. `src/output.ts` (bounded delivery text)

Next to `formatAssistantPreview`, same file and same kind of concern:

```ts
/** Retained-source budget, not an output budget: retained text stays verbatim. */
export const RESULT_EXCERPT_HEAD_CHARS = 4_000;
export const RESULT_EXCERPT_TAIL_CHARS = 2_000;

/**
 * `reportPath` is the durable copy of the full result. Truncation happens only
 * when that copy exists, so a failed save always delivers the full text.
 */
export function formatResultForDelivery(input: {
  result: string;
  tabLabel: string;
  reportPath?: string;
  reportError?: string;
}): string;
```

Order of decisions:

1. `reportError` → `result` + `\n\nWarning: failed to save the full report for
   Herdr agent <label>: <error>. Delivering the full result instead.`
2. No `reportPath` (nothing was attempted) → `result` unchanged. This is the
   no-truncation-without-a-durable-copy invariant, expressed once in the
   formatter.
3. `result.length <= HEAD + TAIL` → `result` + `\n\nFull report saved to <path>`.
4. Otherwise → head, blank line, `… <n> characters omitted …`, blank line, tail,
   path line with the retention hint.

Retained-slice rules (module-private helpers):

- Split on `\n` and take whole lines from the start (head) and the end (tail)
  while the running length stays within the budget.
- If a single line alone exceeds the budget, cut it by characters instead: the
  head keeps the first `HEAD` units, the tail the last `TAIL` units.
- Every hard cut is adjusted inward by one unit when it would split a surrogate
  pair (the unit before the cut is a high surrogate and the unit at the cut is a
  low surrogate), so neither slice can end or start with a lone surrogate. The
  adjustment only ever shrinks the retained slice.
- Display trimming (`trimEnd` on the head, `trimStart` on the tail) is applied
  before the count, and
  `n = result.length - head.length - tail.length` is computed from those final
  slices: `n` is exactly the number of source units absent from the delivered
  excerpt. In the excerpt path `n >= 1` by construction, because head and tail
  are each bounded by their own budget, their sum is the threshold, and the
  excerpt path only runs above it.
- The excerpt is a pure function of its input — no clock, no randomness.

### 3. `src/ui/detached-outcomes.ts` (wiring)

Inside the existing result branch, after the claim succeeds and **before** the
Herdr notification and `closeOneShot`:

```ts
let reportPath: string | undefined;
let reportError: string | undefined;
try {
  reportPath = await saveAgentReport({
    text: result,
    tabLabel: agent.tabLabel,
  });
} catch (error) {
  reportError = errorMessage(error);
}
```

Then `formatResultForDelivery({ result, tabLabel: agent.tabLabel, reportPath,
reportError })` produces the body passed to `formatCollectedOutput` as its
`output` argument, so the close warning and spawn warnings keep their current
order and shape. `details.result` therefore carries the same bounded body the
message states inline, and the renderer needs no change.

Claim, save, and crash windows:

- The claim is still the only gate. Only the claim winner writes a report and
  sends a message, so one delivered outcome means exactly one report — no new
  locking is needed; the unique name would also keep a hypothetical duplicate
  writer from corrupting another report.
- Crash after the claim, before the write: outcome lost, no report. Same loss
  model as today (a claim commits delivery; there is no retry), and the live
  record still says `collected`.
- Crash after the write, before `sendMessage`: the report exists, the message is
  lost; the status check reports "already collected". Strictly better than today,
  where nothing plain-text survives.
- Retries inside a tick: none exist for delivery, and none are added. A failed
  save degrades to a full delivery, not to a retry.

### 4. `src/index.ts` (startup cleanup)

In `herdrAgentsExtension`, after the child-mode early return, two synchronous
lines:

```ts
const reportsDir = herdrAgentReportsDir();
void pruneExpiredReports({ reportsDir });
```

The directory is resolved **synchronously, at load**, and passed in, so the
sweep never calls `getAgentDir()` again. That matters because the sweep is
fire-and-forget: the extension factory is synchronous, and a sweep that resolved
the environment later could read a different agent dir than the one the load ran
with. `pruneExpiredReports` never throws, so no rejection handling is needed. It
runs on every load including `/reload`; it is idempotent and cheap (one
`readdir`). No timer, no widget line, no user notification.

Test isolation — the actual lifecycle, not an assumed guard:

- `vitest.config.ts` pins `HERDR_AGENTS_STATE_PATH` through
  `test-support/state-path-guard.ts`, and that guard covers **only** the state
  file. Nothing guards the reports directory.
- `createHarness` (`test-support/harness.ts`, `test-support/e2e-harness.ts`) sets
  `PI_CODING_AGENT_DIR` with `applyEnv` and restores the previous value in
  `dispose()`, after `session_shutdown` and before `rm -rf <root>`; the e2e
  harness does the same. So during a test body the reports directory is the
  per-test temp dir, and after `dispose()` the ambient value (often the real
  `~/.pi/agent`) is back.
- Protection therefore comes from the sync capture plus the module's own rules:
  the sweep holds an absolute path captured at load, and it never creates a
  directory or traverses a symlinked leaf. A sweep leaked past a teardown
  resolves the temp path that `dispose()` already removed, so it finds nothing.
- A delayed startup sweep cannot switch to the restored environment because it
  holds the captured path. Future default-directory call sites must preserve
  this isolation; the state-path guard cannot detect mistakes here.

## Files to modify

- `src/reports.ts` — new module: directory resolution and policy, name, write
  protocol, TTL prune, test hooks.
- `src/output.ts` — retained-source budget and `formatResultForDelivery`.
- `src/ui/detached-outcomes.ts` — save before close, bounded body.
- `src/index.ts` — synchronous reports-dir capture plus startup prune.
- `test/reports.test.ts` (new), `test/output.test.ts`,
  `test/integration-bounded-delivery.test.ts` (new), `e2e/flow.test.ts`.
- `test-support/integration-harness.ts` — clear report failure injection during
  teardown if the implementation uses the proposed counter-based hook.
- `README.md`, `docs/flow.md`, `docs/tool.md`, `docs/config.md`, `AGENTS.md`.

No new dependency, no new tool parameter, no new config field, no new
environment variable.

## Reuse

- `getAgentDir()` — `@earendil-works/pi-coding-agent` (same import as
  `src/config.ts`); do not hand-roll `PI_CODING_AGENT_DIR` handling.
- `randomBytes` — `src/utils.ts` already imports it from `node:crypto`.
- `errorMessage` — `src/utils.ts`, for the wiring catch.
- `formatCollectedOutput`, `formatAgentOutput`, `formatSpawnWarnings` and the
  `PREVIEW_*` budget style — `src/output.ts` (compose, do not duplicate).
- Failure-injection hook style — `setFailNextStateMutation`
  (`src/state/store.ts`).
- `claimDetachedAgent`, `closeOneShot` — untouched; the report slots between
  them in the existing sequence.
- Not reusable here: the artifact helpers (`readAgentResult`,
  `isManagedHerdrTempPath`, `siblingArtifact`) are all guarded to
  `TMPDIR/herdr-agent-*` paths, and a report deliberately lives outside that
  tree. Read reports with plain `fs.readFile`.

## Steps

- [ ] Slice 1 — `src/reports.ts` plus `test/reports.test.ts` (naming,
      permissions, directory policy, write protocol, TTL, ownership, failure
      injection).
- [ ] Slice 2 — `src/output.ts` retained-source budget and
      `formatResultForDelivery` plus `test/output.test.ts` cases.
- [ ] Slice 3 — wire the save and the bounded body into
      `src/ui/detached-outcomes.ts`; `test/integration-bounded-delivery.test.ts`.
- [ ] Slice 4 — synchronous capture and startup prune in `src/index.ts` (the
      capture-versus-restoration unit case lives in slice 1's file).
- [ ] Slice 5 — docs: `README.md`, `docs/flow.md`, `docs/tool.md`,
      `docs/config.md`, `AGENTS.md` file list and invariants.
- [ ] Slice 6 — e2e case for a long real child result; run all four check
      commands plus `git diff --check`.

## Tests

Unit — `test/reports.test.ts`. Every case passes an explicit `reportsDir` except
the capture/restoration case; no case may run a default-directory call with the
real agent dir ambient (the state-path guard does not cover reports).

1. `saveAgentReport` writes `<reportsDir>/<ts>-<slug>-<8hex>.md`, returns the
   absolute path, and the file content equals the input text byte-for-byte.
2. Permissions: a fresh reports directory is `0700`, the file `0600`.
3. Directory policy: a pre-existing reports directory with mode `0755` is
   `chmod`ed to `0700` and the save succeeds; a reports-dir leaf that is a
   symlink to another temp directory makes the save throw, writes nothing into
   the target, and leaves the target's mode unchanged; a leaf that is a regular
   file makes the save throw.
4. Deterministic name from an injected `now` and an injected `suffix`; a label
   with `/`, `..`, spaces and non-ASCII yields a slug with no separator, and
   `path.dirname(written) === reportsDir` (no traversal).
5. Collision retry: with a `suffix` sequence whose first value is already taken
   (a pre-created file with known content) the second value is used, and the
   collision file keeps its content.
6. Collision exhaustion: with a constant `suffix` and that name already taken,
   the call throws after 3 attempts, the collision file keeps its content, and
   no other entry in the directory is removed. Same for a pre-created
   *directory* carrying the name.
7. Partial-write failure: `setFailNextReportWrites(1)`, then
   `saveAgentReport` rejects, the file it created is gone, and a collision file
   seeded in the same directory is untouched. The hook fires once, so the next
   save succeeds.
8. Prune with an injected `now`: a report dated 31 days ago is removed and one
   dated 29 days ago survives, the count is returned, and the `>=` TTL edge is
   pinned from both sides (exactly 30 days → removed; 30 days minus 1 ms →
   kept).
9. Prune leaves foreign entries alone: `notes.md`, `20260214T093105123Z.md`
   (wrong shape), a shape-matching name with month `13`, and a directory named
   like a report.
10. Prune on a missing directory returns 0 and creates nothing; prune on a
    symlinked or non-directory leaf returns 0 instead of throwing or traversing.
11. One clock per save: inject a `now` more than 30 days before wall-clock time.
    Seed one report 31 days before that injected instant and another at that
    instant. The save removes only the older seed; both the same-instant seed
    and the newly saved report survive. This proves pruning uses the save clock.
12. Capture versus restoration: set `PI_CODING_AGENT_DIR` to a temp dir with
    `applyEnv`, capture `herdrAgentReportsDir()` synchronously (as
    `src/index.ts` does), restore the environment, then await
    `pruneExpiredReports({ reportsDir })`: the expired report under the captured
    directory is gone, and nothing under the restored environment's directory is
    touched. This is the delayed-startup-sweep case; the same two calls are the
    whole startup wiring.

Unit — `test/output.test.ts`:

1. A result within the budget is returned verbatim plus exactly
   `\n\nFull report saved to <path>`, with no omission marker.
2. Exactly `HEAD + TAIL` units → whole; one unit more → excerpt. Both asserted
   with a fixed synthetic line-based input so the expected string is pinned.
3. Over-budget result: the head is ≤ 4 000 units and ends at a line boundary,
   the tail is ≤ 2 000 units and starts at a line boundary, the marker holds the
   exact `result.length - head.length - tail.length`, and the tail's last line
   (the child's `HERDR_RESULT:` line) survives. No assertion about the body
   being shorter than the source: assert instead that retained units are
   ≤ 6 000 and that the body is bounded by that plus the fixed marker/path
   overhead.
4. A barely-over-threshold input (6 001 units) still produces a body longer than
   the source — pinned as the documented consequence of a retained-source
   budget, so a future change to the marker or path line cannot silently change
   the contract.
5. One giant single-line result: the excerpt is non-empty, each slice is within
   its budget, and both a head and a tail slice are present.
6. Non-BMP safety: a long single line of astral characters (and a line-boundary
   variant) yields head and tail with no lone surrogate, and the omission count
   is still exact.
7. No `reportPath` → the full text is returned unchanged even when it exceeds
   the budget.
8. `reportError` → full text plus the exact warning line, no marker, no path.

Integration — `test/integration-bounded-delivery.test.ts` (via `withHarness`):

1. Large detached result (`setBehavior` writing > 6 000 units): the delivered
   message has the header, the `… N characters omitted …` marker, both excerpt
   ends, and `Full report saved to <path>`; the file at that path exists and its
   content equals what the child wrote; the temp artifact directory is gone
   (with the content match, this proves the save happened before cleanup); the
   pane closed and state pruned.
2. Small detached result: the message contains the full text (no marker) plus
   the path line; the file content matches.
3. Save failure through the hook: `setFailNextReportWrites(1)` before the
   delivery; the message then contains the complete result (no marker, no
   truncation) and the exact `Warning: failed to save the full report for Herdr
   agent <label>:` line, while the claim, the close and the temp cleanup all
   still happen.
4. Unsafe reports directory: create a regular file at the reports-dir path
   before the delivery; the same full-delivery warning appears and the delivery
   still completes.
5. Question outcome writes no report: a child that asks a question delivers the
   question, the one-shot stays open, and the reports directory holds no file
   for it.
6. Interrupted result writes no report: write `result.md` and its `interrupted`
   sibling directly into the live record's temp dir, settle the child, and assert
   no message and no report file.
7. Exactly-once: after the delivery, count the files in the reports directory and
   fire `session_start` plus a settle wait as the existing exactly-once test
   does; the count stays 1 and no second message arrives.
8. Resume turn: deliver, `resumeClosed` with the same label, deliver again; the
   reports directory holds 2 files with distinct names, the first file's content
   is byte-identical to the pre-resume read (immutable), and both messages carry
   their own path.
9. TTL sweep after a save: seed an expired, correctly named report (plus a fresh
   one and a foreign file) into the harness agent directory, run one delivery,
   and assert the expired file is gone while the fresh and foreign files remain.

E2E — `e2e/flow.test.ts`:

1. Script `MockLlm` for one child turn returning a long multi-line text
   (`setScript`, `delayMs: 0`). Assert the delivered message contains the
   omission marker and a report path under the hermetic `PI_CODING_AGENT_DIR`
   (`<root>/home/.pi/agent/herdr-agents-results/`), and that reading that file
   returns the child's full text — the end-to-end proof that a real Pi child's
   report survives its own pane closing.

## Docs updates

- `README.md`: a `Durable reports` feature bullet, and a short subsection under
  Usage: where reports live, one file per delivered result, 30-day retention,
  `read` it with `offset`/`limit` for the omitted middle, and that large results
  arrive as a head/tail excerpt bounded in retained source units (the message
  also carries the marker and path, so it can be slightly longer than the
  report's start).
- `docs/flow.md` (`Questions and result collection`, `Close and resume`): the
  save happens after the claim and before the notification/close/cleanup, so the
  delivered text does not disappear with the temp artifact; the delivered text is
  bounded only when the report exists; questions and interrupted results are not
  stored; report retention is separate from closed-history retention.
- `docs/tool.md` (Results table and a short `Bounded delivery` note): the
  delivered result text is the full captured text or a head/tail excerpt with an
  omission marker and the report path; the failed-save warning; the retained
  bound is source units, not a total output size; no new `details` keys.
- `docs/config.md` (`Not in this file`): the report directory and its 30-day TTL
  are not configurable.
- `AGENTS.md`: add `src/reports.ts` to Files, and one invariant — a delivered
  result is written to a report before the temp artifact is cleaned up, delivery
  truncates only when that durable copy exists, and the reports directory is
  `0700`/never a symlink.

## Acceptance criteria

- Small results are delivered unchanged apart from the one-line report path.
- Large results retain at most 4 000 units from the start and 2 000 from the end
  with an exact omission count, and the full text is on disk at the absolute path
  named in the message, readable through the `read` tool with paging.
- A failed report write (open, write, close, or directory policy) delivers the
  complete result with an explicit warning — never a silent truncation, and never
  by deleting a file this call did not create.
- Reports are immutable, uniquely named per delivered outcome (including resume
  turns), `0600` inside a `0700` real directory, and only own expired reports are
  removed, never by a background timer.
- Exactly-once delivery, the non-blocking prompt, close/cleanup order,
  questions, interrupted results, status checks, and `details` contracts are
  unchanged (existing integration and contract suites stay green).

Checks:

```bash
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration
npm run test:e2e
git diff --check
```

Manual verification:

1. Run a delegation whose child writes > 6 000 units; the delivered message shows
   the excerpt, the marker and the path.
2. `read` that path (paging for the middle) and confirm it matches the pane's
   full answer.
3. `stat -f '%Lp' ~/.pi/agent/herdr-agents-results ~/.pi/agent/herdr-agents-results/<report>`
   → `700` and `600`.
4. Back-date one report's filename token by 31 days and `/reload`: the file is
   gone, an unrelated `.md` in the directory is untouched.

## Risks and non-goals

Risks:

- A report path read after 30 days returns ENOENT. Accepted: the excerpt in
  context still carries the answer, and the message states the retention.
- The absolute path embeds the user's home directory and the label slug, and
  appears in the session JSONL and in any shared session. Accepted: it is the
  user's own local path, and Pi's own `bash`/MCP results already name full
  output paths.
- Unbounded disk growth under heavy parallel use (30 days × N/day × report size).
  Accepted for now: cleanup is cheap, and a size cap would need a rule the user
  has not approved.
- A huge reports directory makes a tick's awaited sweep proportional to its entry
  count. Accepted: `readdir` over a few thousand entries is milliseconds; a cap
  or a last-sweep memory is deliberately not added.
- Save failure means a full-length delivery into the context. That is the
  intended trade: never lose the only plain-text copy to keep the context small.
- A symlinked `herdr-agents-results` leaf disables reports (every delivery warns
  and sends the full text). Accepted: never `chmod` or write through a symlink.
  Alternative if the user wants it: follow the leaf symlink but skip the `chmod`.
- Compaction may drop the delivered message, including the path; nothing
  re-injects it, and the report is not re-delivered. Accepted.
- The state-path guard does not protect reports. Test calls must use fixture
  paths; delayed startup sweeps must retain the synchronously captured path.

Non-goals (explicitly out of scope):

- No LLM or heuristic summarization; the middle is dropped, not summarized.
- No configurable TTL, size cap, or per-profile override; no new config field or
  environment variable.
- No archive on manual close from `/herdr-agents`, and no archiving of partial or
  interrupted text: only a delivered, complete result is stored. (This leaves
  today's behaviour where closing a settled-but-undelivered agent discards its
  temp text; the user can veto this by asking for `closeOneShot` to save too.)
- No changes to steering, interruption, `cwd`, model selection, layouts,
  `herdr_agent` parameters, status previews, the closed-history index, the
  widget, or the manager overlay.
- No report index, no report browsing command, no per-report state records, no
  cross-Orchestrator report registry.
- No refactor of `output.ts`, `detached-outcomes.ts`, or the artifact helpers
  beyond the additions named above.
