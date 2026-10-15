import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { PaneInfo } from '../src/herdr/schema.ts';
import type { ClosedAgentHistoryRecord } from '../src/state/schema.ts';

export function pane(overrides: Partial<PaneInfo> = {}): PaneInfo {
  return {
    pane_id: 'pane-1',
    tab_id: 'tab-1',
    workspace_id: 'workspace-1',
    terminal_id: 'term-1',
    ...overrides,
  };
}

export function history(
  overrides: Partial<ClosedAgentHistoryRecord> = {},
): ClosedAgentHistoryRecord {
  return {
    id: overrides.id ?? `ch_${Math.random().toString(16).slice(2)}`,
    ownerSessionId: 'orch-a',
    profileName: 'scout',
    tabLabel: 'Scout Resume',
    childSessionFile: '/tmp/child.jsonl',
    childSessionId: 'child-1',
    cwd: '/tmp/repo',
    layout: 'pane',
    lifecycle: 'oneshot',
    createdAt: '2026-01-01T00:00:00.000Z',
    closedAt: new Date().toISOString(),
    status: 'resumable',
    claimGeneration: 0,
    ...overrides,
  };
}

/**
 * Per-test state files: each directory is removed by the file's single teardown,
 * so nothing accumulates in the temp root run after run.
 */
export function createTempStateFixture(): {
  tempDir(): Promise<string>;
  tempStatePath(): Promise<string>;
  cleanup(): Promise<void>;
} {
  const dirs: string[] = [];
  const tempDir = async (): Promise<string> => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'herdr-agents-state-test-'),
    );
    dirs.push(dir);
    return dir;
  };
  return {
    tempDir,
    tempStatePath: async () => path.join(await tempDir(), 'state.json'),
    cleanup: async () => {
      for (const dir of dirs) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  };
}
