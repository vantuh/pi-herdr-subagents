import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionToolContext,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { discoverAgents } from '../agents.ts';
import type { AgentProfile } from '../agents/types.ts';
import {
  resumableSessionDirError,
  clearAgentQuestion,
  clearAgentResult,
  createAgentTempFiles,
  createResultFile,
  readAgentQuestion,
  removeAgentTempFiles,
  RESULT_FILE_MARKER,
  validateResumableSessionFile,
} from '../artifacts.ts';
import {
  getHerdrAgentsLayout,
  getHerdrAgentsWorkspaceLabel,
} from '../config.ts';
import type { HerdrAgentLayout, HerdrAgentsConfig } from '../config/schema.ts';
import { promptAgent, startAgent } from '../herdr/agent.ts';
import { execHerdr } from '../herdr/cli.ts';
import {
  chooseAgentColumnSplitTarget,
  rebalanceCurrentPaneAgents,
} from '../herdr/layout.ts';
import { PaneLayout } from '../herdr/layout/schema.ts';
import {
  findUnresolvedOwnedAgent,
  findReusableAgentPane,
  findReusableAgentTab,
  listManagedWorkspaceAgents,
  uniqueLabel,
} from '../herdr/placement.ts';
import { CreatedPane, type PaneInfo, type TabInfo } from '../herdr/schema.ts';
import {
  getCurrentContext,
  listPanes,
  listTabs,
  resolveAgentsWorkspace,
} from '../herdr/snapshot.ts';
import type { HerdrContext } from '../herdr/types.ts';
import { parseJson } from '../json.ts';
import { formatSpawnWarnings, spawnWarningDetails } from '../output.ts';
import { CHILD_PROTOCOL } from '../prompts.ts';
import {
  claimClosedHistory,
  findOwnedClosedHistory,
  markClosedHistoryInvalid,
  releaseClosedHistory,
} from '../state/closed-history.ts';
import type {
  ClosedAgentHistoryRecord,
  HerdrAgentsState,
} from '../state/schema.ts';
import {
  emptyHerdrAgentsState,
  paneStateKey,
  persistPrunedAgentsState,
  recordAgentLifecycle,
} from '../state/store.ts';
import { ensureAgentsWidget } from '../ui/poller.ts';
import { bestEffort, makeHerdrAgentName, titleCase } from '../utils.ts';
import {
  buildChildPiArgs,
  herdrChildEnvArgs,
  orchestratorIdentity,
} from './child-args.ts';
import { closeTargetArgs, independentCleanupSignal } from './one-shot.ts';
import { textResult } from './result.ts';
import type { HerdrAgentParams } from './schema.ts';
import { acquirePanePlacementLock } from './spawn/placement-lock.ts';
import { executeAgentStatus, resumeClosedLiveDecision } from './status.ts';

const TabCreateResponse = Type.Object({
  result: Type.Object({ root_pane: Type.Optional(CreatedPane) }),
});
const PaneSplitResponse = Type.Object({
  result: Type.Object({ pane: Type.Optional(CreatedPane) }),
});
const PaneLayoutResponse = Type.Object({
  result: Type.Optional(Type.Object({ layout: Type.Optional(PaneLayout) })),
});

interface TaskInvocation {
  pi: ExtensionAPI;
  params: HerdrAgentParams;
  task: string;
  signal: AbortSignal | undefined;
  onUpdate: AgentToolUpdateCallback<Record<string, unknown>> | undefined;
  ctx: ExtensionToolContext;
}

interface SpawnSettings {
  agent: AgentProfile;
  config: HerdrAgentsConfig;
  layout: HerdrAgentLayout;
  baseLabel: string;
  resumeClosed: boolean;
  owner: ReturnType<typeof orchestratorIdentity>;
}

// Shared progress lets cleanup see claims and targets even when a phase throws.
interface SpawnState {
  agent: AgentProfile;
  tabLabel: string;
  tabId?: string;
  paneId?: string;
  agentPane?: CreatedPane;
  lifecycleRecorded?: boolean;
  automationName?: string;
  resultFile?: string;
  sessionMetaFile?: string;
  systemFile?: string;
  reused: boolean;
  resumed: boolean;
  resumeClaim?: ClosedAgentHistoryRecord;
  resumeDurable: boolean;
  /** Populated only on a fresh spawn: frontmatter fields pi can't honor. */
  spawnWarnings: string[];
}

