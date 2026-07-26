import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAgentPromptArgs,
  buildAgentWaitArgs,
  buildEqualAgentSplitRatios,
  chooseAgentColumnSplitTarget,
  findReusableAgentPane,
  findReusableAgentTab,
  listCurrentWorkspaceAgents,
  listManagedWorkspaceAgents,
  parseAgentSnapshot,
  promptAcceptanceObserved,
} from "./herdr.ts";
import { emptyHerdrAgentsState } from "./state.ts";
import type { HerdrContext, PaneInfo, TabInfo } from "./types.ts";

test("builds an atomic prompt submit without the hardcoded --wait stall gate", () => {
  assert.deepEqual(buildAgentPromptArgs("reviewer_ab12", "Review"), [
    "agent",
    "prompt",
    "reviewer_ab12",
    "Review",
  ]);
});

test("builds a completion wait that ignores blocked", () => {
  assert.deepEqual(buildAgentWaitArgs("worker_ab12", 120000, ["idle", "done"]), [
    "agent",
    "wait",
    "worker_ab12",
    "--until",
    "idle",
    "--until",
    "done",
    "--timeout",
    "120000",
  ]);
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

test("lists agent tabs in the current workspace except the orchestrator", () => {
  const panes: PaneInfo[] = [
    {
      pane_id: "pane-orchestrator",
      tab_id: "tab-orchestrator",
      workspace_id: "workspace-1",
      agent: "pi",
      agent_status: "working",
    },
    {
      pane_id: "pane-agent",
      tab_id: "tab-agent",
      workspace_id: "workspace-1",
      agent: "pi",
      agent_status: "idle",
      foreground_cwd: "/repo",
    },
    {
      pane_id: "pane-shell",
      tab_id: "tab-shell",
      workspace_id: "workspace-1",
      agent_status: "unknown",
    },
    {
      pane_id: "pane-other-workspace",
      tab_id: "tab-other-workspace",
      workspace_id: "workspace-2",
      agent: "pi",
      agent_status: "idle",
    },
  ];
  const tabs: TabInfo[] = [
    { tab_id: "tab-orchestrator", label: "Orchestrator" },
    { tab_id: "tab-agent", label: "Researcher" },
    { tab_id: "tab-shell", label: "shell" },
    { tab_id: "tab-other-workspace", label: "Other" },
  ];
  const context: HerdrContext = {
    panes,
    currentPane: panes[0]!,
    currentTab: "tab-orchestrator",
    workspaceId: "workspace-1",
  };

  assert.deepEqual(listCurrentWorkspaceAgents(context, tabs), [
    {
      tabId: "tab-agent",
      tabLabel: "Researcher",
      paneId: "pane-agent",
      agent: "pi",
      status: "idle",
      cwd: "/repo",
    },
  ]);
});

test("prefers the pi pane when a tab has multiple panes", () => {
  const panes: PaneInfo[] = [
    {
      pane_id: "pane-orchestrator",
      tab_id: "tab-orchestrator",
      workspace_id: "workspace-1",
      agent: "pi",
      agent_status: "working",
    },
    {
      pane_id: "pane-shell-child",
      tab_id: "tab-agent",
      workspace_id: "workspace-1",
      agent: "shell",
      agent_status: "idle",
      foreground_cwd: "/shell-cwd",
    },
    {
      pane_id: "pane-pi-child",
      tab_id: "tab-agent",
      workspace_id: "workspace-1",
      agent: "pi",
      agent_status: "working",
      foreground_cwd: "/pi-cwd",
    },
  ];
  const tabs: TabInfo[] = [
    { tab_id: "tab-orchestrator", label: "Orchestrator" },
    { tab_id: "tab-agent", label: "Researcher" },
  ];
  const context: HerdrContext = {
    panes,
    currentPane: panes[0]!,
    currentTab: "tab-orchestrator",
    workspaceId: "workspace-1",
  };

  assert.deepEqual(listCurrentWorkspaceAgents(context, tabs), [
    {
      tabId: "tab-agent",
      tabLabel: "Researcher",
      paneId: "pane-pi-child",
      agent: "pi",
      status: "working",
      cwd: "/pi-cwd",
    },
  ]);
});

test("includes known lifecycle for agent tabs", () => {
  const panes: PaneInfo[] = [
    {
      pane_id: "pane-orchestrator",
      tab_id: "tab-orchestrator",
      workspace_id: "workspace-1",
      agent: "pi",
    },
    {
      pane_id: "pane-agent",
      tab_id: "tab-agent",
      workspace_id: "workspace-1",
      agent: "pi",
      agent_status: "idle",
    },
  ];
  const tabs: TabInfo[] = [
    { tab_id: "tab-orchestrator", label: "Orchestrator" },
    { tab_id: "tab-agent", label: "Researcher" },
  ];
  const context: HerdrContext = {
    panes,
    currentPane: panes[0]!,
    currentTab: "tab-orchestrator",
    workspaceId: "workspace-1",
  };

  const [agent] = listCurrentWorkspaceAgents(
    context,
    tabs,
    new Map([["tab-agent", "persistent"]]),
  );

  assert.equal(agent?.lifecycle, "persistent");
});

test("falls back to tab.agent_status when pane.agent_status is missing", () => {
  const panes: PaneInfo[] = [
    {
      pane_id: "pane-orchestrator",
      tab_id: "tab-orchestrator",
      workspace_id: "workspace-1",
      agent: "pi",
    },
    {
      pane_id: "pane-agent",
      tab_id: "tab-agent",
      workspace_id: "workspace-1",
      agent: "pi",
    },
  ];
  const tabs: TabInfo[] = [
    { tab_id: "tab-orchestrator", label: "Orchestrator" },
    { tab_id: "tab-agent", label: "Researcher", agent_status: "blocked" },
  ];
  const context: HerdrContext = {
    panes,
    currentPane: panes[0]!,
    currentTab: "tab-orchestrator",
    workspaceId: "workspace-1",
  };

  const [agent] = listCurrentWorkspaceAgents(context, tabs);
  assert.equal(agent?.status, "blocked");
});

test("falls back to unknown when neither pane nor tab report a status", () => {
  const panes: PaneInfo[] = [
    {
      pane_id: "pane-orchestrator",
      tab_id: "tab-orchestrator",
      workspace_id: "workspace-1",
      agent: "pi",
    },
    {
      pane_id: "pane-agent",
      tab_id: "tab-agent",
      workspace_id: "workspace-1",
      agent: "pi",
    },
  ];
  const tabs: TabInfo[] = [
    { tab_id: "tab-orchestrator", label: "Orchestrator" },
    { tab_id: "tab-agent", label: "Researcher" },
  ];
  const context: HerdrContext = {
    panes,
    currentPane: panes[0]!,
    currentTab: "tab-orchestrator",
    workspaceId: "workspace-1",
  };

  const [agent] = listCurrentWorkspaceAgents(context, tabs);
  assert.equal(agent?.status, "unknown");
});

test("falls back to pane.cwd when foreground_cwd is missing", () => {
  const panes: PaneInfo[] = [
    {
      pane_id: "pane-orchestrator",
      tab_id: "tab-orchestrator",
      workspace_id: "workspace-1",
      agent: "pi",
    },
    {
      pane_id: "pane-agent",
      tab_id: "tab-agent",
      workspace_id: "workspace-1",
      agent: "pi",
      agent_status: "idle",
      cwd: "/plain-cwd",
    },
  ];
  const tabs: TabInfo[] = [
    { tab_id: "tab-orchestrator", label: "Orchestrator" },
    { tab_id: "tab-agent", label: "Researcher" },
  ];
  const context: HerdrContext = {
    panes,
    currentPane: panes[0]!,
    currentTab: "tab-orchestrator",
    workspaceId: "workspace-1",
  };

  const [agent] = listCurrentWorkspaceAgents(context, tabs);
  assert.equal(agent?.cwd, "/plain-cwd");
});

test("sorts agents by tab label", () => {
  const panes: PaneInfo[] = [
    {
      pane_id: "pane-orchestrator",
      tab_id: "tab-orchestrator",
      workspace_id: "workspace-1",
      agent: "pi",
    },
    {
      pane_id: "pane-zebra",
      tab_id: "tab-zebra",
      workspace_id: "workspace-1",
      agent: "pi",
      agent_status: "idle",
    },
    {
      pane_id: "pane-apple",
      tab_id: "tab-apple",
      workspace_id: "workspace-1",
      agent: "pi",
      agent_status: "idle",
    },
  ];
  const tabs: TabInfo[] = [
    { tab_id: "tab-orchestrator", label: "Orchestrator" },
    { tab_id: "tab-zebra", label: "Zebra" },
    { tab_id: "tab-apple", label: "Apple" },
  ];
  const context: HerdrContext = {
    panes,
    currentPane: panes[0]!,
    currentTab: "tab-orchestrator",
    workspaceId: "workspace-1",
  };

  const labels = listCurrentWorkspaceAgents(context, tabs).map(
    (agent) => agent.tabLabel,
  );
  assert.deepEqual(labels, ["Apple", "Zebra"]);
});

test("skips panes with an agent but no matching tab", () => {
  const panes: PaneInfo[] = [
    {
      pane_id: "pane-orchestrator",
      tab_id: "tab-orchestrator",
      workspace_id: "workspace-1",
      agent: "pi",
    },
    {
      pane_id: "pane-orphan",
      tab_id: "tab-orphan",
      workspace_id: "workspace-1",
      agent: "pi",
      agent_status: "idle",
    },
  ];
  const tabs: TabInfo[] = [{ tab_id: "tab-orchestrator", label: "Orchestrator" }];
  const context: HerdrContext = {
    panes,
    currentPane: panes[0]!,
    currentTab: "tab-orchestrator",
    workspaceId: "workspace-1",
  };

  assert.deepEqual(listCurrentWorkspaceAgents(context, tabs), []);
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

  assert.equal(listManagedWorkspaceAgents(context, state)[0]?.paneId, "pane-starting");
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

  assert.deepEqual(
    buildEqualAgentSplitRatios(root, new Set(["agent"])),
    [],
  );
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
      agent: "pi",
    },
    {
      pane_id: "pane-worker",
      tab_id: "tab-worker",
      workspace_id: "workspace-1",
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

  assert.deepEqual(findReusableAgentTab(context, tabs, "Worker"), {
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

  assert.equal(findReusableAgentTab(context, tabs, "Worker"), undefined);
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

  assert.equal(findReusableAgentTab(context, tabs, "Worker"), undefined);
});

test("reusable tab lookup prefers a pi pane in a multi-pane tab", () => {
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
    },
    {
      pane_id: "pane-pi",
      tab_id: "tab-worker",
      workspace_id: "workspace-1",
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

  assert.equal(findReusableAgentTab(context, tabs, "Worker")?.pane, panes[2]);
});

test("reusable tab lookup matches exact base label, not numbered labels", () => {
  const panes: PaneInfo[] = [
    {
      pane_id: "pane-orchestrator",
      tab_id: "tab-orchestrator",
      workspace_id: "workspace-1",
      agent: "pi",
    },
    {
      pane_id: "pane-worker-2",
      tab_id: "tab-worker-2",
      workspace_id: "workspace-1",
      agent: "pi",
    },
    {
      pane_id: "pane-worker",
      tab_id: "tab-worker",
      workspace_id: "workspace-1",
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

  assert.equal(findReusableAgentTab(context, tabs, "Worker")?.tab, tabs[2]);
});
