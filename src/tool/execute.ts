import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionToolContext,
} from '@earendil-works/pi-coding-agent';

import { discoverAgents } from '../agents.ts';
import { getHerdrAgentsLayout } from '../config.ts';
import type { HerdrAgentsConfig } from '../config/schema.ts';
import { titleCase } from '../utils.ts';
import { orchestratorIdentity } from './child-args.ts';
import { textResult } from './result.ts';
import type { HerdrAgentParams } from './schema.ts';
import { runAgentTask } from './spawn/flow.ts';
import { executeAgentStatus } from './status.ts';

export async function executeHerdrAgent(
  pi: ExtensionAPI,
  params: HerdrAgentParams,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<Record<string, unknown>> | undefined,
  ctx: ExtensionToolContext,
  configPromise: Promise<HerdrAgentsConfig>,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const agents = await discoverAgents(ctx.cwd);
  const agent = agents.find((item) => item.name === params.agent);
  if (!agent) {
    // Profiles marked disable-model-invocation stay spawnable by exact
    // name, but they are not offered as options to the Orchestrator.
    const listable = agents.filter((item) => !item.disableModelInvocation);
    const available = listable.map((item) => item.name).join(', ') || 'none';
    return textResult(
      `Unknown Herdr agent: ${params.agent}. Available: ${available}`,
      { availableAgents: listable },
      true,
    );
  }

  if (ctx.mode !== 'tui') {
    return textResult(
      'herdr_agent requires TUI mode. Non-TUI sessions have no widget poller to deliver the result.',
      {},
      true,
    );
  }

  const config = await configPromise;
  const layout = getHerdrAgentsLayout(config);
  const baseLabel = params.tabLabel?.trim() || titleCase(agent.name);
  const resumeClosed = params.resumeClosed === true;
  const owner = orchestratorIdentity(ctx);

  if (resumeClosed) {
    if (!params.task?.trim()) {
      return textResult(
        'resumeClosed requires a non-empty task. Omit resumeClosed and task to check the status of a still-running agent.',
        { resumeClosed: true },
        true,
      );
    }
    if (!params.tabLabel?.trim()) {
      return textResult(
        'resumeClosed requires an explicit non-empty tabLabel.',
        { resumeClosed: true },
        true,
      );
    }
  }

  if (!params.task?.trim()) {
    // Status check: no new task. Looks up the live agent and returns its
    // status plus a preview of its latest captured assistant text. It never
    // prompts, claims, collects, or closes.
    // Omitting task never resurrects a closed agent.
    return await executeAgentStatus({
      agent,
      tabLabel: params.tabLabel,
      baseLabel,
      layout,
      config,
      ownerSessionId: owner.ownerSessionId,
      signal,
    });
  }

  const task = params.task;
  return await runAgentTask(
    { pi, params, task, signal, onUpdate, ctx },
    { agent, config, layout, baseLabel, resumeClosed, owner },
  );
}
