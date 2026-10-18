import assert from 'node:assert/strict';

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  Theme,
} from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import { afterEach, test, vi } from 'vitest';

import type { HerdrAgentInfo } from '../src/herdr/types.ts';
import type { ClosedAgentHistoryRecord } from '../src/state/schema.ts';
import {
  AgentManagerOverlay,
  type ManagerListing,
  type ManagerLoader,
  pickAgentAction,
} from '../src/ui/manager.ts';

/**
 * The open `/herdr-agents` modal: it keeps watching Herdr and state, keeps the
 * selected row across rebuilds, and stops touching the screen and the state
 * lock once it closes or the session shuts down.
 */

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

/** Every overlay a test creates, disposed after the test. */
const created: AgentManagerOverlay[] = [];
afterEach(async () => {
  for (const overlay of created.splice(0)) {
    overlay.dispose();
    await overlay.settled();
  }
});

function agent(overrides: Partial<HerdrAgentInfo> = {}): HerdrAgentInfo {
  return {
    tabId: 'w1:tA',
    tabLabel: 'Scout A',
    paneId: 'w1:p1',
    agent: 'scout',
    status: 'working',
    ...overrides,
  };
}

/** Pane-layout siblings: one tab, one pane each, so only the pane is unique. */
function sameTabAgents(): HerdrAgentInfo[] {
  return [
    agent({ tabId: 'w1:t1', paneId: 'w1:p1', tabLabel: 'Scout A' }),
    agent({ tabId: 'w1:t1', paneId: 'w1:p2', tabLabel: 'Scout B' }),
  ];
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
    cwd: '/tmp/repo',
    layout: 'tab',
    lifecycle: 'oneshot',
    createdAt: '2026-08-27T11:00:00.000Z',
    closedAt: '2026-08-27T12:00:00.000Z',
    status: 'resumable',
    claimGeneration: 1,
    ...overrides,
  };
}

function fakeTui(): { tui: TUI; renders: () => number } {
  let renders = 0;
  return {
    tui: { requestRender: () => renders++ } as unknown as TUI,
    renders: () => renders,
  };
}

function overlayFor(
  listing: ManagerListing,
  load: ManagerLoader,
  selections: Array<{ action: 'focus' | 'close'; value: string } | null> = [],
): {
  overlay: AgentManagerOverlay;
  lines: (width?: number) => string;
  renders: () => number;
} {
  const { tui, renders } = fakeTui();
  const overlay = new AgentManagerOverlay(tui, theme, listing, load, (result) =>
    selections.push(result),
  );
  created.push(overlay);
  return {
    overlay,
    lines: (width = 120) => overlay.render(width).join('\n'),
    renders,
  };
}

test('an open manager shows an agent that appeared while it stayed open', async () => {
  const listing: ManagerListing = { agents: [agent()], closed: [] };
  const next: ManagerListing = {
    agents: [
      agent(),
      agent({
        paneId: 'w1:p2',
        tabLabel: 'Scout B',
        context: { tokens: 8_000, contextWindow: 200_000 },
        sessionCost: 0.25,
      }),
    ],
    closed: [closedRecord()],
  };
  const { overlay, lines } = overlayFor(listing, async () => next);
  assert.doesNotMatch(lines(), /Scout B/);

  await overlay.refresh();

  assert.equal(overlay.snapshot.agents.length, 2);
  assert.match(lines(), /Scout B \(scout\).*~\$0\.250 • ctx 8k \/ 200k/);
  assert.match(lines(), /Reviewer \(reviewer\)/);
});

test('an open manager shows changed context and cost for an existing row', async () => {
  const listing: ManagerListing = {
    agents: [
      agent({
        context: { tokens: 1_000, contextWindow: 200_000 },
        sessionCost: 0.001,
      }),
    ],
    closed: [],
  };
  const { overlay, lines } = overlayFor(listing, async () => ({
    agents: [
      agent({
        context: { tokens: 38_000, contextWindow: 200_000 },
        sessionCost: 0.024,
      }),
    ],
    closed: [],
  }));
  assert.match(lines(), /~\$0\.001 • ctx 1k \/ 200k/);

  await overlay.refresh();

  assert.match(lines(), /~\$0\.024 • ctx 38k \/ 200k/);
  assert.doesNotMatch(lines(), /ctx 1k \/ 200k/);
});

test('keeps the selected same-tab sibling across a refresh', async () => {
  const selections: Array<{ action: 'focus' | 'close'; value: string } | null> =
    [];
  const { overlay } = overlayFor(
    { agents: sameTabAgents(), closed: [] },
    async () => ({
      agents: sameTabAgents(),
      closed: [closedRecord()],
    }),
    selections,
  );
  overlay.handleInput('\x1b[B');
  await overlay.refresh();

  overlay.handleInput('\r');

  assert.deepEqual(selections, [{ action: 'focus', value: 'w1:p2' }]);
});

