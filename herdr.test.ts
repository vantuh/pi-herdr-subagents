import assert from "node:assert/strict";
import test from "node:test";
import {
  findReusableAgentTab,
  listCurrentWorkspaceAgents,
  observeAgentWaitState,
} from "./herdr.ts";
import type { AgentWaitState } from "./herdr.ts";
import type { HerdrContext, PaneInfo, TabInfo } from "./types.ts";

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
