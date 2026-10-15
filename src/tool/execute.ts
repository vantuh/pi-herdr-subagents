import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionToolContext,
} from '@earendil-works/pi-coding-agent';

import { discoverAgents } from '../agents.ts';
import type { AgentProfile } from '../agents/types.ts';
import { getHerdrAgentsLayout } from '../config.ts';
import type { HerdrAgentsConfig } from '../config/schema.ts';
import { listManagedWorkspaceAgents } from '../herdr/placement.ts';
import { loadContextWithState } from '../herdr/snapshot.ts';
import { findOwnedClosedHistory } from '../state/closed-history.ts';
import { titleCase } from '../utils.ts';
import { orchestratorIdentity } from './child-args.ts';
import { textResult } from './result.ts';
import type { HerdrAgentParams } from './schema.ts';
import { runAgentTask } from './spawn/flow.ts';
import { executeAgentStatus } from './status.ts';

function unknownProfileResult(
  agents: readonly AgentProfile[],
  name: string,
): AgentToolResult<Record<string, unknown>> {
  // Hidden (disable-model-invocation) profiles stay spawnable by exact name.
  const listable = agents.filter((item) => !item.disableModelInvocation);
  const available = listable.map((item) => item.name).join(', ') || 'none';
  return textResult(
    `Unknown Herdr agent: ${name}. Available: ${available}`,
    { availableAgents: listable },
    true,
  );
}

/**
 * A call without `agent` addresses an existing agent through its label, so the
 * profile name comes from the record this Orchestrator session owns.
 */
async function resolveProfileNameByLabel(
  label: string,
  resumeClosed: boolean,
  ownerSessionId: string | undefined,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const { context, state } = await loadContextWithState(signal);
  const live = listManagedWorkspaceAgents(context, state).find(
    (item) => item.tabLabel === label,
  );
  if (live) return live.agent;
  if (!resumeClosed || !ownerSessionId) return undefined;
  return findOwnedClosedHistory(state, ownerSessionId, label)?.profileName;
}

export async function executeHerdrAgent(
  pi: ExtensionAPI,
  params: HerdrAgentParams,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<Record<string, unknown>> | undefined,
  ctx: ExtensionToolContext,
  configPromise: Promise<HerdrAgentsConfig>,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const agents = await discoverAgents(ctx.cwd);
  const requestedName = params.agent?.trim();
  const tabLabel = params.tabLabel?.trim();
  const resumeClosed = params.resumeClosed === true;
  const owner = orchestratorIdentity(ctx);

  const named = requestedName
    ? agents.find((item) => item.name === requestedName)
    : undefined;
  // Checked before the TUI gate, so an unknown name is reported outside TUI too.
  if (requestedName && !named) {
    return unknownProfileResult(agents, requestedName);
  }

  if (ctx.mode !== 'tui') {
    return textResult(
      'herdr_agent requires TUI mode. Non-TUI sessions have no widget poller to deliver the result.',
      {},
      true,
    );
  }

  const profileName =
    requestedName ??
    (tabLabel
      ? await resolveProfileNameByLabel(
          tabLabel,
          resumeClosed,
          owner.ownerSessionId,
          signal,
        )
      : undefined);
  if (!profileName) {
    return textResult(
      tabLabel
        ? `No agent labeled "${tabLabel}" found for this session. Pass agent to start a new one.`
        : 'agent is required to start a new agent; tabLabel is required to address an existing one.',
      {},
      true,
    );
  }
  const agent = named ?? agents.find((item) => item.name === profileName);
  if (!agent) {
    return unknownProfileResult(agents, profileName);
  }

  const config = await configPromise;
  const layout = getHerdrAgentsLayout(config);
  const baseLabel = tabLabel || titleCase(agent.name);

  if (resumeClosed) {
    if (!params.task?.trim()) {
      return textResult(
        'resumeClosed requires a non-empty task. Omit resumeClosed and task to check the status of a still-running agent.',
        { resumeClosed: true },
        true,
      );
    }
    if (!tabLabel) {
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
      tabLabel,
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
