import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type Theme,
} from '@earendil-works/pi-coding-agent';
import {
  Container,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  Text,
  type TUI,
} from '@earendil-works/pi-tui';

import { readAgentQuestion } from '../artifacts.ts';
import { getHerdrAgentsLayout } from '../config.ts';
import type { HerdrAgentLayout, HerdrAgentsConfig } from '../config/schema.ts';
import { isSettledAgentStatus } from '../herdr/agent.ts';
import { execHerdr } from '../herdr/cli.ts';
import { listManagedWorkspaceAgents } from '../herdr/placement.ts';
import { loadContextWithState } from '../herdr/snapshot.ts';
import type { HerdrAgentInfo } from '../herdr/types.ts';
import { listOwnedResumableHistory } from '../state/closed-history.ts';
import type { ClosedAgentHistoryRecord } from '../state/schema.ts';
import { orchestratorIdentity } from '../tool/child-args.ts';
import { closeOneShot } from '../tool/one-shot.ts';
import { openClosedAgent } from '../tool/spawn/flow.ts';
import {
  attachAgentMetrics,
  formatContextLabel,
  formatCostLabel,
} from './agent-metrics.ts';

const MANAGER_REFRESH_MS = 1000;
/** Narrowest status cell; a longer status widens the shared column instead. */
const STATUS_COLUMN_MIN_WIDTH = 7;
const CLOSED_PREFIX = 'closed:';

type AgentMenuAction =
  | { action: 'focus' | 'close'; agent: HerdrAgentInfo }
  | { action: 'open'; record: ClosedAgentHistoryRecord };

export interface ManagerListing {
  agents: HerdrAgentInfo[];
  closed: ClosedAgentHistoryRecord[];
}

export type ManagerLoader = (signal?: AbortSignal) => Promise<ManagerListing>;

export interface AgentMenuItemPaint {
  status(status: string): string;
  dim(text: string): string;
}

interface MenuRow {
  item: SelectItem;
  status: string;
  paint: (text: string) => string;
  cost: string;
  detail: string;
}

function padCell(painted: string, plain: string, width: number): string {
  return `${painted}${' '.repeat(Math.max(0, width - plain.length))}`;
}

export function agentMenuItems(
  agents: HerdrAgentInfo[],
  closed: ClosedAgentHistoryRecord[],
  paint: AgentMenuItemPaint,
): SelectItem[] {
  const rows: MenuRow[] = agents.map((agent) => ({
    item: {
      // Pane-layout agents share the Orchestrator's tab, so the pane is the
      // only stable unique identity for a live row.
      value: agent.paneId,
      label: `${agent.tabLabel} (${agent.agent})`,
    },
    status: agent.status,
    paint: paint.status,
    cost: formatCostLabel(agent.sessionCost),
    detail: formatContextLabel(agent.context),
  }));
  for (const record of closed) {
    rows.push({
      item: {
        value: `${CLOSED_PREFIX}${record.id}`,
        label: `${record.tabLabel} (${record.profileName})`,
      },
      status: 'closed',
      paint: paint.dim,
      cost: formatCostLabel(record.sessionCost),
      detail: new Date(record.closedAt).toLocaleString(),
    });
  }

  const statusWidth = Math.max(
    STATUS_COLUMN_MIN_WIDTH,
    ...rows.map((row) => row.status.length),
  );
  const costWidth = Math.max(0, ...rows.map((row) => row.cost.length));

  return rows.map((row) => ({
    ...row.item,
    description: [
      padCell(row.paint(row.status), row.status, statusWidth),
      // Cost before context and date: a long label plus the context label would
      // otherwise push the price past the overlay's common widths.
      padCell(row.cost, row.cost, costWidth),
      row.detail,
    ].join(' • '),
  }));
}

