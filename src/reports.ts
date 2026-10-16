import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { getAgentDir } from '@earendil-works/pi-coding-agent';

export const HERDR_AGENTS_REPORTS_DIR = 'herdr-agents-results';
export const REPORT_TTL_DAYS = 30;

const REPORT_FILE_MODE = 0o600;
const REPORT_DIR_MODE = 0o700;
const WRITE_ATTEMPTS = 3;

/** `<UTC ms stamp>-<label slug>-<8 hex>.md`; the stamp is what prune reads back. */
const REPORT_NAME = /^(\d{8}T\d{9}Z)-([a-z0-9_-]+)-([0-9a-f]{8})\.md$/;

export function herdrAgentReportsDir(agentDir: string = getAgentDir()): string {
  return path.join(agentDir, HERDR_AGENTS_REPORTS_DIR);
}

/** `20260214T093105123Z`: the ISO form with its separators dropped. */
function reportStamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, '');
}

/** The label is a hint only: no `.` and no separators can survive here. */
function slugLabel(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, 32) || 'agent';
}

/**
 * The instant an own report name carries, or undefined when it is not one of
 * ours or when its stamp is not a real instant (month 13, hour 24, minute 60):
 * the stamp must survive a round trip, so nothing undatable is ever removed.
 */
function reportSavedAt(name: string): Date | undefined {
  const match = REPORT_NAME.exec(name);
  if (!match) return undefined;
  const [, stamp] = match;
  const iso =
    `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}` +
    `T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.${stamp.slice(15, 18)}Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return reportStamp(date) === stamp ? date : undefined;
}

let failNextReportWrites = 0;

export function setFailNextReportWrites(count: number): void {
  failNextReportWrites = Math.max(0, count);
}

function throwIfInjectedReportWrite(): void {
  if (failNextReportWrites <= 0) return;
  failNextReportWrites -= 1;
  throw new Error('injected report write failure');
}

/**
 * The reports directory is ours: a real directory, `0700`, never a symlink leaf,
 * so neither `chmod` nor a write ever follows a user-planted path. A symlinked
 * *parent* (an agent dir that is itself a symlink) is followed normally, which
 * `mkdir` already does.
 */
async function ensureReportsDir(reportsDir: string): Promise<void> {
  await fs.mkdir(reportsDir, { recursive: true, mode: REPORT_DIR_MODE });
  const stat = await fs.lstat(reportsDir);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to write reports into a symlink: ${reportsDir}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Reports path is not a directory: ${reportsDir}`);
  }
  // mkdir's mode only applies to a created leaf, so repair a pre-existing one.
  if ((stat.mode & 0o777) !== REPORT_DIR_MODE) {
    await fs.chmod(reportsDir, REPORT_DIR_MODE);
  }
}

/**
 * Write the full result once, then prune expired reports with the same clock.
 * Returns the absolute report path; any failure throws, and the caller then
 * delivers the full text instead of a truncated one.
 */
export async function saveAgentReport(input: {
  text: string;
  tabLabel: string;
  now?: Date;
  reportsDir?: string;
  suffix?: () => string;
}): Promise<string> {
  const reportsDir = path.resolve(input.reportsDir ?? herdrAgentReportsDir());
  const now = input.now ?? new Date();
  await ensureReportsDir(reportsDir);
  const stamp = reportStamp(now);
  const slug = slugLabel(input.tabLabel);

  let collision: unknown;
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    const suffix = input.suffix?.() ?? randomBytes(4).toString('hex');
    const reportPath = path.join(reportsDir, `${stamp}-${slug}-${suffix}.md`);

    let handle;
    try {
      handle = await fs.open(reportPath, 'wx', REPORT_FILE_MODE);
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
      collision = error;
      continue;
    }

    // Ownership of the file starts at the open above: only that handle's
    // failure may unlink this path, never a name this call did not create.
    try {
      throwIfInjectedReportWrite();
      await fs.writeFile(handle, input.text, 'utf8');
      await handle.close();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fs.rm(reportPath, { force: true }).catch(() => undefined);
      throw error;
    }

    await pruneExpiredReports({ reportsDir, now });
    return reportPath;
  }

  throw collision ?? new Error('no report write attempted');
}

/**
 * Remove own reports at or past the TTL, best-effort: never creates the
 * directory, never traverses a symlinked leaf, never throws.
 */
export async function pruneExpiredReports(
  options: { now?: Date; reportsDir?: string } = {},
): Promise<number> {
  const reportsDir = path.resolve(options.reportsDir ?? herdrAgentReportsDir());
  const now = (options.now ?? new Date()).getTime();
  const ttlMs = REPORT_TTL_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  try {
    const stat = await fs.lstat(reportsDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return 0;
    for (const entry of await fs.readdir(reportsDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const savedAt = reportSavedAt(entry.name);
      if (!savedAt || now - savedAt.getTime() < ttlMs) continue;
      try {
        await fs.rm(path.join(reportsDir, entry.name), { force: true });
        removed += 1;
      } catch {
        // A failed unlink leaves that report; the sweep keeps going.
      }
    }
  } catch {
    // Missing or unreadable directory: nothing to prune.
  }
  return removed;
}
