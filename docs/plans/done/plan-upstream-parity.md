# Plan: second wave of porting from pi-interactive-subagents

> Historical implementation notes. See [README.md](../../../README.md) and
> [flow.md](../../flow.md) for the supported runtime and current behavior.

A continuation of [`plan-interactive-agents.md`](./plan-interactive-agents.md), where the
parallel agent limit, the widget, `ask_question` and asynchronous delivery were
already ported. The source is the same —
[amosblomqvist/pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents)
(HazAT's tmux fork). The comparison was done against their README + `activity.ts`,
`tools/safe-bash.ts`, `plugin/hooks/on-stop.sh` versus our
`schema.ts` / `agents.ts` / `types.ts` / the spawn block of `index.ts` / `widget.ts`.

The rule is the same: we port **features**, not the architecture. Each phase is a separate
merge with its own gate; the next one does not start until the previous one is green.

## Order and gates

| Phase | What | Risk | State |
|---|---|:---:|---|
| A | Profile frontmatter: `thinking`, `skills`, `system-prompt`, `disable-model-invocation` | low | ✅ done (2026-08-28) |
| B | Child isolation: `--no-extensions` + dynamic `--extension` selection | medium | planned |
| C | Stall detection via session-file growth + parent ping for detached | medium | planned |
| D | Message to an already working agent (steer into a live pane) | medium | planned |
| E | Resume a finished one-shot session via `agent_session` | medium | planned |
| F | Activity detail in the widget from the child's session file | low | planned |

The order is by benefit/risk ratio, not by value: A is cheap and
unlocks the rest of the profile fields. C, E and F, after the empirical checks
(see below), rest on one shared mechanism — the child's session file.
In the gate table D remains between them: it is independent of the session file and
must not wait for E/F. The shared `agent_session` parser lands in phase C;
E and F reuse it. The child writes nothing — the phase 1 decision
of the previous plan is no longer violated.

## Verified APIs

Verified through `pi --help`, introspection of the `node_modules` SDK and live
experiments (see the next section); nothing new has to be invented:

- Pi CLI flags we do not use yet: `--thinking <level>`,
  `--skill <path>`, `--no-skills`, `--system-prompt`, `--no-extensions`,
  `--extension`, `--exclude-tools`, `--session <path|id>`, `--session-id <id>`,
  `--fork`.
- Already used: `--name`, `--model`, `--tools`,
  `--append-system-prompt` (`index.ts`, the `piArgs` builder).
- **SDK (export of `@earendil-works/pi-coding-agent`):**
  - `pi.getAllTools(): ToolInfo[]` — every tool carries `sourceInfo.path` and
    `sourceInfo.source`; built-in tools have `source === "builtin"`
    (a synthetic path `<builtin:name>`), extension tools — the real path to the
    extension file. This gives a dynamic tool → extension map without hardcoding
    (phase B).
  - `DefaultPackageManager.resolve()` returns a package-aware list of resources,
    including `.pi/skills`, ancestor `.agents/skills`, configured paths and
    package skills. We pass its enabled skill paths into
    `loadSkills({ cwd, agentDir, skillPaths, includeDefaults: false })`, which
    returns **`LoadSkillsResult`** (`{ skills, diagnostics }`), not a bare
    `Skill[]`. Every `Skill` has `name` and `filePath`.
  - `ScopedModel` does **not** contain source info: a model → extension map is
    dynamically unreachable, so providers need a static list +
    a safe fallback (phase B).
  - `--no-extensions` disables **extension discovery**, not just tools.
    `getAllTools()` sees only extensions that are already loaded in the orchestrator
    process **and** registered a tool. Extensions without tools (e.g.
    `herdr-agent-state.ts`) are not in the map — they must be added explicitly (phase B).
- Herdr: `agent start|prompt|wait|send-keys|read|get`, `api snapshot`,
  `pane split --cwd`, `tab create --cwd`. `parseAgentSnapshot` today reads
  only `agent_status`, `state_change_seq`, `interactive_ready`, but a real
  `agent get` returns more: **`agent_session` — an `AgentSessionInfo` object**
  (`source`, `agent`, `kind`, `value`) plus `revision`, `cwd`. `kind` is
  `id` or `path`; `value` is a path to a file **only when `kind` === `path`**.
  Both suit `--session`; for `stat`/size in C/F — only `path`.
  This is the key to phases C/E/F.
- Our state file (`state.ts`) already stores a per-agent record with `resultFile`,
  `automationName`, `lifecycle`, `updatedAt`, `detached` — there is room for new
  fields.

## Empirical checks (2026-08-27)

Three live experiments in a Herdr session, each changed the design of phases:

1. **`state_change_seq` advances only on real state transitions.** Direct
   socket requests `pane.report_agent` to Herdr: two identical `working`
   reports → seq did not move; a real transition `working → idle` → a jump
   `1120 → 1124`; a report after `done` — ignored. Plus in the source code of
   `~/.pi/agent/extensions/herdr-agent-state.ts` (installed by Herdr):
   the Pi side deduplicates reports, and `agentActive` flips only on
   `agent_start`/`agent_settled` — that is, **within one turn seq freezes
   forever**, no matter how many tools run. Stall detection of "dead seq +
   working" from a previous edition of this plan would give a false stall on every
   healthy long turn — the design of phase C was rewritten.
2. **The session file is a progress signal at turn boundaries.** A live one-shot agent
   (`sleep 45` in one tool call): during the whole turn seq = `1137`
   with no movement, the session file — `0` records; after the turn finished all
   `6` records appeared at once. In the orchestrator's session, on the contrary, a record
   is appended immediately after every tool result. Consequence for C: the threshold must be
   "turn-scaled" (tens of minutes), because between turns of a healthy TUI child
   the file does not grow. Consequence for F: live detail like "which tool is active right
   now" from the session file is impossible — only post factum (finished turns).
3. **Children report `agent_session`.** A real spawned agent: `agent get`
   immediately returns `agent_session` (`kind` + `value`). Phase E does not need
   `--session-id <uuid>` guessing: the reference is already available. The implementation
   must look at `kind`, not always treat `value` as a path.

A limitation discovered alongside this: a TUI child agglomerates session-file records
at turn boundaries, so a child's session file is poorer in events than the
orchestrator's session for the same work. We cannot control this (the write strategy is
inside Pi), only account for it in thresholds.

