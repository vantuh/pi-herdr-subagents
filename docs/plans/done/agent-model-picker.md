# Agent model picker

## Context

The deleted `agents-models` extension (`dotfiles` `e34407c`, removed in `77ad9e6`) opened `/agents-models`: pick an agent, then a model. It wrote `subagents.agentOverrides.<agent>.model` plus `subagents.modelScope` into `~/.pi/agent/settings.json` or `<project>/.pi/settings.json`. Frontmatter was read only, to show where the current model came from.

`pi-herdr-subagents` does not use those settings. The only model a child starts with is `model:` in the profile markdown (`docs/plans/done/remove-parent-model-override.md`). `discoverAgents` (`src/agents.ts`) loads `getAgentDir()/agents/*.md`, then the nearest `.pi/agents`, and a project profile replaces a user profile with the same name. `AgentProfile.filePath` and `source` are already on the loaded profile. A non-string `model` is ignored; omit the field and the child gets Pi's default (`--model` is not passed).

Intended outcome: the same two-step popup, inside this extension, writing `model:` in the profile file that the next `herdr_agent` spawn will read. `modelScope` and `agentOverrides` are not ported.

## Decisions

- Command name: `/herdr-agent-models`. Distinct from `/herdr-agents` and from the old `/agents-models`.
- No write-target switch. The target is always the winning profile's `filePath`. Tab, `ScopeLine`, `toggleScope`, `scopes`, `localMissingNote` are dropped.
- TUI only. Outside TUI the handler notifies and returns, like the old command.
- No Pi reload. `discoverAgents` reads the files on each `herdr_agent` call. A pane that is already running keeps the model it started with.

## chezmoi drift (prerequisite outside this repo)

In the author's setup `~/.pi/agent/agents/*.md` are regular files copied by chezmoi from `~/dotfiles/home/dot_pi/private_agent/agents/`, not symlinks. A pin written to the target is overwritten by the next `chezmoi apply`.

