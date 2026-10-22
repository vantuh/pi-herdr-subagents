# Profile-local state

## Scope

- Resolve default state through Pi's active agent directory; retain the explicit state-path override.
- Keep state locks beside each profile's state file and preserve shared configuration through symlinks.
- Skip legacy-name migration locking when no rename is needed; recheck under the lock before a rename.
- Cover default path resolution, override precedence, cross-profile locking, and migration with occupied locks.
- Document the storage boundary and the manual migration of previously mixed state.

## Runtime migration

- Stop relevant Pi sessions before modifying live storage.
- Back up current and legacy state and all report directories.
- Partition history by validated profile-local owner session paths; retain IDs and child session paths.
- Preserve every input record and report in the backup; validate retention before installing state.
- Archive legacy-name storage and remove only the confirmed empty, unused lock.
- Verify both profile loaders and migration warnings after installation.

## Checks

- `npm run typecheck`
- `npm run lint`
- `npm run test:unit`
- `npm run test:integration`

## Status

Completed on 2026-10-22. Typecheck, lint, 335 unit tests, and 193 integration tests passed.
The migration passed first in an isolated copy, then in the live directories with no Pi CLI sessions running.
All 260 history records remain: 225 personal and 35 work. All 316 reports remain.
The old storage names are archived, and the empty unused lock was removed.
Both profile migrations completed without warnings; no retention rule removed records.
Six older work child sessions remain at their existing personal-directory paths; their validated IDs and paths are unchanged.
No automatic stale-lock recovery or real-model end-to-end run was added.
