import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatCouncilUserMessage,
  formatRunUserMessage,
  parseCouncilArgs,
  parseRunArgs,
} from "../run.ts";

describe("parseRunArgs", () => {
  it("parses agent and task", () => {
    assert.deepEqual(parseRunArgs("scout find auth entry points"), {
      agent: "scout",
      task: "find auth entry points",
    });
  });

  it("parses task without agent", () => {
    assert.deepEqual(parseRunArgs("review the current diff"), {
      task: "review the current diff",
    });
  });

  it("rejects empty input", () => {
    assert.equal(parseRunArgs(""), null);
    assert.equal(parseRunArgs("   "), null);
  });

  it("rejects agent without task", () => {
    assert.equal(parseRunArgs("scout"), null);
  });
});

describe("formatRunUserMessage", () => {
  it("includes agent when provided", () => {
    assert.equal(
      formatRunUserMessage({ agent: "reviewer", task: "check diff" }),
      "[via /run → reviewer] check diff",
    );
  });

  it("omits agent when not provided", () => {
    assert.equal(formatRunUserMessage({ task: "check diff" }), "[via /run] check diff");
  });
});

describe("parseCouncilArgs", () => {
  it("returns the question verbatim", () => {
    assert.equal(parseCouncilArgs("Why is X better than Y?"), "Why is X better than Y?");
  });

  it("trims surrounding whitespace", () => {
    assert.equal(parseCouncilArgs("  pick a database  "), "pick a database");
  });

  it("rejects empty input", () => {
    assert.equal(parseCouncilArgs(""), null);
    assert.equal(parseCouncilArgs("   "), null);
  });
});

describe("formatCouncilUserMessage", () => {
  it("wraps the question and names both models", () => {
    const message = formatCouncilUserMessage("Why is X better than Y?", [
      "model-a",
      "model-b",
    ]);
    assert.match(message, /^\[via \/council\] Why is X better than Y\?/);
    assert.ok(message.includes("model-a"));
    assert.ok(message.includes("model-b"));
    assert.ok(message.includes("wait: false"));
    assert.ok(message.includes("consolidate"));
  });
});
