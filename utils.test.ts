import assert from "node:assert/strict";
import test from "node:test";
import { formatAgentOutput, normalizeTools, shouldCloseTab } from "./utils.ts";

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
