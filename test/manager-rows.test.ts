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

/** The column of every ` • ` separator in a description. */
function separators(description: string | undefined): number[] {
  return [...(description ?? '').matchAll(/ • /g)].map(
    (match) => match.index ?? -1,
  );
}

test('a live row shows status, cost and current context', () => {
  const items = agentMenuItems(
    [
      agent({
        context: { tokens: 38_000, contextWindow: 200_000 },
        sessionCost: 0.024,
      }),
    ],
    [],
    paint,
  );

  assert.equal(items.length, 1);
  assert.equal(items[0]?.label, 'Scout (scout)');
  assert.equal(items[0]?.description, 'S(working) • ~$0.024 • ctx 38k / 200k');
});

test('keys a live row by its pane, not by its shared tab', () => {
  const items = agentMenuItems(
    [
      agent({ tabId: 'w1:t1', paneId: 'w1:p1', tabLabel: 'A' }),
      agent({ tabId: 'w1:t1', paneId: 'w1:p2', tabLabel: 'B' }),
    ],
    [closedRecord()],
    paint,
  );

  assert.deepEqual(
    items.map((item) => item.value),
    ['w1:p1', 'w1:p2', `closed:ch_1`],
  );
});

test('a live row without published metrics reads as unknown, not as zero', () => {
  const items = agentMenuItems([agent()], [], paint);

  assert.equal(items[0]?.description, 'S(working) • cost — • ctx —');
});

test('a measured zero cost stays zero in the row', () => {
  const items = agentMenuItems(
    [
      agent({
        context: { tokens: 0, contextWindow: 128_000 },
        sessionCost: 0,
      }),
    ],
    [],
    paint,
  );

  assert.equal(items[0]?.description, 'S(working) • ~$0.000 • ctx 0 / 128k');
});

test('pads the plain status so the separator aligns across statuses', () => {
  const items = agentMenuItems(
    [
      agent({ tabLabel: 'A', status: 'working', sessionCost: 0.024 }),
      agent({ paneId: 'w1:p2', tabLabel: 'B', status: 'idle' }),
      agent({ paneId: 'w1:p3', tabLabel: 'C', status: 'blocked' }),
      agent({ paneId: 'w1:p4', tabLabel: 'D', status: 'done' }),
    ],
    [closedRecord()],
    paint,
  );

  const columns = items.map((item) => separators(item.description)[0]);
  assert.equal(new Set(columns).size, 1, JSON.stringify(columns));
  // `working` is the widest status: the plain cell is the padded source.
  assert.equal(items[0]?.description, 'S(working) • ~$0.024 • ctx —');
  assert.equal(items[1]?.description, 'S(idle)    • cost —  • ctx —');
  assert.equal(
    items[4]?.description,
    `D(closed)  • cost —  • ${new Date('2026-08-27T12:00:00.000Z').toLocaleString()}`,
  );
});

test('widens the status column for a status longer than working', () => {
  const items = agentMenuItems(
    [
      agent({ paneId: 'w1:p1', status: 'starting' }),
      agent({ paneId: 'w1:p2', status: 'working' }),
    ],
    [closedRecord()],
    paint,
  );

  assert.equal(items[0]?.description, 'S(starting) • cost — • ctx —');
  assert.equal(items[1]?.description, 'S(working)  • cost — • ctx —');
  assert.equal(
    items[2]?.description,
    `D(closed)   • cost — • ${new Date('2026-08-27T12:00:00.000Z').toLocaleString()}`,
  );
  assert.equal(new Set(items.map((i) => separators(i.description)[0])).size, 1);
});

test('pads the cost cell so the context column aligns', () => {
  const items = agentMenuItems(
    [
      agent({
        paneId: 'w1:p1',
        context: { tokens: 38_000, contextWindow: 200_000 },
        sessionCost: 0.024,
      }),
      agent({
        paneId: 'w1:p2',
        context: { tokens: 5_000, contextWindow: 200_000 },
      }),
    ],
    [],
    paint,
  );

  assert.equal(items[0]?.description, 'S(working) • ~$0.024 • ctx 38k / 200k');
  assert.equal(items[1]?.description, 'S(working) • cost —  • ctx 5k / 200k');
  assert.deepEqual(
    separators(items[0]?.description),
    separators(items[1]?.description),
  );
});

test('a closed row keeps its status, frozen cost and date', () => {
  const items = agentMenuItems([], [closedRecord({ sessionCost: 0.5 })], paint);

  assert.equal(items[0]?.value, `closed:${closedRecord().id}`);
  assert.equal(items[0]?.label, 'Reviewer (reviewer)');
  assert.equal(
    items[0]?.description,
    `D(closed)  • ~$0.500 • ${new Date('2026-08-27T12:00:00.000Z').toLocaleString()}`,
  );
});

test('colors the status without padding inside the color', () => {
  const painted = agentMenuItems([agent({ status: 'idle' })], [], {
    status: (status) => `<${status}>`,
    dim: (text) => `<${text}>`,
  });

  assert.equal(painted[0]?.description, '<idle>    • cost — • ctx —');
});
