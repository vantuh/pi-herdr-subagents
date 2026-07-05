import assert from "node:assert/strict";
import test from "node:test";
import { observeAgentWaitState } from "./herdr.ts";
import type { AgentWaitState } from "./herdr.ts";
import type { PaneInfo } from "./types.ts";

function pane(agent_status: string): PaneInfo {
  return {
    pane_id: "pane-1",
    tab_id: "tab-1",
    workspace_id: "workspace-1",
    agent: "pi",
    agent_status,
  };
}

test("does not finish on initial idle", () => {
  const state: AgentWaitState = { sawActive: false };

  assert.equal(observeAgentWaitState(pane("idle"), state), false);
  assert.equal(state.sawActive, false);
});

test("finishes on idle after working", () => {
  const state: AgentWaitState = { sawActive: false };

  assert.equal(observeAgentWaitState(pane("working"), state), false);
  assert.equal(state.sawActive, true);
  assert.equal(observeAgentWaitState(pane("idle"), state), true);
});

test("finishes on idle after blocked", () => {
  const state: AgentWaitState = { sawActive: false };

  assert.equal(observeAgentWaitState(pane("blocked"), state), false);
  assert.equal(state.sawActive, true);
  assert.equal(observeAgentWaitState(pane("idle"), state), true);
});

test("finishes immediately on done", () => {
  const state: AgentWaitState = { sawActive: false };

  assert.equal(observeAgentWaitState(pane("done"), state), true);
});

test("keeps waiting on unknown", () => {
  const state: AgentWaitState = { sawActive: false };

  assert.equal(observeAgentWaitState(pane("unknown"), state), false);
  assert.equal(state.sawActive, false);
});
