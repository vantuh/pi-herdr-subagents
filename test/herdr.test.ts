import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAgentFinishedNotificationArgs,
  buildAgentPromptArgs,
  buildAgentRenameArgs,
  buildAgentWaitArgs,
  buildEqualAgentSplitRatios,
  chooseAgentColumnSplitTarget,
  findAgentsWorkspaceId,
  findReusableAgentPane,
  findReusableAgentTab,
  HerdrCliError,
  listManagedWorkspaceAgents,
  mapPromptError,
  parseAgentSnapshot,
  parseCreatedWorkspace,
  parseStartedAgentSnapshot,
  parseWorkspaceListOutput,
  promptAcceptanceObserved,
  redactHerdrArgs,
  sanitizeHerdrOutput,
  sensitiveArgValues,
  startedAgentReady,
} from "../herdr.ts";
import { emptyHerdrAgentsState } from "../state.ts";
import type { HerdrContext, PaneInfo, TabInfo } from "../types.ts";

test("builds an atomic prompt submit without the hardcoded --wait stall gate", () => {
  assert.deepEqual(buildAgentPromptArgs("reviewer_ab12", "Review"), [
    "agent",
    "prompt",
    "reviewer_ab12",
    "Review",
  ]);
});

test("maps agent_blocked prompt failures to an actionable orchestrator error", () => {
  const secret = "SECRET_PROMPT_TEXT";
  const blocked = new HerdrCliError(
    `herdr agent prompt worker_ab12 ${secret} failed [agent_blocked]: blocked`,
    "agent_blocked",
    ["agent", "prompt", "worker_ab12", secret],
  );

  assert.throws(
    () => mapPromptError(blocked, "worker_ab12"),
    (error: unknown) => {
      assert.ok(error instanceof HerdrCliError);
      assert.equal(error.code, "agent_blocked");
      assert.match(
        error.message,
        /attach with `herdr agent attach worker_ab12`/,
      );
      assert.match(error.message, /resolve it before re-prompting/);
      assert.deepEqual(error.args, [
        "agent",
        "prompt",
        "worker_ab12",
        "<prompt>",
      ]);
      assert.ok(!error.message.includes(secret));
      assert.ok(!error.args.includes(secret));
      return true;
    },
  );

  const busy = new HerdrCliError(
    "herdr agent prompt worker_ab12 <prompt> failed [agent_pane_busy]: busy",
    "agent_pane_busy",
    ["agent", "prompt", "worker_ab12", "<prompt>"],
  );
  assert.throws(
    () => mapPromptError(busy, "worker_ab12"),
    (error: unknown) => error === busy,
  );

  const plain = new Error("network down");
  assert.throws(
    () => mapPromptError(plain, "worker_ab12"),
    (error: unknown) => error === plain,
  );
});

test("redacts session, system-prompt, and managed temp paths from Herdr argv", () => {
  const session = "/tmp/herdr-pi-sessions/child.jsonl";
  const system = "/tmp/herdr-agent-xyz/system.md";
  const meta = "/tmp/herdr-agent-xyz/session.json";
  const redacted = redactHerdrArgs([
    "agent",
    "start",
    "scout_ab12",
    "--pane",
    "pane-1",
    "--",
    "--session",
    session,
    "--append-system-prompt",
    system,
    "--env",
    `HERDR_AGENT_SESSION_META=${meta}`,
  ]);
  assert.equal(redacted.includes(session), false);
  assert.equal(redacted.includes(system), false);
  assert.equal(redacted.includes(meta), false);
  assert.equal(redacted[redacted.indexOf("--session") + 1], "<redacted>");
  assert.equal(
    redacted[redacted.indexOf("--append-system-prompt") + 1],
    "<redacted>",
  );
});

test("sanitizes exact argv values including paths with spaces from Herdr stderr", () => {
  const session = "/tmp/my project/herdr-pi-sessions/child session.jsonl";
  const temp = "/tmp/herdr-agent-xyz/system file.md";
  const args = [
    "agent",
    "start",
    "scout_ab12",
    "--",
    "--session",
    session,
    "--append-system-prompt",
    temp,
  ];
  const quoted = `failed '${session}' and "${temp}"`;
  const unquoted = `cmd ${session} ${temp}`;
  const sensitive = sensitiveArgValues(args);
  assert.ok(sensitive.includes(session));
  assert.ok(sensitive.includes(temp));
  for (const text of [quoted, unquoted, JSON.stringify({ cmd: args })]) {
    const safe = sanitizeHerdrOutput(text, sensitive);
    assert.equal(safe.includes(session), false);
    assert.equal(safe.includes(temp), false);
  }
});