// SelectList has no item mutator; rebuild it while retaining the selected pane or history record.
export class AgentManagerOverlay extends Container {
  private readonly paint: AgentMenuItemPaint;
  private readonly emptyText: Text;
  private readonly controller = new AbortController();
  private list: SelectList;
  private listIndex: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private refreshInFlight: Promise<void> | undefined;
  private closed = false;
  private listing: ManagerListing;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    listing: ManagerListing,
    private readonly load: ManagerLoader,
    private readonly done: (
      result: { action: 'focus' | 'close'; value: string } | null,
    ) => void,
  ) {
    super();
    this.listing = listing;
    this.paint = {
      status: (status) => {
        if (status === 'working') return theme.fg('accent', status);
        if (status === 'blocked') return theme.fg('warning', status);
        if (status === 'done' || status === 'idle') {
          return theme.fg('success', status);
        }
        return theme.fg('dim', status);
      },
      dim: (text) => theme.fg('dim', text),
    };

    this.addChild(new DynamicBorder((str: string) => theme.fg('accent', str)));
    this.addChild(
      new Text(theme.fg('accent', theme.bold('Herdr Agents')), 1, 0),
    );
    this.emptyText = new Text(
      theme.fg('dim', 'No managed Herdr agents. Watching for new ones…'),
      1,
      0,
    );
    const items = this.rows(listing);
    this.list = this.buildList(items);
    this.listIndex = this.children.length;
    this.addChild(items.length > 0 ? this.list : this.emptyText);
    this.addChild(
      new Text(
        theme.fg(
          'dim',
          '↑↓ navigate • enter focus/open • d/ctrl+d close • esc close',
        ),
        1,
        0,
      ),
    );
    this.addChild(new DynamicBorder((str: string) => theme.fg('accent', str)));

    this.timer = setInterval(() => {
      void this.refresh();
    }, MANAGER_REFRESH_MS);
    this.timer.unref?.();
  }

  get snapshot(): ManagerListing {
    return this.listing;
  }

  /** Cancels an open interaction without replacing an already completed selection. */
  dispose(): void {
    if (!this.stop()) return;
    this.done(null);
  }

  // Shutdown must wait for the refresh to release any state lock.
  settled(): Promise<void> {
    return this.refreshInFlight ?? Promise.resolve();
  }

  /** Skips overlapping ticks and retains the current rows when loading fails. */
  async refresh(): Promise<void> {
    if (this.closed || this.refreshInFlight) return;
    this.refreshInFlight = this.runRefresh().finally(() => {
      this.refreshInFlight = undefined;
    });
    await this.refreshInFlight;
  }

  private async runRefresh(): Promise<void> {
    let next: ManagerListing;
    try {
      next = await this.load(this.controller.signal);
    } catch {
      return;
    }
    // A refresh that lands after the interaction ended, or after shutdown
    // aborted it, must not write rows.
    if (this.closed) return;
    this.listing = next;

    const selected = this.list.getSelectedItem()?.value;
    const items = this.rows(next);
    const list = this.buildList(items);
    const index = items.findIndex((item) => item.value === selected);
    // A row that vanished (closed agent) must not leave a stale index.
    list.setSelectedIndex(index >= 0 ? index : 0);
    this.list = list;
    // With no rows left the modal keeps watching, so it shows an empty state
    // instead of the list's own "no match" line.
    this.children.splice(
      this.listIndex,
      1,
      items.length > 0 ? list : this.emptyText,
    );
    this.invalidate();
    this.tui.requestRender();
  }

  private rows(listing: ManagerListing): SelectItem[] {
    return agentMenuItems(listing.agents, listing.closed, this.paint);
  }

  private buildList(items: SelectItem[]): SelectList {
    const list = new SelectList(
      items,
      Math.min(Math.max(items.length, 1), 12),
      {
        selectedPrefix: (text) => this.theme.fg('accent', text),
        selectedText: (text) => this.theme.fg('accent', text),
        description: (text) => this.theme.fg('muted', text),
        scrollInfo: (text) => this.theme.fg('dim', text),
        noMatch: (text) => this.theme.fg('warning', text),
      },
      // Grow the name column to the longest label instead of the 32-column
      // default, which clipped labels with a profile suffix.
      { minPrimaryColumnWidth: 32, maxPrimaryColumnWidth: 48 },
    );
    list.onSelect = (item) =>
      this.finish({ action: 'focus', value: item.value });
    list.onCancel = () => this.finish(null);
    return list;
  }

  private stop(): boolean {
    if (this.closed) return false;
    this.closed = true;
    this.controller.abort();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    return true;
  }

  private finish(
    result: { action: 'focus' | 'close'; value: string } | null,
  ): void {
    if (!this.stop()) return;
    this.done(result);
  }

  handleInput(data: string): void {
    if (this.closed) return;
    if (data === 'd' || matchesKey(data, Key.ctrl('d'))) {
      const selected = this.list.getSelectedItem();
      if (selected && !selected.value.startsWith(CLOSED_PREFIX)) {
        this.finish({ action: 'close', value: selected.value });
      }
      return;
    }

    this.list.handleInput(data);
    this.tui.requestRender();
  }
}

