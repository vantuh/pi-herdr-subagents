import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { SelectItem } from '@earendil-works/pi-tui';

import { discoverAgents } from '../../agents.ts';
import { errorMessage } from '../../utils.ts';
import { AgentModelPicker, type PickerData } from './picker.ts';
import { setProfileModel } from './write.ts';

type Model = ExtensionCommandContext['scopedModels'][number]['model'];

function modelRef(model: Model): string {
  return `${model.provider}/${model.id}`;
}

async function buildData(ctx: ExtensionCommandContext): Promise<PickerData> {
  const agents = await discoverAgents(ctx.cwd);
  const scoped = ctx.scopedModels.map((entry) => entry.model);
  const scopedIds = new Set(scoped.map(modelRef));
  const available = ctx.modelRegistry
    .getAvailable()
    .filter((model) => !scopedIds.has(modelRef(model)))
    .sort((a, b) => modelRef(a).localeCompare(modelRef(b)));
  const toItem = (model: Model, isScoped: boolean): SelectItem => ({
    value: modelRef(model),
    label: modelRef(model),
    description: [
      isScoped ? 'scoped' : undefined,
      model.name,
      ctx.modelRegistry.hasConfiguredAuth(model) ? undefined : 'no auth',
    ]
      .filter(Boolean)
      .join(' · '),
  });
  const scopedModelItems = scoped.map((model) => toItem(model, true));
  return {
    agents,
    scopedModelItems,
    modelItems: [
      ...scopedModelItems,
      ...available.map((model) => toItem(model, false)),
    ],
  };
}

export async function showAgentModelPicker(
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (ctx.mode !== 'tui') {
    ctx.ui.notify('/agent-models requires TUI mode', 'error');
    return;
  }

  try {
    const data = await buildData(ctx);
    if (data.agents.length === 0) {
      ctx.ui.notify('No agent profiles found', 'warning');
      return;
    }
    await ctx.ui.custom<void>(
      (tui, theme, keybindings, done) =>
        new AgentModelPicker(
          tui,
          theme,
          keybindings,
          data,
          async ({ agent, model }) => {
            const error = await setProfileModel(agent.filePath, model);
            if (error) return `Failed to write ${agent.filePath}: ${error}`;
            return await buildData(ctx);
          },
          done,
        ),
      { overlay: true },
    );
  } catch (error) {
    ctx.ui.notify(
      `Failed to load agent models: ${errorMessage(error)}`,
      'error',
    );
  }
}