---

## Phase A — Profile frontmatter

### Motivation

`discoverAgents` (`agents.ts`) reads only `name`, `description`, `tools`,
`model`, body. In the fork the profile also controls the thinking level, skills and the shape of
the system prompt. The practical difference: scout should not think like a reviewer, and
the child currently pulls **all** skills from disk, though roles need one or two.

### Design

Extend `AgentProfile` (`types.ts`) and the parser (`agents.ts`):

| Field | Action at spawn |
|---|---|
| `thinking` | `--thinking <level>`; validate against `off, minimal, low, medium, high, xhigh, max`, an unknown value — ignore with a warning in `details` |
| `skills` | comma-separated list of names → `--no-skills` + `--skill <path>` for each one found; a name that is not found does not fail the spawn |
| `system-prompt` | `append` (the default, as now) or `replace` → `--system-prompt` instead of `--append-system-prompt`. `CHILD_PROTOCOL` is **always** added, even with `replace` |
| `disable-model-invocation` | the profile remains spawnable by name, but disappears from the `agent` description in the schema/`details` |

Resolving `skills` goes through the SDK `DefaultPackageManager.resolve()` with the same
`cwd` / `agentDir`, then the enabled skill paths are passed into
`loadSkills({ ..., includeDefaults: false })`. This covers user/project `.pi`,
ancestor `.agents`, configured paths and package skills with the same
precedence as Pi. Name → `skill.filePath` → `--skill <path>`. Missing
configured packages are not installed during resolution. We do not add separate caching
between spawns, to avoid drift from settings or disk.