interface AgentPlacement {
  current: HerdrContext;
  state: HerdrAgentsState;
  tabs: TabInfo[];
  usesTabs: boolean;
  agentsWorkspaceId?: string;
  agentsWorkspaceCreated: boolean;
  agentsWorkspaceRootTabId?: string;
}

type PlacementResolution =
  | { error: AgentToolResult<Record<string, unknown>> }
  | { placement: AgentPlacement };

type SpawnTargetResult =
  | { error: AgentToolResult<Record<string, unknown>> }
  | { target: { tabId: string; paneId: string } };

function resumedDetails(resumed: boolean): { resumed?: boolean } {
  return resumed ? { resumed: true } : {};
}

function turnDetails(
  spawn: SpawnState,
  target: { tabId?: string; paneId?: string },
): Record<string, unknown> {
  return {
    tabId: target.tabId,
    paneId: target.paneId,
    tabLabel: spawn.tabLabel,
    reused: spawn.reused,
    ...resumedDetails(spawn.resumed),
    agent: spawn.agent,
    ...spawnWarningDetails(spawn.spawnWarnings),
  };
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

async function runAgentTask(
  invocation: TaskInvocation,
  settings: SpawnSettings,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const spawn: SpawnState = {
    agent: settings.agent,
    tabLabel: settings.baseLabel,
    reused: false,
    resumed: false,
    resumeDurable: false,
    spawnWarnings: [],
  };
  // Pane spawns need the lock so parallel calls cannot create competing
  // right columns; workspace spawns serialize the Agents-workspace lookup
  // through it (within this process) so two parallel first spawns cannot
  // create it twice. The lock is released once the agent's tab is visible
  // to listTabs. Label uniqueness is computed client-side via uniqueLabel,
  // so subsequent `agent start` calls stay serialized only for placement.
  const releasePlacement =
    settings.layout === 'pane' || settings.layout === 'workspace'
      ? await acquirePanePlacementLock()
      : () => {};
  let target!: { tabId: string; paneId: string };
  let placementReleased = false;
  const releasePlacementOnce = () => {
    if (placementReleased) return;
    placementReleased = true;
    releasePlacement();
  };

  try {
    const prepared = await prepareSpawnTarget(
      invocation,
      settings,
      spawn,
      releasePlacementOnce,
    );
    if ('error' in prepared) return prepared.error;
    target = prepared.target;
  } catch (error) {
    if (spawn.resumeClaim && !spawn.resumeDurable) {
      const cleanupSignal = independentCleanupSignal();
      let closedPartial = true;
      if (spawn.paneId && spawn.tabId) {
        const { paneId, tabId } = spawn;
        closedPartial = await bestEffort(false, async () => {
          await execHerdr(
            closeTargetArgs(settings.layout, tabId, paneId),
            cleanupSignal,
          );
          return true;
        });
      }
      await bestEffort(undefined, () => removeAgentTempFiles(spawn.resultFile));
      if (closedPartial) {
        await releaseClosedHistory(
          spawn.resumeClaim.id,
          spawn.resumeClaim.claimGeneration,
        );
      }
    }
    throw error;
  } finally {
    releasePlacementOnce();
  }

  ensureAgentsWidget(invocation.pi, invocation.ctx);

  return await runAgentTurn(invocation, spawn, target);
}

async function prepareSpawnTarget(
  invocation: TaskInvocation,
  settings: SpawnSettings,
  spawn: SpawnState,
  releasePlacementOnce: () => void,
): Promise<SpawnTargetResult> {
  const resolved = await resolveAgentPlacement(invocation, settings);
  if ('error' in resolved) return { error: resolved.error };
  const placement = resolved.placement;

  const earlyReuse = await reuseParkedAgent(
    invocation,
    settings,
    spawn,
    placement,
  );
  if (earlyReuse) return { error: earlyReuse };

  const earlyClaim = await claimClosedHistoryForResume(
    invocation,
    settings,
    spawn,
    placement,
  );
  if (earlyClaim) return { error: earlyClaim };

  if (!spawn.reused) {
    const profilePrompt = [spawn.agent.systemPrompt, CHILD_PROTOCOL]
      .filter(Boolean)
      .join('\n\n');
    const tempFiles = await createAgentTempFiles(profilePrompt);
    spawn.resultFile = tempFiles.resultFile;
    spawn.sessionMetaFile = tempFiles.sessionMetaFile;
    spawn.systemFile = tempFiles.systemFile;
  }

  if (!spawn.reused && placement.usesTabs) {
    await createAgentTab(invocation, settings, spawn, placement);
  }

  // The agent's tab now exists and is visible to the next `listTabs`,
  // so workspace spawns no longer need the placement lock. Uniqueness of
  // the label is computed client-side (uniqueLabel) — releasing here
  // still leaves a same-label parallel spawn window, which the
  // reuse contract already rules out (reuse is sequential by tabLabel).
  // Best effort: close the known root shell tab `workspace create`
  // starts every new workspace with. Only the creating spawn does this,
  // and only by id — never by "empty pane" heuristics, which can race
  // a sibling spawn whose agent has not started.
  if (settings.layout === 'workspace') {
    if (
      placement.agentsWorkspaceCreated &&
      !spawn.reused &&
      placement.agentsWorkspaceRootTabId
    ) {
      await bestEffort(undefined, () =>
        execHerdr(
          ['tab', 'close', placement.agentsWorkspaceRootTabId!],
          invocation.signal,
        ),
      );
    }
    releasePlacementOnce();
  }

  if (!spawn.reused && settings.layout === 'pane') {
    await createAgentPane(invocation, settings, spawn, placement);
  }

  const paneId = spawn.paneId;
  if (!spawn.tabId || !paneId) {
    throw new Error(
      `Could not identify Herdr tab or pane for ${spawn.tabLabel}.`,
    );
  }
  const tabId = spawn.tabId;

  if (!spawn.agentPane?.terminal_id) {
    spawn.agentPane = (await listPanes(invocation.signal)).find(
      (pane) => pane.pane_id === paneId,
    );
  }

  await startAndRecordAgent(invocation, settings, spawn, placement);
  return { target: { tabId, paneId } };
}

async function resolveAgentPlacement(
  invocation: TaskInvocation,
  settings: SpawnSettings,
): Promise<PlacementResolution> {
  const { ctx, signal } = invocation;
  const { config, layout } = settings;
  // Refresh context only after acquiring the short placement lock so
  // parallel calls see panes and labels created by earlier calls.
  const current = await getCurrentContext(signal);

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
        error: textResult(
          `The configured workspace.label matches this Orchestrator's own workspace. Change workspace.label in herdr-agents.json so agents spawn into a dedicated workspace instead of the Orchestrator's.`,
          { workspaceId: agentsWorkspaceId },
          true,
        ),
      };
    }
  }
  const usesTabs = layout === 'tab' || layout === 'workspace';
  const tabs = usesTabs
    ? await listTabs(agentsWorkspaceId ?? current.workspaceId, signal)
    : [];
  const state = await bestEffort(emptyHerdrAgentsState(), () =>
    persistPrunedAgentsState(
      { panes: current.panes, agents: current.agents },
      { signal },
    ),
  );

  return {
    placement: {
      current,
      state,
      tabs,
      usesTabs,
      agentsWorkspaceId,
      agentsWorkspaceCreated,
      agentsWorkspaceRootTabId,
    },
  };
}