test('closes the selected same-tab sibling, not the first row', async () => {
  const selections: Array<{ action: 'focus' | 'close'; value: string } | null> =
    [];
  const { overlay } = overlayFor(
    { agents: sameTabAgents(), closed: [] },
    async () => ({ agents: sameTabAgents(), closed: [] }),
    selections,
  );
  overlay.handleInput('\x1b[B');
  await overlay.refresh();

  overlay.handleInput('d');

  assert.deepEqual(selections, [{ action: 'close', value: 'w1:p2' }]);
});

test('falls back to the first row when the selected row vanished', async () => {
  const selections: Array<{ action: 'focus' | 'close'; value: string } | null> =
    [];
  const { overlay } = overlayFor(
    { agents: sameTabAgents(), closed: [] },
    async () => ({ agents: [agent()], closed: [] }),
    selections,
  );
  overlay.handleInput('\x1b[B');
  await overlay.refresh();

  overlay.handleInput('\r');

  assert.deepEqual(selections, [{ action: 'focus', value: 'w1:p1' }]);
});

test('an empty listing shows an empty state and keeps watching', async () => {
  let next: ManagerListing = { agents: [], closed: [] };
  const { overlay, lines } = overlayFor(
    { agents: [agent()], closed: [] },
    async () => next,
  );

  await overlay.refresh();

  assert.match(lines(), /No managed Herdr agents\. Watching for new ones/);
  assert.doesNotMatch(lines(), /No matching commands/);

  next = {
    agents: [agent({ paneId: 'w1:p2', tabLabel: 'Scout B' })],
    closed: [],
  };
  await overlay.refresh();

  assert.match(lines(), /Scout B \(scout\)/);
  assert.doesNotMatch(lines(), /Watching for new ones/);
});

test('starts on the empty state when nothing is listed yet', () => {
  const { lines } = overlayFor({ agents: [], closed: [] }, async () => ({
    agents: [],
    closed: [],
  }));

  assert.match(lines(), /No managed Herdr agents\. Watching for new ones/);
  assert.doesNotMatch(lines(), /No matching commands/);
});

test('keeps the cost visible at a common overlay width', () => {
  const { lines } = overlayFor(
    {
      agents: [
        agent({
          tabLabel: 'release-audit-specialist',
          sessionCost: 0.024,
          context: { tokens: 38_000, contextWindow: 200_000 },
        }),
      ],
      closed: [closedRecord({ sessionCost: 1.23 })],
    },
    async () => ({ agents: [], closed: [] }),
  );

  const rendered = lines(84);
  assert.match(rendered, /release-audit-specialist \(scout\)/);
  assert.match(rendered, /~\$0\.024 • ctx 38k \/ 200k/);
  assert.match(rendered, /~\$1\.230 • /);
});

test('a failed refresh keeps the current rows', async () => {
  const { overlay, lines } = overlayFor(
    { agents: [agent()], closed: [] },
    async () => {
      throw new Error('herdr snapshot failed');
    },
  );
  const before = lines();

  await overlay.refresh();

  assert.equal(lines(), before);
  assert.equal(overlay.snapshot.agents.length, 1);
});

test('a tick that lands while a refresh is in flight is dropped', async () => {
  let loadCalls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { overlay } = overlayFor(
    { agents: [agent()], closed: [] },
    async () => {
      loadCalls++;
      await gate;
      return { agents: [agent()], closed: [] };
    },
  );

  const first = overlay.refresh();
  const second = overlay.refresh();
  assert.equal(loadCalls, 1);
  release?.();
  await Promise.all([first, second]);
  assert.equal(loadCalls, 1);
});

test('refreshes on its own interval and stops after dispose', async () => {
  vi.useFakeTimers();
  try {
    let loadCalls = 0;
    const { overlay, lines, renders } = overlayFor(
      { agents: [agent()], closed: [] },
      async () => {
        loadCalls++;
        return { agents: [agent({ sessionCost: 0.024 })], closed: [] };
      },
    );

    await vi.advanceTimersByTimeAsync(1_000);
    assert.equal(loadCalls, 1);
    assert.match(lines(), /~\$0\.024/);

    overlay.dispose();
    const rendersAfterClose = renders();
    await vi.advanceTimersByTimeAsync(3_000);
    assert.equal(loadCalls, 1);
    assert.equal(renders(), rendersAfterClose);
  } finally {
    vi.useRealTimers();
  }
});

test('a refresh that lands after close writes nothing', async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { overlay, lines, renders } = overlayFor(
    { agents: [agent()], closed: [] },
    async (signal) => {
      await gate;
      signal?.throwIfAborted();
      return {
        agents: [agent({ sessionCost: 0.5 })],
        closed: [closedRecord()],
      };
    },
  );
  const before = lines();
  const rendersBefore = renders();

  const pending = overlay.refresh();
  overlay.dispose();
  release?.();
  await pending;

  assert.equal(lines(), before);
  assert.equal(overlay.snapshot.agents.length, 1);
  assert.equal(renders(), rendersBefore);
});

