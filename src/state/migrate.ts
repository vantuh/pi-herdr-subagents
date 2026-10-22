import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { getAgentDir } from '@earendil-works/pi-coding-agent';

import { HERDR_AGENTS_REPORTS_DIR } from '../reports.ts';
import { errorMessage } from '../utils.ts';
import { withStateFileLock } from './lock.ts';
import { getHerdrAgentsStatePath } from './store.ts';

const LEGACY_STATE_FILE = 'herdr-agents-state.json';
const LEGACY_REPORTS_DIR = 'herdr-agents-results';

type Warn = (message: string) => void;

interface MigrationOptions {
  agentDir?: string;
  statePath?: string;
  warn?: Warn;
}

function warnToStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * The state file lives beside its own path, so an explicit `PI_AGENTS_STATE_PATH`
 * moves the legacy name with it. Both files present is never merged: the new
 * file wins and the old one stays as the user left it.
 */
async function migrateStateFile(statePath: string, warn: Warn): Promise<void> {
  const legacyPath = path.join(path.dirname(statePath), LEGACY_STATE_FILE);
  const needsRename = async () => {
    const [current, legacy] = await Promise.all([
      pathExists(statePath),
      pathExists(legacyPath),
    ]);
    if (current && legacy) {
      warn(
        `herdr-agents: ${statePath} and ${legacyPath} both exist; keeping ${statePath} and leaving ${legacyPath} untouched`,
      );
    }
    return !current && legacy;
  };
  if (!(await needsRename())) return;

  await withStateFileLock(statePath, async () => {
    if (!(await needsRename())) return;
    try {
      await fs.rename(legacyPath, statePath);
    } catch (error) {
      warn(
        `herdr-agents: failed to move ${legacyPath} to ${statePath}: ${errorMessage(error)}`,
      );
    }
  });
}

/**
 * The reports directory is ours and must never be a symlink leaf, matching the
 * write path: following one here would move a directory the user did not mean.
 */
async function migrateReportsDir(agentDir: string, warn: Warn): Promise<void> {
  const reportsDir = path.join(agentDir, HERDR_AGENTS_REPORTS_DIR);
  const legacyDir = path.join(agentDir, LEGACY_REPORTS_DIR);
  if (await pathExists(reportsDir)) {
    if (await pathExists(legacyDir)) {
      warn(
        `herdr-agents: ${reportsDir} and ${legacyDir} both exist; keeping ${reportsDir} and leaving ${legacyDir} untouched`,
      );
    }
    return;
  }
  let legacyStat;
  try {
    legacyStat = await fs.lstat(legacyDir);
  } catch {
    return;
  }
  if (legacyStat.isSymbolicLink()) {
    warn(
      `herdr-agents: refusing to move the symlink ${legacyDir}; reports stay under ${reportsDir}`,
    );
    return;
  }
  try {
    await fs.rename(legacyDir, reportsDir);
  } catch (error) {
    warn(
      `herdr-agents: failed to move ${legacyDir} to ${reportsDir}: ${errorMessage(error)}`,
    );
  }
}

/**
 * One-time rename of the pre-package-name storage files, called once per
 * extension load before config and state reads. Idempotent, and never throws: a
 * failed rename leaves the old file in place and the extension starts with the
 * new (empty) names.
 */
export async function migrateHerdrAgentStorage(
  options: MigrationOptions = {},
): Promise<void> {
  const warn = options.warn ?? warnToStderr;
  const statePath = options.statePath ?? getHerdrAgentsStatePath();
  try {
    await migrateStateFile(statePath, warn);
  } catch (error) {
    warn(
      `herdr-agents: state storage migration failed: ${errorMessage(error)}`,
    );
  }
  try {
    await migrateReportsDir(options.agentDir ?? getAgentDir(), warn);
  } catch (error) {
    warn(
      `herdr-agents: reports storage migration failed: ${errorMessage(error)}`,
    );
  }
}
