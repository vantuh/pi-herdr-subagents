import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import {
  claimDetachedAgent,
  clearAgentSpawnWarnings,
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
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "herdr-agents-state-test-"),
  );
  tempDirs.push(dir);
  return path.join(dir, "state.json");
}

// Every test here needs its own state file, so the dirs are removed in one
// teardown instead of accumulating in the temp root run after run.
const tempDirs: string[] = [];
after(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

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
      spawnWarnings: ["Skill missing."],
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
    spawnWarnings: ["Skill missing."],
    updatedAt: state.agents["terminal:term-1"]?.updatedAt,
  });
});

test("clears spawn warnings after a successful collect", async () => {
  const filePath = await tempStatePath();
  const agentPane = pane();

  await recordAgentLifecycle(
    agentPane,
    "persistent",
    { spawnWarnings: ["Skill missing."] },
    filePath,
  );
  await clearAgentSpawnWarnings(agentPane, filePath);

  assert.equal(
    (await loadHerdrAgentsState(filePath)).agents["terminal:term-1"]
      ?.spawnWarnings,
    undefined,
  );
});

test("ignores corrupted state files", async () => {
  const filePath = await tempStatePath();
  await fs.writeFile(filePath, "not json", "utf8");

  assert.deepEqual(
    await loadHerdrAgentsState(filePath),
    emptyHerdrAgentsState(),
  );
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

test("claims a detached agent exactly once", async () => {
  const filePath = await tempStatePath();
  const target = pane({ terminal_id: "term-async" });

  await recordAgentLifecycle(
    target,
    "persistent",
    { tabLabel: "Async", detached: true },
    filePath,
  );

  assert.equal(await claimDetachedAgent(target, filePath), true);
  assert.equal(await claimDetachedAgent(target, filePath), false);

  const state = await loadHerdrAgentsState(filePath);
  assert.equal(state.agents["terminal:term-async"]?.detached, undefined);
  // Only the claim is released; the record itself must survive.
  assert.equal(state.agents["terminal:term-async"]?.tabLabel, "Async");
});

test("does not claim an agent that was never detached", async () => {
  const filePath = await tempStatePath();
  const target = pane({ terminal_id: "term-sync" });

  await recordAgentLifecycle(target, "oneshot", { tabLabel: "Sync" }, filePath);

  assert.equal(await claimDetachedAgent(target, filePath), false);
});

test("does not claim an unknown agent", async () => {
  const filePath = await tempStatePath();
  assert.equal(
    await claimDetachedAgent(pane({ terminal_id: "term-missing" }), filePath),
    false,
  );
  assert.equal(
    await claimDetachedAgent(pane({ terminal_id: undefined }), filePath),
    false,
  );
});

test("serializes concurrent claims so only one wins", async () => {
  const filePath = await tempStatePath();
  const target = pane({ terminal_id: "term-race" });

  await recordAgentLifecycle(
    target,
    "persistent",
    { tabLabel: "Race", detached: true },
    filePath,
  );

  const results = await Promise.all([
    claimDetachedAgent(target, filePath),
    claimDetachedAgent(target, filePath),
    claimDetachedAgent(target, filePath),
  ]);

  assert.equal(results.filter(Boolean).length, 1);
});

test("persists the detached flag across a reload of the state file", async () => {
  const filePath = await tempStatePath();
  const target = pane({ terminal_id: "term-reload" });

  await recordAgentLifecycle(
    target,
    "persistent",
    { tabLabel: "Reload", detached: true },
    filePath,
  );

  const reloaded = await loadHerdrAgentsState(filePath);
  assert.equal(reloaded.agents["terminal:term-reload"]?.detached, true);
});