test('enter while a refresh is pending keeps the selection and drops the update', async () => {
  const selections: Array<{ action: 'focus' | 'close'; value: string } | null> =
    [];
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { overlay, lines, renders } = overlayFor(
    { agents: sameTabAgents(), closed: [] },
    async (signal) => {
      await gate;
      signal?.throwIfAborted();
      return {
        agents: [agent({ paneId: 'w1:p9', tabLabel: 'Scout Z' })],
        closed: [],
      };
    },
    selections,
  );
  overlay.handleInput('\x1b[B');
  const before = lines();

  const pending = overlay.refresh();
  overlay.handleInput('\r');
  const rendersAfterClose = renders();
  release?.();
  await pending;

  assert.deepEqual(selections, [{ action: 'focus', value: 'w1:p2' }]);
  assert.equal(lines(), before);
  assert.equal(overlay.snapshot.agents.length, 2);
  assert.equal(renders(), rendersAfterClose);
});

test('escape while a refresh is pending cancels without applying the update', async () => {
  const selections: Array<{ action: 'focus' | 'close'; value: string } | null> =
    [];
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { overlay, lines } = overlayFor(
    { agents: sameTabAgents(), closed: [] },
    async (signal) => {
      await gate;
      signal?.throwIfAborted();
      return { agents: [], closed: [closedRecord()] };
    },
    selections,
  );
  const before = lines();

  const pending = overlay.refresh();
  overlay.handleInput('\x1b');
  release?.();
  await pending;

  assert.deepEqual(selections, [null]);
  assert.equal(lines(), before);
  assert.equal(overlay.snapshot.closed.length, 0);
});

test('a selected action resolves against agents that appeared while open', async () => {
  let overlay: AgentManagerOverlay | undefined;
  let finish: ((value: unknown) => void) | undefined;
  const shutdownHandlers: Array<() => void> = [];
  const pi = {
    on: (_event: string, handler: () => void) => {
      shutdownHandlers.push(handler);
      return () => {
        shutdownHandlers.splice(shutdownHandlers.indexOf(handler), 1);
      };
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: 'tui',
    ui: {
      custom: (factory: (...args: unknown[]) => AgentManagerOverlay) =>
        new Promise((resolve) => {
          finish = resolve;
          overlay = factory(fakeTui().tui, theme, {}, resolve);
          if (overlay) created.push(overlay);
        }),
    },
  } as unknown as ExtensionCommandContext;
  const listing: ManagerListing = { agents: [agent()], closed: [] };
  const next: ManagerListing = {
    agents: [agent(), agent({ paneId: 'w1:p2', tabLabel: 'Scout B' })],
    closed: [],
  };

  const pending = pickAgentAction(pi, ctx, listing, async () => next);
  assert.equal(shutdownHandlers.length, 1);

  await overlay?.refresh();
  finish?.({ action: 'focus', value: 'w1:p2' });
  const selected = await pending;

  assert.equal(selected?.action, 'focus');
  assert.equal(
    selected?.action === 'focus' ? selected.agent.paneId : undefined,
    'w1:p2',
  );
  // The shutdown subscription is scoped to the open modal.
  assert.deepEqual(shutdownHandlers, []);
});

test('session_shutdown drains the refresh and settles the open modal', async () => {
  let component: AgentManagerOverlay | undefined;
  let customResolved = false;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const signals: Array<AbortSignal | undefined> = [];
  const shutdownHandlers: Array<() => Promise<void> | void> = [];
  const { tui, renders } = fakeTui();
  const pi = {
    on: (_event: string, handler: () => Promise<void> | void) => {
      shutdownHandlers.push(handler);
      return () => {
        shutdownHandlers.splice(shutdownHandlers.indexOf(handler), 1);
      };
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: 'tui',
    ui: {
      custom: (factory: (...args: unknown[]) => AgentManagerOverlay) =>
        new Promise((resolve) => {
          const settle = (value?: unknown) => {
            customResolved = true;
            resolve(value ?? null);
          };
          component = factory(tui, theme, {}, settle);
          if (component) created.push(component);
        }),
    },
  } as unknown as ExtensionCommandContext;
  const load: ManagerLoader = async (signal) => {
    signals.push(signal);
    await gate;
    signal?.throwIfAborted();
    return { agents: sameTabAgents(), closed: [] };
  };

  let commandResolved = false;
  const command = pickAgentAction(
    pi,
    ctx,
    { agents: [agent()], closed: [] },
    load,
  );
  void command.then(() => {
    commandResolved = true;
  });

  const refreshing = component?.refresh();
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.aborted, false);

  const shutdown = shutdownHandlers[0]?.();

  // The abort reaches the loader, the modal settles without the test resolving
  // it, and the listing that arrives after the abort never reaches the rows.
  assert.equal(signals[0]?.aborted, true);
  assert.equal(customResolved, true);
  assert.equal(commandResolved, false);

  const rendersAfterShutdown = renders();
  release?.();
  await shutdown;
  await refreshing;
  await command;

  assert.equal(commandResolved, true);
  assert.equal(component?.snapshot.agents.length, 1);
  assert.equal(renders(), rendersAfterShutdown);
  assert.deepEqual(shutdownHandlers, []);
});
