import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionToolContext,
} from '@earendil-works/pi-coding-agent';

import { discoverAgents } from '../agents.ts';
import type { AgentProfile } from '../agents/types.ts';
import { readAgentQuestion } from '../artifacts.ts';
import { getHerdrAgentsLayout } from '../config.ts';
import type { HerdrAgentsConfig } from '../config/schema.ts';
import {
  findUnresolvedOwnedAgent,
  listManagedWorkspaceAgents,
} from '../herdr/placement.ts';
import { loadContextWithState } from '../herdr/snapshot.ts';
import { findOwnedClosedHistory } from '../state/closed-history.ts';
import { bestEffort, titleCase } from '../utils.ts';
import { orchestratorIdentity } from './child-args.ts';
import { controlLiveAgent } from './control.ts';
import { textResult } from './result.ts';
import type {
  AgentSendParams,
  AgentSpawnParams,
  AgentStatusParams,
} from './schema.ts';
import { runAgentTask } from './spawn/flow.ts';
import { executeAgentStatus, unresolvedOwnedAgentResult } from './status.ts';

type ToolResult = AgentToolResult<Record<string, unknown>>;

function unknownProfileResult(
  agents: readonly AgentProfile[],
  name: string,
): ToolResult {
  // Hidden (disable-model-invocation) profiles stay spawnable by exact name.
  const listable = agents.filter((item) => !item.disableModelInvocation);
  const available = listable.map((item) => item.name).join(', ') || 'none';
  return textResult(
    `Unknown agent profile: ${name}. Available: ${available}`,
    { availableAgents: listable },
    true,
  );
}

function requiresTuiResult(tool: string): ToolResult {
  return textResult(
    `${tool} requires TUI mode. Non-TUI sessions have no widget poller to deliver the result.`,
    {},
    true,
  );
}

export async function executeAgentSpawn(
  pi: ExtensionAPI,
  params: AgentSpawnParams,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<Record<string, unknown>> | undefined,
  ctx: ExtensionToolContext,
  configPromise: Promise<HerdrAgentsConfig>,
): Promise<ToolResult> {
  const requestedName = params.agent?.trim();
  if (!requestedName) return textResult('agent is required.', {}, true);
  if (!params.task?.trim()) return textResult('task is required.', {}, true);

  const agents = await discoverAgents(ctx.cwd);
  const agent = agents.find((item) => item.name === requestedName);
  // Checked before the TUI gate, so an unknown profile is reported outside TUI too.
  if (!agent) return unknownProfileResult(agents, requestedName);
  if (ctx.mode !== 'tui') return requiresTuiResult('agent_spawn');

  const config = await configPromise;
  const name = params.name?.trim();
  return await runAgentTask(
    { pi, task: params.task, signal, onUpdate, ctx },
    {
      agent,
      config,
      layout: getHerdrAgentsLayout(config),
      baseLabel: name || titleCase(agent.name),
      mode: 'spawn',
      explicitName: !!name,
      owner: orchestratorIdentity(ctx),
    },
  );
}

/**
 * Dispatches by the named agent's state: a live agent with a parked question
 * takes the message as its answer, any other live agent gets it as a steer,
 * and a closed one-shot of this session resumes with it as the new task. The
 * profile of a closed agent comes from its stored history record.
 */
export async function executeAgentSend(
  pi: ExtensionAPI,
  params: AgentSendParams,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<Record<string, unknown>> | undefined,
  ctx: ExtensionToolContext,
  configPromise: Promise<HerdrAgentsConfig>,
): Promise<ToolResult> {
  const name = params.name?.trim() ?? '';
  const message = params.message?.trim() ?? '';
  if (!name) return textResult('name is required.', {}, true);
  if (!message) return textResult('message is required.', { name }, true);
  if (ctx.mode !== 'tui') return requiresTuiResult('agent_send');

  const owner = orchestratorIdentity(ctx);
  const { context, state } = await loadContextWithState(signal);
  const live = listManagedWorkspaceAgents(context, state).find(
    (item) => item.tabLabel === name,
  );
  const closed =
    !live && owner.ownerSessionId
      ? findOwnedClosedHistory(state, owner.ownerSessionId, name)
      : undefined;
  const profileName = live ? live.agent : closed?.profileName;
  if (!profileName) {
    const unresolved = findUnresolvedOwnedAgent(
      context,
      state,
      name,
      owner.ownerSessionId,
    );
    if (unresolved) return unresolvedOwnedAgentResult(unresolved);
    return textResult(
      `No agent named "${name}" found for this session. Use agent_spawn to start one.`,
      { name },
      true,
    );
  }

  const answeringQuestion =
    !!live &&
    (await bestEffort(undefined, () => readAgentQuestion(live.resultFile))) !==
      undefined;
  if (live && !answeringQuestion) {
    return await controlLiveAgent(live, 'steer', message, signal, ctx);
  }

  const agents = await discoverAgents(ctx.cwd);
  const agent = agents.find((item) => item.name === profileName);
  if (!agent) return unknownProfileResult(agents, profileName);

  const config = await configPromise;
  return await runAgentTask(
    { pi, task: params.message, signal, onUpdate, ctx },
    {
      agent,
      config,
      layout: getHerdrAgentsLayout(config),
      baseLabel: name,
      mode: live ? 'answer' : 'resume',
      explicitName: true,
      owner,
    },
  );
}

export async function executeAgentStatusCall(
  params: AgentStatusParams,
  signal: AbortSignal | undefined,
  ctx: ExtensionToolContext,
  configPromise: Promise<HerdrAgentsConfig>,
): Promise<ToolResult> {
  if (ctx.mode !== 'tui') return requiresTuiResult('agent_status');

  const name = params.name?.trim();
  const { context, state } = await loadContextWithState(signal);
  const live = listManagedWorkspaceAgents(context, state);
  const ownerSessionId = orchestratorIdentity(ctx).ownerSessionId;

  if (!name) {
    const owned = live.filter(
      (item) => !!ownerSessionId && item.ownerSessionId === ownerSessionId,
    );
    const lines = owned.map(
      (item) => `${item.tabLabel} (${item.agent}): ${item.status}`,
    );
    return textResult(
      owned.length > 0
        ? `Live agents owned by this session:\n${lines.join('\n')}`
        : 'No live agents are owned by this session.',
      {
        agents: owned.map((item) => ({
          name: item.tabLabel,
          agent: item.agent,
          status: item.status,
        })),
      },
    );
  }

  const profileName = live.find((item) => item.tabLabel === name)?.agent;
  if (!profileName) {
    const unresolved = findUnresolvedOwnedAgent(
      context,
      state,
      name,
      ownerSessionId,
    );
    if (unresolved) return unresolvedOwnedAgentResult(unresolved);
    return textResult(
      `No running agent named "${name}" found for this session.`,
      { name },
      true,
    );
  }
  const agents = await discoverAgents(ctx.cwd);
  const agent = agents.find((item) => item.name === profileName);
  if (!agent) return unknownProfileResult(agents, profileName);

  const config = await configPromise;
  return await executeAgentStatus({
    agent,
    name,
    layout: getHerdrAgentsLayout(config),
    config,
    ownerSessionId,
    signal,
  });
}