- This repo does not handle chezmoi. The writer stays generic: it resolves `realpath` before the atomic rename, so a symlinked profile keeps its link and the source file is edited.
- Recommended dotfiles change (separate commit in `dotfiles`, not part of this plan's steps): turn each profile into a per-file `symlink_<name>.md.tmpl` pointing at a source file outside chezmoi's managed names, the same pattern as `symlink_settings.json.tmpl`. Do not symlink the whole `agents` directory: `kiro-subagents-bridge` writes `agents/kiro-active/` there at runtime.
- Until then, `docs/agent-profiles.md` notes that a copied (non-symlinked) managed file needs `chezmoi re-add` after a pin.

## Approach

Copy the picker UI from the deleted extension and replace the data source and the writer.

Source at `77ad9e6^`, `home/dot_pi/private_agent/extensions/agents-models/`:

- `picker.ts` — step machine (filter, back, close, confirm, clear, save-and-return-to-agents). Keep it, minus everything scope-related.
- `index.ts` — command and model list (scoped models first, then the rest sorted by `provider/id`, `no auth` mark). Keep the list. Drop scope wiring and `ctx.reload()`.
- `agents.ts` — pi-subagents roster. Do not copy. Use `discoverAgents`.
- `settings.ts` — JSON writer. Do not copy the JSON shape. Reuse only the temp-file + `realpath` + rename idea.
- `test/agents-models.test.ts` (`bun test`) — port picker step tests and write tests to Vitest. Drop `modelScope` / `agentOverrides` cases. Check how it fakes `TUI` and `KeybindingsManager` before porting.

### Picker data is a snapshot, refreshed after each write

The old picker called `buildData()` synchronously on every access (`this.data` getter, used during render). `discoverAgents` is async, so that does not port.

- The command awaits `discoverAgents(ctx.cwd)` once before opening the overlay and passes a plain snapshot (`PickerData`) to the picker.
- `apply` writes, then re-runs `discoverAgents` and returns the new snapshot (or an error string). The picker replaces its snapshot before returning to the agent step, so the row shows the new model.
- Remove the `data` getter; the picker holds the snapshot in a field.

### Agent rows

- Every discovered profile, including `disable-model-invocation: true` (dim note in the description). Those are still spawnable by name.
- Description: current `model` or `Pi default`, then `user` / `project`.
- Status after save shows the file path: `saved <agent> → <model | Pi default> (<filePath>)`. A project profile lives in the project's git tree; the path makes that visible.

### Model rows

- Scoped models, then the rest, as in the old `index.ts`.
- `clear model` row only when the profile currently has a `model`. Selecting it deletes the line.

## Write rules (`write.ts`)

`setProfileModel(filePath, model: string | null)`:

- Read the file fresh at write time; never reuse discovery content.
- Frontmatter block: line 1 is `---`, it ends at the next line that is exactly `---`. Found by a line scan, not `parseFrontmatter` (which returns no positions). No block → error.
- Match only top-level `model:` lines inside the block (`/^model:/`, no indentation). Nested keys and the markdown body are never touched.
- More than one top-level `model:` line → error, file untouched.
- Set: replace the matched line, or insert `model: <value>` right after the opening `---`.
- Clear: delete the matched line only. No line → no-op.
- Value: always `JSON.stringify(value)`. The originally proposed plain-scalar regex also accepted invalid YAML (`@local/model`) and non-string scalars (`true`, `123`).
- Reject existing quoted model keys and unsupported multiline model values without writing. Parse the original and edited frontmatter and verify the result changes only `model`; the line scan still determines edit positions.
- Keep the file's line ending (`\r\n` if the original uses it).
- Atomic write: `target = realpath(filePath)`, exclusively create `${target}.herdr-agent-models.tmp` with the original file mode, then `rename` onto `target`. Record temporary-file ownership immediately after opening, close the handle on failure, and clean up owned temporary files. Never remove another writer's file.
- Errors return a message for the picker status line; nothing throws out of the overlay.

## Files to modify

- `src/index.ts` — register `/herdr-agent-models` next to `/herdr-agents` (parent mode only; `index.ts` already returns before commands when `HERDR_AGENT_CHILD=1`).
- `src/ui/agent-models/picker.ts` — copied step machine, scope removed, snapshot field.
- `src/ui/agent-models/write.ts` — `setProfileModel`.
- `src/ui/agent-models/command.ts` — TUI guard, snapshot from `discoverAgents`, model list from `ctx.modelRegistry` / `ctx.scopedModels`, `apply` = write + re-discover.
- `test/agent-models.test.ts` — picker steps and write rules.
- `test/contract-commands.test.ts` — command registered in parent mode, absent in child mode.
- `test/contract-profile-argv.test.ts` — a pin written by `setProfileModel` reaches the child argv as `--model`; a cleared pin omits it.
- `docs/agent-profiles.md` — the command edits `model:` in the file discovery selected; symlink and chezmoi note.
- `README.md` — add the command to the Commands bullet.
- `AGENTS.md` — `Files` entries for `src/ui/agent-models/*`.

No change to spawn, `herdr_agent` parameters, or `src/agents.ts` parsing.

## Reuse

- `discoverAgents`, `AgentProfile` (`src/agents.ts`, `src/agents/types.ts`) — roster, `filePath`, `source`.
- `ctx.ui.custom` overlay, `SelectList`, `DynamicBorder`, `fuzzyFilter` — same pattern as `src/ui/manager.ts`.
- `ctx.modelRegistry.getAvailable()`, `hasConfiguredAuth`, `ctx.scopedModels`.
- Deleted `picker.ts` step machine.

## Steps

- [x] Add `write.ts` with the rules above.
- [x] Copy `picker.ts`; drop scope; replace `buildData` with a snapshot field updated from `apply`.
- [x] Add `command.ts`: TUI guard, empty-roster notify, model list, `apply`.
- [x] Register the command in `src/index.ts`.
- [x] Tests: `agent-models.test.ts`, `contract-commands.test.ts`, `contract-profile-argv.test.ts` cases.
- [x] Docs: `docs/agent-profiles.md`, `README.md`, `AGENTS.md`.

## Verification

- `npm run typecheck`, `npm run lint`, `npm run test:unit`, `npm run test:integration`.
- Unit (`write.ts`): set replaces one line and keeps `thinking` and the body; set inserts after `---` when absent; clear removes only `model`; nested `  model:` and a `model:` in the body are untouched; duplicate top-level `model:` errors without writing; CRLF preserved; file mode preserved; a symlinked file keeps the link and the target changes; values including `@local/model`, `true` and `123` round-trip as strings; quoted model keys and unsupported multiline values error without writing; failed writes/renames leave the profile intact and clean up owned temporary files.
- Unit (picker): select agent → model → save returns to the agent list with the refreshed description; `clear model` row only when a model is set; Esc on the model step goes back, on the agent step closes; a write error stays on screen.
- Integration: see `contract-*` cases above.
- Manual, in a TUI session: `/herdr-agent-models`, pin one profile, run `herdr_agent` for it, confirm the child starts with the new `--model`.

## Completion

Implemented and independently reviewed. All code was written by the Orchestrator;
read-only agents supplied reconnaissance and review.

- Passed: `npm run typecheck`, `npm run lint`, `git diff --check`.
- Passed: 213 unit tests and 138 integration tests.
- Passed: 15 real Pi/Herdr E2E tests on an isolated final run. One earlier run,
  concurrent with unit/integration checks, failed the unchanged cold-shell test
  with `agent_pane_busy`; no retry logic or test changes were added.
- Not performed: manual interaction with `/herdr-agent-models` in a live TUI.
  Picker behavior and profile-to-child argv are covered by automated tests.
- Not included: the separate dotfiles/chezmoi symlink migration.

Review-driven corrections to the original write rules: always quote model
values, reject unsupported YAML without changing files, and clean up temporary
files even after a partial write.
