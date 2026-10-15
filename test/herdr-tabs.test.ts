import assert from 'node:assert/strict';

import { test } from 'vitest';

import { findReusableAgentTab } from '../src/herdr/placement.ts';
import type { PaneInfo, TabInfo } from '../src/herdr/schema.ts';
import type { HerdrContext } from '../src/herdr/types.ts';
import { emptyHerdrAgentsState } from '../src/state/store.ts';

/**
 * Reusable agent tabs: exact-label lookup, ownership, and record-driven
 * synthesis.
 */

test('finds a reusable agent tab by exact label', () => {
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
      tab_id: 'tab-worker',
      workspace_id: 'workspace-1',
      terminal_id: 'term-worker',
      agent: 'pi',
      agent_status: 'idle',
    },
  ];
  const tabs: TabInfo[] = [
    { tab_id: 'tab-orchestrator', label: 'Orchestrator' },
    { tab_id: 'tab-worker', label: 'Worker' },
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
    layout: 'tab',
    tabLabel: 'Worker',
    ownerTerminalId: 'term-orchestrator',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  assert.deepEqual(findReusableAgentTab(context, tabs, 'Worker', state), {
    tab: tabs[1],
    pane: panes[1],
  });

  tabs[1]!.label = 'pi';
  assert.equal(
    findReusableAgentTab(context, tabs, 'Worker', state)?.pane,
    panes[1],
  );
  assert.equal(findReusableAgentTab(context, tabs, 'pi', state), undefined);
});

test('does not reuse the orchestrator tab', () => {
  const panes: PaneInfo[] = [
    {
      pane_id: 'pane-orchestrator',
      tab_id: 'tab-orchestrator',
      workspace_id: 'workspace-1',
      agent: 'pi',
    },
  ];
  const tabs: TabInfo[] = [{ tab_id: 'tab-orchestrator', label: 'Worker' }];
  const context: HerdrContext = {
    panes,
    currentPane: panes[0]!,
    currentTab: 'tab-orchestrator',
    workspaceId: 'workspace-1',
  };

  assert.equal(
    findReusableAgentTab(context, tabs, 'Worker', emptyHerdrAgentsState()),
    undefined,
  );
});

test('does not reuse a tab without a pi pane', () => {
  const panes: PaneInfo[] = [
    {
      pane_id: 'pane-orchestrator',
      tab_id: 'tab-orchestrator',
      workspace_id: 'workspace-1',
      agent: 'pi',
    },
    {
      pane_id: 'pane-shell',
      tab_id: 'tab-worker',
      workspace_id: 'workspace-1',
      agent: 'shell',
      agent_status: 'idle',
    },
  ];
  const tabs: TabInfo[] = [
    { tab_id: 'tab-orchestrator', label: 'Orchestrator' },
    { tab_id: 'tab-worker', label: 'Worker' },
  ];
  const context: HerdrContext = {
    panes,
    currentPane: panes[0]!,
    currentTab: 'tab-orchestrator',
    workspaceId: 'workspace-1',
  };

  assert.equal(
    findReusableAgentTab(context, tabs, 'Worker', emptyHerdrAgentsState()),
    undefined,
  );
});

