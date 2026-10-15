import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { parseJson } from '../json.ts';
import { errorMessage } from '../utils.ts';
import { isNonEmptyString, PiSessionHeader } from './schema.ts';

export async function readPiSessionHeader(
  sessionFile: string,
): Promise<PiSessionHeader | undefined> {
  if (!path.isAbsolute(sessionFile)) return undefined;
  let stat;
  try {
    stat = await fs.lstat(sessionFile);
  } catch {
    return undefined;
  }
  if (!stat.isFile()) return undefined;

  const handle = await fs.open(sessionFile, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const firstLine = buf.toString('utf8', 0, bytesRead).split(/\r?\n/, 1)[0];
    if (!firstLine) return undefined;
    const parsed = parseJson(PiSessionHeader, firstLine);
    if (!parsed) return undefined;
    if (!isNonEmptyString(parsed.id) || !isNonEmptyString(parsed.cwd)) {
      return undefined;
    }
    return { type: 'session', id: parsed.id.trim(), cwd: parsed.cwd.trim() };
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

export async function validateResumableSessionFile(
  sessionFile: string,
  expected: { sessionId: string; cwd: string },
): Promise<PiSessionHeader | undefined> {
  const header = await readPiSessionHeader(sessionFile);
  if (!header) return undefined;
  if (header.id !== expected.sessionId) return undefined;
  if (path.resolve(header.cwd) !== path.resolve(expected.cwd)) return undefined;
  return header;
}

export async function resumableSessionDirError(
  cwd: string,
): Promise<string | undefined> {
  try {
    const stat = await fs.stat(cwd);
    if (!stat.isDirectory())
      return 'Session working directory is not a directory.';
    return undefined;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT') return 'Session working directory is missing.';
    return errorMessage(error);
  }
}