async function reuseParkedAgent(
  invocation: TaskInvocation,
  settings: SpawnSettings,
  spawn: SpawnState,
  placement: AgentPlacement,
): Promise<AgentToolResult<Record<string, unknown>> | undefined> {
  const { params } = invocation;
  const { current, state, tabs, usesTabs } = placement;
  const { baseLabel, resumeClosed } = settings;
  const unresolved = findUnresolvedOwnedAgent(
    current,
    state,
    baseLabel,
    settings.owner.ownerSessionId,
  );
  if (unresolved) {
    return textResult(
      `Owned Herdr target ${unresolved.automationName} is still live, but its legacy owner/pane identity cannot be reconciled safely. Inspect that target; do not resend the task or spawn a replacement.`,
      { tabLabel: baseLabel },
      true,
    );
  }

  const candidateTab = usesTabs
    ? findReusableAgentTab(current, tabs, baseLabel, state)
    : undefined;
  const candidatePane = usesTabs
    ? candidateTab?.pane
    : findReusableAgentPane(current, state, baseLabel);
  const candidateKey = candidatePane ? paneStateKey(candidatePane) : undefined;
  const candidateRecord = candidateKey ? state.agents[candidateKey] : undefined;
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
    return textResult(
      `A live Herdr agent named "${baseLabel}" already exists and cannot receive a new task. If it is still working, call herdr_agent again with the same tabLabel and no task to check its status. If it already settled, wait for the result to be delivered, then use resumeClosed: true with the same tabLabel to continue it with its context. If you want a fresh agent, pass a different tabLabel.`,
      {
        tabLabel: baseLabel,
        paneId: candidatePane.pane_id,
        existingLifecycle: candidateRecord?.lifecycle,
      },
      true,
    );
  }

  if (resumeClosed && candidatePane) {
    const decision = resumeClosedLiveDecision({
      label: baseLabel,
      pane: candidatePane,
      record: candidateRecord,
      answeringQuestion,
    });
    if (decision.action === 'reject') {
      return textResult(
        decision.text,
        {
          resumeClosed: true,
          tabLabel: baseLabel,
          paneId: candidatePane.pane_id,
          liveStatus: candidatePane.agent_status,
          detached: candidateRecord?.detached === true,
        },
        true,
      );
    }
  }

  if (answeringQuestion && candidatePane) {
    spawn.reused = true;
    spawn.tabId = candidateTab?.tab.tab_id ?? candidatePane.tab_id;
    spawn.tabLabel = candidateRecord?.tabLabel ?? baseLabel;
    spawn.paneId = candidatePane.pane_id;
    spawn.agentPane = candidatePane;
    spawn.automationName = candidateRecord?.automationName;
    spawn.resultFile = candidateRecord?.resultFile;
    // A new task on an existing pane is not the first collection:
    // do not copy spawn-time notes onto subsequent turns.
  }
  return undefined;
}

