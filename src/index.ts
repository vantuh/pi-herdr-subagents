import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { AutocompleteItem } from '@earendil-works/pi-tui';

import { discoverAgents } from './agents.ts';
import { registerChildMode } from './child.ts';
import { loadHerdrAgentsConfig } from './config.ts';
import { buildRunTurnInstructions, GLOBAL_INSTRUCTIONS } from './prompts.ts';
import { herdrAgentReportsDir, pruneExpiredReports } from './reports.ts';
import {
  formatRunUserMessage,
  parseRunArgs,
  type RunDelegationRequest,
} from './run.ts';
import { executeAgentStop } from './tool/control.ts';
import {
  executeAgentSend,
  executeAgentSpawn,
  executeAgentStatusCall,
} from './tool/execute.ts';
import {
  buildAgentSendParams,
  buildAgentSpawnParams,
  buildAgentStatusParams,
  buildAgentStopParams,
  describeAgentProfiles,
} from './tool/schema.ts';
import { showAgentModelPicker } from './ui/agent-models/command.ts';
import { showHerdrAgentsManager } from './ui/manager.ts';
import {
  ensureAgentsWidget,
  initializeAgentsWidgetPoller,
  settleAgentsWidgetPoller,
  stopAgentsWidgetPoller,
} from './ui/poller.ts';
import { registerAgentMessageRenderers } from './ui/renderers.ts';
import { errorMessage } from './utils.ts';

let pendingRunDelegation: RunDelegationRequest | null = null;

