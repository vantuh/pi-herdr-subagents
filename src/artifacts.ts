import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Value } from 'typebox/value';

import {
  ChildSessionMeta,
  ChildSessionMetaInput,
  ContextMetrics,
  isNonEmptyString,
  isSessionCost,
  MessageContent,
  TextPart,
} from './artifacts/schema.ts';
import { parseJson } from './json.ts';

export const RESULT_FILE_MARKER = 'HERDR_RESULT_FILE:';

export const ASK_QUESTION_TOOL = 'ask_question';

/** Child-only: absolute path to the private session metadata artifact. */
export const SESSION_META_ENV = 'HERDR_AGENT_SESSION_META';

const SESSION_META_FILE_NAME = 'session.json';

async function makeAgentTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'herdr-agent-'));
}

/** Raw file contents, or undefined when the file does not exist. */
export async function readIfExists(
  filePath: string,
): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function readTrimmedIfExists(
  filePath: string,
): Promise<string | undefined> {
  return (await readIfExists(filePath))?.trim() || undefined;
}

async function writePrivateFile(filePath: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, { encoding: 'utf8', mode: 0o600 });
}

export async function createAgentTempFiles(systemPrompt: string): Promise<{
  systemFile: string;
  resultFile: string;
  sessionMetaFile: string;
}> {
  const dir = await makeAgentTempDir();
  const systemFile = path.join(dir, 'system.md');
  await writePrivateFile(systemFile, systemPrompt);
  return {
    systemFile,
    resultFile: path.join(dir, 'result.md'),
    sessionMetaFile: path.join(dir, SESSION_META_FILE_NAME),
  };
}

export async function createResultFile(): Promise<string> {
  return path.join(await makeAgentTempDir(), 'result.md');
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
function siblingArtifact(
  resultFile: string | undefined,
  fileName: string,
): string | undefined {
  if (!resultFile || !isManagedResultFile(resultFile)) return undefined;
  return path.join(path.dirname(path.resolve(resultFile)), fileName);
}

export function questionFileFor(
  resultFile: string | undefined,
): string | undefined {
  return siblingArtifact(resultFile, 'question.md');
}

function isManagedSessionMetaFile(filePath: string): boolean {
  return isManagedAgentFile(filePath, SESSION_META_FILE_NAME);
}

export function sessionMetaFileFor(
  resultFile: string | undefined,
): string | undefined {
  return siblingArtifact(resultFile, SESSION_META_FILE_NAME);
}

export async function writeAgentSessionMeta(
  filePath: string | undefined,
  meta: ChildSessionMeta,
): Promise<string | undefined> {
  if (!filePath || !isManagedSessionMetaFile(filePath)) return undefined;
  await writePrivateFile(filePath, `${JSON.stringify(meta)}\n`);
  return filePath;
}

export async function readAgentSessionMeta(
  resultFile: string | undefined,
): Promise<ChildSessionMeta | undefined> {
  const filePath = sessionMetaFileFor(resultFile);
  if (!filePath) return undefined;
  const raw = await readTrimmedIfExists(filePath);
  if (!raw) return undefined;
  const parsed = parseJson(ChildSessionMetaInput, raw);
  if (
    !parsed ||
    !isNonEmptyString(parsed.sessionId) ||
    !isNonEmptyString(parsed.cwd)
  ) {
    return undefined;
  }
  return {
    sessionId: parsed.sessionId.trim(),
    cwd: parsed.cwd.trim(),
    updatedAt: parsed.updatedAt ?? new Date(0).toISOString(),
    ...(isNonEmptyString(parsed.sessionFile)
      ? { sessionFile: path.resolve(parsed.sessionFile!.trim()) }
      : {}),
    ...(Value.Check(ContextMetrics, parsed.context)
      ? { context: parsed.context }
      : {}),
    ...(isSessionCost(parsed.sessionCost)
      ? { sessionCost: parsed.sessionCost }
      : {}),
  };
}

export async function writeAgentQuestion(
  resultFile: string | undefined,
  question: string,
): Promise<string | undefined> {
  const filePath = questionFileFor(resultFile);
  if (!filePath) return undefined;
  await writePrivateFile(filePath, question);
  return filePath;
}

export async function readAgentQuestion(
  resultFile: string | undefined,
): Promise<string | undefined> {
  const filePath = questionFileFor(resultFile);
  if (!filePath) return undefined;
  return readTrimmedIfExists(filePath);
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
  if (!Value.Check(MessageContent, message)) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((part) => (Value.Check(TextPart, part) ? [part.text] : []))
    .join('\n');
}

/** Appends so an answer split across several assistant messages is not lost. */
export async function appendAgentResult(
  filePath: string,
  output: string,
): Promise<void> {
  if (!isManagedResultFile(filePath)) return;
  const size = await fs.stat(filePath).then(
    (stat) => stat.size,
    () => 0,
  );
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, size > 0 ? `\n\n${output}` : output, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

export async function setAgentResultInterrupted(
  resultFile: string | undefined,
  interrupted: boolean,
): Promise<void> {
  const marker = siblingArtifact(resultFile, 'interrupted');
  if (!marker) return;
  if (interrupted) await writePrivateFile(marker, 'interrupted\n');
  else await fs.rm(marker, { force: true });
}

export async function isAgentResultInterrupted(
  resultFile: string | undefined,
): Promise<boolean> {
  const marker = siblingArtifact(resultFile, 'interrupted');
  return marker ? (await readIfExists(marker)) !== undefined : false;
}

export async function clearAgentResult(
  filePath: string | undefined,
): Promise<void> {
  if (!filePath || !isManagedResultFile(filePath)) return;
  await fs.rm(filePath, { force: true });
  await setAgentResultInterrupted(filePath, false);
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
  return readTrimmedIfExists(filePath);
}