async function claimClosedHistoryForResume(
  invocation: TaskInvocation,
  settings: SpawnSettings,
  spawn: SpawnState,
  placement: AgentPlacement,
): Promise<AgentToolResult<Record<string, unknown>> | undefined> {
  const { params } = invocation;
  const { resumeClosed, owner } = settings;
  if (!resumeClosed || spawn.reused) return undefined;

  if (!owner.ownerSessionId) {
    return textResult(
      'Cannot resume a closed agent: this Orchestrator session has no session id.',
      { resumeClosed: true },
      true,
    );
  }
  const existing = findOwnedClosedHistory(
    placement.state,
    owner.ownerSessionId,
    params.tabLabel!.trim(),
  );
  if (!existing) {
    return textResult(
      `No closed one-shot Herdr agent named "${params.tabLabel!.trim()}" is owned by this Orchestrator session.`,
      { resumeClosed: true },
      true,
    );
  }
  const claimed = await claimClosedHistory({
    ownerSessionId: owner.ownerSessionId,
    tabLabel: existing.tabLabel,
    profileName: spawn.agent.name,
  });
  if (!claimed.ok) {
    return textResult(claimed.error, { resumeClosed: true }, true);
  }

  spawn.resumeClaim = claimed.record;
  const record = claimed.record;
  const cwdError = await resumableSessionDirError(record.cwd);
  const header = cwdError
    ? undefined
    : await validateResumableSessionFile(record.childSessionFile, {
        sessionId: record.childSessionId,
        cwd: record.cwd,
      });
  if (cwdError || !header) {
    const invalidated = await bestEffort(false, async () => {
      await markClosedHistoryInvalid(record.id, record.claimGeneration);
      return true;
    });
    // A successful invalidation already drops the claim; releasing it again
    // would only add a state read that can fail over the error below.
    if (!invalidated) {
      await bestEffort(undefined, () =>
        releaseClosedHistory(record.id, record.claimGeneration),
      );
    }
    return textResult(
      cwdError
        ? `Cannot resume "${record.tabLabel}": ${cwdError}`
        : `Cannot resume "${record.tabLabel}": child session file is missing, corrupt, or does not match the stored session id/cwd.`,
      { resumeClosed: true },
      true,
    );
  }
  spawn.resumed = true;
  spawn.tabLabel = claimed.record.tabLabel;
  const resumedAgents = await discoverAgents(claimed.record.cwd);
  spawn.agent =
    resumedAgents.find((item) => item.name === params.agent) ?? spawn.agent;
  return undefined;
}

