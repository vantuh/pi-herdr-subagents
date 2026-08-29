import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  claimDetachedAgent,
  clearAgentSpawnWarnings,
  deleteAgentLifecycle,
  emptyHerdrAgentsState,
  loadHerdrAgentsState,
  paneStateKey,
  pruneHerdrAgentsState,
  recordAgentLifecycle,
  isAgentOwnedBy,
  archiveClosedOneShot,
  claimClosedHistory,
  releaseClosedHistory,
  pruneClosedHistory,
  stageClosedOneShot,
  finalizeStagedClosedOneShot,
  setFailNextStateSaves,
  setFailNextStateMutation,
  persistPrunedAgentsState,
  withHerdrAgentsStateLock,
  CLOSED_HISTORY_MAX_GLOBAL,
  CLOSED_HISTORY_MAX_PER_OWNER,
  CLOSED_HISTORY_TTL_MS,
  type ClosedAgentHistoryRecord,
} from "../state.ts";
import type { PaneInfo } from "../types.ts";

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
      ownerTerminalId: "term-orch",
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
    ownerTerminalId: "term-orch",
    updatedAt: state.agents["terminal:term-1"]?.updatedAt,
  });
});

test("preserves owner when a later record omits it", async () => {
  const filePath = await tempStatePath();
  const agentPane = pane();

  await recordAgentLifecycle(
    agentPane,
    "persistent",
    { tabLabel: "Scout", ownerTerminalId: "term-orch" },
    filePath,
  );
  await recordAgentLifecycle(
    agentPane,
    "persistent",
    { tabLabel: "Scout", detached: true },
    filePath,
  );

  assert.equal(
    (await loadHerdrAgentsState(filePath)).agents["terminal:term-1"]
      ?.ownerTerminalId,
    "term-orch",
  );
});

