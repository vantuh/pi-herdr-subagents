import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  deleteAgentLifecycle,
  emptyHerdrAgentsState,
  getKnownAgentLifecyclesByTabId,
  loadHerdrAgentsState,
  paneStateKey,
  pruneHerdrAgentsState,
  recordAgentLifecycle,
} from "./state.ts";
import type { PaneInfo } from "./types.ts";

function pane(overrides: Partial<PaneInfo> = {}): PaneInfo {
  return {
    pane_id: "pane-1",
    tab_id: "tab-1",
    workspace_id: "workspace-1",
    terminal_id: "term-1",
    ...overrides,
  };
}

async function tempStatePath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-agents-state-test-"));
  return path.join(dir, "state.json");
}

test("uses terminal id as the durable pane state key", () => {
  assert.equal(paneStateKey(pane()), "terminal:term-1");
  assert.equal(paneStateKey(pane({ terminal_id: undefined })), undefined);
});

test("records and loads agent lifecycle state", async () => {
  const filePath = await tempStatePath();

  await recordAgentLifecycle(
    pane(),
    "persistent",
    {
      tabLabel: "Researcher",
      agent: "researcher",
      automationName: "researcher_ab12cd34",
      resultFile: "/tmp/herdr-agent-test/result.md",
      layout: "pane",
    },
    filePath,
  );

  const state = await loadHerdrAgentsState(filePath);
  assert.deepEqual(state.agents["terminal:term-1"], {
    lifecycle: "persistent",
    tabLabel: "Researcher",
    agent: "researcher",
    automationName: "researcher_ab12cd34",
    resultFile: "/tmp/herdr-agent-test/result.md",
    layout: "pane",
    updatedAt: state.agents["terminal:term-1"]?.updatedAt,
  });
});

test("ignores corrupted state files", async () => {
  const filePath = await tempStatePath();
  await fs.writeFile(filePath, "not json", "utf8");

  assert.deepEqual(await loadHerdrAgentsState(filePath), emptyHerdrAgentsState());
});

test("maps known pane lifecycle state by tab id", () => {
  const state = emptyHerdrAgentsState();
  state.agents["terminal:term-1"] = {
    lifecycle: "oneshot",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  assert.deepEqual(
    getKnownAgentLifecyclesByTabId([pane()], state),
    new Map([["tab-1", "oneshot"]]),
  );
});

test("prunes state for terminals no longer reported by Herdr", () => {
  const state = emptyHerdrAgentsState();
  state.agents["terminal:term-1"] = {
    lifecycle: "persistent",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  state.agents["terminal:gone"] = {
    lifecycle: "oneshot",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  assert.equal(pruneHerdrAgentsState(state, [pane()]), true);
  assert.deepEqual(Object.keys(state.agents), ["terminal:term-1"]);
  assert.equal(pruneHerdrAgentsState(state, [pane()]), false);
});

test("recordAgentLifecycle is a no-op when terminal_id is missing", async () => {
  const filePath = await tempStatePath();

  await recordAgentLifecycle(
    pane({ terminal_id: undefined }),
    "oneshot",
    {},
    filePath,
  );

  await assert.rejects(fs.access(filePath));
});

test("deleteAgentLifecycle is a no-op when terminal_id is missing", async () => {
  const filePath = await tempStatePath();
  await recordAgentLifecycle(pane(), "oneshot", {}, filePath);

  await deleteAgentLifecycle(pane({ terminal_id: undefined }), filePath);

  const state = await loadHerdrAgentsState(filePath);
  assert.ok(state.agents["terminal:term-1"]);
});

test("concurrent recordAgentLifecycle calls in the same process don't lose entries", async () => {
  const filePath = await tempStatePath();

  const panes = Array.from({ length: 20 }, (_, i) =>
    pane({ terminal_id: `term-${i}` }),
  );

  await Promise.all(
    panes.map((p, i) =>
      recordAgentLifecycle(p, "persistent", { agent: `agent-${i}` }, filePath),
    ),
  );

  const state = await loadHerdrAgentsState(filePath);
  assert.equal(Object.keys(state.agents).length, panes.length);
  for (let i = 0; i < panes.length; i++) {
    assert.equal(state.agents[`terminal:term-${i}`]?.agent, `agent-${i}`);
  }
});

test("concurrent record and delete calls for the same terminal don't corrupt state", async () => {
  const filePath = await tempStatePath();
  const survivor = pane({ terminal_id: "term-survivor" });

  await Promise.all([
    recordAgentLifecycle(pane(), "oneshot", { agent: "a" }, filePath),
    recordAgentLifecycle(survivor, "persistent", { agent: "b" }, filePath),
    deleteAgentLifecycle(pane(), filePath),
    recordAgentLifecycle(survivor, "persistent", { agent: "c" }, filePath),
  ]);

  const state = await loadHerdrAgentsState(filePath);
  // The last queued write for the survivor terminal must win.
  assert.equal(state.agents["terminal:term-survivor"]?.agent, "c");
});
