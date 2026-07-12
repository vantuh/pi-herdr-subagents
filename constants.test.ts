import { describe, expect, test } from "bun:test";
import { CHILD_PROTOCOL, GLOBAL_INSTRUCTIONS } from "./constants.ts";

describe("constants", () => {
  test("CHILD_PROTOCOL prohibits recursive delegation", () => {
    expect(CHILD_PROTOCOL).toContain("Do not spawn additional agents");
    expect(CHILD_PROTOCOL).not.toContain("unless explicitly asked");
  });

  test("GLOBAL_INSTRUCTIONS names herdr_agent and oneshot default", () => {
    expect(GLOBAL_INSTRUCTIONS).toContain("herdr_agent");
    expect(GLOBAL_INSTRUCTIONS).toContain('lifecycle: "oneshot"');
    expect(GLOBAL_INSTRUCTIONS).toContain("tab closes after a successful result");
    expect(GLOBAL_INSTRUCTIONS).toContain("reuse by exact label");
    expect(GLOBAL_INSTRUCTIONS).toContain("scout, researcher, planner, worker, reviewer");
  });

  test("GLOBAL_INSTRUCTIONS keeps proactive delegation boundaries", () => {
    expect(GLOBAL_INSTRUCTIONS).toContain("Proactively use");
    expect(GLOBAL_INSTRUCTIONS).toContain("Stay direct for needle queries");
    expect(GLOBAL_INSTRUCTIONS).toContain("do not duplicate");
    expect(GLOBAL_INSTRUCTIONS).toContain("Use scout for broad or unfamiliar");
  });
});