`cwd` is deliberately **not** in this phase — see the open questions.

### Tests

- unit (`agents.test.ts`): parsing of each field, invalid `thinking`,
  empty `skills`, `system-prompt: replace` stored as a profile
  value (the parser does not build argv).
- contract (`contract.test.ts`): the exact `agent start` argv for a profile with all
  fields; with `system-prompt: replace` the argv has `--system-prompt` **and**
  `CHILD_PROTOCOL` (this is the spawn block, not `agents.ts`); a profile without the new fields
  gives a **byte-for-byte** previous argv.

### Gate

`bun run test` green; a profile without the new fields does not change a single argument.

---

## Phase B — Child isolation

### Motivation

We pass only `--tools`, so in every child **all** discovered extensions
are initialized. Their tools are filtered by the allowlist, but injected
instructions, widgets and hooks remain: extra context, a longer start,
unexpected side effects in an autonomous child. The fork starts with
`--no-extensions` and brings back only what backs the allowed tools.

### Design

There will be **no** hardcoded tool → extension map: introspection gives it for free
and without drift.

1. On a spawn with an allowlist: `pi.getAllTools()` → for each allowed
   tool we take its `sourceInfo`. `source === "builtin"` → nothing needed;
   otherwise `sourceInfo.path` is the extension file that registers this tool →
   `-e <path>`. The same file is added once.
2. **Model providers are the main trap of this phase.** `--no-extensions` also kills
   provider extensions: the `reviewer` profile with `model: kiro-acp/...`
   would fail without the `kiro-acp` extension. This cannot be solved dynamically
   (`ScopedModel` has no source info, see verified APIs), therefore:
   - a static list `PROVIDER_EXTENSIONS: Record<providerPrefix, path>`
     in `constants.ts` (today one entry: `kiro-acp`);
   - if the profile's provider is not built-in and not in the list → **do not isolate**: spawn
     without `--no-extensions`, as now, plus a warning in `details`. Silently
     breaking a model is worse than temporarily not isolating.
3. **`--no-extensions` disables discovery, not just tools.** `getAllTools()`
   does not see extensions without tools. Without an explicit `-e` the child loses
   `pane.report_agent` / `pane.report_agent_session` — the wait/idle breaks, and so do the
   widget and the whole shared mechanism of C/E/F. Therefore with `--no-extensions`
   **always** add (paths from `import.meta` / a sibling file, not
   a hardcoded `~`):
   - `herdr-agents/index.ts` — `ask_question` and the artifact writer (`child.ts`).
     The tool is registered only in child mode (`HERDR_AGENT_CHILD=1`), so in the
     orchestrator process it has no entry in `getAllTools()`;
   - `herdr-agent-state.ts` — Herdr status and session path reports.
     It has no tools at all, introspection will never pick it up.
   Other herdr integrations without tools (`zz-composer-herdr-agent.ts` etc.)
   are also invisible to `getAllTools()`. In the first iteration we do not add them; if
   needed — a separate entry in the same always-on list, not a heuristic.
4. An allowlisted tool that is not in `getAllTools()` (unknown name or a tool
   of another role) → a warning in `details`; the child receives fewer tools
   than the profile promised — this must be visible, not silent.
5. A profile without `tools` (no allowlist) stays as now — a full child
   without `--no-extensions`. Isolation turns on only together with a tool
   restriction and only if the model provider is known (point 2).

### Tests

- contract: the argv contains `--no-extensions`, `-e` for herdr-agents **and**
  `-e` for herdr-agent-state; a tool registered by a test extension
  adds its path; a built-in tool adds nothing; an unknown tool →
  a warning in `details`; a provider not in `PROVIDER_EXTENSIONS` → spawn
  without isolation + a warning; a profile without `tools` does not get
  `--no-extensions`.
- e2e (`e2e/flow.test.ts`): a real child with `tools: read` still executes
  `ask_question` and writes `result.md`; an isolated child still changes
  `agent_status` and returns `agent_session` (without `herdr-agent-state` this
  case is red — this is the phase gate).

