import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { test } from 'vitest';

import {
  clearAgentQuestion,
  clearAgentResult,
  createAgentTempFiles,
  createResultFile,
  findResultFileMarker,
  questionFileFor,
  readAgentQuestion,
  readAgentResult,
  removeAgentTempFiles,
  writeAgentQuestion,
  appendAgentResult,
} from '../src/artifacts.ts';

/**
 * Managed artifacts: result and question files inside the agent temp dir.
 */

test('writes and reads a managed result artifact', async () => {
  const filePath = await createResultFile();
  await appendAgentResult(filePath, 'AGENT_RESULT:\n- status: done\n');

  assert.equal(
    await readAgentResult(filePath),
    'AGENT_RESULT:\n- status: done',
  );
  assert.equal(
    findResultFileMarker(`task\nAGENT_RESULT_FILE: ${filePath}`),
    filePath,
  );
  await removeAgentTempFiles(filePath);
});

test('keeps system and result files in one managed temp directory', async () => {
  const files = await createAgentTempFiles('system prompt');

  assert.equal(path.dirname(files.systemFile), path.dirname(files.resultFile));
  assert.equal(await fs.readFile(files.systemFile, 'utf8'), 'system prompt');
  await removeAgentTempFiles(files.resultFile);
  await assert.rejects(fs.access(files.systemFile), { code: 'ENOENT' });
});

test('clears stale result content before a reused-agent prompt', async () => {
  const filePath = await createResultFile();
  await appendAgentResult(filePath, 'old result');

  await clearAgentResult(filePath);

  assert.equal(await readAgentResult(filePath), undefined);
  await removeAgentTempFiles(filePath);
});

test('rejects result markers outside managed temp directories', () => {
  assert.equal(
    findResultFileMarker('AGENT_RESULT_FILE: /tmp/result.md'),
    undefined,
  );
});

test('derives the question file next to the result file', async () => {
  const resultFile = await createResultFile();
  assert.equal(
    questionFileFor(resultFile),
    path.join(path.dirname(resultFile), 'question.md'),
  );
  await removeAgentTempFiles(resultFile);
});

test('refuses to derive a question file outside managed temp dirs', () => {
  assert.equal(questionFileFor(undefined), undefined);
  assert.equal(questionFileFor('/etc/passwd'), undefined);
  assert.equal(
    questionFileFor(path.join(path.sep, 'tmp', 'result.md')),
    undefined,
  );
});

test('round-trips a question through the managed file', async () => {
  const resultFile = await createResultFile();

  assert.equal(await readAgentQuestion(resultFile), undefined);

  const written = await writeAgentQuestion(resultFile, '  Which API?  ');
  assert.equal(written, questionFileFor(resultFile));
  assert.equal(await readAgentQuestion(resultFile), 'Which API?');

  await clearAgentQuestion(resultFile);
  assert.equal(await readAgentQuestion(resultFile), undefined);

  await removeAgentTempFiles(resultFile);
});

test('does not write a question without a managed channel', async () => {
  assert.equal(await writeAgentQuestion(undefined, 'hi'), undefined);
  assert.equal(await writeAgentQuestion('/etc/passwd', 'hi'), undefined);
});

test('treats a whitespace-only question file as no question', async () => {
  const resultFile = await createResultFile();
  const questionFile = questionFileFor(resultFile)!;
  await fs.mkdir(path.dirname(questionFile), { recursive: true });
  await fs.writeFile(questionFile, '   \n\n');

  assert.equal(await readAgentQuestion(resultFile), undefined);

  await removeAgentTempFiles(resultFile);
});

test('keeps question and result independent', async () => {
  const resultFile = await createResultFile();

  await appendAgentResult(resultFile, 'done text');
  await writeAgentQuestion(resultFile, 'a question');

  await clearAgentResult(resultFile);
  assert.equal(await readAgentResult(resultFile), undefined);
  assert.equal(await readAgentQuestion(resultFile), 'a question');

  await removeAgentTempFiles(resultFile);
});

test('removes the question file with the temp dir', async () => {
  const resultFile = await createResultFile();
  await writeAgentQuestion(resultFile, 'q');
  const questionFile = questionFileFor(resultFile)!;

  await removeAgentTempFiles(resultFile);

  await assert.rejects(() => fs.access(questionFile));
});
