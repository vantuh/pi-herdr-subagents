import { promises as fs, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Stand-in for the live `~/.pi/agent/herdr-agents-state.json` for a whole test
 * run.
 *
 * `vitest.config.ts` pins `HERDR_AGENTS_STATE_PATH` to this path, so nothing in
 * a test process can fall back to the real state file — not even async work that
 * resolves the default path after a harness restored the env. Such a leak
 * prunes the sentinel record seeded here, and the teardown fails the run.
 *
 * The path is built once per run in the config's process and handed to the
 * workers through `test.env`, so importing this module from a test would give a
 * different pid; use the env var there.
 */
export const GUARDED_STATE_PATH = path.join(
  os.tmpdir(),
  `herdr-agents-state-guard-${process.pid}.json`,
);

const SENTINEL = `${JSON.stringify(
  {
    version: 2,
    agents: {
      'terminal:leak-sentinel': {
        lifecycle: 'oneshot',
        tabLabel: 'Leak Sentinel',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    },
    closedHistory: [],
  },
  null,
  2,
)}\n`;

export default function setupStatePathGuard(): () => Promise<void> {
  // A recycled pid can leave a file from an earlier run behind.
  rmSync(GUARDED_STATE_PATH, { force: true });
  writeFileSync(GUARDED_STATE_PATH, SENTINEL, 'utf8');

  return async () => {
    const content = await fs.readFile(GUARDED_STATE_PATH, 'utf8');
    if (content !== SENTINEL) {
      throw new Error(
        `A test touched the default state file at ${GUARDED_STATE_PATH}: async work leaked past a harness teardown.`,
      );
    }
    rmSync(GUARDED_STATE_PATH, { force: true });
  };
}