### Gate

`bun run test:e2e` green — proves that an isolated child has lost neither
`ask_question`/artifacts nor Herdr reports (`agent_status`,
`agent_session`).

---

## Phase C — Stall detection

### Motivation

A detached agent that hangs is currently detected only by looking at the widget or via
the timeout of a synchronous wait. The fork has an `interactive` field and steers the parent
on `stalled` / `recovered` transitions.

### Design (rewritten after the empirical checks)

The original idea "dead `state_change_seq` + `working` = stall" is **disproved
by the experiment**: seq advances only on state transitions, and the Pi-side
Herdr extension reports state only at turn boundaries — inside a long
healthy turn seq freezes (see "Empirical checks", point 1).

Instead — the growth of the child's session file (depends on phase B:
an isolated child must keep loading `herdr-agent-state.ts`):

- `parseAgentSnapshot` (`herdr.ts`) is extended with an `agent_session` field
  (`kind` + `value`). For `stat`/size we take `value` only when `kind`
  means path; `kind: id` → stall detection stays silent (no file);
- into the state record: `sessionFile` (path, if any), `sessionRef` (`kind`+`value`
  for resume), `lastFileSize`, `lastGrowthAt`;
- status `stalled` if `agent_status === "working"` and the session file has not
  grown for more than `HERDR_AGENTS_STALL_MS` (the default raised to ~15 minutes:
  the child appends records in batches at turn boundaries, so a healthy turn with one
  long bash tool also gives a pause in growth). This is a **turn timeout**, not
  a hang detector inside a tool;
- `stalled` is shown in the widget with the `attention` tone (like `blocked`);
- **one** steer to the parent on entering `stalled` and one on `recovered`, only for
  `detached` agents. A `stallNotified` flag in the record, to avoid spamming;
  reset on `recovered` (any file growth or status change).

If the file is missing or `stat` throws ENOENT/EACCES → stall detection stays silent:
this is diagnostics, not correctness. An empty **existing** file (size 0) is
not "missing": the clock runs, and a stall may fire. Silence only on an access
error, not on a zero size.

The synchronous path gets no pings: there the orchestrator is already sitting in the tool and has
its own `timeoutMs`.

### Tests

- unit (`widget.test.ts`): `stalled` renders, the tone is right.
- integration: `neverSettle` + a file that does not grow + rewound time →
  exactly one steer, then file growth → `recovered` → exactly one;
  a missing session file (ENOENT) → no steers; an empty existing
  file + rewound time → a stall just like "does not grow"; `kind: id` without a path →
  no steers; a persistent non-detached agent gives no steers.

### Risk

False positives on very long single tools (build, e2e).
With batched writes, "the file did not grow for 15 min while `working`" ≈ a turn timeout, not
a hang. This is unfixable without a live signal from the child (writing one would violate the
phase 1 decision of the previous plan, see F). Hence the default of ~15 minutes,
the `attention` tone, one steer with no repeats. If it is noisy — raise the threshold, do not
change the logic.

---

## Phase D — Message to a working agent

### Motivation

The only way to add context to a child right now is to wait for `idle` or its
`ask_question`. If mid-work it becomes clear that it is digging in the wrong
direction, nothing can be done. The fork prints the message into the live pane and the child
picks it up at the turn boundary; we already have `herdr agent send-keys` (used
for the Enter nudge).

### Design

A separate tool `herdr_agent_message` — **not** a new mode of `herdr_agent`. Reason:
`herdr_agent` holds the whole lifecycle (spawn, allowlist, layout, closing), and
adding "and sometimes just print text" to it breaks its contract and tests.

```ts
{ tabLabel: string; message: string }
```

Behavior:

- the target agent is looked up among managed ones by exact label (the same function
  as for reuse);
- `working` → `agent send-keys` with newlines flattened + Enter, return
  "delivered, will be picked up at the turn boundary", do **not** wait;