test("treats a stamped record as owned only by that orchestrator", () => {
  const record = {
    lifecycle: "persistent" as const,
    ownerTerminalId: "term-a",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  assert.equal(isAgentOwnedBy(record, "term-a", "tab-b", "tab-a"), true);
  assert.equal(isAgentOwnedBy(record, "term-b", "tab-b", "tab-a"), false);
  assert.equal(isAgentOwnedBy(record, undefined, "tab-a", "tab-a"), false);
});

test("legacy pane records without owner stay in the current tab only", () => {
  const record = {
    lifecycle: "oneshot" as const,
    layout: "pane" as const,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  assert.equal(isAgentOwnedBy(record, "term-a", "tab-a", "tab-a"), true);
  assert.equal(isAgentOwnedBy(record, "term-a", "tab-b", "tab-a"), false);
});

test("legacy tab records without owner stay visible until restamped", () => {
  const record = {
    lifecycle: "persistent" as const,
    layout: "tab" as const,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  assert.equal(isAgentOwnedBy(record, "term-b", "tab-worker", "tab-a"), true);
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

function history(
  overrides: Partial<ClosedAgentHistoryRecord> = {},
): ClosedAgentHistoryRecord {
  return {
    id: overrides.id ?? `ch_${Math.random().toString(16).slice(2)}`,
    ownerSessionId: "orch-a",
    profileName: "scout",
    tabLabel: "Scout Resume",
    childSessionFile: "/tmp/child.jsonl",
    childSessionId: "child-1",
    cwd: "/tmp/repo",
    layout: "pane",
    lifecycle: "oneshot",
    createdAt: "2026-01-01T00:00:00.000Z",
    closedAt: new Date().toISOString(),
    status: "resumable",
    claimGeneration: 0,
    ...overrides,
  };
}

test("migrates v1 state to v2 and keeps live terminal-keyed records", async () => {
  const filePath = await tempStatePath();
  await fs.writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      agents: {
        "terminal:term-1": {
          lifecycle: "oneshot",
          tabLabel: "Scout",
          ownerTerminalId: "term-orch",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    }),
  );

  const loaded = await loadHerdrAgentsState(filePath);
  assert.equal(loaded.version, 2);
  assert.equal(loaded.agents["terminal:term-1"]?.tabLabel, "Scout");
  assert.deepEqual(loaded.closedHistory, []);
});

test("archives one newest continuation slot per owner session and label", async () => {
  const filePath = await tempStatePath();
  const first = await archiveClosedOneShot(
    {
      ownerSessionId: "orch-a",
      profileName: "scout",
      tabLabel: "Scout Resume",
      childSessionFile: "/tmp/a.jsonl",
      childSessionId: "sid-a",
      cwd: "/tmp/repo",
      layout: "pane",
    },
    filePath,
  );
  const second = await archiveClosedOneShot(
    {
      id: first.id,
      ownerSessionId: "orch-a",
      profileName: "scout",
      tabLabel: "Scout Resume",
      childSessionFile: "/tmp/b.jsonl",
      childSessionId: "sid-b",
      cwd: "/tmp/repo",
      layout: "pane",
    },
    filePath,
  );

  const state = await loadHerdrAgentsState(filePath);
  assert.equal(state.closedHistory.length, 1);
  assert.equal(state.closedHistory[0]?.id, first.id);
  assert.equal(state.closedHistory[0]?.childSessionId, "sid-b");
  assert.equal(second.id, first.id);
});

test("does not let another orchestrator session claim closed history", async () => {
  const filePath = await tempStatePath();
  await archiveClosedOneShot(
    {
      ownerSessionId: "orch-a",
      profileName: "scout",
      tabLabel: "Scout Resume",
      childSessionFile: "/tmp/a.jsonl",
      childSessionId: "sid-a",
      cwd: "/tmp/repo",
      layout: "pane",
    },
    filePath,
  );

  const other = await claimClosedHistory(
    {
      ownerSessionId: "orch-b",
      tabLabel: "Scout Resume",
      profileName: "scout",
    },
    filePath,
  );
  assert.equal(other.ok, false);
  if (!other.ok)
    assert.match(other.error, /owned by this Orchestrator session/);
});

test("claims a closed history slot exactly once and can release it", async () => {
  const filePath = await tempStatePath();
  const archived = await archiveClosedOneShot(
    {
      ownerSessionId: "orch-a",
      profileName: "scout",
      tabLabel: "Scout Resume",
      childSessionFile: "/tmp/a.jsonl",
      childSessionId: "sid-a",
      cwd: "/tmp/repo",
      layout: "pane",
    },
    filePath,
  );

  const results = await Promise.all([
    claimClosedHistory(
      {
        ownerSessionId: "orch-a",
        tabLabel: "Scout Resume",
        profileName: "scout",
      },
      filePath,
    ),
    claimClosedHistory(
      {
        ownerSessionId: "orch-a",
        tabLabel: "Scout Resume",
        profileName: "scout",
      },
      filePath,
    ),
    claimClosedHistory(
      {
        ownerSessionId: "orch-a",
        tabLabel: "Scout Resume",
        profileName: "scout",
      },
      filePath,
    ),
  ]);
  assert.equal(results.filter((item) => item.ok).length, 1);

  const winner = results.find((item) => item.ok);
  assert.ok(winner && winner.ok);
  await releaseClosedHistory(
    winner.record.id,
    winner.record.claimGeneration,
    filePath,
  );
  const again = await claimClosedHistory(
    {
      ownerSessionId: "orch-a",
      tabLabel: "Scout Resume",
      profileName: "scout",
    },
    filePath,
  );
  assert.equal(again.ok, true);
  assert.equal(archived.id, winner.record.id);
});

test("keeps live records terminal-keyed while pruning closed history bounds", () => {
  const state = emptyHerdrAgentsState();
  state.agents["terminal:term-1"] = {
    lifecycle: "oneshot",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  for (let i = 0; i < CLOSED_HISTORY_MAX_PER_OWNER + 5; i++) {
    state.closedHistory.push(
      history({
        id: `ch-${i}`,
        tabLabel: `Label ${i}`,
        closedAt: new Date(Date.now() - i * 1000).toISOString(),
      }),
    );
  }
  assert.equal(pruneHerdrAgentsState(state, [pane()]), false);
  assert.ok(state.agents["terminal:term-1"]);
  pruneClosedHistory(state);
  assert.equal(state.closedHistory.length, CLOSED_HISTORY_MAX_PER_OWNER);
});

test("drops expired closed history but never claimed in-flight slots", () => {
  const state = emptyHerdrAgentsState();
  state.closedHistory.push(
    history({
      id: "old",
      closedAt: new Date(
        Date.now() - CLOSED_HISTORY_TTL_MS - 1000,
      ).toISOString(),
    }),
    history({
      id: "claimed-old",
      status: "claimed",
      closedAt: new Date(
        Date.now() - CLOSED_HISTORY_TTL_MS - 1000,
      ).toISOString(),
    }),
  );
  pruneClosedHistory(state);
  assert.deepEqual(
    state.closedHistory.map((record) => record.id),
    ["claimed-old"],
  );
});

test("caps closed history globally without deleting session files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-hist-jsonl-"));
  tempDirs.push(dir);
  const state = emptyHerdrAgentsState();
  const files: string[] = [];
  for (let i = 0; i < CLOSED_HISTORY_MAX_GLOBAL + 3; i++) {
    const sessionFile = path.join(dir, `s-${i}.jsonl`);
    await fs.writeFile(sessionFile, "{}\n");
    files.push(sessionFile);
    state.closedHistory.push(
      history({
        id: `g-${i}`,
        ownerSessionId: `owner-${i}`,
        tabLabel: `L${i}`,
        childSessionFile: sessionFile,
        closedAt: new Date(Date.now() - i * 1000).toISOString(),
      }),
    );
  }
  pruneClosedHistory(state);
  assert.ok(state.closedHistory.length <= CLOSED_HISTORY_MAX_GLOBAL);
  for (const file of files) {
    await fs.access(file);
  }
});

test("loads v2 closed history without rewriting an unknown future version", async () => {
  const filePath = await tempStatePath();
  await fs.writeFile(
    filePath,
    JSON.stringify({
      version: 2,
      agents: {},
      closedHistory: [history({ id: "keep-me" })],
    }),
  );
  const loaded = await loadHerdrAgentsState(filePath);
  assert.equal(loaded.version, 2);
  assert.equal(loaded.closedHistory[0]?.id, "keep-me");
  const onDisk = JSON.parse(await fs.readFile(filePath, "utf8")) as {
    version: number;
  };
  assert.equal(onDisk.version, 2);
});

test("quarantines unknown future versions instead of silently rewriting them", async () => {
  const filePath = await tempStatePath();
  const original = {
    version: 99,
    agents: {
      "terminal:term-1": {
        lifecycle: "oneshot",
        tabLabel: "Keep",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
  };
  await fs.writeFile(filePath, `${JSON.stringify(original)}\n`);
  const loaded = await loadHerdrAgentsState(filePath);
  assert.deepEqual(loaded, emptyHerdrAgentsState());
  await assert.rejects(fs.access(filePath));
  const quarantined = JSON.parse(
    await fs.readFile(`${filePath}.quarantine.v99`, "utf8"),
  ) as typeof original;
  assert.equal(quarantined.version, 99);
  assert.equal(quarantined.agents["terminal:term-1"]?.tabLabel, "Keep");
});

test("explicitly migrates numeric v1 to in-memory v2", async () => {
  const filePath = await tempStatePath();
  await fs.writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      agents: {
        "terminal:term-1": {
          lifecycle: "oneshot",
          tabLabel: "Legacy",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    }),
  );
  const loaded = await loadHerdrAgentsState(filePath);
  assert.equal(loaded.version, 2);
  assert.equal(loaded.agents["terminal:term-1"]?.tabLabel, "Legacy");
  assert.deepEqual(loaded.closedHistory, []);
  const onDisk = JSON.parse(await fs.readFile(filePath, "utf8")) as {
    version: number;
  };
  assert.equal(onDisk.version, 1);
});

test("quarantines missing versions instead of treating them as v1", async () => {
  const filePath = await tempStatePath();
  const original = JSON.stringify({
    agents: {
      "terminal:term-1": {
        lifecycle: "oneshot",
        tabLabel: "Keep",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
  });
  await fs.writeFile(filePath, `${original}\n`);
  const loaded = await loadHerdrAgentsState(filePath);
  assert.deepEqual(loaded, emptyHerdrAgentsState());
  await assert.rejects(fs.access(filePath));
  const quarantined = await fs.readFile(
    `${filePath}.quarantine.vmissing`,
    "utf8",
  );
  assert.equal(quarantined.trim(), original);
});

test("quarantines malformed JSON instead of overwriting it", async () => {
  const filePath = await tempStatePath();
  await fs.writeFile(filePath, "{not json\n");
  const loaded = await loadHerdrAgentsState(filePath);
  assert.deepEqual(loaded, emptyHerdrAgentsState());
  await fs.access(`${filePath}.quarantine.vjson`);
  assert.equal(
    await fs.readFile(`${filePath}.quarantine.vjson`, "utf8"),
    "{not json\n",
  );
});

test("quarantines malformed versions instead of migrating them", async () => {
  const filePath = await tempStatePath();
  await fs.writeFile(
    filePath,
    `${JSON.stringify({ version: "two", agents: {} })}\n`,
  );
  const loaded = await loadHerdrAgentsState(filePath);
  assert.deepEqual(loaded, emptyHerdrAgentsState());
  await fs.access(`${filePath}.quarantine.vtwo`);
});

test("releases stale claimed history that has no live generation", async () => {
  const filePath = await tempStatePath();
  const archived = await archiveClosedOneShot(
    {
      ownerSessionId: "orch-a",
      profileName: "scout",
      tabLabel: "Scout Resume",
      childSessionFile: "/tmp/a.jsonl",
      childSessionId: "sid-a",
      cwd: "/tmp/repo",
      layout: "pane",
    },
    filePath,
  );
  const claimed = await claimClosedHistory(
    {
      ownerSessionId: "orch-a",
      tabLabel: "Scout Resume",
      profileName: "scout",
    },
    filePath,
  );
  assert.equal(claimed.ok, true);
  const previous = process.env.HERDR_AGENTS_CLAIM_LEASE_MS;
  process.env.HERDR_AGENTS_CLAIM_LEASE_MS = "0";
  try {
    const loaded = await loadHerdrAgentsState(filePath);
    assert.equal(loaded.closedHistory[0]?.id, archived.id);
    assert.equal(loaded.closedHistory[0]?.status, "resumable");
  } finally {
    if (previous === undefined) delete process.env.HERDR_AGENTS_CLAIM_LEASE_MS;
    else process.env.HERDR_AGENTS_CLAIM_LEASE_MS = previous;
  }
});

test("does not release a claimed generation that still has a live agent", async () => {
  const filePath = await tempStatePath();
  await archiveClosedOneShot(
    {
      ownerSessionId: "orch-a",
      profileName: "scout",
      tabLabel: "Scout Resume",
      childSessionFile: "/tmp/a.jsonl",
      childSessionId: "sid-a",
      cwd: "/tmp/repo",
      layout: "pane",
    },
    filePath,
  );
  const claimed = await claimClosedHistory(
    {
      ownerSessionId: "orch-a",
      tabLabel: "Scout Resume",
      profileName: "scout",
    },
    filePath,
  );
  assert.ok(claimed.ok);
  if (!claimed.ok) return;
  await recordAgentLifecycle(
    pane(),
    "oneshot",
    {
      tabLabel: "Scout Resume",
      closedHistoryId: claimed.record.id,
      closedHistoryGeneration: claimed.record.claimGeneration,
    },
    filePath,
  );
  const previous = process.env.HERDR_AGENTS_CLAIM_LEASE_MS;
  process.env.HERDR_AGENTS_CLAIM_LEASE_MS = "0";
  try {
    const loaded = await loadHerdrAgentsState(filePath);
    assert.equal(loaded.closedHistory[0]?.status, "claimed");
    const again = await claimClosedHistory(
      {
        ownerSessionId: "orch-a",
        tabLabel: "Scout Resume",
        profileName: "scout",
      },
      filePath,
    );
    assert.equal(again.ok, false);
  } finally {
    if (previous === undefined) delete process.env.HERDR_AGENTS_CLAIM_LEASE_MS;
    else process.env.HERDR_AGENTS_CLAIM_LEASE_MS = previous;
  }
});

test("finalizes staged history after the live pane disappears", async () => {
  const state = emptyHerdrAgentsState();
  state.agents["terminal:term-1"] = {
    lifecycle: "oneshot",
    closedHistoryId: "ch-1",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  state.closedHistory.push(
    history({ id: "ch-1", status: "staged", tabLabel: "Scout Resume" }),
  );
  pruneHerdrAgentsState(state, []);
  assert.equal(state.agents["terminal:term-1"], undefined);
  assert.equal(state.closedHistory[0]?.status, "resumable");
});

test("stages continuation metadata and finalizes it atomically", async () => {
  const filePath = await tempStatePath();
  await recordAgentLifecycle(
    pane(),
    "oneshot",
    { tabLabel: "Scout Resume", agent: "scout", ownerSessionId: "orch-a" },
    filePath,
  );
  const staged = await stageClosedOneShot(
    {
      livePane: pane(),
      ownerSessionId: "orch-a",
      profileName: "scout",
      tabLabel: "Scout Resume",
      childSessionFile: "/tmp/a.jsonl",
      childSessionId: "sid-a",
      cwd: "/tmp/repo",
      layout: "pane",
    },
    filePath,
  );
  assert.equal(staged.status, "staged");
  assert.equal(
    (await loadHerdrAgentsState(filePath)).agents["terminal:term-1"]
      ?.closedHistoryId,
    staged.id,
  );
  await finalizeStagedClosedOneShot(
    { historyId: staged.id, livePane: pane() },
    filePath,
  );
  const after = await loadHerdrAgentsState(filePath);
  assert.equal(after.agents["terminal:term-1"], undefined);
  assert.equal(after.closedHistory[0]?.status, "resumable");
});

test("stage write failure leaves live state and no resumable history", async () => {
  const filePath = await tempStatePath();
  await recordAgentLifecycle(
    pane(),
    "oneshot",
    { tabLabel: "Scout Resume", agent: "scout", ownerSessionId: "orch-a" },
    filePath,
  );
  setFailNextStateSaves(1);
  try {
    await assert.rejects(
      () =>
        stageClosedOneShot(
          {
            livePane: pane(),
            ownerSessionId: "orch-a",
            profileName: "scout",
            tabLabel: "Scout Resume",
            childSessionFile: "/tmp/a.jsonl",
            childSessionId: "sid-a",
            cwd: "/tmp/repo",
            layout: "pane",
          },
          filePath,
        ),
      /injected state save failure/,
    );
    const after = await loadHerdrAgentsState(filePath);
    assert.ok(after.agents["terminal:term-1"]);
    assert.equal(after.closedHistory.length, 0);
  } finally {
    setFailNextStateSaves(0);
  }
});

test("a prior lock holder does not remove a replacement lock directory", async () => {
  const filePath = await tempStatePath();
  const lockPath = `${filePath}.lock`;
  const replacementSentinel = "owner.0.replacement-token";
  await withHerdrAgentsStateLock(filePath, async () => {
    const original = await fs.readdir(lockPath);
    assert.equal(original.length, 1);
    await fs.rm(lockPath, { recursive: true, force: true });
    await fs.mkdir(lockPath);
    await fs.writeFile(
      path.join(lockPath, replacementSentinel),
      `${JSON.stringify({
        pid: 0,
        token: "replacement-token",
        createdAt: Date.now(),
      })}\n`,
    );
  });
  assert.deepEqual(await fs.readdir(lockPath), [replacementSentinel]);
  assert.match(
    await fs.readFile(path.join(lockPath, replacementSentinel), "utf8"),
    /replacement-token/,
  );
});

test("a waiter cannot steal a live lock after the old stale threshold", async () => {
  const filePath = await tempStatePath();
  const dir = path.dirname(filePath);
  const stateModule = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../state.ts",
  );
  const holderScript = path.join(dir, "holder.ts");
  const waiterScript = path.join(dir, "waiter.ts");
  await fs.writeFile(
    holderScript,
    `import { withHerdrAgentsStateLock } from ${JSON.stringify(stateModule)};
import { promises as fs } from 'node:fs';
const filePath = ${JSON.stringify(filePath)};
const dir = ${JSON.stringify(dir)};
await withHerdrAgentsStateLock(filePath, async () => {
  await fs.writeFile(dir + '/holder-entered', String(Date.now()));
  await new Promise((resolve) => setTimeout(resolve, 250));
  await fs.writeFile(dir + '/holder-left', String(Date.now()));
});
`,
  );
  await fs.writeFile(
    waiterScript,
    `import { withHerdrAgentsStateLock } from ${JSON.stringify(stateModule)};
import { promises as fs } from 'node:fs';
const filePath = ${JSON.stringify(filePath)};
const dir = ${JSON.stringify(dir)};
await withHerdrAgentsStateLock(filePath, async () => {
  const holderLeft = await fs.readFile(dir + '/holder-left', 'utf8').catch(() => '');
  await fs.writeFile(dir + '/waiter-entered', holderLeft ? 'after-holder' : 'before-holder');
});
`,
  );

  const env = {
    ...process.env,
    HERDR_AGENTS_LOCK_STALE_MS: "40",
    HERDR_AGENTS_LOCK_WAIT_MS: "2000",
  };
  const holder = spawn(process.execPath, [holderScript], { env });
  await waitForChildFile(dir, "holder-entered");
  const waiter = spawn(process.execPath, [waiterScript], { env });
  const [holderCode, waiterCode] = await Promise.all([
    waitForExit(holder),
    waitForExit(waiter),
  ]);
  assert.equal(holderCode, 0);
  assert.equal(waiterCode, 0);
  assert.equal(
    await fs.readFile(path.join(dir, "waiter-entered"), "utf8"),
    "after-holder",
  );
});

test("two processes cannot occupy the state lock at the same time", async () => {
  const filePath = await tempStatePath();
  const dir = path.dirname(filePath);
  const stateModule = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../state.ts",
  );
  const lockerScript = path.join(dir, "locker.ts");
  await fs.writeFile(
    lockerScript,
    `import { withHerdrAgentsStateLock } from ${JSON.stringify(stateModule)};
import { promises as fs } from 'node:fs';
const filePath = ${JSON.stringify(filePath)};
const marker = process.argv[2];
const dir = ${JSON.stringify(dir)};
await withHerdrAgentsStateLock(filePath, async () => {
  const entered = Date.now();
  await fs.writeFile(dir + '/' + marker + '-entered', String(entered));
  await new Promise((resolve) => setTimeout(resolve, 80));
  await fs.writeFile(dir + '/' + marker + '-left', String(Date.now()));
});
`,
  );
  const env = { ...process.env, HERDR_AGENTS_LOCK_WAIT_MS: "2000" };
  const a = spawn(process.execPath, [lockerScript, "a"], { env });
  const b = spawn(process.execPath, [lockerScript, "b"], { env });
  const [aCode, bCode] = await Promise.all([waitForExit(a), waitForExit(b)]);
  assert.equal(aCode, 0);
  assert.equal(bCode, 0);
  const aEntered = Number(
    await fs.readFile(path.join(dir, "a-entered"), "utf8"),
  );
  const aLeft = Number(await fs.readFile(path.join(dir, "a-left"), "utf8"));
  const bEntered = Number(
    await fs.readFile(path.join(dir, "b-entered"), "utf8"),
  );
  const bLeft = Number(await fs.readFile(path.join(dir, "b-left"), "utf8"));
  assert.ok(aLeft <= bEntered || bLeft <= aEntered);
});

function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

async function waitForChildFile(dir: string, name: string): Promise<void> {
  const deadline = Date.now() + 2000;
  const filePath = path.join(dir, name);
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

test("persistPrunedAgentsState finalizes staged history when the live terminal is gone", async () => {
  const filePath = await tempStatePath();
  await recordAgentLifecycle(
    pane(),
    "oneshot",
    { tabLabel: "Scout Resume", agent: "scout", ownerSessionId: "orch-a" },
    filePath,
  );
  const staged = await stageClosedOneShot(
    {
      livePane: pane(),
      ownerSessionId: "orch-a",
      profileName: "scout",
      tabLabel: "Scout Resume",
      childSessionFile: "/tmp/a.jsonl",
      childSessionId: "sid-a",
      cwd: "/tmp/repo",
      layout: "pane",
    },
    filePath,
  );
  setFailNextStateMutation("finalize");
  await assert.rejects(
    () =>
      finalizeStagedClosedOneShot(
        { historyId: staged.id, livePane: pane() },
        filePath,
      ),
    /injected finalize state save failure/,
  );
  const before = await loadHerdrAgentsState(filePath);
  assert.equal(before.closedHistory[0]?.status, "staged");
  assert.ok(before.agents["terminal:term-1"]);
  const after = await persistPrunedAgentsState([], filePath);
  assert.equal(after.agents["terminal:term-1"], undefined);
  assert.equal(after.closedHistory[0]?.status, "resumable");
});

test("two waiters observing a legacy lock file never unlink it or both win", async () => {
  const filePath = await tempStatePath();
  const lockPath = `${filePath}.lock`;
  const dir = path.dirname(filePath);
  const stale = "not-a-lock";
  await fs.writeFile(lockPath, stale);
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(lockPath, old, old);

  const stateModule = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../state.ts",
  );
  const waiterScript = path.join(dir, "stale-waiter.ts");
  await fs.writeFile(
    waiterScript,
    `import { withHerdrAgentsStateLock } from ${JSON.stringify(stateModule)};
const filePath = ${JSON.stringify(filePath)};
try {
  await withHerdrAgentsStateLock(filePath, async () => {});
  process.exit(0);
} catch (error) {
  process.stderr.write(String(error));
  process.exit(2);
}
`,
  );
  const env = { ...process.env, HERDR_AGENTS_LOCK_WAIT_MS: "80" };
  const first = spawn(process.execPath, [waiterScript], { env });
  const second = spawn(process.execPath, [waiterScript], { env });
  const [firstCode, secondCode] = await Promise.all([
    waitForExit(first),
    waitForExit(second),
  ]);
  assert.equal(firstCode, 2);
  assert.equal(secondCode, 2);
  assert.equal(await fs.readFile(lockPath, "utf8"), stale);
});