async function createAgentTab(
  invocation: TaskInvocation,
  settings: SpawnSettings,
  spawn: SpawnState,
  placement: AgentPlacement,
): Promise<void> {
  const { ctx, signal } = invocation;
  const { baseLabel } = settings;
  const { current, tabs, agentsWorkspaceId } = placement;

  if (!spawn.resumeClaim) {
    const managedTabs = listManagedWorkspaceAgents(current, placement.state)
      .filter((item) => tabs.some((tab) => tab.tab_id === item.tabId))
      .map((item) => ({ tab_id: item.tabId, label: item.tabLabel }));
    spawn.tabLabel = uniqueLabel(baseLabel, [...tabs, ...managedTabs]);
  }
  const createOutput = await execHerdr(
    [
      'tab',
      'create',
      '--workspace',
      agentsWorkspaceId ?? current.workspaceId,
      '--label',
      spawn.tabLabel,
      '--cwd',
      spawn.resumeClaim?.cwd ?? ctx.cwd,
      ...herdrChildEnvArgs(spawn.sessionMetaFile),
      '--no-focus',
    ],
    signal,
  );
  const createResult = parseJson(TabCreateResponse, createOutput)?.result;
  const rootPane = createResult?.root_pane;
  if (!rootPane) {
    throw new Error(
      `Malformed Herdr tab create output: missing result.root_pane.pane_id. Output: ${createOutput}`,
    );
  }
  spawn.paneId = rootPane.pane_id;
  spawn.agentPane = rootPane;
  spawn.tabId = rootPane.tab_id;

  if (!spawn.tabId) {
    spawn.tabId = (await listPanes(signal)).find(
      (pane) => pane.pane_id === spawn.paneId,
    )?.tab_id;
  }
}

async function createAgentPane(
  invocation: TaskInvocation,
  settings: SpawnSettings,
  spawn: SpawnState,
  placement: AgentPlacement,
): Promise<void> {
  const { ctx, signal } = invocation;
  const { baseLabel } = settings;
  const { current, state } = placement;

  const managedAgents = listManagedWorkspaceAgents(current, state).filter(
    (item) => item.layout === 'pane' && item.tabId === current.currentTab,
  );
  if (!spawn.resumeClaim) {
    spawn.tabLabel = uniqueLabel(
      baseLabel,
      managedAgents.map((item) => ({
        tab_id: item.paneId,
        label: item.tabLabel,
      })),
    );
  }
  const managedPaneIds = new Set(managedAgents.map((item) => item.paneId));
  const managedPanes = current.panes.filter((pane) =>
    managedPaneIds.has(pane.pane_id),
  );
  let splitTarget: PaneInfo | undefined = managedPanes[0];
  if (managedPanes.length > 0) {
    const layoutOutput = await execHerdr(
      ['pane', 'layout', '--pane', current.currentPane.pane_id],
      signal,
    );
    const paneLayout = parseJson(PaneLayoutResponse, layoutOutput)?.result
      ?.layout;
    splitTarget = chooseAgentColumnSplitTarget(managedPanes, paneLayout);
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
      spawn.resumeClaim?.cwd ?? ctx.cwd,
      ...herdrChildEnvArgs(spawn.sessionMetaFile),
      '--no-focus',
    ],
    signal,
  );
  const createResult = parseJson(PaneSplitResponse, createOutput)?.result;
  const createdPane = createResult?.pane;
  if (!createdPane) {
    throw new Error(
      `Malformed Herdr pane split output: missing result.pane.pane_id. Output: ${createOutput}`,
    );
  }
  spawn.paneId = createdPane.pane_id;
  spawn.tabId = createdPane.tab_id || current.currentTab;
  spawn.agentPane = createdPane;
  await execHerdr(['pane', 'rename', spawn.paneId, spawn.tabLabel], signal);
}

