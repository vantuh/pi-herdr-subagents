import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildRunTurnInstructions,
  CHILD_PROTOCOL,
  GLOBAL_INSTRUCTIONS,
} from "../constants.ts";

describe("constants", () => {
  it("CHILD_PROTOCOL prohibits recursive delegation", () => {
    assert.ok(
      CHILD_PROTOCOL.includes(
        "Do not spawn additional agents unless explicitly asked",
      ),
    );
  });

  it("GLOBAL_INSTRUCTIONS names herdr_agent and oneshot default", () => {
    assert.ok(GLOBAL_INSTRUCTIONS.includes("herdr_agent"));
    assert.ok(GLOBAL_INSTRUCTIONS.includes('lifecycle: "oneshot"'));
    assert.ok(GLOBAL_INSTRUCTIONS.includes("agent closes after a successful result"));
    assert.ok(
      GLOBAL_INSTRUCTIONS.includes(
        'Reuse requires repeating \`lifecycle: "persistent"\`',
      ),
    );
    assert.ok(
      GLOBAL_INSTRUCTIONS.includes(
        "a delivered result does not mean the tab closed",
      ),
    );
    assert.ok(
      GLOBAL_INSTRUCTIONS.includes("Closed persistent agents cannot be resumed"),
    );
    assert.ok(
      GLOBAL_INSTRUCTIONS.includes(
        "scout, researcher, planner, worker, reviewer",
      ),
    );
  });

  it("GLOBAL_INSTRUCTIONS handles agents opened without a task", () => {
    assert.ok(GLOBAL_INSTRUCTIONS.includes("do not inspect skills"));
    assert.ok(GLOBAL_INSTRUCTIONS.includes('lifecycle: "persistent"'));
    assert.ok(GLOBAL_INSTRUCTIONS.includes("minimal standby"));
    assert.ok(GLOBAL_INSTRUCTIONS.includes("By default"));
    assert.ok(GLOBAL_INSTRUCTIONS.includes("pass `wait: true`"));
  });

  it("GLOBAL_INSTRUCTIONS does not use proactive delegation", () => {
    assert.ok(!GLOBAL_INSTRUCTIONS.includes("openai-codex"));
    assert.ok(!GLOBAL_INSTRUCTIONS.includes("Proactively use"));
  });

  it("GLOBAL_INSTRUCTIONS covers abort and timeout re-wait", () => {
    assert.ok(GLOBAL_INSTRUCTIONS.includes("times out or was aborted"));
    assert.ok(GLOBAL_INSTRUCTIONS.includes("no `task`"));
    assert.ok(GLOBAL_INSTRUCTIONS.includes("re-wait"));
  });

  it("GLOBAL_INSTRUCTIONS covers closed one-shot resume", () => {
    assert.ok(GLOBAL_INSTRUCTIONS.includes("resumeClosed: true"));
    assert.ok(GLOBAL_INSTRUCTIONS.includes("never resurrects a closed agent"));
  });

  it("buildRunTurnInstructions names agent when provided", () => {
    assert.ok(buildRunTurnInstructions("scout").includes('agent: "scout"'));
    assert.ok(buildRunTurnInstructions().includes("smallest suitable"));
  });
});
