import { join } from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { AutocompleteItem } from '@earendil-works/pi-tui';

import { discoverAgents } from './agents.ts';
import {
  assertResumableSessionDir,
  clearAgentQuestion,
  clearAgentResult,
  createAgentTempFiles,
  createResultFile,
  readAgentQuestion,
  removeAgentTempFiles,
  RESULT_FILE_MARKER,
  validateResumableSessionFile,
} from './artifacts.ts';
import { registerChildMode } from './child.ts';
import {
  getHerdrAgentsLayout,
  getHerdrAgentsWorkspaceLabel,
  loadHerdrAgentsConfig,
} from './config.ts';
import { promptAgent, startAgent } from './herdr/agent.ts';
import { execHerdr } from './herdr/cli.ts';
import {
  chooseAgentColumnSplitTarget,
  findReusableAgentPane,
  findReusableAgentTab,
  listManagedWorkspaceAgents,
  uniqueLabel,
} from './herdr/placement.ts';
import {
  getCurrentContext,
  listPanes,
  listTabs,
  resolveAgentsWorkspace,
} from './herdr/snapshot.ts';
import {
  buildRunTurnInstructions,
  CHILD_PROTOCOL,
  formatAgentQuestion,
  GLOBAL_INSTRUCTIONS,
} from './prompts.ts';
import {
  formatRunUserMessage,
  parseRunArgs,
  type RunDelegationRequest,
} from './run.ts';
import {
  claimClosedHistory,
  findOwnedClosedHistory,
  markClosedHistoryInvalid,
  releaseClosedHistory,
  type ClosedAgentHistoryRecord,
} from './state/closed-history.ts';
import {
  claimDetachedAgent,
  emptyHerdrAgentsState,
  paneStateKey,
  persistPrunedAgentsState,
  recordAgentLifecycle,
} from './state/store.ts';
import {
  buildChildPiArgs,
  herdrChildEnvArgs,
  orchestratorIdentity,
} from './tool/child-args.ts';
import {
  acquirePanePlacementLock,
  bestEffort,
  closeOneShot,
  dropCollectedSpawnWarnings,
  formatCollectedOutput,
  independentCleanupSignal,
  readSettledAgentOutput,
  rebalanceCurrentPaneAgents,
  spawnWarningDetails,
} from './tool/one-shot.ts';
import {
  executeRewait,
  resumeClosedLiveDecision,
  resumedDetails,
} from './tool/rewait.ts';
import { buildHerdrAgentParams, describeAgentProfiles } from './tool/schema.ts';
import type { PaneInfo } from './types.ts';
import { showHerdrAgentsManager } from './ui/manager.ts';
import {
  beginAwaitingAgent,
  endAwaitingAgent,
  ensureAgentsWidget,
  settleAgentsWidgetPoller,
  stopAgentsWidgetPoller,
} from './ui/poller.ts';
import { registerAgentMessageRenderers } from './ui/renderers.ts';
import {
  formatSpawnWarnings,
  formatWaitInterrupted,
  isRecoverableWaitInterrupt,
  makeHerdrAgentName,
  titleCase,
  waitInterruptReason,
} from './utils.ts';

/** Fixed wait timeout; tuning lives in code, not in the model-facing schema. */
const DEFAULT_WAIT_TIMEOUT_MS = 600_000;

let pendingRunDelegation: RunDelegationRequest | null = null;