test("builds a completion wait that ignores blocked", () => {
  assert.deepEqual(
    buildAgentWaitArgs("worker_ab12", 120000, ["idle", "done"]),
    [
      "agent",
      "wait",
      "worker_ab12",
      "--until",
      "idle",
      "--until",
      "done",
      "--timeout",
      "120000",
    ],
  );
});

test("reassigns the requested automation name after startup recovery", () => {
  assert.deepEqual(buildAgentRenameArgs("w1:p2", "scout_ab12"), [
    "agent",
    "rename",
    "w1:p2",
    "scout_ab12",
  ]);
});

test("recognizes Pi after a transient startup kind mismatch", () => {
  const kiro = parseStartedAgentSnapshot(
    JSON.stringify({
      result: { agent: { agent: "kiro", agent_status: "working" } },
    }),
  );
  const pi = parseStartedAgentSnapshot(
    JSON.stringify({
      result: { agent: { agent: "pi", agent_status: "idle" } },
    }),
  );

  assert.equal(startedAgentReady(kiro, "pi"), false);
  assert.equal(startedAgentReady(pi, "pi"), true);
  assert.equal(
    startedAgentReady({ agent: "pi", status: "working" }, "pi"),
    false,
  );
});

test("parses agent get snapshots used for prompt acceptance", () => {
  assert.deepEqual(
    parseAgentSnapshot(
      JSON.stringify({
        result: {
          agent: {
            agent_status: "idle",
            state_change_seq: 12,
            interactive_ready: true,
          },
        },
      }),
    ),
    { status: "idle", stateChangeSeq: 12, interactiveReady: true },
  );
});

test("prompt acceptance requires a newer seq for working or settled", () => {
  const before = {
    status: "idle",
    stateChangeSeq: 10,
    interactiveReady: true,
  };
  // Same seq while still working: prior turn, not this prompt.
  assert.equal(
    promptAcceptanceObserved(before, {
      status: "working",
      stateChangeSeq: 10,
      interactiveReady: true,
    }),
    null,
  );
  assert.equal(
    promptAcceptanceObserved(
      { status: "working", stateChangeSeq: 10, interactiveReady: true },
      { status: "working", stateChangeSeq: 10, interactiveReady: true },
    ),
    null,
  );
  assert.equal(
    promptAcceptanceObserved(before, {
      status: "working",
      stateChangeSeq: 11,
      interactiveReady: true,
    }),
    "working",
  );
  assert.equal(
    promptAcceptanceObserved(before, {
      status: "blocked",
      stateChangeSeq: 11,
      interactiveReady: true,
    }),
    "working",
  );
  assert.equal(
    promptAcceptanceObserved(before, {
      status: "idle",
      stateChangeSeq: 11,
      interactiveReady: true,
    }),
    "settled",
  );
  assert.equal(
    promptAcceptanceObserved(before, {
      status: "idle",
      stateChangeSeq: 10,
      interactiveReady: true,
    }),
    null,
  );
});

