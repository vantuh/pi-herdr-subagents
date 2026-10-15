import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { AutocompleteItem } from '@earendil-works/pi-tui';

import { discoverAgents } from './agents.ts';
import { registerChildMode } from './child.ts';
import { loadHerdrAgentsConfig } from './config.ts';
import { buildRunTurnInstructions, GLOBAL_INSTRUCTIONS } from './prompts.ts';
import {
  formatRunUserMessage,
  parseRunArgs,
  type RunDelegationRequest,
} from './run.ts';
import { executeHerdrAgent } from './tool/execute.ts';
import { buildHerdrAgentParams, describeAgentProfiles } from './tool/schema.ts';
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
  if (process.env.HERDR_AGENT_CHILD === '1') {
    registerChildMode(pi);
    return;
  }

  // Read once per extension load: herdr-agents.json changes apply on /reload.
  const configPromise = loadHerdrAgentsConfig();
  // Profile names for /run, discovered on session_start (and /reload).
  let agentNames: string[] = [];

  registerHerdrAgentTool(pi);
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

    event.systemPromptOptions.sections.herdr_agents = instructions;
  });

  pi.registerCommand('run', {
    description: 'Explicitly delegate a task to a Herdr agent',
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
    description: 'Show, focus, and close managed Herdr agents',
    handler: async (_args, ctx) => {
      try {
        await showHerdrAgentsManager(pi, ctx, configPromise);
      } catch (error) {
        ctx.ui.notify(
          `Failed to load Herdr agents: ${errorMessage(error)}`,
          'error',
        );
      }
    },
  });

  async function refreshAgentListing(cwd: string): Promise<void> {
    try {
      const agents = await discoverAgents(cwd);
      agentNames = agents.map((agent) => agent.name);
      registerHerdrAgentTool(pi, describeAgentProfiles(agents));
    } catch (error) {
      process.stderr.write(
        `herdr-agents: failed to refresh agent listing: ${errorMessage(error)}\n`,
      );
    }
  }

  /**
   * `agent` description is static at load; `session_start` re-registers with
   * a dynamic listing once profiles are discoverable. registerTool replaces
   * by name, so the refreshed schema wins. Pi `/reload` emits session_start
   * with reason "reload", which is the path that restores Available.
   */
  function registerHerdrAgentTool(
    pi: ExtensionAPI,
    agentDescription?: string,
  ): void {
    pi.registerTool({
      name: 'herdr_agent',
      label: 'Herdr Agent',
      description:
        'Spawn a one-shot Herdr agent with a named profile from ~/.pi/agent/agents. Agents close after delivering their result; continue a closed one-shot with its context via resumeClosed and the same tabLabel.',
      promptSnippet:
        'Delegate exploration, research, planning, review, and isolated implementation to a one-shot Herdr agent.',
      promptGuidelines: [
        'Use herdr_agent when isolated context helps, after /run, or on an explicit delegation request.',
        'Follow the Herdr agents system instructions for self-contained tasks, independent parallel calls, avoiding duplicate work, status checks, and resume.',
      ],
      parameters: buildHerdrAgentParams(agentDescription),

      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        return await executeHerdrAgent(
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