- `idle` / `done` → refuse with the hint "use `herdr_agent` with the same
  `tabLabel`", so there are not two paths to one action;
- nothing changes in the state record except `updatedAt`.

Deliberately not done: delivering a result after such a message. Whoever was waiting
keeps waiting; whoever is detached will get it through the poller.

### Tests

- integration: a steer to a `working` agent → `send-keys` argv with flattened newlines;
  `idle` → an error with the hint; an unknown label → an error listing the known ones.
- e2e: a real child receives a second message mid-turn and mentions it in
  the final result.

---

## Phase E — Resume a finished session

### Motivation

A one-shot pane closes, the child's context is lost, and `result.md` remains.
The fork keeps a `name → session file` registry and resumes a finished session with a new
message. Decision taken: we do it.

### Design

`--session-id <uuid>` from the previous edition is **not needed**: Herdr itself
reports `agent_session` (`kind` + `value`, see "Empirical checks", point 3).
`--session` accepts both a path and an id. The parser is the same as in phase C.
Order:

1. After start, on the first successful `agent get` (the spawn block already performs
   a state check), we read `agent_session` into `sessionRef`; if `kind`
   is path, we duplicate `value` into `sessionFile`. We store the **base** `piArgs`
   **without** `--session`: otherwise a second resume would add the flag twice.
2. On closing a one-shot the record is **not deleted** but marked
   `closed: true, closedAt`. The temp dir / `resultFile` are cleaned up as now
   (oneshot cleanup) — the session file lives in `~/.pi/agent/sessions/`, not in the
   tmpdir, so the artifact cleanup does not break resume.
3. **Retention is a mandatory pruning change.** Today `pruneHerdrAgentsState`
   destroys the record of any non-live pane on every poller tick (~1 s),
   so without a carve-out a closed one-shot would disappear before anyone
   resumes it. New rule: keep `closed` records for `HERDR_AGENTS_RESUME_TTL`
   (default 7 days), live ones — pruned as now.
4. `herdr_agent` with the `tabLabel` of a closed agent and a new `task` → a new pane,
   base argv + one `--session <sessionRef.value>`, the same label;
   the record migrates to the new terminal key, `closed` is reset. If
   `kind` was path and the file is already gone (deleted earlier than the TTL) — refuse
   with an explicit error, the `closed` record is pruned; a silent fresh spawn
   under the same label is forbidden.
5. Label conflict: the label of a closed agent matches a live one → the live one has
   priority (reuse as now), the closed one waits for its TTL.

### Limitations

- Resume brings old tool results and old errors back into the context —
  the price of continuing instead of a fresh session. Therefore "fresh context" from
  `docs/README.md` remains the default: resume only through an explicit `tabLabel`
  of a closed agent, not through the `agent` name.
- `--fork` instead of `--session` ("continue without the risk of spoiling the original")
  remains outside the first iteration — there is no visible consumer.

### Tests

- integration: closing a one-shot → the record lives with `closed: true`; the TTL passes →
  the record is pruned; `herdr_agent` with the label of a closed one + a `task` → the argv
  contains exactly one `--session <value>` (and after a second resume also one);
  the session file is deleted → an explicit error, not a fresh spawn; a label conflict →
  the live one has priority.
- e2e: the full cycle — a one-shot runs, closes, resume with the same
  label → the new answer accounts for the context of the first task.

---

## Phase F — Widget activity detail

### Motivation and why this is no longer a reversal of a decision

Phase 1 of the previous plan explicitly decided: "the child writes nothing", because Herdr
already returns `agent_status`. That remains right for **status**.
A previous edition of this plan was going to violate it for the sake of live
`active · bash 7m` via an `activity.json` from the child. The empirical checks
opened another path: the child's session file already contains **finished** turns
and tools, and Herdr returns the reference (`agent_session`). This is a **downgrade**
relative to the fork / the old F, not an equivalent: during a turn the file does not grow,
so "last" and "7m ago" are from the **previous** turn. Live tool detail is unreachable
without violating the phase 1 decision. The widget shows post-factum detail, not the current
tool.