test("finds a reusable managed pane by exact label in the orchestrator tab", () => {
  const panes: PaneInfo[] = [
    {
      pane_id: "pane-orchestrator",
      tab_id: "tab-orchestrator",
      workspace_id: "workspace-1",
      terminal_id: "term-orchestrator",
      agent: "pi",
    },
    {
      pane_id: "pane-worker",
      tab_id: "tab-orchestrator",
      workspace_id: "workspace-1",
      terminal_id: "term-worker",
      agent: "pi",
      agent_status: "idle",
    },
  ];
  const context: HerdrContext = {
    panes,
    currentPane: panes[0]!,
    currentTab: "tab-orchestrator",
    workspaceId: "workspace-1",
  };
  const state = emptyHerdrAgentsState();
  state.agents["terminal:term-worker"] = {
    lifecycle: "persistent",
    layout: "pane",
    tabLabel: "Worker",
    agent: "worker",
    automationName: "worker_ab12cd34",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  assert.equal(findReusableAgentPane(context, state, "Worker"), panes[1]);
  assert.deepEqual(listManagedWorkspaceAgents(context, state), [
    {
      tabId: "tab-orchestrator",
      tabLabel: "Worker",
      paneId: "pane-worker",
      agent: "worker",
      automationName: "worker_ab12cd34",
      status: "idle",
      lifecycle: "persistent",
      layout: "pane",
      cwd: undefined,
      updatedAt: "2026-01-01T00:00:00.000Z",
      terminalId: "term-worker",
    },
  ]);
});

test("lists a newly created managed pane before Pi agent detection", () => {
  const panes: PaneInfo[] = [
    {
      pane_id: "pane-orchestrator",
      tab_id: "tab-orchestrator",
      workspace_id: "workspace-1",
      terminal_id: "term-orchestrator",
      agent: "pi",
    },
    {
      pane_id: "pane-starting",
      tab_id: "tab-orchestrator",
      workspace_id: "workspace-1",
      terminal_id: "term-starting",
    },
  ];
  const context: HerdrContext = {
    panes,
    currentPane: panes[0]!,
    currentTab: "tab-orchestrator",
    workspaceId: "workspace-1",
  };
  const state = emptyHerdrAgentsState();
  state.agents["terminal:term-starting"] = {
    lifecycle: "oneshot",
    layout: "pane",
    tabLabel: "Scout",
    agent: "scout",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  assert.equal(
    listManagedWorkspaceAgents(context, state)[0]?.paneId,
    "pane-starting",
  );
});

test("reuses a legacy same-tab pane record without a layout field", () => {
  const panes: PaneInfo[] = [
    {
      pane_id: "pane-orchestrator",
      tab_id: "tab-orchestrator",
      workspace_id: "workspace-1",
      terminal_id: "term-orchestrator",
      agent: "pi",
    },
    {
      pane_id: "pane-worker",
      tab_id: "tab-orchestrator",
      workspace_id: "workspace-1",
      terminal_id: "term-worker",
      agent: "pi",
    },
  ];
  const context: HerdrContext = {
    panes,
    currentPane: panes[0]!,
    currentTab: "tab-orchestrator",
    workspaceId: "workspace-1",
  };
  const state = emptyHerdrAgentsState();
  state.agents["terminal:term-worker"] = {
    lifecycle: "persistent",
    tabLabel: "Worker",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  assert.equal(findReusableAgentPane(context, state, "Worker"), panes[1]);
});

test("does not reuse an unmanaged or cross-tab pane", () => {
  const panes: PaneInfo[] = [
    {
      pane_id: "pane-orchestrator",
      tab_id: "tab-orchestrator",
      workspace_id: "workspace-1",
      terminal_id: "term-orchestrator",
      agent: "pi",
    },
    {
      pane_id: "pane-unmanaged",
      tab_id: "tab-orchestrator",
      workspace_id: "workspace-1",
      terminal_id: "term-unmanaged",
      agent: "pi",
    },
    {
      pane_id: "pane-other-tab",
      tab_id: "tab-other",
      workspace_id: "workspace-1",
      terminal_id: "term-other",
      agent: "pi",
    },
  ];
  const context: HerdrContext = {
    panes,
    currentPane: panes[0]!,
    currentTab: "tab-orchestrator",
    workspaceId: "workspace-1",
  };
  const state = emptyHerdrAgentsState();
  state.agents["terminal:term-other"] = {
    lifecycle: "persistent",
    layout: "pane",
    tabLabel: "Worker",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  assert.equal(findReusableAgentPane(context, state, "Worker"), undefined);
});

test("builds equal ratios for three vertically stacked agent panes", () => {
  const root = {
    type: "split" as const,
    direction: "right" as const,
    ratio: 0.6,
    first: { type: "pane" as const, pane_id: "orchestrator" },
    second: {
      type: "split" as const,
      direction: "down" as const,
      ratio: 0.5,
      first: { type: "pane" as const, pane_id: "agent-1" },
      second: {
        type: "split" as const,
        direction: "down" as const,
        ratio: 0.5,
        first: { type: "pane" as const, pane_id: "agent-2" },
        second: { type: "pane" as const, pane_id: "agent-3" },
      },
    },
  };

  assert.deepEqual(
    buildEqualAgentSplitRatios(
      root,
      new Set(["agent-1", "agent-2", "agent-3"]),
    ),
    [
      { path: [true], ratio: 1 / 3 },
      { path: [true, true], ratio: 1 / 2 },
    ],
  );
});

test("does not resize the outer orchestrator split", () => {
  const root = {
    type: "split" as const,
    direction: "right" as const,
    ratio: 0.6,
    first: { type: "pane" as const, pane_id: "orchestrator" },
    second: { type: "pane" as const, pane_id: "agent" },
  };

  assert.deepEqual(buildEqualAgentSplitRatios(root, new Set(["agent"])), []);
});

test("splits the largest existing agent pane in the right column", () => {
  const panes: PaneInfo[] = [
    { pane_id: "small", tab_id: "tab", workspace_id: "workspace" },
    { pane_id: "large", tab_id: "tab", workspace_id: "workspace" },
  ];

  assert.equal(
    chooseAgentColumnSplitTarget(panes, {
      panes: [
        { pane_id: "small", rect: { width: 40, height: 20 } },
        { pane_id: "large", rect: { width: 40, height: 40 } },
      ],
    })?.pane_id,
    "large",
  );
});

test("finds a reusable agent tab by exact label", () => {
  const panes: PaneInfo[] = [
    {
      pane_id: "pane-orchestrator",
      tab_id: "tab-orchestrator",
      workspace_id: "workspace-1",
      terminal_id: "term-orchestrator",
      agent: "pi",
    },
    {
      pane_id: "pane-worker",
      tab_id: "tab-worker",
      workspace_id: "workspace-1",
      terminal_id: "term-worker",
      agent: "pi",
      agent_status: "idle",
    },
  ];
  const tabs: TabInfo[] = [
    { tab_id: "tab-orchestrator", label: "Orchestrator" },
    { tab_id: "tab-worker", label: "Worker" },
  ];
  const context: HerdrContext = {
    panes,
    currentPane: panes[0]!,
    currentTab: "tab-orchestrator",
    workspaceId: "workspace-1",
  };
  const state = emptyHerdrAgentsState();
  state.agents["terminal:term-worker"] = {
    lifecycle: "persistent",
    layout: "tab",
    tabLabel: "Worker",
    ownerTerminalId: "term-orchestrator",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  assert.deepEqual(findReusableAgentTab(context, tabs, "Worker", state), {
    tab: tabs[1],
    pane: panes[1],
  });
});

test("does not reuse the orchestrator tab", () => {
  const panes: PaneInfo[] = [
    {
      pane_id: "pane-orchestrator",
      tab_id: "tab-orchestrator",
      workspace_id: "workspace-1",
      agent: "pi",
    },
  ];
  const tabs: TabInfo[] = [{ tab_id: "tab-orchestrator", label: "Worker" }];
  const context: HerdrContext = {
    panes,
    currentPane: panes[0]!,
    currentTab: "tab-orchestrator",
    workspaceId: "workspace-1",
  };

  assert.equal(
    findReusableAgentTab(context, tabs, "Worker", emptyHerdrAgentsState()),
    undefined,
  );
});

test("does not reuse a tab without a pi pane", () => {
  const panes: PaneInfo[] = [
    {
      pane_id: "pane-orchestrator",
      tab_id: "tab-orchestrator",
      workspace_id: "workspace-1",
      agent: "pi",
    },
    {
      pane_id: "pane-shell",
      tab_id: "tab-worker",
      workspace_id: "workspace-1",
      agent: "shell",
      agent_status: "idle",
    },
  ];
  const tabs: TabInfo[] = [
    { tab_id: "tab-orchestrator", label: "Orchestrator" },
    { tab_id: "tab-worker", label: "Worker" },
  ];
  const context: HerdrContext = {
    panes,
    currentPane: panes[0]!,
    currentTab: "tab-orchestrator",
    workspaceId: "workspace-1",
  };

  assert.equal(
    findReusableAgentTab(context, tabs, "Worker", emptyHerdrAgentsState()),
    undefined,
  );
});

test("reusable tab lookup prefers a pi pane in a multi-pane tab", () => {
  const panes: PaneInfo[] = [
    {
      pane_id: "pane-orchestrator",
      tab_id: "tab-orchestrator",
      workspace_id: "workspace-1",
      terminal_id: "term-orchestrator",
      agent: "pi",
    },
    {
      pane_id: "pane-shell",
      tab_id: "tab-worker",
      workspace_id: "workspace-1",
      agent: "shell",
    },
    {
      pane_id: "pane-pi",
      tab_id: "tab-worker",
      workspace_id: "workspace-1",
      terminal_id: "term-pi",
      agent: "pi",
    },
  ];
  const tabs: TabInfo[] = [
    { tab_id: "tab-orchestrator", label: "Orchestrator" },
    { tab_id: "tab-worker", label: "Worker" },
  ];
  const context: HerdrContext = {
    panes,
    currentPane: panes[0]!,
    currentTab: "tab-orchestrator",
    workspaceId: "workspace-1",
  };
  const state = emptyHerdrAgentsState();
  state.agents["terminal:term-pi"] = {
    lifecycle: "persistent",
    layout: "tab",
    tabLabel: "Worker",
    ownerTerminalId: "term-orchestrator",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  assert.equal(
    findReusableAgentTab(context, tabs, "Worker", state)?.pane,
    panes[2],
  );
});

test("reusable tab lookup matches exact base label, not numbered labels", () => {
  const panes: PaneInfo[] = [
    {
      pane_id: "pane-orchestrator",
      tab_id: "tab-orchestrator",
      workspace_id: "workspace-1",
      terminal_id: "term-orchestrator",
      agent: "pi",
    },
    {
      pane_id: "pane-worker-2",
      tab_id: "tab-worker-2",
      workspace_id: "workspace-1",
      terminal_id: "term-worker-2",
      agent: "pi",
    },
    {
      pane_id: "pane-worker",
      tab_id: "tab-worker",
      workspace_id: "workspace-1",
      terminal_id: "term-worker",
      agent: "pi",
    },
  ];
  const tabs: TabInfo[] = [
    { tab_id: "tab-orchestrator", label: "Orchestrator" },
    { tab_id: "tab-worker-2", label: "Worker #2" },
    { tab_id: "tab-worker", label: "Worker" },
  ];
  const context: HerdrContext = {
    panes,
    currentPane: panes[0]!,
    currentTab: "tab-orchestrator",
    workspaceId: "workspace-1",
  };
  const state = emptyHerdrAgentsState();
  state.agents["terminal:term-worker"] = {
    lifecycle: "persistent",
    layout: "tab",
    tabLabel: "Worker",
    ownerTerminalId: "term-orchestrator",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  state.agents["terminal:term-worker-2"] = {
    lifecycle: "persistent",
    layout: "tab",
    tabLabel: "Worker #2",
    ownerTerminalId: "term-orchestrator",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  assert.equal(
    findReusableAgentTab(context, tabs, "Worker", state)?.tab,
    tabs[2],
  );
});

test("does not list or reuse another orchestrator's agents", () => {
  const panes: PaneInfo[] = [
    {
      pane_id: "pane-orch-a",
      tab_id: "tab-a",
      workspace_id: "workspace-1",
      terminal_id: "term-orch-a",
      agent: "pi",
    },
    {
      pane_id: "pane-orch-b",
      tab_id: "tab-b",
      workspace_id: "workspace-1",
      terminal_id: "term-orch-b",
      agent: "pi",
    },
    {
      pane_id: "pane-scout-a",
      tab_id: "tab-a",
      workspace_id: "workspace-1",
      terminal_id: "term-scout-a",
      agent: "pi",
      agent_status: "working",
    },
    {
      pane_id: "pane-scout-b",
      tab_id: "tab-scout-b",
      workspace_id: "workspace-1",
      terminal_id: "term-scout-b",
      agent: "pi",
      agent_status: "idle",
    },
  ];
  const tabs: TabInfo[] = [
    { tab_id: "tab-a", label: "Orchestrator" },
    { tab_id: "tab-b", label: "Orchestrator" },
    { tab_id: "tab-scout-b", label: "Scout" },
  ];
  const state = emptyHerdrAgentsState();
  state.agents["terminal:term-scout-a"] = {
    lifecycle: "oneshot",
    layout: "pane",
    tabLabel: "Scout",
    agent: "scout",
    ownerTerminalId: "term-orch-a",
    detached: true,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  state.agents["terminal:term-scout-b"] = {
    lifecycle: "persistent",
    layout: "tab",
    tabLabel: "Scout",
    agent: "scout",
    ownerTerminalId: "term-orch-b",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  const orchA: HerdrContext = {
    panes,
    currentPane: panes[0]!,
    currentTab: "tab-a",
    workspaceId: "workspace-1",
  };
  const orchB: HerdrContext = {
    panes,
    currentPane: panes[1]!,
    currentTab: "tab-b",
    workspaceId: "workspace-1",
  };

  assert.deepEqual(
    listManagedWorkspaceAgents(orchA, state).map((agent) => agent.paneId),
    ["pane-scout-a"],
  );
  assert.deepEqual(
    listManagedWorkspaceAgents(orchB, state).map((agent) => agent.paneId),
    ["pane-scout-b"],
  );
  assert.equal(findReusableAgentPane(orchB, state, "Scout"), undefined);
  assert.equal(findReusableAgentTab(orchA, tabs, "Scout", state), undefined);
  assert.equal(
    findReusableAgentTab(orchB, tabs, "Scout", state)?.pane,
    panes[3],
  );
});

test("parses the workspace list envelope and drops malformed entries", () => {
  assert.deepEqual(
    parseWorkspaceListOutput(
      JSON.stringify({
        result: {
          workspaces: [
            { workspace_id: "w1", label: "main", focused: true },
            { workspace_id: "w2", label: "Agents" },
            { label: "no id" },
            "junk",
          ],
        },
      }),
    ),
    [
      { workspace_id: "w1", label: "main", focused: true },
      { workspace_id: "w2", label: "Agents" },
    ],
  );
  assert.throws(() => parseWorkspaceListOutput("this is not json"));
  assert.throws(() =>
    parseWorkspaceListOutput(JSON.stringify({ result: {} })),
  );
});

test("reads the created workspace id and root tab id from workspace create output", () => {
  assert.deepEqual(
    parseCreatedWorkspace(
      JSON.stringify({
        result: {
          workspace: { workspace_id: "w7" },
          tab: { tab_id: "w7:t1" },
        },
      }),
    ),
    { workspaceId: "w7", rootTabId: "w7:t1" },
  );
  assert.deepEqual(
    parseCreatedWorkspace(
      JSON.stringify({ result: { workspace: { workspace_id: "w7" } } }),
    ),
    { workspaceId: "w7" },
  );
  assert.deepEqual(parseCreatedWorkspace("this is not json"), {});
  assert.deepEqual(
    parseCreatedWorkspace(JSON.stringify({ result: { workspace: {} } })),
    {},
  );
});

test("builds the agent-finished notification with a truncated body", () => {
  assert.deepEqual(
    buildAgentFinishedNotificationArgs("Scout", "scout_ab12", "All done."),
    ["notification", "show", "Pi · Scout finished", "--body", "All done."],
  );

  const long = "x".repeat(500);
  const args = buildAgentFinishedNotificationArgs("Scout", "scout", long);
  const body = args.at(-1)!;
  assert.equal(body.length, 401); // 400 chars + ellipsis
  assert.ok(body.endsWith("…"));
  assert.deepEqual(
    buildAgentFinishedNotificationArgs("Scout", "scout", "   "),
    [
      "notification",
      "show",
      "Pi · Scout finished",
      "--body",
      "scout finished with an empty result.",
    ],
  );
});

test("record-driven reuse synthesizes the tab when it is not in the listed tabs", () => {
  // A managed record whose tab exists in another workspace (or predates the
  // current listTabs scope) still resolves reuse from the record, with the
  // recorded label standing in for the missing TabInfo.
  const orchA: HerdrContext = {
    panes: [
      {
        pane_id: "pane-orch",
        tab_id: "tab-orch",
        workspace_id: "w1",
        terminal_id: "term-orch",
        agent: "pi",
      },
      {
        pane_id: "pane-scout",
        tab_id: "tab-scout",
        workspace_id: "w2",
        terminal_id: "term-scout",
        agent: "pi",
        agent_status: "idle",
      },
    ],
    currentPane: {
      pane_id: "pane-orch",
      tab_id: "tab-orch",
      workspace_id: "w1",
      terminal_id: "term-orch",
      agent: "pi",
    },
    workspaceId: "w1",
    currentTab: "tab-orch",
  };
  const state = emptyHerdrAgentsState();
  state.agents["terminal:term-scout"] = {
    lifecycle: "persistent",
    layout: "workspace",
    tabLabel: "Scout",
    agent: "scout",
    ownerTerminalId: "term-orch",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  const reused = findReusableAgentTab(orchA, [], "Scout", state);
  assert.ok(reused, "expected a record-driven reuse");
  assert.equal(reused.pane.pane_id, "pane-scout");
  assert.deepEqual(reused.tab, {
    tab_id: "tab-scout",
    label: "Scout",
  });

  // A foreign owner must not adopt it.
  state.agents["terminal:term-scout"].ownerTerminalId = "term-someone-else";
  assert.equal(findReusableAgentTab(orchA, [], "Scout", state), undefined);
});

