import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { errorMessage } from './utils.ts';

export const RESULT_FILE_MARKER = 'HERDR_RESULT_FILE:';

export const ASK_QUESTION_TOOL = 'ask_question';

/** Child-only: absolute path to the private session metadata artifact. */
export const SESSION_META_ENV = 'HERDR_AGENT_SESSION_META';

const SESSION_META_FILE_NAME = 'session.json';

interface ChildSessionMeta {
  sessionId: string;
  sessionFile?: string;
  cwd: string;
  updatedAt: string;
}

interface PiSessionHeader {
  id: string;
  cwd: string;
}

export async function createAgentTempFiles(systemPrompt: string): Promise<{
  systemFile: string;
  resultFile: string;
  sessionMetaFile: string;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'herdr-agent-'));
  const systemFile = path.join(dir, 'system.md');
  await fs.writeFile(systemFile, systemPrompt, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return {
    systemFile,
    resultFile: path.join(dir, 'result.md'),
    sessionMetaFile: path.join(dir, SESSION_META_FILE_NAME),
  };
}

export async function createResultFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'herdr-agent-'));
  return path.join(dir, 'result.md');
}

export function isManagedHerdrTempPath(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  const relative = path.relative(os.tmpdir(), resolved);
  return (
    !relative.startsWith('..') &&
    relative.split(path.sep)[0]?.startsWith('herdr-agent-') === true
  );
}

function isManagedAgentFile(filePath: string, fileName: string): boolean {
  return (
    isManagedHerdrTempPath(filePath) &&
    path.basename(path.resolve(filePath)) === fileName
  );
}

function isManagedResultFile(filePath: string): boolean {
  return isManagedAgentFile(filePath, 'result.md');
}

/**
 * The question lives next to the result file, so the child can derive it from
 * the single `HERDR_RESULT_FILE:` marker already present in its prompt — no
 * second marker to keep in sync.
 */
export function questionFileFor(
  resultFile: string | undefined,
): string | undefined {
  if (!resultFile || !isManagedResultFile(resultFile)) return undefined;
  return path.join(path.dirname(path.resolve(resultFile)), 'question.md');
}

function isManagedSessionMetaFile(filePath: string): boolean {
  return isManagedAgentFile(filePath, SESSION_META_FILE_NAME);
}

export function sessionMetaFileFor(
  resultFile: string | undefined,
): string | undefined {
  if (!resultFile || !isManagedResultFile(resultFile)) return undefined;
  return path.join(
    path.dirname(path.resolve(resultFile)),
    SESSION_META_FILE_NAME,
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export async function writeAgentSessionMeta(
  filePath: string | undefined,
  meta: ChildSessionMeta,
): Promise<string | undefined> {
  if (!filePath || !isManagedSessionMetaFile(filePath)) return undefined;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(meta)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return filePath;
}

export async function readAgentSessionMeta(
  resultFile: string | undefined,
): Promise<ChildSessionMeta | undefined> {
  const filePath = sessionMetaFileFor(resultFile);
  if (!filePath) return undefined;
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ChildSessionMeta>;
    if (!isNonEmptyString(parsed.sessionId) || !isNonEmptyString(parsed.cwd)) {
      return undefined;
    }
    return {
      sessionId: parsed.sessionId.trim(),
      cwd: parsed.cwd.trim(),
      updatedAt:
        typeof parsed.updatedAt === 'string'
          ? parsed.updatedAt
          : new Date(0).toISOString(),
      ...(isNonEmptyString(parsed.sessionFile)
        ? { sessionFile: path.resolve(parsed.sessionFile.trim()) }
        : {}),
    };
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

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
    const parsed = JSON.parse(firstLine) as {
      type?: unknown;
      id?: unknown;
      cwd?: unknown;
    };
    if (parsed.type !== 'session') return undefined;
    if (!isNonEmptyString(parsed.id) || !isNonEmptyString(parsed.cwd)) {
      return undefined;
    }
    return { id: parsed.id.trim(), cwd: parsed.cwd.trim() };
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

export async function writeAgentQuestion(
  resultFile: string | undefined,
  question: string,
): Promise<string | undefined> {
  const filePath = questionFileFor(resultFile);
  if (!filePath) return undefined;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, question, { encoding: 'utf8', mode: 0o600 });
  return filePath;
}

export async function readAgentQuestion(
  resultFile: string | undefined,
): Promise<string | undefined> {
  const filePath = questionFileFor(resultFile);
  if (!filePath) return undefined;
  try {
    const question = await fs.readFile(filePath, 'utf8');
    return question.trim() || undefined;
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function clearAgentQuestion(
  resultFile: string | undefined,
): Promise<void> {
  const filePath = questionFileFor(resultFile);
  if (!filePath) return;
  await fs.rm(filePath, { force: true });
}

export function findResultFileMarker(prompt: string): string | undefined {
  const matches = [...prompt.matchAll(/^HERDR_RESULT_FILE:\s*(.+)$/gm)];
  const candidate = matches.at(-1)?.[1]?.trim();
  return candidate && isManagedResultFile(candidate) ? candidate : undefined;
}

export function assistantText(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (part): part is { type: 'text'; text: string } =>
        typeof part === 'object' &&
        part !== null &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string',
    )
    .map((part) => part.text)
    .join('\n');
}

export async function writeAgentResult(
  filePath: string,
  output: string,
): Promise<void> {
  if (!isManagedResultFile(filePath)) return;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, output, { encoding: 'utf8', mode: 0o600 });
}

export async function clearAgentResult(
  filePath: string | undefined,
): Promise<void> {
  if (!filePath || !isManagedResultFile(filePath)) return;
  await fs.rm(filePath, { force: true });
}

export async function removeAgentTempFiles(
  resultFile: string | undefined,
): Promise<void> {
  if (!resultFile || !isManagedResultFile(resultFile)) return;
  await fs.rm(path.dirname(resultFile), { recursive: true, force: true });
}

export async function readAgentResult(
  filePath: string | undefined,
): Promise<string | undefined> {
  if (!filePath || !isManagedResultFile(filePath)) return undefined;
  try {
    const output = await fs.readFile(filePath, 'utf8');
    return output.trim() || undefined;
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return undefined;
    throw error;
  }
}
