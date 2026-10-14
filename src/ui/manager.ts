import {
  DynamicBorder,
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
import { isSettledAgentStatus } from '../herdr/agent.ts';
import { execHerdr } from '../herdr/cli.ts';
import { closeOneShot } from '../tool/one-shot.ts';
import type { HerdrAgentInfo } from '../types.ts';
import { loadCurrentAgents } from './poller.ts';

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

interface AgentMenuAction {
  action: 'focus' | 'close';
  agent: HerdrAgentInfo;
}

async function pickAgentAction(
  ctx: ExtensionCommandContext,
  agents: HerdrAgentInfo[],
): Promise<AgentMenuAction | undefined> {
  const result = await ctx.ui.custom<{
    action: 'focus' | 'close';
    tabId: string;
  } | null>(
    (tui, theme, _kb, done) => {
      const colorStatus = (status: string) => {
        if (status === 'working') return theme.fg('accent', status);
        if (status === 'blocked') return theme.fg('warning', status);
        if (status === 'done') return theme.fg('success', status);
        if (status === 'idle') return theme.fg('success', status);
        return theme.fg('dim', status);
      };

      const items: SelectItem[] = agents.map((agent) => ({
        value: agent.tabId,
        label: `${agent.tabLabel} (${agent.agent})`,
        description: [
          `status:${colorStatus(agent.status)}`,
          `pane:${agent.paneId}`,
          agent.cwd,
        ]
          .filter(Boolean)
          .join(' • '),
      }));

      const container = new Container();
      container.addChild(
        new DynamicBorder((str: string) => theme.fg('accent', str)),
      );
      container.addChild(
        new Text(theme.fg('accent', theme.bold('Herdr Agents')), 1, 0),
      );

      const selectList = new SelectList(items, Math.min(items.length, 12), {
        selectedPrefix: (text) => theme.fg('accent', text),
        selectedText: (text) => theme.fg('accent', text),
        description: (text) => theme.fg('muted', text),
        scrollInfo: (text) => theme.fg('dim', text),
        noMatch: (text) => theme.fg('warning', text),
      });
      selectList.onSelect = (item) =>
        done({ action: 'focus', tabId: item.value });
      selectList.onCancel = () => done(null);

      container.addChild(selectList);
      container.addChild(
        new Text(
          theme.fg(
            'dim',
            '↑↓ navigate • enter focus • d/ctrl+d close • esc close',
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
            if (selected) done({ action: 'close', tabId: selected.value });
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

  const agent = agents.find((agent) => agent.tabId === result.tabId);
  if (!agent) return undefined;

  return { action: result.action, agent };
}

export async function showHerdrAgentsManager(
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (ctx.mode !== 'tui') {
    ctx.ui.notify('/herdr-agents requires TUI mode', 'error');
    return;
  }

  while (true) {
    const agents = await loadCurrentAgents();
    if (agents.length === 0) {
      await showNoAgentsDialog(ctx);
      return;
    }

    const selected = await pickAgentAction(ctx, agents);
    if (!selected) return;

    if (selected.action === 'focus') {
      await execHerdr(
        selected.agent.layout === 'pane'
          ? ['agent', 'focus', selected.agent.paneId]
          : // Tab ids are workspace-qualified, so this reaches Agents-workspace
            // agents too and makes Herdr switch to that workspace.
            ['tab', 'focus', selected.agent.tabId],
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
