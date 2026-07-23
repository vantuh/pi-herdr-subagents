import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import {
  clearAgentResult,
  createAgentTempFiles,
  createResultFile,
  findResultFileMarker,
  formatAgentOutput,
  makeHerdrAgentName,
  normalizeTools,
  readAgentResult,
  removeAgentTempFiles,
  shouldCloseTab,
  writeAgentResult,
} from "./utils.ts";

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
  assert.equal(findResultFileMarker(`task\nHERDR_RESULT_FILE: ${filePath}`), filePath);
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
  assert.equal(findResultFileMarker("HERDR_RESULT_FILE: /tmp/result.md"), undefined);
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