test('reusable tab lookup prefers a pi pane in a multi-pane tab', () => {
  const panes: PaneInfo[] = [
    {
      pane_id: 'pane-orchestrator',
      tab_id: 'tab-orchestrator',
      workspace_id: 'workspace-1',
      terminal_id: 'term-orchestrator',
      agent: 'pi',
    },
    {
      pane_id: 'pane-shell',
      tab_id: 'tab-worker',
      workspace_id: 'workspace-1',
      agent: 'shell',
    },
    {
      pane_id: 'pane-pi',
      tab_id: 'tab-worker',
      workspace_id: 'workspace-1',
      terminal_id: 'term-pi',
      agent: 'pi',
    },
  ];
  const tabs: TabInfo[] = [
    { tab_id: 'tab-orchestrator', label: 'Orchestrator' },
    { tab_id: 'tab-worker', label: 'Worker' },
  ];
  const context: HerdrContext = {
    panes,
    currentPane: panes[0]!,
    currentTab: 'tab-orchestrator',
    workspaceId: 'workspace-1',
  };
  const state = emptyHerdrAgentsState();
  state.agents['terminal:term-pi'] = {
    lifecycle: 'oneshot',
    layout: 'tab',
    tabLabel: 'Worker',
    ownerTerminalId: 'term-orchestrator',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  assert.equal(
    findReusableAgentTab(context, tabs, 'Worker', state)?.pane,
    panes[2],
  );
});

test('reusable tab lookup matches exact base label, not numbered labels', () => {
  const panes: PaneInfo[] = [
    {
      pane_id: 'pane-orchestrator',
      tab_id: 'tab-orchestrator',
      workspace_id: 'workspace-1',
      terminal_id: 'term-orchestrator',
      agent: 'pi',
    },
    {
      pane_id: 'pane-worker-2',
      tab_id: 'tab-worker-2',
      workspace_id: 'workspace-1',
      terminal_id: 'term-worker-2',
      agent: 'pi',
    },
    {
      pane_id: 'pane-worker',
      tab_id: 'tab-worker',
      workspace_id: 'workspace-1',
      terminal_id: 'term-worker',
      agent: 'pi',
    },
  ];
  const tabs: TabInfo[] = [
    { tab_id: 'tab-orchestrator', label: 'Orchestrator' },
    { tab_id: 'tab-worker-2', label: 'Worker #2' },
    { tab_id: 'tab-worker', label: 'Worker' },
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
    layout: 'tab',
    tabLabel: 'Worker',
    ownerTerminalId: 'term-orchestrator',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  state.agents['terminal:term-worker-2'] = {
    lifecycle: 'oneshot',
    layout: 'tab',
    tabLabel: 'Worker #2',
    ownerTerminalId: 'term-orchestrator',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  assert.equal(
    findReusableAgentTab(context, tabs, 'Worker', state)?.tab,
    tabs[2],
  );
});

test('record-driven reuse synthesizes the tab when it is not in the listed tabs', () => {
  // A managed record whose tab exists in another workspace (or predates the
  // current listTabs scope) still resolves reuse from the record, with the
  // recorded label standing in for the missing TabInfo.
  const orchA: HerdrContext = {
    panes: [
      {
        pane_id: 'pane-orch',
        tab_id: 'tab-orch',
        workspace_id: 'w1',
        terminal_id: 'term-orch',
        agent: 'pi',
      },
      {
        pane_id: 'pane-scout',
        tab_id: 'tab-scout',
        workspace_id: 'w2',
        terminal_id: 'term-scout',
        agent: 'pi',
        agent_status: 'idle',
      },
    ],
    currentPane: {
      pane_id: 'pane-orch',
      tab_id: 'tab-orch',
      workspace_id: 'w1',
      terminal_id: 'term-orch',
      agent: 'pi',
    },
    workspaceId: 'w1',
    currentTab: 'tab-orch',
  };
  const state = emptyHerdrAgentsState();
  state.agents['terminal:term-scout'] = {
    lifecycle: 'oneshot',
    layout: 'workspace',
    tabLabel: 'Scout',
    agent: 'scout',
    ownerTerminalId: 'term-orch',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  const reused = findReusableAgentTab(orchA, [], 'Scout', state);
  assert.ok(reused, 'expected a record-driven reuse');
  assert.equal(reused.pane.pane_id, 'pane-scout');
  assert.deepEqual(reused.tab, {
    tab_id: 'tab-scout',
    label: 'Scout',
  });

  // A foreign owner must not adopt it.
  state.agents['terminal:term-scout'].ownerTerminalId = 'term-someone-else';
  assert.equal(findReusableAgentTab(orchA, [], 'Scout', state), undefined);
});
