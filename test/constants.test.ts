import { describe, expect, test } from "bun:test";
import {
  buildRunTurnInstructions,
  CHILD_PROTOCOL,
  GLOBAL_INSTRUCTIONS,
} from "../constants.ts";

describe("constants", () => {
  test("CHILD_PROTOCOL prohibits recursive delegation", () => {
    expect(CHILD_PROTOCOL).toContain(
      "Do not spawn additional agents unless explicitly asked",
    );
  });

  test("GLOBAL_INSTRUCTIONS names herdr_agent and oneshot default", () => {
    expect(GLOBAL_INSTRUCTIONS).toContain("herdr_agent");
    expect(GLOBAL_INSTRUCTIONS).toContain('lifecycle: "oneshot"');
    expect(GLOBAL_INSTRUCTIONS).toContain(
      "agent closes after a successful result",
    );
    expect(GLOBAL_INSTRUCTIONS).toContain("reuse by exact label");
    expect(GLOBAL_INSTRUCTIONS).toContain(
      "scout, researcher, planner, worker, reviewer",
    );
  });

  test("GLOBAL_INSTRUCTIONS handles agents opened without a task", () => {
    expect(GLOBAL_INSTRUCTIONS).toContain("do not inspect skills");
    expect(GLOBAL_INSTRUCTIONS).toContain('lifecycle: "persistent"');
    expect(GLOBAL_INSTRUCTIONS).toContain("wait: false");
    expect(GLOBAL_INSTRUCTIONS).toContain("minimal standby");
  });

  test("GLOBAL_INSTRUCTIONS does not use proactive delegation", () => {
    expect(GLOBAL_INSTRUCTIONS).not.toContain("openai-codex");
    expect(GLOBAL_INSTRUCTIONS).not.toContain("Proactively use");
  });

  test("GLOBAL_INSTRUCTIONS covers abort and timeout re-wait", () => {
    expect(GLOBAL_INSTRUCTIONS).toContain("times out or was aborted");
    expect(GLOBAL_INSTRUCTIONS).toContain("no `task`");
    expect(GLOBAL_INSTRUCTIONS).toContain("re-wait");
  });

  test("GLOBAL_INSTRUCTIONS covers closed one-shot resume", () => {
    expect(GLOBAL_INSTRUCTIONS).toContain("resumeClosed: true");
    expect(GLOBAL_INSTRUCTIONS).toContain("never resurrects a closed agent");
  });

  test("buildRunTurnInstructions names agent when provided", () => {
    expect(buildRunTurnInstructions("scout")).toContain('agent: "scout"');
    expect(buildRunTurnInstructions()).toContain("smallest suitable");
  });
});