async function startAndRecordAgent(
  invocation: TaskInvocation,
  settings: SpawnSettings,
  spawn: SpawnState,
  placement: AgentPlacement,
): Promise<void> {
  const { ctx, signal, onUpdate } = invocation;
  const { layout } = settings;

  if (!spawn.reused) {
    spawn.automationName = makeHerdrAgentName(spawn.agent.name);
    const built = await buildChildPiArgs({
      agent: spawn.agent,
      tabLabel: spawn.tabLabel,
      systemFile: spawn.systemFile!,
      cwd: spawn.resumeClaim?.cwd ?? ctx.cwd,
      ...(spawn.resumeClaim
        ? { sessionFile: spawn.resumeClaim.childSessionFile }
        : {}),
    });
    spawn.spawnWarnings = built.spawnWarnings;
    const piArgs = built.piArgs;

    onUpdate?.({
      content: [
        {
          type: 'text',
          text: spawn.resumed
            ? `Resuming Herdr agent ${spawn.tabLabel} (${spawn.paneId})...`
            : `Starting Herdr agent ${spawn.tabLabel} (${spawn.paneId})...`,
        },
      ],
      details: turnDetails(spawn, {
        tabId: spawn.tabId,
        paneId: spawn.paneId,
      }),
    });
    await startAgent(spawn.automationName, spawn.paneId!, piArgs, signal);
    spawn.agentPane =
      (await listPanes(signal)).find((pane) => pane.pane_id === spawn.paneId) ??
      spawn.agentPane;
  } else {
    spawn.resultFile ??= await createResultFile();
  }

  if (spawn.agentPane) {
    const pane = spawn.agentPane;
    const writeLifecycle = () =>
      recordAgentLifecycle(pane, {
        tabLabel: spawn.tabLabel,
        agent: spawn.agent.name,
        automationName: spawn.automationName,
        resultFile: spawn.resultFile,
        layout,
        ...(spawn.spawnWarnings.length > 0
          ? { spawnWarnings: spawn.spawnWarnings }
          : {}),
        detached: true,
        ownerPaneId: placement.current.currentPane.pane_id,
        ...(placement.current.currentPane.terminal_id
          ? { ownerTerminalId: placement.current.currentPane.terminal_id }
          : {}),
        ...settings.owner,
        ...(spawn.resumeClaim
          ? {
              closedHistoryId: spawn.resumeClaim.id,
              closedHistoryGeneration: spawn.resumeClaim.claimGeneration,
            }
          : {}),
      }).then(() => {
        spawn.lifecycleRecorded = !!pane.terminal_id;
      });
    if (spawn.resumeClaim) {
      await writeLifecycle();
      spawn.resumeDurable = true;
    } else {
      await bestEffort(undefined, writeLifecycle);
    }
  } else if (spawn.resumeClaim) {
    throw new Error(
      `Could not record a live lifecycle for resumed Herdr agent ${spawn.tabLabel}.`,
    );
  }
  if (layout === 'pane') {
    await bestEffort(undefined, () => rebalanceCurrentPaneAgents(signal));
  }
}

async function runAgentTurn(
  invocation: TaskInvocation,
  spawn: SpawnState,
  target: { tabId: string; paneId: string },
): Promise<AgentToolResult<Record<string, unknown>>> {
  const { task, signal, onUpdate } = invocation;
  const { tabId, paneId } = target;
  const tabLabel = spawn.tabLabel;

  const promptTarget = spawn.automationName ?? paneId;
  const taskPrompt = [
    `You are the ${spawn.agent.name} Herdr agent.`,
    '',
    'Task from Orchestrator:',
    task,
    '',
    'All assistant text you write for this task is captured as the result artifact.',
    `${RESULT_FILE_MARKER} ${spawn.resultFile}`,
  ].join('\n');

  await clearAgentResult(spawn.resultFile);
  // A leftover question from the previous turn would otherwise be reported
  // again as soon as this prompt finishes.
  await clearAgentQuestion(spawn.resultFile);

  onUpdate?.({
    content: [
      {
        type: 'text',
        text: `Sending task to Herdr agent ${tabLabel} (${paneId})...`,
      },
    ],
    details: {
      tabId,
      paneId,
      tabLabel,
      reused: spawn.reused,
      agent: spawn.agent,
    },
  });

  await promptAgent(promptTarget, taskPrompt, signal);

  return textResult(
    formatSpawnWarnings(
      `Herdr agent ${tabLabel} started (${paneId}).`,
      spawn.spawnWarnings,
    ),
    turnDetails(spawn, target),
  );
}