export default function herdrAgentsExtension(pi: ExtensionAPI) {
  if (process.env.HERDR_AGENT_CHILD === '1') {
    registerChildMode(pi);
    return;
  }

  registerHerdrAgentTool(pi);
  // A /reload leaves the previous instance's poller running with a stale ctx.
  stopAgentsWidgetPoller();

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
    stopAgentsWidgetPoller();
    // Stopping the interval is not enough on its own: a tick that is already
    // running would keep pruning state and calling Herdr after shutdown.
    await settleAgentsWidgetPoller();
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
      const agents = ['scout', 'researcher', 'planner', 'worker', 'reviewer'];
      const [first = '', ...rest] = prefix.trimStart().split(/\s+/);
      const taskPrefix = rest.join(' ');

      if (!prefix.trim() || (!taskPrefix && !prefix.includes(' '))) {
        const items = agents.map((agent) => ({
          value: `${agent} `,
          label: agent,
        }));
        const filtered = items.filter((item) =>
          item.value.startsWith(prefix.toLowerCase()),
        );
        return filtered.length > 0 ? filtered : null;
      }

      if (taskPrefix) return null;

      const items = agents
        .filter((agent) => agent.startsWith(first.toLowerCase()))
        .map((agent) => ({ value: `${agent} `, label: agent }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const parsed = parseRunArgs(args);
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
        await showHerdrAgentsManager(ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to load Herdr agents: ${message}`, 'error');
      }
    },
  });

  async function refreshAgentListing(cwd: string): Promise<void> {
    try {
      const agents = await discoverAgents(cwd);
      registerHerdrAgentTool(pi, describeAgentProfiles(agents));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `herdr-agents: failed to refresh agent listing: ${message}\n`,
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
        'Use herdr_agent when global Delegation says isolated context helps; call after /run, a named role, or explicit delegation request.',
        'Follow the Herdr agents system instructions for self-contained tasks, independent parallel calls, avoiding duplicate work, re-wait, and resume.',
      ],
      parameters: buildHerdrAgentParams(agentDescription),

      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const agents = await discoverAgents(ctx.cwd);
        let agent = agents.find((item) => item.name === params.agent);
        if (!agent) {
          // Profiles marked disable-model-invocation stay spawnable by exact
          // name, but they are not offered as options to the Orchestrator.
          const listable = agents.filter(
            (item) => !item.disableModelInvocation,
          );
          const available =
            listable.map((item) => item.name).join(', ') || 'none';
          return {
            content: [
              {
                type: 'text',
                text: `Unknown Herdr agent: ${params.agent}. Available: ${available}`,
              },
            ],
            details: { availableAgents: listable },
            isError: true,
          };
        }

        // Only TUI sessions have a detached collector.
        const wait = params.wait ?? ctx.mode !== 'tui';
        const config = await loadHerdrAgentsConfig();
        const layout = getHerdrAgentsLayout(config);
        const timeoutMs = DEFAULT_WAIT_TIMEOUT_MS;
        const baseLabel = params.tabLabel?.trim() || titleCase(agent.name);
        const resumeClosed = params.resumeClosed === true;
        const owner = orchestratorIdentity(ctx);

        if (resumeClosed) {
          if (!params.task?.trim()) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'resumeClosed requires a non-empty task. Omit resumeClosed and task to re-wait on a still-running agent.',
                },
              ],
              details: { resumeClosed: true, waited: false },
              isError: true,
            };
          }
          if (!params.tabLabel?.trim()) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'resumeClosed requires an explicit non-empty tabLabel.',
                },
              ],
              details: { resumeClosed: true, waited: false },
              isError: true,
            };
          }
        }

        // Detached collection needs the TUI widget poller.
        if (!wait && ctx.mode !== 'tui') {
          return {
            content: [
              {
                type: 'text',
                text: 'wait: false requires TUI mode with the agents widget poller. Non-TUI sessions require wait: true because no background collector exists.',
              },
            ],
            details: { waited: false },
            isError: true,
          };
        }

        if (params.task === undefined) {
          // Re-wait mode: no new task, just reconnect to an existing tab that is
          // (expected to be) still running — e.g. after a previous call to this
          // tool timed out while the agent kept working. It only invokes the
          // server-owned agent wait, so no prompt is re-sent into a busy pane.
          // Omitting task never resurrects a closed agent.
          return await executeRewait(pi, {
            agent,
            tabLabel: params.tabLabel,
            baseLabel,
            layout,
            wait,
            timeoutMs,
            signal,
            onUpdate,
          });
        }

        const task = params.task;

        let tabLabel = baseLabel;
        let tabId: string | undefined;
        let paneId: string | undefined;
        let agentPane: PaneInfo | undefined;
        let automationName: string | undefined;
        let resultFile: string | undefined;
        let sessionMetaFile: string | undefined;
        let systemFile: string | undefined;
        let reused = false;
        let resumed = false;
        let resumeClaim: ClosedAgentHistoryRecord | undefined;
        let resumeDurable = false;
        // Populated only on a fresh spawn: frontmatter fields pi can't honor.
        let spawnWarnings: string[] = [];
        // Pane spawns need the lock so parallel calls cannot create competing
        // right columns; workspace spawns serialize the Agents-workspace lookup
        // through it (within this process) so two parallel first spawns cannot
        // create it twice. The lock is released once the agent's tab is visible
        // to listTabs. Label uniqueness is computed client-side via uniqueLabel,
        // so `agent start` and the wait stay parallel.
        const releasePlacement =
          layout === 'pane' || layout === 'workspace'
            ? await acquirePanePlacementLock()
            : () => {};
        let placementReleased = false;
        const releasePlacementOnce = () => {
          if (placementReleased) return;
          placementReleased = true;
          releasePlacement();
        };

        try {
          // Refresh context only after acquiring the short placement lock so
          // parallel calls see panes and labels created by earlier calls.
          const current = await getCurrentContext(signal);

          // Resolved on every spawn from the live workspace list: if the user
          // closed the Agents workspace by hand, a fresh one is created instead
          // of failing on a stale recorded id.
          let agentsWorkspaceId: string | undefined;
          let agentsWorkspaceCreated = false;
          let agentsWorkspaceRootTabId: string | undefined;
          if (layout === 'workspace') {
            const resolved = await resolveAgentsWorkspace(
              getHerdrAgentsWorkspaceLabel(config),
              {
                cwd: ctx.cwd,
                signal,
              },
            );
            agentsWorkspaceId = resolved.workspaceId;
            agentsWorkspaceCreated = resolved.created;
            agentsWorkspaceRootTabId = resolved.rootTabId;
            if (agentsWorkspaceId === current.workspaceId) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `The configured workspace.label matches this Orchestrator's own workspace. Change workspace.label in herdr-agents.json so agents spawn into a dedicated workspace instead of the Orchestrator's.`,
                  },
                ],
                details: {
                  workspaceId: agentsWorkspaceId,
                  waited: false,
                },
                isError: true,
              };
            }
          }
          const usesTabs = layout === 'tab' || layout === 'workspace';
          const tabs = usesTabs
            ? await listTabs(agentsWorkspaceId ?? current.workspaceId, signal)
            : [];
          const state = await bestEffort(emptyHerdrAgentsState(), () =>
            persistPrunedAgentsState(current.panes),
          );

          // Reuse by label is only for answering a parked question: the answer
          // arrives as a normal `task`, and without reuse it would spawn a
          // second agent and orphan the parked one forever. Everything else
          // addressed to a live agent by label is rejected with guidance.
          {
            const candidateTab = usesTabs
              ? findReusableAgentTab(current, tabs, baseLabel, state)
              : undefined;
            const candidatePane = usesTabs
              ? candidateTab?.pane
              : findReusableAgentPane(current, state, baseLabel);
            const candidateKey = candidatePane
              ? paneStateKey(candidatePane)
              : undefined;
            const candidateRecord = candidateKey
              ? state.agents[candidateKey]
              : undefined;
            const answeringQuestion =
              !!candidateRecord &&
              (await bestEffort(undefined, () =>
                readAgentQuestion(candidateRecord.resultFile),
              )) !== undefined;

            // A task explicitly addressed by label to a live agent is almost
            // certainly a failed reuse: silently spawning a
            // duplicate ("... #2") would orphan the live pane. Default labels
            // fall through — parallel spawns of one profile get suffixed labels
            // via uniqueLabel. Fail loudly with the alternatives instead.
            if (
              params.tabLabel?.trim() &&
              !resumeClosed &&
              !answeringQuestion &&
              candidatePane
            ) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `A live Herdr agent named "${baseLabel}" already exists and cannot receive a new task. If it is still working, call herdr_agent again with the same tabLabel and no task to re-wait. If it already settled detached, wait for the result to be delivered, then use resumeClosed: true with the same tabLabel to continue it with its context. If you want a fresh agent, pass a different tabLabel.`,
                  },
                ],
                details: {
                  tabLabel: baseLabel,
                  paneId: candidatePane.pane_id,
                  existingLifecycle: candidateRecord?.lifecycle,
                  waited: false,
                },
                isError: true,
              };
            }

            if (resumeClosed && candidatePane) {
              const decision = resumeClosedLiveDecision({
                label: baseLabel,
                pane: candidatePane,
                record: candidateRecord,
                answeringQuestion,
              });
              if (decision.action === 'reject') {
                return {
                  content: [{ type: 'text', text: decision.text }],
                  details: {
                    resumeClosed: true,
                    tabLabel: baseLabel,
                    paneId: candidatePane.pane_id,
                    waited: false,
                    liveStatus: candidatePane.agent_status,
                    detached: candidateRecord?.detached === true,
                  },
                  isError: true,
                };
              }
            }

            if (answeringQuestion && candidatePane) {
              reused = true;
              tabId = candidateTab?.tab.tab_id ?? candidatePane.tab_id;
              if (candidateTab) tabLabel = candidateTab.tab.label;
              paneId = candidatePane.pane_id;
              agentPane = candidatePane;
              automationName = candidateRecord?.automationName;
              resultFile = candidateRecord?.resultFile;
              // A new task on an existing pane is not the first collection:
              // do not copy spawn-time notes onto later turns.
            }
          }

          if (resumeClosed && !reused) {
            if (!owner.sessionId) {
              return {
                content: [
                  {
                    type: 'text',
                    text: 'Cannot resume a closed agent: this Orchestrator session has no session id.',
                  },
                ],
                details: { resumeClosed: true, waited: false },
                isError: true,
              };
            }
            const historyState = await bestEffort(emptyHerdrAgentsState(), () =>
              persistPrunedAgentsState(current.panes),
            );
            const existing = findOwnedClosedHistory(
              historyState,
              owner.sessionId,
              params.tabLabel!.trim(),
            );
            if (!existing) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `No closed one-shot Herdr agent named "${params.tabLabel!.trim()}" is owned by this Orchestrator session.`,
                  },
                ],
                details: { resumeClosed: true, waited: false },
                isError: true,
              };
            }
            if (existing.status === 'claimed') {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Closed Herdr agent "${existing.tabLabel}" is already being resumed.`,
                  },
                ],
                details: { resumeClosed: true, waited: false },
                isError: true,
              };
            }
            if (existing.profileName !== agent.name) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Closed Herdr agent "${existing.tabLabel}" was a ${existing.profileName} agent, not ${agent.name}.`,
                  },
                ],
                details: { resumeClosed: true, waited: false },
                isError: true,
              };
            }
            const cwdError = await assertResumableSessionDir(existing.cwd);
            const header = cwdError
              ? undefined
              : await validateResumableSessionFile(existing.childSessionFile, {
                  sessionId: existing.childSessionId,
                  cwd: existing.cwd,
                });
            if (cwdError || !header) {
              await bestEffort(undefined, () =>
                markClosedHistoryInvalid(existing.id, existing.claimGeneration),
              );
              return {
                content: [
                  {
                    type: 'text',
                    text: cwdError
                      ? `Cannot resume "${existing.tabLabel}": ${cwdError}`
                      : `Cannot resume "${existing.tabLabel}": child session file is missing, corrupt, or does not match the stored session id/cwd.`,
                  },
                ],
                details: { resumeClosed: true, waited: false },
                isError: true,
              };
            }
            const claimed = await claimClosedHistory({
              ownerSessionId: owner.sessionId,
              tabLabel: existing.tabLabel,
              profileName: agent.name,
            });
            if (!claimed.ok) {
              return {
                content: [{ type: 'text', text: claimed.error }],
                details: { resumeClosed: true, waited: false },
                isError: true,
              };
            }
            resumeClaim = claimed.record;
            resumed = true;
            tabLabel = claimed.record.tabLabel;
            const resumedAgents = await discoverAgents(claimed.record.cwd);
            agent =
              resumedAgents.find((item) => item.name === params.agent) ?? agent;
          }

          if (!reused) {
            const profilePrompt = [agent.systemPrompt, CHILD_PROTOCOL]
              .filter(Boolean)
              .join('\n\n');
            const tempFiles = await createAgentTempFiles(profilePrompt);
            resultFile = tempFiles.resultFile;
            sessionMetaFile = tempFiles.sessionMetaFile;
            systemFile = tempFiles.systemFile;
          }

          if (!reused && usesTabs) {
            if (!resumeClaim) tabLabel = uniqueLabel(baseLabel, tabs);
            const createOutput = await execHerdr(
              [
                'tab',
                'create',
                '--workspace',
                agentsWorkspaceId ?? current.workspaceId,
                '--label',
                tabLabel,
                '--cwd',
                resumeClaim?.cwd ?? ctx.cwd,
                ...herdrChildEnvArgs(sessionMetaFile),
                '--no-focus',
              ],
              signal,
            );
            let createResult;
            try {
              createResult = JSON.parse(createOutput)?.result;
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              throw new Error(
                `Malformed Herdr tab create output: expected JSON with result.root_pane.pane_id (${message}). Output: ${createOutput}`,
              );
            }

            const rootPane = createResult?.root_pane as PaneInfo | undefined;
            if (!rootPane || typeof rootPane.pane_id !== 'string') {
              throw new Error(
                `Malformed Herdr tab create output: missing result.root_pane.pane_id. Output: ${createOutput}`,
              );
            }
            paneId = rootPane.pane_id;
            agentPane = rootPane;
            tabId =
              typeof rootPane.tab_id === 'string' ? rootPane.tab_id : undefined;

            if (!tabId) {
              const createdTabs = await listTabs(
                agentsWorkspaceId ?? current.workspaceId,
                signal,
              );
              tabId = createdTabs.find((tab) => tab.label === tabLabel)?.tab_id;
            }
          }

          // The agent's tab now exists and is visible to the next `listTabs`,
          // so workspace spawns no longer need the placement lock. Uniqueness of
          // the label is computed client-side (uniqueLabel) — releasing here
          // still leaves a same-label parallel spawn window, which the
          // reuse contract already rules out (reuse is sequential by tabLabel).
          // Best effort: close the known root shell tab `workspace create`
          // starts every new workspace with. Only the creating spawn does this,
          // and only by id — never by "empty pane" heuristics, which can race
          // a sibling spawn whose agent is not started yet.
          if (layout === 'workspace') {
            if (agentsWorkspaceCreated && !reused && agentsWorkspaceRootTabId) {
              await bestEffort(undefined, () =>
                execHerdr(['tab', 'close', agentsWorkspaceRootTabId], signal),
              );
            }
            releasePlacementOnce();
          }

          if (!reused && layout === 'pane') {
            const managedAgents = listManagedWorkspaceAgents(
              current,
              state,
            ).filter(
              (item) =>
                item.layout === 'pane' && item.tabId === current.currentTab,
            );
            if (!resumeClaim) {
              tabLabel = uniqueLabel(
                baseLabel,
                managedAgents.map((item) => ({
                  tab_id: item.paneId,
                  label: item.tabLabel,
                })),
              );
            }
            const managedPaneIds = new Set(
              managedAgents.map((item) => item.paneId),
            );
            const managedPanes = current.panes.filter((pane) =>
              managedPaneIds.has(pane.pane_id),
            );
            let splitTarget = managedPanes[0];
            if (managedPanes.length > 0) {
              const layoutOutput = await execHerdr(
                ['pane', 'layout', '--pane', current.currentPane.pane_id],
                signal,
              );
              const paneLayout = JSON.parse(layoutOutput)?.result?.layout;
              splitTarget = chooseAgentColumnSplitTarget(
                managedPanes,
                paneLayout,
              );
            }

            const createOutput = await execHerdr(
              [
                'pane',
                'split',
                splitTarget?.pane_id ?? current.currentPane.pane_id,
                '--direction',
                splitTarget ? 'down' : 'right',
                '--ratio',
                splitTarget ? '0.5' : '0.6',
                '--cwd',
                resumeClaim?.cwd ?? ctx.cwd,
                ...herdrChildEnvArgs(sessionMetaFile),
                '--no-focus',
              ],
              signal,
            );
            let createResult;
            try {
              createResult = JSON.parse(createOutput)?.result;
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              throw new Error(
                `Malformed Herdr pane split output: expected JSON with result.pane.pane_id (${message}). Output: ${createOutput}`,
              );
            }
            const createdPane = createResult?.pane as PaneInfo | undefined;
            if (!createdPane || typeof createdPane.pane_id !== 'string') {
              throw new Error(
                `Malformed Herdr pane split output: missing result.pane.pane_id. Output: ${createOutput}`,
              );
            }
            paneId = createdPane.pane_id;
            tabId = createdPane.tab_id || current.currentTab;
            agentPane = createdPane;
            await execHerdr(['pane', 'rename', paneId, tabLabel], signal);
          }

          if (!tabId || !paneId) {
            throw new Error(
              `Could not identify Herdr tab or pane for ${tabLabel}.`,
            );
          }

          if (!agentPane?.terminal_id) {
            agentPane = (await listPanes(signal)).find(
              (pane) => pane.pane_id === paneId,
            );
          }

          if (!reused) {
            automationName = makeHerdrAgentName(agent.name);
            const built = await buildChildPiArgs({
              agent,
              tabLabel,
              systemFile: systemFile!,
              cwd: resumeClaim?.cwd ?? ctx.cwd,
              ...(resumeClaim
                ? { sessionFile: resumeClaim.childSessionFile }
                : {}),
            });
            spawnWarnings = built.spawnWarnings;
            const piArgs = built.piArgs;

            onUpdate?.({
              content: [
                {
                  type: 'text',
                  text: resumed
                    ? `Resuming Herdr agent ${tabLabel} (${paneId})...`
                    : `Starting Herdr agent ${tabLabel} (${paneId})...`,
                },
              ],
              details: {
                tabId,
                paneId,
                tabLabel,

                reused,
                ...resumedDetails(resumed),
                agent,
                ...spawnWarningDetails(spawnWarnings),
              },
            });
            await startAgent(automationName, paneId, piArgs, signal);
            agentPane =
              (await listPanes(signal)).find(
                (pane) => pane.pane_id === paneId,
              ) ?? agentPane;
          } else {
            resultFile ??= await createResultFile();
          }

          if (agentPane) {
            const writeLifecycle = () =>
              recordAgentLifecycle(agentPane!, {
                tabLabel,
                agent: agent.name,
                automationName,
                resultFile,
                layout,
                ...(spawnWarnings.length > 0 ? { spawnWarnings } : {}),
                detached: !wait,
                ...(current.currentPane.terminal_id
                  ? { ownerTerminalId: current.currentPane.terminal_id }
                  : {}),
                ...(owner.sessionId ? { ownerSessionId: owner.sessionId } : {}),
                ...(owner.sessionFile
                  ? { ownerSessionFile: owner.sessionFile }
                  : {}),
                ...(resumeClaim
                  ? {
                      closedHistoryId: resumeClaim.id,
                      closedHistoryGeneration: resumeClaim.claimGeneration,
                    }
                  : {}),
              });
            if (resumeClaim) {
              await writeLifecycle();
              resumeDurable = true;
            } else {
              await bestEffort(undefined, writeLifecycle);
            }
          } else if (resumeClaim) {
            throw new Error(
              `Could not record a live lifecycle for resumed Herdr agent ${tabLabel}.`,
            );
          }
          if (layout === 'pane') {
            await bestEffort(undefined, () =>
              rebalanceCurrentPaneAgents(signal),
            );
          }
        } catch (error) {
          if (resumeClaim && !resumeDurable) {
            const cleanupSignal = independentCleanupSignal();
            let closedPartial = true;
            if (paneId && tabId) {
              closedPartial = await bestEffort(false, async () => {
                await execHerdr(
                  layout === 'pane'
                    ? ['pane', 'close', paneId!]
                    : ['tab', 'close', tabId!],
                  cleanupSignal,
                );
                return true;
              });
            }
            await bestEffort(undefined, () => removeAgentTempFiles(resultFile));
            if (closedPartial) {
              await releaseClosedHistory(
                resumeClaim.id,
                resumeClaim.claimGeneration,
              );
            }
          }
          throw error;
        } finally {
          releasePlacementOnce();
        }

        ensureAgentsWidget(pi, ctx);

        if (!tabId || !paneId) {
          throw new Error(
            `Could not identify Herdr tab or pane for ${tabLabel}.`,
          );
        }

        const target = automationName ?? paneId;

        const taskPrompt = [
          `You are the ${agent.name} Herdr agent.`,
          '',
          'Task from Orchestrator:',
          task,
          '',
          'Your final assistant response is captured as the structured result artifact.',
          `${RESULT_FILE_MARKER} ${resultFile}`,
        ].join('\n');

        await clearAgentResult(resultFile);
        // A leftover question from the previous turn would otherwise be reported
        // again as soon as this prompt finishes.
        await clearAgentQuestion(resultFile);

        onUpdate?.({
          content: [
            {
              type: 'text',
              text: `${reused ? 'Sending task to' : 'Waiting for'} Herdr agent ${tabLabel} (${paneId})...`,
            },
          ],
          details: { tabId, paneId, tabLabel, reused, agent },
        });

        const blockedLabel = `waiting for ${tabLabel}`;
        if (wait) {
          pi.events.emit('herdr:blocked', {
            active: true,
            label: blockedLabel,
          });
          beginAwaitingAgent(tabLabel);
        }
        try {
          await promptAgent(target, taskPrompt, { wait, timeoutMs }, signal);

          if (!wait) {
            return {
              content: [
                {
                  type: 'text',
                  text: formatSpawnWarnings(
                    `Herdr agent ${tabLabel} started (${paneId}).`,
                    spawnWarnings,
                  ),
                },
              ],
              details: {
                tabId,
                paneId,
                tabLabel,

                reused,
                ...resumedDetails(resumed),
                agent,
                waited: false,
                ...spawnWarningDetails(spawnWarnings),
              },
            };
          }

          // Checked before the result: a child that asked ends its turn without
          // HERDR_RESULT, so the wait fires on idle exactly like a completion.
          // The agent stays open — including one-shots — until it really finishes.
          const settled = await readSettledAgentOutput(
            resultFile,
            target,
            signal,
          );
          if ('question' in settled) {
            await dropCollectedSpawnWarnings(agentPane);
            return {
              content: [
                {
                  type: 'text',
                  text: formatSpawnWarnings(
                    formatAgentQuestion(tabLabel, agent.name, settled.question),
                    spawnWarnings,
                  ),
                },
              ],
              details: {
                tabId,
                paneId,
                tabLabel,

                reused,
                ...resumedDetails(resumed),
                closed: false,
                agent,
                waited: true,
                status: 'question',
                ...spawnWarningDetails(spawnWarnings),
              },
            };
          }

          // Whoever collects first owns the result. Releasing the claim here stops
          // the poller from delivering the same result a second time.
          if (agentPane) {
            await bestEffort(false, () => claimDetachedAgent(agentPane!));
          }

          // Every spawned agent is a one-shot now, including reused parked ones;
          const closeError = await closeOneShot({
            layout,
            tabId,
            paneId,
            resultFile,
            lifecyclePane: agentPane,
            signal,
          });
          const closed = closeError === undefined;

          const text = formatCollectedOutput(
            settled.output,
            tabLabel,
            closeError,
            spawnWarnings,
          );
          await dropCollectedSpawnWarnings(agentPane);

          return {
            content: [
              {
                type: 'text',
                text,
              },
            ],
            details: {
              tabId,
              paneId,
              tabLabel,

              reused,
              ...resumedDetails(resumed),
              closed,
              closeError,
              ...spawnWarningDetails(spawnWarnings),
              agent,
              waited: true,
            },
          };
        } catch (error) {
          if (wait && isRecoverableWaitInterrupt(error)) {
            const reason = waitInterruptReason(error);
            return {
              content: [
                {
                  type: 'text',
                  text: formatSpawnWarnings(
                    formatWaitInterrupted(tabLabel, reason),
                    spawnWarnings,
                  ),
                },
              ],
              details: {
                tabId,
                paneId,
                tabLabel,

                reused,
                ...resumedDetails(resumed),
                agent,
                waited: false,
                interrupted: true,
                interruptReason: reason,
                ...spawnWarningDetails(spawnWarnings),
              },
            };
          }
          throw error;
        } finally {
          if (wait) {
            endAwaitingAgent(tabLabel);
            pi.events.emit('herdr:blocked', {
              active: false,
              label: blockedLabel,
            });
          }
        }
      },
    });
  }
}
