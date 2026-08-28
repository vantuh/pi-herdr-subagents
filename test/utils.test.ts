import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import {
  ASK_QUESTION_TOOL,
  buildChildToolAllowlist,
  clearAgentQuestion,
  clearAgentResult,
  createAgentTempFiles,
  createResultFile,
  findResultFileMarker,
  formatAgentOutput,
  formatSpawnWarnings,
  formatWaitInterrupted,
  isRecoverableWaitInterrupt,
  makeHerdrAgentName,
  normalizeTools,
  questionFileFor,
  readAgentQuestion,
  readAgentResult,
  removeAgentTempFiles,
  shouldCloseTab,
  waitInterruptReason,
  writeAgentQuestion,
  writeAgentResult,
} from "../utils.ts";

test("generates valid unique Herdr automation names", () => {
  const first = makeHerdrAgentName("Code Reviewer");
  const second = makeHerdrAgentName("Code Reviewer");

  assert.match(first, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.notEqual(first, second);
});

test("writes and reads a managed result artifact", async () => {
  const filePath = await createResultFile();
  await writeAgentResult(filePath, "HERDR_RESULT:\n- status: done\n");

  assert.equal(
    await readAgentResult(filePath),
    "HERDR_RESULT:\n- status: done",
  );
  assert.equal(
    findResultFileMarker(`task\nHERDR_RESULT_FILE: ${filePath}`),
    filePath,
  );
  await removeAgentTempFiles(filePath);
});

test("keeps system and result files in one managed temp directory", async () => {
  const files = await createAgentTempFiles("system prompt");

  assert.equal(path.dirname(files.systemFile), path.dirname(files.resultFile));
  assert.equal(await fs.readFile(files.systemFile, "utf8"), "system prompt");
  await removeAgentTempFiles(files.resultFile);
  await assert.rejects(fs.access(files.systemFile), { code: "ENOENT" });
});

test("clears stale result content before a reused-agent prompt", async () => {
  const filePath = await createResultFile();
  await writeAgentResult(filePath, "old result");

  await clearAgentResult(filePath);

  assert.equal(await readAgentResult(filePath), undefined);
  await removeAgentTempFiles(filePath);
});

test("rejects result markers outside managed temp directories", () => {
  assert.equal(
    findResultFileMarker("HERDR_RESULT_FILE: /tmp/result.md"),
    undefined,
  );
});

test("normalizes comma-separated tools", () => {
  assert.deepEqual(normalizeTools("read, grep, bash"), [
    "read",
    "grep",
    "bash",
  ]);
});

test("normalizes array tools", () => {
  assert.deepEqual(normalizeTools(["read", " grep ", ""]), ["read", "grep"]);
});

test("normalizes single tool strings", () => {
  assert.deepEqual(normalizeTools("read"), ["read"]);
});

test("returns undefined for empty tools", () => {
  assert.equal(normalizeTools(" ,  "), undefined);
  assert.equal(normalizeTools([]), undefined);
});

test("returns undefined for unsupported tool shapes", () => {
  assert.equal(normalizeTools(123), undefined);
  assert.equal(normalizeTools({ read: true }), undefined);
});

test("closes only oneshot tabs", () => {
  assert.equal(shouldCloseTab("oneshot"), true);
  assert.equal(shouldCloseTab("persistent"), false);
});

test("formats agent output text", () => {
  assert.equal(formatAgentOutput("  hello  \n", "Worker"), "hello");
});

test("appends spawn warnings to model-facing result text", () => {
  assert.equal(formatSpawnWarnings("done", []), "done");
  assert.equal(
    formatSpawnWarnings("done", ["Skills not found: ghost."]),
    "done\n\nSpawn warnings:\n- Skills not found: ghost.",
  );
});

test("falls back to a placeholder for empty agent output", () => {
  assert.equal(
    formatAgentOutput("   \n", "Worker"),
    "(Herdr agent Worker finished with no visible output.)",
  );
});

test("appends a close warning when closing the agent failed", () => {
  assert.equal(
    formatAgentOutput("done", "Worker", "target not found"),
    "done\n\nWarning: failed to close one-shot Herdr agent Worker: target not found",
  );
});

test("treats abort and herdr timeout as recoverable wait interrupts", () => {
  assert.equal(isRecoverableWaitInterrupt(new Error("Aborted")), true);
  assert.equal(
    isRecoverableWaitInterrupt(new Error("The operation was aborted")),
    true,
  );
  const abortErr = new Error("aborted");
  abortErr.name = "AbortError";
  assert.equal(isRecoverableWaitInterrupt(abortErr), true);
  assert.equal(
    isRecoverableWaitInterrupt(
      Object.assign(
        new Error("herdr agent wait x failed [timeout]: timed out"),
        {
          code: "timeout",
        },
      ),
    ),
    true,
  );
  assert.equal(
    isRecoverableWaitInterrupt(
      new Error(
        "herdr agent prompt x failed [agent_prompt_stalled]: no change",
      ),
    ),
    false,
  );
  assert.equal(
    waitInterruptReason(new Error("The operation was aborted")),
    "aborted",
  );
  assert.equal(
    waitInterruptReason(
      Object.assign(new Error("failed [timeout]"), { code: "timeout" }),
    ),
    "timeout",
  );
  assert.match(
    formatWaitInterrupted("Reviewer — herdr", "aborted"),
    /omit task to re-wait/,
  );
  assert.match(
    formatWaitInterrupted("Reviewer — herdr", "aborted"),
    /Do not resend the task/,
  );
});

test("derives the question file next to the result file", async () => {
  const resultFile = await createResultFile();
  assert.equal(
    questionFileFor(resultFile),
    path.join(path.dirname(resultFile), "question.md"),
  );
  await removeAgentTempFiles(resultFile);
});

test("refuses to derive a question file outside managed temp dirs", () => {
  assert.equal(questionFileFor(undefined), undefined);
  assert.equal(questionFileFor("/etc/passwd"), undefined);
  assert.equal(
    questionFileFor(path.join(path.sep, "tmp", "result.md")),
    undefined,
  );
});

test("round-trips a question through the managed file", async () => {
  const resultFile = await createResultFile();

  assert.equal(await readAgentQuestion(resultFile), undefined);

  const written = await writeAgentQuestion(resultFile, "  Which API?  ");
  assert.equal(written, questionFileFor(resultFile));
  assert.equal(await readAgentQuestion(resultFile), "Which API?");

  await clearAgentQuestion(resultFile);
  assert.equal(await readAgentQuestion(resultFile), undefined);

  await removeAgentTempFiles(resultFile);
});

test("does not write a question without a managed channel", async () => {
  assert.equal(await writeAgentQuestion(undefined, "hi"), undefined);
  assert.equal(await writeAgentQuestion("/etc/passwd", "hi"), undefined);
});

test("treats a whitespace-only question file as no question", async () => {
  const resultFile = await createResultFile();
  const questionFile = questionFileFor(resultFile)!;
  await fs.mkdir(path.dirname(questionFile), { recursive: true });
  await fs.writeFile(questionFile, "   \n\n");

  assert.equal(await readAgentQuestion(resultFile), undefined);

  await removeAgentTempFiles(resultFile);
});

test("keeps question and result independent", async () => {
  const resultFile = await createResultFile();

  await writeAgentResult(resultFile, "done text");
  await writeAgentQuestion(resultFile, "a question");

  await clearAgentResult(resultFile);
  assert.equal(await readAgentResult(resultFile), undefined);
  assert.equal(await readAgentQuestion(resultFile), "a question");

  await removeAgentTempFiles(resultFile);
});

test("removes the question file with the temp dir", async () => {
  const resultFile = await createResultFile();
  await writeAgentQuestion(resultFile, "q");
  const questionFile = questionFileFor(resultFile)!;

  await removeAgentTempFiles(resultFile);

  await assert.rejects(() => fs.access(questionFile));
});

test("adds the question channel to a restricted tool profile", () => {
  assert.deepEqual(buildChildToolAllowlist(["read", "grep"]), [
    "read",
    "grep",
    ASK_QUESTION_TOOL,
  ]);
});

test("passes no tool allowlist when the profile does not restrict tools", () => {
  assert.equal(buildChildToolAllowlist(undefined), undefined);
  assert.equal(buildChildToolAllowlist([]), undefined);
});

test("does not duplicate an explicitly listed question tool", () => {
  assert.deepEqual(buildChildToolAllowlist(["read", ASK_QUESTION_TOOL]), [
    "read",
    ASK_QUESTION_TOOL,
  ]);
});

test("keeps profile tool order in the allowlist", () => {
  assert.deepEqual(buildChildToolAllowlist(["bash", "read", "edit"]), [
    "bash",
    "read",
    "edit",
    ASK_QUESTION_TOOL,
  ]);
});
