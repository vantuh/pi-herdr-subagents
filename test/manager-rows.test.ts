import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { HerdrAgentInfo } from '../src/herdr/types.ts';
import type { ClosedAgentHistoryRecord } from '../src/state/schema.ts';
import { agentMenuItems, type AgentMenuItemPaint } from '../src/ui/manager.ts';

/**
 * `/herdr-agents` rows: what each live and closed line actually shows.
 */

const paint: AgentMenuItemPaint = {
  status: (status) => `S(${status})`,
  dim: (text) => `D(${text})`,
};

function agent(overrides: Partial<HerdrAgentInfo> = {}): HerdrAgentInfo {
  return {
    tabId: 'w1:tA',
    tabLabel: 'Scout',
    paneId: 'w1:p1',
    agent: 'scout',
    status: 'working',
    cwd: '/Users/someone/repo',
    ...overrides,
  };
}

function closedRecord(
  overrides: Partial<ClosedAgentHistoryRecord> = {},
): ClosedAgentHistoryRecord {
  return {
    id: 'ch_1',
    ownerSessionId: 'orch-1',
    profileName: 'reviewer',
    tabLabel: 'Reviewer',
    childSessionFile: '/tmp/child.jsonl',
    childSessionId: 'child-1',
    cwd: '/Users/someone/repo',
    layout: 'tab',
    lifecycle: 'oneshot',
    createdAt: '2026-08-27T11:00:00.000Z',
    closedAt: '2026-08-27T12:00:00.000Z',
    status: 'resumable',
    claimGeneration: 1,
    ...overrides,
  };
}

test('a live row shows status and current context instead of pane and cwd', () => {
  const items = agentMenuItems(
    [agent({ context: { tokens: 38_000, contextWindow: 200_000 } })],
    [],
    paint,
  );

  assert.equal(items.length, 1);
  assert.equal(items[0]?.label, 'Scout (scout)');
  assert.equal(items[0]?.description, 'status:S(working) • ctx 38k / 200k');
});

test('a live row without a published sample reads as unknown, not as zero', () => {
  const items = agentMenuItems([agent()], [], paint);

  assert.equal(items[0]?.description, 'status:S(working) • ctx —');
});

test('a closed row keeps its status and date without a cwd or context', () => {
  const items = agentMenuItems([], [closedRecord()], paint);

  assert.equal(items[0]?.value, `closed:${closedRecord().id}`);
  assert.equal(items[0]?.label, 'Reviewer (reviewer)');
  assert.equal(
    items[0]?.description,
    `D(closed) • ${new Date('2026-08-27T12:00:00.000Z').toLocaleString()}`,
  );
});