### Design

- `parseAgentSnapshot` returns `agent_session` (`kind` + `value`) — a change shared
  with phase C; detail only when `kind` gives a path;
- the poller reads the tail of the session file (the last ~64 KB, once per tick — cheap)
  as JSONL: we count records by `type` (turns / tool calls), not lines.
  A large tool result can easily evict history from those 64 KB — then we show
  what is visible in the tail, without claiming a full count;
- during `working` the widget shows post-factum detail like
  `working · 3 turns · last: bash · 7m ago` (the last **finished** turn);
  the file is missing/empty/`kind: id` → the row is exactly as now;
- Herdr remains the source of truth for status; the session file is only
  detail. The child writes nothing — the phase 1 decision is preserved.

### Gate

Deleting/inaccessibility of the session file changes nothing except the detail of the
row — this is verified by a test, not by eye.

---

## What we do not port

In addition to the list in `plan-interactive-agents.md`:

- **`safe_bash` (a blocklist of destructive commands for children)** — the wrapper
  blocks about a dozen patterns (`rm -rf /`, `sudo`, `curl|sh`...), but it is bypassed with
  a single `node -e` or `base64 | sh`: this is not a sandbox and not a security model, but an
  illusion of protection. The child already has the `ask_question` channel for doubtful
  actions, and against obvious catastrophe the cheaper protection is a paragraph in
  `CHILD_PROTOCOL`. Return to this only if a real incident appears or a legit
  sandbox mechanism does.

- **Recursive spawn** (`subagent_agents` + `PI_SUBAGENT_ALLOWED`) — the decision
  stands: `HERDR_AGENT_CHILD=1` disables delegation in the child. If it is ever
  revisited, then with exactly the fork's whitelist model (a list of allowed targets in the
  profile, which also issues the spawn toolset), not by removing the flag.
- **`cli: claude`** + a Stop hook with a sentinel file — interesting as a template for
  heterogeneous backends, there is no consumer.
- **`auto-exit` as the child's decision** — with us the closing of a one-shot is done by the
  orchestrator after the collected result; that is more deterministic. At the same time
  the fork covers the case "a human typed something into the pane by hand", which we do not
  have in the behavior description — record it as a known gap, not as a phase.
- **`PI_SUBAGENT_SHELL_READY_DELAY_MS`** — we start through
  `herdr agent start`, not by typing into a shell.
- **Automatic name suffixes** — already there (`uniqueLabel`, in both pane and tab mode).
- **`config.json` in the extension directory** — we keep config in env
  (`HERDR_AGENTS_LAYOUT`), we do not add a second mechanism.

## Open questions

1. **`cwd` / role folders.** The fork gives a role its own directory with its own AGENTS.md and
   `.pi/`. With us `cwd` is in `HerdrAgentInfo`, but the pane always inherits the cwd
   of the orchestrator. The question is not about the implementation (`pane split --cwd` already
   can), but whether to add `cwd` to the tool schema — we deliberately keep it narrow
   (layout, for example, was removed from it). Proposal: first only
   `cwd:` in the profile frontmatter, do not add it to the schema.
2. **Per-call model override.** The fork has `model` in the call. Our schema does not, and
   so far that is rather a plus: the choice of model belongs to the role. Do not do it without a
   real case.
3. **The stall threshold.** The default of ~15 minutes is a guessed number, and it is below
   the ceiling because of the batched appending of the session file at turn boundaries. Refine
   it after the first week with phase C; in parallel check on real
   long turns (build, e2e) whether a finer growth signal appears
   (thinking/streaming are appended earlier than tool results). If it appears —
   the threshold can be lowered.
4. **The `agent_session` source for children with a non-standard CLI.** If a child ever
   appears that does not start through TUI Pi (the "heterogeneous
   backends" phase from the fork), `agent_session` is not guaranteed for it — phases C/E/F
   must degrade silently, as described in their gates.