export async function pickAgentAction(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  listing: ManagerListing,
  load: ManagerLoader,
): Promise<AgentMenuAction | undefined> {
  let overlay: AgentManagerOverlay | undefined;
  // Shutdown stops the tick, closes the modal, and waits for a refresh that
  // already holds the state lock so the lock directory is never left behind.
  const unsubscribe = pi.on('session_shutdown', async () => {
    overlay?.dispose();
    await overlay?.settled();
  });

  let result: { action: 'focus' | 'close'; value: string } | null;
  try {
    result = await ctx.ui.custom<{
      action: 'focus' | 'close';
      value: string;
    } | null>(
      (tui, theme, _kb, done) => {
        overlay = new AgentManagerOverlay(tui, theme, listing, load, done);
        return overlay;
      },
      {
        overlay: true,
        overlayOptions: { width: '70%', minWidth: 60, maxHeight: '80%' },
      },
    );
  } finally {
    unsubscribe();
    overlay?.dispose();
    await overlay?.settled();
  }

  if (!result) return undefined;
  // The overlay may have refreshed while it stayed open, so resolve against
  // the listing it showed last, not the one captured before it opened.
  const latest = overlay?.snapshot ?? listing;

  if (result.value.startsWith(CLOSED_PREFIX)) {
    const id = result.value.slice(CLOSED_PREFIX.length);
    const record = latest.closed.find((item) => item.id === id);
    return record ? { action: 'open', record } : undefined;
  }

  const agent = latest.agents.find((item) => item.paneId === result.value);
  if (!agent) return undefined;

  return { action: result.action, agent };
}

async function focusAgent(
  layout: HerdrAgentLayout | undefined,
  paneId: string,
  tabId: string,
): Promise<void> {
  await execHerdr(
    layout === 'pane'
      ? ['agent', 'focus', paneId]
      : // Tab ids are workspace-qualified, so this reaches Agents-workspace
        // agents too and makes Herdr switch to that workspace.
        ['tab', 'focus', tabId],
  );
}

export async function showHerdrAgentsManager(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  configPromise: Promise<HerdrAgentsConfig>,
): Promise<void> {
  if (ctx.mode !== 'tui') {
    ctx.ui.notify('/herdr-agents requires TUI mode', 'error');
    return;
  }
  const { ownerSessionId } = orchestratorIdentity(ctx);

  const load: ManagerLoader = async (signal) => {
    const { context, state } = await loadContextWithState(signal);
    const agents = listManagedWorkspaceAgents(context, state);
    await attachAgentMetrics(agents);
    return {
      agents,
      closed: ownerSessionId
        ? listOwnedResumableHistory(state, ownerSessionId)
        : [],
    };
  };

  // The overlay opens even with nothing to list: it keeps watching, so an
  // agent spawned in parallel appears without reopening the command.
  while (true) {
    const listing = await load();
    const selected = await pickAgentAction(pi, ctx, listing, load);
    if (!selected) return;

    if (selected.action === 'open') {
      const config = await configPromise;
      const opened = await openClosedAgent(pi, ctx, config, selected.record);
      const text = opened.content.find((part) => part.type === 'text');
      if (opened.isError) {
        ctx.ui.notify(
          `Could not open Herdr agent "${selected.record.tabLabel}": ${text?.type === 'text' ? text.text : 'unknown error'}`,
          'error',
        );
        continue;
      }
      const { paneId, tabId } = opened.details as {
        paneId: string;
        tabId: string;
      };
      await focusAgent(getHerdrAgentsLayout(config), paneId, tabId);
      ctx.ui.notify(`Opened Herdr agent "${selected.record.tabLabel}"`, 'info');
      return;
    }

    if (selected.action === 'focus') {
      await focusAgent(
        selected.agent.layout,
        selected.agent.paneId,
        selected.agent.tabId,
      );
      ctx.ui.notify(`Focused Herdr agent "${selected.agent.tabLabel}"`, 'info');
      return;
    }

    const question = await readAgentQuestion(selected.agent.resultFile);
    const settled = isSettledAgentStatus(selected.agent.status);
    if (!settled || question) {
      ctx.ui.notify(
        `Cannot close "${selected.agent.tabLabel}": it is still running or waiting on a question. Answer it or wait for it to finish so history can be saved.`,
        'warning',
      );
      continue;
    }
    const closeError = await closeOneShot({
      layout: selected.agent.layout,
      tabId: selected.agent.tabId,
      paneId: selected.agent.paneId,
      resultFile: selected.agent.resultFile,
      lifecyclePane: selected.agent.terminalId
        ? { terminal_id: selected.agent.terminalId }
        : undefined,
    });
    if (closeError) {
      ctx.ui.notify(
        `Could not close Herdr agent "${selected.agent.tabLabel}": ${closeError}`,
        'error',
      );
      continue;
    }
    ctx.ui.notify(`Closed Herdr agent "${selected.agent.tabLabel}"`, 'info');
  }
}
