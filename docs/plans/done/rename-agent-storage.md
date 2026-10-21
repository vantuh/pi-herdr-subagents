# Rename agent storage

Phase 2 of the tool unification: give the extension's own storage files names
derived from the package name `@vantuh/pi-herdr-subagents`, migrating existing
data once, without losing settings, live records, history or reports.

Phase 1 (`docs/plans/done/unify-agent-tools.md`) removed `herdr` from the
model-facing surface. These files are runtime-only, and the `herdr` prefix here
is deliberate: it identifies the owning package in the shared agent directory.

## Names

| Current | New |
|---|---|
| `~/.pi/agent/herdr-agents.json` | `~/.pi/agent/pi-herdr-subagents.json` |
| `~/.pi/agent/herdr-agents-state.json` | `~/.pi/agent/pi-herdr-subagents-state.json` |
| `~/.pi/agent/herdr-agents-results/` | `~/.pi/agent/pi-herdr-subagents-results/` |

Unchanged on purpose:

- Package name and repository directory: it is a Herdr-only extension, and Pi
  loads it by path (`~/projects/personal/pi-herdr-subagents`) from
  `~/.pi/agent/settings.json`.
- `~/.pi/agent/herdr-agent-sessions/`: absolute paths live in
  `closedHistory.sessionPath` and in Pi session headers, so a rename needs a
  record rewrite and a resume revalidation pass. Separate task, if ever.
- `TMPDIR/herdr-agent-<id>` prefix: the same string is a security boundary in
  `src/artifacts.ts` (managed-temp path check), `src/herdr/cli.ts` (argv
  redaction) and `src/control.ts` (control-directory policy). Renaming it would
  require accepting both prefixes indefinitely for no user-visible gain.
- `PI_AGENTS_STATE_PATH`, `PI_AGENTS_LOCK_WAIT_MS`,
  `PI_AGENTS_CLAIM_LEASE_MS`: they already carry the neutral prefix and are
  test-only overrides.

## Migration

One-time, at extension load, before anything reads config or state:

1. **State.** If the new path does not exist and the old one does, rename it
   under the existing cross-process state lock. If both exist, use the new file
   and leave the old one untouched with a stderr warning; never merge.
2. **Reports directory.** If the new directory does not exist and the old one
   does, rename it in the same parent (atomic). Refuse with a stderr warning if
   the old path is a symlink, matching the write path's existing refusal. The
   269 existing reports move with the directory; their stamped names are
   unchanged, so TTL prune keeps working.
3. **Config.** No runtime migration: the file is chezmoi-managed. Rename its
   source in `~/dotfiles/home/dot_pi/private_agent/`, commit, `chezmoi apply`,
   then remove the stale destination file (chezmoi leaves a removed source's
   destination in place). The loader reads only the new name.

Migration is idempotent, runs once per load, and writes nothing when neither
path exists. A failure to rename is reported on stderr and never blocks startup:
the extension then starts with empty state rather than crashing.

Accepted effect: a second Orchestrator process loading an older extension build
keeps writing the old files; the first process to migrate wins and the other
sees separate state. Multi-process use on one agent dir is already unsupported.

## Steps

Each step ends green on `npm run typecheck`, `npm run lint`, `npm run test:unit`
and `npm run test:integration`; commit per step. Step 5 also runs
`npm run test:e2e`.

1. **Paths and constants.** New names in `src/config.ts` (`HERDR_AGENTS_CONFIG_FILE`
   → the package-derived name), `src/reports.ts`, `src/state/store.ts`. Update
   the model-less strings that name the config file (`src/tool/spawn/targets.ts`)
   and the comments in `src/config/schema.ts` and `src/index.ts`.
2. **Migration module.** One small module (e.g. `src/state/migrate.ts`) with the
   state and reports renames, called once from `src/index.ts` before the config
   promise and state reads. No new abstraction beyond the two renames.
3. **Tests.** Unit: only-old renames, only-new stays, both-exist keeps the old
   file and warns, neither path is a no-op, symlinked reports directory is
   refused. Integration: a legacy state file with a closed-history record is
   migrated and still resumable; a delivered result writes its report into the
   new directory; prune still dates the moved reports.
4. **Dotfiles.** Rename the chezmoi source, commit, apply, remove the stale
   destination. Verify `/reload` and that `agent_spawn` still honours
   `layout: pane`.
5. **Docs and live check.** `README.md`, `docs/config.md`, `docs/flow.md`,
   `AGENTS.md`; not `docs/plans/done/`. Then `test:e2e` and one live
   `agent_spawn` + `agent_send` round trip: report lands in the new directory,
   `/agents` still lists the migrated history, the agent closes.
