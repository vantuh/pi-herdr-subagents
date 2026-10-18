import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { test } from 'vitest';

import type { HerdrAgentInfo } from '../src/herdr/types.ts';
import {
  attachAgentMetrics,
  formatContextLabel,
  formatCostLabel,
  formatTokenCount,
} from '../src/ui/agent-metrics.ts';
import { applyEnv } from '../test-support/mock-extension.ts';

/**
 * Metrics a managed child publishes: what the widget and the manager render,
 * and how one bad artifact is contained.
 */

function agent(overrides: Partial<HerdrAgentInfo> = {}): HerdrAgentInfo {
  return {
    tabId: 'w1:tA',
    tabLabel: 'Scout',
    paneId: 'w1:p1',
    agent: 'scout',
    status: 'working',
    ...overrides,
  };
}

test('formats absolute counts compactly', () => {
  assert.equal(formatTokenCount(0), '0');
  assert.equal(formatTokenCount(950), '950');
  assert.equal(formatTokenCount(38_000), '38k');
  assert.equal(formatTokenCount(200_000), '200k');
  assert.equal(formatTokenCount(1_048_576), '1M');
});

test('renders the context label with a known capacity, unknown tokens, or neither', () => {
  assert.equal(
    formatContextLabel({ tokens: 38_000, contextWindow: 200_000 }),
    'ctx 38k / 200k',
  );
  assert.equal(
    formatContextLabel({ tokens: null, contextWindow: 200_000 }),
    'ctx — / 200k',
  );
  assert.equal(formatContextLabel(undefined), 'ctx —');
});

test('renders a measured zero as zero, not as unknown', () => {
  assert.equal(
    formatContextLabel({ tokens: 0, contextWindow: 200_000 }),
    'ctx 0 / 200k',
  );
});

test('renders a session cost estimate, a measured zero and an unknown one', () => {
  assert.equal(formatCostLabel(0.024), '~$0.024');
  assert.equal(formatCostLabel(1.5), '~$1.500');
  assert.equal(formatCostLabel(0.0004), '<$0.001');
  assert.equal(formatCostLabel(0), '~$0.000');
  assert.equal(formatCostLabel(undefined), 'cost —');
});

test('reads each published sample once for the whole list', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'herdr-context-'));
  const restoreEnv = applyEnv({ TMPDIR: tmp });
  try {
    const withSample = await managedResultFile(tmp);
    await fs.writeFile(
      path.join(path.dirname(withSample), 'session.json'),
      `${JSON.stringify({
        sessionId: 'child-1',
        cwd: '/tmp/repo',
        context: { tokens: 4_000, contextWindow: 200_000 },
        sessionCost: 0.024,
      })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    const corrupt = await managedResultFile(tmp);
    await fs.writeFile(
      path.join(path.dirname(corrupt), 'session.json'),
      'not json\n',
      'utf8',
    );
    // An unreadable artifact is an isolated failure, not a missing file: the
    // session-channel file is a directory here, so the read throws.
    const unreadable = await managedResultFile(tmp);
    await fs.mkdir(path.join(path.dirname(unreadable), 'session.json'));

    const agents = [
      agent({ resultFile: withSample }),
      agent({ tabLabel: 'Reviewer', resultFile: corrupt }),
      agent({ tabLabel: 'Research', resultFile: unreadable }),
      agent({ tabLabel: 'Ad-hoc' }),
    ];
    await attachAgentMetrics(agents);

    assert.deepEqual(agents[0]?.context, {
      tokens: 4_000,
      contextWindow: 200_000,
    });
    assert.equal(agents[0]?.sessionCost, 0.024);
    assert.equal(agents[1]?.context, undefined);
    assert.equal(agents[1]?.sessionCost, undefined);
    assert.equal(agents[2]?.context, undefined);
    assert.equal(agents[2]?.sessionCost, undefined);
    assert.equal(agents[3]?.context, undefined);
    assert.equal(agents[3]?.sessionCost, undefined);
  } finally {
    restoreEnv();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

/** A managed artifact path: `readAgentSessionMeta` only accepts one of these. */
async function managedResultFile(tmp: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmp, 'herdr-agent-'));
  return path.join(dir, 'result.md');
}
