import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  findReusableAgentPane,
  findReusableAgentTab,
  listManagedWorkspaceAgents,
} from '../src/herdr/placement.ts';
import type { PaneInfo, TabInfo } from '../src/herdr/schema.ts';
import type { HerdrContext } from '../src/herdr/types.ts';
import { emptyHerdrAgentsState } from '../src/state/store.ts';

/**
 * Managed pane ownership: listing, reuse by exact label, and handoff-safe
 * matching.
 */

test('does not list or reuse historical persistent panes in any layout', () => {
  for (const layout of ['pane', 'tab', 'workspace'] as const) {
    const currentPane: PaneInfo = {
      pane_id: 'orch',
      terminal_id: 'orch-terminal',
      workspace_id: 'workspace',
      tab_id: 'orch-tab',
      agent: 'pi',
    };
    const legacyPane: PaneInfo = {
      pane_id: 'legacy',
      terminal_id: 'legacy-terminal',
      workspace_id: layout === 'workspace' ? 'agents-workspace' : 'workspace',
      tab_id: layout === 'pane' ? 'orch-tab' : 'legacy-tab',
      agent: 'pi',
    };
    const context: HerdrContext = {
      currentPane,
      panes: [currentPane, legacyPane],
      workspaceId: 'workspace',
      currentTab: 'orch-tab',
    };
    const state = emptyHerdrAgentsState();
    state.agents['terminal:legacy-terminal'] = {
      lifecycle: 'persistent',
      layout,
      tabLabel: 'Legacy',
      ownerTerminalId: 'orch-terminal',
      detached: true,
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const before = structuredClone(state);
    assert.equal(findReusableAgentPane(context, state, 'Legacy'), undefined);
    assert.equal(findReusableAgentTab(context, [], 'Legacy', state), undefined);
    assert.deepEqual(listManagedWorkspaceAgents(context, state), []);
    assert.deepEqual(state, before);
  }
});

test('finds a reusable managed pane by exact label in the orchestrator tab', () => {
  const panes: PaneInfo[] = [
    {
      pane_id: 'pane-orchestrator',
      tab_id: 'tab-orchestrator',
      workspace_id: 'workspace-1',
      terminal_id: 'term-orchestrator',
      agent: 'pi',
    },
    {
      pane_id: 'pane-worker',
      tab_id: 'tab-orchestrator',
      workspace_id: 'workspace-1',
      terminal_id: 'term-worker',
      agent: 'pi',
      agent_status: 'idle',
    },
  ];
  const context: HerdrContext = {
    panes,
    currentPane: panes[0]!,
    currentTab: 'tab-orchestrator',
    workspaceId: 'workspace-1',
  };
  const state = emptyHerdrAgentsState();
  state.agents['terminal:term-worker'] = {
    lifecycle: 'oneshot',
    layout: 'pane',
    tabLabel: 'Worker',
    agent: 'worker',
    automationName: 'worker_ab12cd34',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  assert.equal(findReusableAgentPane(context, state, 'Worker'), panes[1]);
  assert.deepEqual(listManagedWorkspaceAgents(context, state), [
    {
      tabId: 'tab-orchestrator',
      tabLabel: 'Worker',
      paneId: 'pane-worker',
      agent: 'worker',
      automationName: 'worker_ab12cd34',
      status: 'idle',
      lifecycle: 'oneshot',
      layout: 'pane',
      cwd: undefined,
      updatedAt: '2026-01-01T00:00:00.000Z',
      terminalId: 'term-worker',
    },
  ]);
});

test('lists a newly created managed pane before Pi agent detection', () => {
  const panes: PaneInfo[] = [
    {
      pane_id: 'pane-orchestrator',
      tab_id: 'tab-orchestrator',
      workspace_id: 'workspace-1',
      terminal_id: 'term-orchestrator',
      agent: 'pi',
    },
    {
      pane_id: 'pane-starting',
      tab_id: 'tab-orchestrator',
      workspace_id: 'workspace-1',
      terminal_id: 'term-starting',
    },
  ];
  const context: HerdrContext = {
    panes,
    currentPane: panes[0]!,
    currentTab: 'tab-orchestrator',
    workspaceId: 'workspace-1',
  };
  const state = emptyHerdrAgentsState();
  state.agents['terminal:term-starting'] = {
    lifecycle: 'oneshot',
    layout: 'pane',
    tabLabel: 'Scout',
    agent: 'scout',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  assert.equal(
    listManagedWorkspaceAgents(context, state)[0]?.paneId,
    'pane-starting',
  );
});

test('reuses a legacy same-tab pane record without a layout field', () => {
  const panes: PaneInfo[] = [
    {
      pane_id: 'pane-orchestrator',
      tab_id: 'tab-orchestrator',
      workspace_id: 'workspace-1',
      terminal_id: 'term-orchestrator',
      agent: 'pi',
    },
    {
      pane_id: 'pane-worker',
      tab_id: 'tab-orchestrator',
      workspace_id: 'workspace-1',
      terminal_id: 'term-worker',
      agent: 'pi',
    },
  ];
  const context: HerdrContext = {
    panes,
    currentPane: panes[0]!,
    currentTab: 'tab-orchestrator',
    workspaceId: 'workspace-1',
  };
  const state = emptyHerdrAgentsState();
  state.agents['terminal:term-worker'] = {
    lifecycle: 'oneshot',
    tabLabel: 'Worker',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  assert.equal(findReusableAgentPane(context, state, 'Worker'), panes[1]);
});

test('does not reuse an unmanaged or cross-tab pane', () => {
  const panes: PaneInfo[] = [
    {
      pane_id: 'pane-orchestrator',
      tab_id: 'tab-orchestrator',
      workspace_id: 'workspace-1',
      terminal_id: 'term-orchestrator',
      agent: 'pi',
    },
    {
      pane_id: 'pane-unmanaged',
      tab_id: 'tab-orchestrator',
      workspace_id: 'workspace-1',
      terminal_id: 'term-unmanaged',
      agent: 'pi',
    },
    {
      pane_id: 'pane-other-tab',
      tab_id: 'tab-other',
      workspace_id: 'workspace-1',
      terminal_id: 'term-other',
      agent: 'pi',
    },
  ];
  const context: HerdrContext = {
    panes,
    currentPane: panes[0]!,
    currentTab: 'tab-orchestrator',
    workspaceId: 'workspace-1',
  };
  const state = emptyHerdrAgentsState();
  state.agents['terminal:term-other'] = {
    lifecycle: 'oneshot',
    layout: 'pane',
    tabLabel: 'Worker',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  assert.equal(findReusableAgentPane(context, state, 'Worker'), undefined);
});

test("does not list or reuse another orchestrator's agents", () => {
  const panes: PaneInfo[] = [
    {
      pane_id: 'pane-orch-a',
      tab_id: 'tab-a',
      workspace_id: 'workspace-1',
      terminal_id: 'term-orch-a',
      agent: 'pi',
    },
    {
      pane_id: 'pane-orch-b',
      tab_id: 'tab-b',
      workspace_id: 'workspace-1',
      terminal_id: 'term-orch-b',
      agent: 'pi',
    },
    {
      pane_id: 'pane-scout-a',
      tab_id: 'tab-a',
      workspace_id: 'workspace-1',
      terminal_id: 'term-scout-a',
      agent: 'pi',
      agent_status: 'working',
    },
    {
      pane_id: 'pane-scout-b',
      tab_id: 'tab-scout-b',
      workspace_id: 'workspace-1',
      terminal_id: 'term-scout-b',
      agent: 'pi',
      agent_status: 'idle',
    },
  ];
  const tabs: TabInfo[] = [
    { tab_id: 'tab-a', label: 'Orchestrator' },
    { tab_id: 'tab-b', label: 'Orchestrator' },
    { tab_id: 'tab-scout-b', label: 'Scout' },
  ];
  const state = emptyHerdrAgentsState();
  state.agents['terminal:term-scout-a'] = {
    lifecycle: 'oneshot',
    layout: 'pane',
    tabLabel: 'Scout',
    agent: 'scout',
    ownerTerminalId: 'term-orch-a',
    detached: true,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  state.agents['terminal:term-scout-b'] = {
    lifecycle: 'oneshot',
    layout: 'tab',
    tabLabel: 'Scout',
    agent: 'scout',
    ownerTerminalId: 'term-orch-b',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  const orchA: HerdrContext = {
    panes,
    currentPane: panes[0]!,
    currentTab: 'tab-a',
    workspaceId: 'workspace-1',
  };
  const orchB: HerdrContext = {
    panes,
    currentPane: panes[1]!,
    currentTab: 'tab-b',
    workspaceId: 'workspace-1',
  };

  assert.deepEqual(
    listManagedWorkspaceAgents(orchA, state).map((agent) => agent.paneId),
    ['pane-scout-a'],
  );
  assert.deepEqual(
    listManagedWorkspaceAgents(orchB, state).map((agent) => agent.paneId),
    ['pane-scout-b'],
  );
  assert.equal(findReusableAgentPane(orchB, state, 'Scout'), undefined);
  assert.equal(findReusableAgentTab(orchA, tabs, 'Scout', state), undefined);
  assert.equal(
    findReusableAgentTab(orchB, tabs, 'Scout', state)?.pane,
    panes[3],
  );
});