export default function herdrAgentsExtension(pi: ExtensionAPI) {
  if (process.env.PI_AGENT_CHILD === '1') {
    registerChildMode(pi);
    return;
  }

  // Read once per extension load: herdr-agents.json changes apply on /reload.
  const configPromise = loadHerdrAgentsConfig();
  // Sweep expired durable reports at load. The directory is captured
  // synchronously because the sweep is fire-and-forget: resolving it inside the
  // sweep would read whatever agent dir the environment holds when it runs.
  const reportsDir = herdrAgentReportsDir();
  void pruneExpiredReports({ reportsDir });

  // Profile names for /run, discovered on session_start (and /reload).
  let agentNames: string[] = [];

  registerAgentSpawnTool(pi);
  registerAgentSendTool(pi);
  registerAgentStopTool(pi);
  registerAgentStatusTool(pi);
  // A /reload leaves the previous instance's poller running with a stale ctx.
  initializeAgentsWidgetPoller(pi);

  registerAgentMessageRenderers(pi);

  pi.on('session_start', async (_event, ctx) => {
    ensureAgentsWidget(pi, ctx);
    // Once profiles are discoverable, refresh the model-facing agent listing:
    // disable-model-invocation profiles keep working by exact name but drop
    // out of the schema description. registerTool replaces by name.
    // `/reload` rebinds extensions then emits session_start with reason
    // "reload", which is what restores Available after the load-time
    // static schema.
    await refreshAgentListing(ctx.cwd);
  });

  // Covers quit/new/resume/fork too, not just the reload path above.
  pi.on('session_shutdown', async () => {
    stopAgentsWidgetPoller(pi);
    // Stopping the interval is not enough on its own: a tick that is already
    // running would keep pruning state and calling Herdr after shutdown.
    await settleAgentsWidgetPoller(pi);
  });

  pi.on('before_agent_start', async (event) => {
    let instructions = GLOBAL_INSTRUCTIONS;

    if (event.messageType === 'user' && pendingRunDelegation) {
      const runRequest = pendingRunDelegation;
      pendingRunDelegation = null;
      instructions = `${instructions}\n\n${buildRunTurnInstructions(runRequest.agent)}`;
    }

    event.systemPromptOptions.sections.agents = instructions;
  });

  pi.registerCommand('run', {
    description: 'Explicitly delegate a task to an agent',
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const [first = '', ...rest] = prefix.trimStart().split(/\s+/);
      const taskPrefix = rest.join(' ');

      if (!prefix.trim() || (!taskPrefix && !prefix.includes(' '))) {
        const items = agentNames.map((agent) => ({
          value: `${agent} `,
          label: agent,
        }));
        const filtered = items.filter((item) =>
          item.value.toLowerCase().startsWith(prefix.toLowerCase()),
        );
        return filtered.length > 0 ? filtered : null;
      }

      if (taskPrefix) return null;

      const items = agentNames
        .filter((agent) => agent.toLowerCase().startsWith(first.toLowerCase()))
        .map((agent) => ({ value: `${agent} `, label: agent }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const parsed = parseRunArgs(args, agentNames);
      if (!parsed) {
        ctx.ui.notify(
          'Usage: /run [agent] <task> — e.g. /run scout find auth flow',
          'warning',
        );
        return;
      }

      if (!ctx.isIdle()) {
        ctx.ui.notify(
          'Agent is busy. Wait for the current turn to finish.',
          'warning',
        );
        return;
      }

      pendingRunDelegation = parsed;
      pi.sendUserMessage(formatRunUserMessage(parsed));
    },
  });

  pi.registerCommand('herdr-agents', {
    description: 'Show, focus, and close managed agents',
    handler: async (_args, ctx) => {
      try {
        await showHerdrAgentsManager(pi, ctx, configPromise);
      } catch (error) {
        ctx.ui.notify(`Failed to load agents: ${errorMessage(error)}`, 'error');
      }
    },
  });

  pi.registerCommand('herdr-agent-models', {
    description: 'Choose models for agents (edits profile frontmatter)',
    handler: async (_args, ctx) => showAgentModelPicker(ctx),
  });

  async function refreshAgentListing(cwd: string): Promise<void> {
    try {
      const agents = await discoverAgents(cwd);
      agentNames = agents.map((agent) => agent.name);
      registerAgentSpawnTool(pi, describeAgentProfiles(agents));
    } catch (error) {
      process.stderr.write(
        `herdr-agents: failed to refresh agent listing: ${errorMessage(error)}\n`,
      );
    }
  }

  // Parent-only: a child registers `ask_question` and the result writer and
  // returns before these registrations, so children cannot delegate or steer.

  function registerAgentSendTool(pi: ExtensionAPI): void {
    pi.registerTool({
      name: 'agent_send',
      label: 'Agent Send',
      description:
        'Send a message to an agent this session owns, addressed by name. Answers a question the agent asked, steers a running agent at its next turn boundary, or gives a closed agent a follow-up task that keeps its context.',
      promptSnippet:
        'Answer an agent question, steer a running agent, or continue a closed agent with a follow-up task.',
      promptGuidelines: [
        'Use agent_send to answer a question an agent asked, using its exact name and your answer as the message.',
        'Steer a running agent only when a correction must reach work already in progress; never to check progress.',
        'To continue a closed agent with its context, send it a new self-contained task by its exact name.',
        'If agent_send reports the agent is not in an active run, wait for its result instead of sending a task.',
        'Never repeat an agent_send call that reported no acknowledgement.',
      ],
      parameters: buildAgentSendParams(),

      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        return await executeAgentSend(
          pi,
          params,
          signal,
          onUpdate,
          ctx,
          configPromise,
        );
      },
    });
  }

  function registerAgentStopTool(pi: ExtensionAPI): void {
    pi.registerTool({
      name: 'agent_stop',
      label: 'Agent Stop',
      description:
        'Abort the current run of a running agent this session owns. The agent stays open. It cannot start, answer, resume, or close an agent.',
      promptSnippet:
        'Stop the current run of a running agent when the user or a decision requires it.',
      promptGuidelines: [
        'Use agent_stop only when the user or a decision requires stopping the run.',
        'A stop drops a queued steer.',
        'Never repeat an agent_stop call that reported no acknowledgement.',
      ],
      parameters: buildAgentStopParams(),

      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        return await executeAgentStop(params, signal, ctx);
      },
    });
  }

  function registerAgentStatusTool(pi: ExtensionAPI): void {
    pi.registerTool({
      name: 'agent_status',
      label: 'Agent Status',
      description:
        'Check one live agent by name (status and a preview of its latest text), or list the live agents this session owns. Read-only: never sends work, claims, or closes.',
      promptSnippet:
        'Check an agent when the user asks or a decision depends on its progress.',
      promptGuidelines: [
        'Use agent_status only when the user asks or a decision depends on progress, never to wait for completion: the outcome arrives as a message automatically.',
      ],
      parameters: buildAgentStatusParams(),

      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        return await executeAgentStatusCall(params, signal, ctx, configPromise);
      },
    });
  }

  /**
   * `agent` description is static at load; `session_start` re-registers with
   * a dynamic listing once profiles are discoverable. registerTool replaces
   * by name, so the refreshed schema wins. Pi `/reload` emits session_start
   * with reason "reload", which is the path that restores Available.
   */
  function registerAgentSpawnTool(
    pi: ExtensionAPI,
    agentDescription?: string,
  ): void {
    pi.registerTool({
      name: 'agent_spawn',
      label: 'Agent Spawn',
      description:
        'Spawn a one-shot agent with a named profile from ~/.pi/agent/agents. Agents close after delivering their result; continue a closed one with agent_send and the same name.',
      promptSnippet:
        'Delegate exploration, research, planning, review, and isolated implementation to a one-shot agent.',
      promptGuidelines: [
        'Use agent_spawn when isolated context helps, after /run, or on an explicit delegation request.',
        'Follow the agents system instructions for self-contained tasks, independent parallel calls, avoiding duplicate work, status checks, and continuing agents.',
      ],
      parameters: buildAgentSpawnParams(agentDescription),

      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        return await executeAgentSpawn(
          pi,
          params,
          signal,
          onUpdate,
          ctx,
          configPromise,
        );
      },
    });
  }
}
