import { describe, expect, test } from "bun:test";
import { formatRunUserMessage, parseRunArgs } from "../run.ts";

describe("parseRunArgs", () => {
  test("parses agent and task", () => {
    expect(parseRunArgs("scout find auth entry points")).toEqual({
      agent: "scout",
      task: "find auth entry points",
    });
  });

  test("parses task without agent", () => {
    expect(parseRunArgs("review the current diff")).toEqual({
      task: "review the current diff",
    });
  });

  test("rejects empty input", () => {
    expect(parseRunArgs("")).toBeNull();
    expect(parseRunArgs("   ")).toBeNull();
  });

  test("rejects agent without task", () => {
    expect(parseRunArgs("scout")).toBeNull();
  });
});

describe("formatRunUserMessage", () => {
  test("includes agent when provided", () => {
    expect(
      formatRunUserMessage({ agent: "reviewer", task: "check diff" }),
    ).toBe("[via /run → reviewer] check diff");
  });

  test("omits agent when not provided", () => {
    expect(formatRunUserMessage({ task: "check diff" })).toBe(
      "[via /run] check diff",
    );
  });
});
