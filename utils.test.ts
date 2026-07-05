import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTools } from "./utils.ts";

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
