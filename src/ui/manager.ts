import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import {
  Container,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  Text,
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
import { attachAgentContext, formatContextLabel } from './agent-context.ts';

async function showNoAgentsDialog(ctx: ExtensionCommandContext): Promise<void> {
  await ctx.ui.custom<void>(
    (_tui, theme, _kb, done) => {
      const container = new Container();
      container.addChild(
        new DynamicBorder((str: string) => theme.fg('accent', str)),
      );
      container.addChild(
        new Text(theme.fg('accent', theme.bold('Herdr Agents')), 1, 0),
      );
      container.addChild(new Text('No managed Herdr agents.', 1, 0));
      container.addChild(new Text(theme.fg('dim', 'enter/esc close'), 1, 0));
      container.addChild(
        new DynamicBorder((str: string) => theme.fg('accent', str)),
      );

      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: () => done(),
      };
    },
    { overlay: true, overlayOptions: { width: 58, maxHeight: 8 } },
  );
}

type AgentMenuAction =
  | { action: 'focus' | 'close'; agent: HerdrAgentInfo }
  | { action: 'open'; record: ClosedAgentHistoryRecord };

const CLOSED_PREFIX = 'closed:';

export interface AgentMenuItemPaint {
  status(status: string): string;
  dim(text: string): string;
}

export function agentMenuItems(
  agents: HerdrAgentInfo[],
  closed: ClosedAgentHistoryRecord[],
  paint: AgentMenuItemPaint,
): SelectItem[] {
  const items: SelectItem[] = agents.map((agent) => ({
    value: agent.tabId,
    label: `${agent.tabLabel} (${agent.agent})`,
    description: [
      paint.status(agent.status),
      formatContextLabel(agent.context),
    ].join(' • '),
  }));
  for (const record of closed) {
    items.push({
      value: `${CLOSED_PREFIX}${record.id}`,
      label: `${record.tabLabel} (${record.profileName})`,
      description: [
        paint.dim('closed'),
        new Date(record.closedAt).toLocaleString(),
      ].join(' • '),
    });
  }
  return items;
}

async function pickAgentAction(
  ctx: ExtensionCommandContext,
  agents: HerdrAgentInfo[],
  closed: ClosedAgentHistoryRecord[],
): Promise<AgentMenuAction | undefined> {
  const result = await ctx.ui.custom<{
    action: 'focus' | 'close';
    value: string;
  } | null>(
    (tui, theme, _kb, done) => {
      const paint: AgentMenuItemPaint = {
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

      const items = agentMenuItems(agents, closed, paint);

      const container = new Container();
      container.addChild(
        new DynamicBorder((str: string) => theme.fg('accent', str)),
      );
      container.addChild(
        new Text(theme.fg('accent', theme.bold('Herdr Agents')), 1, 0),
      );

      const selectList = new SelectList(
        items,
        Math.min(items.length, 12),
        {
          selectedPrefix: (text) => theme.fg('accent', text),
          selectedText: (text) => theme.fg('accent', text),
          description: (text) => theme.fg('muted', text),
          scrollInfo: (text) => theme.fg('dim', text),
          noMatch: (text) => theme.fg('warning', text),
        },
        // Grow the name column to the longest label instead of the 32-column
        // default, which clipped labels with a profile suffix.
        { minPrimaryColumnWidth: 32, maxPrimaryColumnWidth: 48 },
      );
      selectList.onSelect = (item) =>
        done({ action: 'focus', value: item.value });
      selectList.onCancel = () => done(null);

      container.addChild(selectList);
      container.addChild(
        new Text(
          theme.fg(
            'dim',
            '↑↓ navigate • enter focus/open • d/ctrl+d close • esc close',
          ),
          1,
          0,
        ),
      );
      container.addChild(
        new DynamicBorder((str: string) => theme.fg('accent', str)),
      );

      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          if (data === 'd' || matchesKey(data, Key.ctrl('d'))) {
            const selected = selectList.getSelectedItem();
            if (selected && !selected.value.startsWith(CLOSED_PREFIX)) {
              done({ action: 'close', value: selected.value });
            }
            return;
          }

          selectList.handleInput(data);
          tui.requestRender();
        },
      };
    },
    {
      overlay: true,
      overlayOptions: { width: '70%', minWidth: 60, maxHeight: '80%' },
    },
  );

  if (!result) return undefined;

  if (result.value.startsWith(CLOSED_PREFIX)) {
    const id = result.value.slice(CLOSED_PREFIX.length);
    const record = closed.find((item) => item.id === id);
    return record ? { action: 'open', record } : undefined;
  }

  const agent = agents.find((agent) => agent.tabId === result.value);
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

  while (true) {
    const { context, state } = await loadContextWithState();
    const agents = listManagedWorkspaceAgents(context, state);
    await attachAgentContext(agents);
    const closed = ownerSessionId
      ? listOwnedResumableHistory(state, ownerSessionId)
      : [];
    if (agents.length === 0 && closed.length === 0) {
      await showNoAgentsDialog(ctx);
      return;
    }

    const selected = await pickAgentAction(ctx, agents, closed);
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
