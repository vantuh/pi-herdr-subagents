import { join } from "node:path";
import {
  DynamicBorder,
  getAgentDir,
  type AgentToolUpdateCallback,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
  Box,
  Container,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";
import {
  discoverAgents,
  resolveThinkingLevel,
  resolveProfileSkills,
} from "./agents.ts";
import { registerChildMode } from "./child.ts";
import {
  getHerdrAgentsLayout,
  getHerdrAgentsWorkspaceLabel,
  loadHerdrAgentsConfig,
  readCouncilConfig,
} from "./config.ts";
import {
  buildRunTurnInstructions,
  CHILD_PROTOCOL,
  formatAgentQuestion,
  GLOBAL_INSTRUCTIONS,
} from "./constants.ts";
import {
  formatCouncilUserMessage,
  formatRunUserMessage,
  parseCouncilArgs,
  parseRunArgs,
  type RunDelegationRequest,
} from "./run.ts";
import {
  buildEqualAgentSplitRatios,
  buildAgentFinishedNotificationArgs,
  chooseAgentColumnSplitTarget,
  execHerdr,
  exportPaneLayout,
  findAgentsWorkspaceId,
  findReusableAgentPane,
  findReusableAgentTab,
  getCurrentContext,
  listManagedWorkspaceAgents,
  listPanes,
  listTabs,
  promptAgent,
  readAgent,
  resolveAgentsWorkspace,
  setLayoutSplitRatio,
  startAgent,
  uniqueLabel,
  waitForAgent,
} from "./herdr.ts";
import {
  buildHerdrAgentParams,
  describeAgentProfiles,
} from "./schema.ts";
import {
  claimDetachedAgent,
  clearAgentSpawnWarnings,
  deleteAgentLifecycle,
  emptyHerdrAgentsState,
  loadHerdrAgentsState,
  paneStateKey,
  persistPrunedAgentsState,
  recordAgentLifecycle,
  claimClosedHistory,
  releaseClosedHistory,
  markClosedHistoryInvalid,
  findOwnedClosedHistory,
  stageClosedOneShot,
  finalizeStagedClosedOneShot,
  type ClosedAgentHistoryRecord,
  type HerdrAgentStateRecord,
} from "./state.ts";
import type {
  AgentProfile,
  HerdrAgentInfo,
  HerdrAgentLayout,
  HerdrAgentLifecycle,
  PaneInfo,
} from "./types.ts";
import {
  buildChildToolAllowlist,
  clearAgentQuestion,
  clearAgentResult,
  createAgentTempFiles,
  createResultFile,
  formatAgentOutput,
  formatSpawnWarnings,
  formatWaitInterrupted,
  isRecoverableWaitInterrupt,
  makeHerdrAgentName,
  readAgentQuestion,
  readAgentResult,
  readAgentSessionMeta,
  removeAgentTempFiles,
  RESULT_FILE_MARKER,
  SESSION_META_ENV,
  assertResumableSessionDir,
  titleCase,
  validateResumableSessionFile,
  waitInterruptReason,
} from "./utils.ts";
import {
  AGENTS_WIDGET_ID,
  AGENTS_WIDGET_TICK_MS,
  isSettledAgentStatus,
  renderAgentWidgetLines,
  type StatusTone,
  visibleWidgetAgents,
  type WidgetPaint,
} from "./widget.ts";

function formatLifecycle(lifecycle?: HerdrAgentLifecycle): string {
  if (lifecycle === "oneshot") return "one-shot";
  if (lifecycle === "persistent") return "reusable";
  return "unknown";
}

// Lifecycle state persistence (state.ts) is best-effort: a failure to
// load/save/prune/record/delete must never abort agent execution/output or
// manager listing. This swallows the error and returns a fallback so callers
// can proceed without persisted lifecycle info.
async function bestEffort<T>(fallback: T, task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch {
    return fallback;
  }
}

const RESUME_CLEANUP_TIMEOUT_MS = 8_000;
const FINALIZE_RETRY_ATTEMPTS = 3;

function independentCleanupSignal(
  timeoutMs = RESUME_CLEANUP_TIMEOUT_MS,
): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resumeClosedLiveDecision(input: {
  label: string;
  pane: PaneInfo;
  record?: HerdrAgentStateRecord;
  answeringQuestion: boolean;
}): { action: "reuse" } | { action: "reject"; text: string } {
  if (input.answeringQuestion) return { action: "reuse" };
  if (input.record?.lifecycle === "persistent") return { action: "reuse" };
  const status = input.pane.agent_status;
  if (status === "working" || status === "blocked") {
    return {
      action: "reject",
      text: `A live Herdr agent named "${input.label}" is still working. Omit task to re-wait; do not resume a closed copy over live work.`,
    };
  }
  if (input.record?.detached) {
    return {
      action: "reject",
      text: `A live Herdr agent named "${input.label}" already settled and is waiting to be collected. Re-wait or let the widget deliver it; do not resume a closed copy over live work.`,
    };
  }
  return {
    action: "reject",
    text: `A live Herdr agent named "${input.label}" is still open. Re-wait or answer it; do not resume a closed copy over live work.`,
  };
}

async function rebalanceCurrentPaneAgents(signal?: AbortSignal): Promise<void> {
  const current = await getCurrentContext(signal);
  const state = await bestEffort(emptyHerdrAgentsState(), () =>
    persistPrunedAgentsState(current.panes),
  );
  const agents = listManagedWorkspaceAgents(current, state).filter(
    (agent) => agent.layout === "pane" && agent.tabId === current.currentTab,
  );
  if (agents.length < 2) return;

  const layout = await exportPaneLayout(current.currentPane.pane_id, signal);
  const managedPaneIds = new Set(agents.map((agent) => agent.paneId));
  const updates = buildEqualAgentSplitRatios(layout.root, managedPaneIds);
  for (const update of updates) {
    await setLayoutSplitRatio(layout.tab_id, update.path, update.ratio, signal);
  }
}

/**
 * Close a one-shot pane/tab after durably staging continuation metadata.
 * Stage first; close only after a successful stage; then atomically finalize
 * history as resumable and delete live state.
 */
async function closeOneShot(target: {
  layout?: HerdrAgentLayout;
  tabId: string;
  paneId: string;
  resultFile?: string;
  lifecyclePane?: Pick<PaneInfo, "terminal_id">;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  let stagedId: string | undefined;
  try {
    stagedId = await stageClosedOneShotIfEligible({
      resultFile: target.resultFile,
      lifecyclePane: target.lifecyclePane,
    });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  try {
    await execHerdr(
      // Pane layout dissolves one split; tab and workspace layouts close the
      // agent's whole tab (workspace tabs live in the Agents workspace).
      target.layout === "pane"
        ? ["pane", "close", target.paneId]
        : ["tab", "close", target.tabId],
      target.signal,
    );
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  const finalizeOnce = async () => {
    if (stagedId) {
      await finalizeStagedClosedOneShot({
        historyId: stagedId,
        livePane: target.lifecyclePane,
      });
    } else if (target.lifecyclePane) {
      await deleteAgentLifecycle(target.lifecyclePane);
    }
  };

  let finalizeError: string | undefined;
  for (let attempt = 0; attempt < FINALIZE_RETRY_ATTEMPTS; attempt++) {
    try {
      await finalizeOnce();
      finalizeError = undefined;
      break;
    } catch (error) {
      finalizeError = errorMessage(error);
    }
  }
  if (finalizeError) {
    await bestEffort(false, async () => {
      const panes = await listPanes(independentCleanupSignal());
      const state = await persistPrunedAgentsState(panes);
      if (!stagedId) return true;
      const record = state.closedHistory.find((item) => item.id === stagedId);
      return record?.status === "resumable";
    });
  }

  await bestEffort(undefined, () => removeAgentTempFiles(target.resultFile));
  // Only pane-layout closes change a split column; tab/workspace closes remove
  // whole tabs and must not touch the Orchestrator's pane geometry.
  if (target.layout === "pane") {
    await bestEffort(undefined, () =>
      rebalanceCurrentPaneAgents(target.signal),
    );
  }
  return undefined;
}

async function stageClosedOneShotIfEligible(target: {
  resultFile?: string;
  lifecyclePane?: Pick<PaneInfo, "terminal_id">;
}): Promise<string | undefined> {
  if (!target.lifecyclePane) return undefined;
  let state;
  try {
    state = await loadHerdrAgentsState();
  } catch {
    return undefined;
  }
  const key = paneStateKey(target.lifecyclePane);
  const live = key ? state.agents[key] : undefined;
  if (!live) return undefined;
  if (live.lifecycle !== "oneshot") return undefined;
  if (!live.ownerSessionId || !live.tabLabel || !live.agent) {
    throw new Error(
      `Cannot close "${live.tabLabel ?? "one-shot"}": missing owner/label/profile metadata needed to resume later.`,
    );
  }

  const meta = await readAgentSessionMeta(target.resultFile);
  if (!meta?.sessionFile || !meta.sessionId) {
    throw new Error(
      `Cannot close "${live.tabLabel}": child session metadata is missing, so the one-shot cannot be archived for resume.`,
    );
  }
  const header = await validateResumableSessionFile(meta.sessionFile, {
    sessionId: meta.sessionId,
    cwd: meta.cwd,
  });
  if (!header) {
    throw new Error(
      `Cannot close "${live.tabLabel}": child session file is missing, corrupt, or does not match the stored session id/cwd.`,
    );
  }

  const staged = await stageClosedOneShot({
    ...(live.closedHistoryId ? { id: live.closedHistoryId } : {}),
    livePane: target.lifecyclePane,
    ownerSessionId: live.ownerSessionId,
    ...(live.ownerSessionFile
      ? { ownerSessionFile: live.ownerSessionFile }
      : {}),
    profileName: live.agent,
    tabLabel: live.tabLabel,
    childSessionFile: meta.sessionFile,
    childSessionId: header.id,
    cwd: header.cwd,
    layout: live.layout ?? "pane",
  });
  return staged.id;
}

function herdrChildEnvArgs(sessionMetaFile?: string): string[] {
  const args = [
    "--env",
    "HERDR_AGENT_CHILD=1",
    "--env",
    "PROCESS_LAUNCHED_BY_Q=1",
  ];
  if (sessionMetaFile) {
    args.push("--env", `${SESSION_META_ENV}=${sessionMetaFile}`);
  }
  return args;
}

function orchestratorIdentity(ctx: ExtensionContext): {
  sessionId?: string;
  sessionFile?: string;
} {
  const sessionId = ctx.sessionManager?.getSessionId()?.trim();
  const sessionFile = ctx.sessionManager?.getSessionFile()?.trim();
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(sessionFile ? { sessionFile } : {}),
  };
}

async function buildChildPiArgs(options: {
  agent: AgentProfile;
  tabLabel: string;
  systemFile: string;
  cwd: string;
  sessionFile?: string;
  modelOverride?: string;
}): Promise<{ piArgs: string[]; spawnWarnings: string[] }> {
  const spawnWarnings: string[] = [];
  const piArgs: string[] = [];
  if (!options.sessionFile) {
    piArgs.push("--name", options.tabLabel);
  } else {
    piArgs.push("--session", options.sessionFile);
  }
  const model = options.modelOverride ?? options.agent.model;
  if (model) piArgs.push("--model", model);
  if (options.agent.thinking) {
    const level = resolveThinkingLevel(options.agent.thinking);
    if (level) {
      piArgs.push("--thinking", level);
    } else {
      spawnWarnings.push(
        `Unknown thinking level "${options.agent.thinking}" ignored.`,
      );
    }
  }
  if (Array.isArray(options.agent.skills)) {
    const resolved = await resolveProfileSkills(
      options.agent.skills,
      options.cwd,
    );
    piArgs.push("--no-skills");
    for (const skill of resolved.found) {
      piArgs.push("--skill", skill.filePath);
    }
    if (resolved.missing.length > 0) {
      spawnWarnings.push(`Skills not found: ${resolved.missing.join(", ")}.`);
    }
    spawnWarnings.push(...resolved.diagnostics);
  }
  const toolAllowlist = buildChildToolAllowlist(options.agent.tools);
  if (toolAllowlist) piArgs.push("--tools", toolAllowlist.join(","));
  piArgs.push(
    options.agent.systemPromptMode === "replace"
      ? "--system-prompt"
      : "--append-system-prompt",
    options.systemFile,
  );
  return { piArgs, spawnWarnings };
}

function formatCollectedOutput(
  output: string,
  tabLabel: string,
  closeError: string | undefined,
  warnings: readonly string[],
): string {
  return formatSpawnWarnings(
    formatAgentOutput(output, tabLabel, closeError),
    warnings,
  );
}

async function readSettledAgentOutput(
  resultFile: string | undefined,
  target: string,
  signal?: AbortSignal,
): Promise<{ question: string } | { output: string }> {
  const question = await readAgentQuestion(resultFile);
  if (question) return { question };
  const artifact = await readAgentResult(resultFile);
  return { output: artifact ?? (await readAgent(target, signal)) };
}

async function loadCurrentAgents(): Promise<HerdrAgentInfo[]> {
  const current = await getCurrentContext();
  const state = await bestEffort(emptyHerdrAgentsState(), () =>
    persistPrunedAgentsState(current.panes),
  );
  return listManagedWorkspaceAgents(current, state);
}

// Widget ticks prune only when live terminals disappeared so staged
// history can finalize without a second-long write on every idle tick.
async function loadAgentsForWidget(): Promise<HerdrAgentInfo[]> {
  const current = await getCurrentContext();
  const state = await bestEffort(emptyHerdrAgentsState(), () =>
    persistPrunedAgentsState(current.panes),
  );
  return listManagedWorkspaceAgents(current, state);
}

// An extension instance replaced by /reload keeps its interval alive with a
// stale closure, so the handle lives on globalThis and is cleared on load.
type WidgetTimerHolder = {
  __herdrAgentsWidgetTimer?: ReturnType<typeof setInterval> | null;
};

let widgetTicking = false;

// Labels the Orchestrator is currently blocked on inside a `wait: true` call.
// Kept in-process rather than in the state file: it describes this session's
// call stack, not the agent, and it must stay accurate across the re-wait path
// too. Deliberately not derived from the `herdr:blocked` event — that payload
// is a contract consumed by Herdr's own Pi state extension
// (extensions/herdr-agent-state.ts), so it is left untouched.
const awaitedAgentLabels = new Set<string>();

function beginAwaitingAgent(label: string): void {
  awaitedAgentLabels.add(label);
}

function endAwaitingAgent(label: string): void {
  awaitedAgentLabels.delete(label);
}

function stopAgentsWidgetPoller(): void {
  const holder = globalThis as WidgetTimerHolder;
  if (!holder.__herdrAgentsWidgetTimer) return;
  clearInterval(holder.__herdrAgentsWidgetTimer);
  holder.__herdrAgentsWidgetTimer = null;
}

function themeWidgetPaint(ctx: ExtensionContext): WidgetPaint {
  const theme = ctx.ui.theme;
  const toneColor: Record<StatusTone, "accent" | "warning" | "muted"> = {
    active: "accent",
    attention: "warning",
    quiet: "muted",
  };
  return {
    header: (text) => theme.fg("muted", text),
    elapsed: (text) => theme.fg("dim", text),
    status: (text, tone) => theme.fg(toneColor[tone], text),
  };
}

export const AGENT_RESULT_MESSAGE_TYPE = "herdr_agent_result";
export const AGENT_QUESTION_MESSAGE_TYPE = "herdr_agent_question";

/**
 * Deliver outcomes of agents nobody is waiting for — a finished result, or a
 * question the child asked instead of finishing.
 *
 * This is the half of `wait: false` that was missing: the tool returns
 * immediately, and from then on nothing watches the child, so an uncollected
 * result was simply lost. The widget poller is already a per-second watcher
 * that knows every agent's status, so delivery rides on it rather than adding
 * another loop.
 *
 * The claim is taken *before* sending, and any synchronous collection releases
 * it too, so a result is delivered exactly once no matter which path gets there
 * first.
 *
 * Outcomes found in one tick are sent as a batch with a single turn trigger on
 * the last message. Triggering on the first instead starts a turn that the rest
 * must queue behind as `steer`, and `steer` lands only after that turn's tool
 * calls finish — observed with two agents asking in parallel, where the second
 * question surfaced a whole turn later. Batching makes them arrive together.
 */
async function deliverDetachedOutcomes(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  agents: readonly HerdrAgentInfo[],
): Promise<void> {
  const pending: Array<{
    customType: string;
    content: string;
    display: boolean;
    details: Record<string, unknown>;
  }> = [];

  for (const agent of agents) {
    if (!agent.detached || !agent.terminalId) continue;
    if (!isSettledAgentStatus(agent.status)) continue;

    // Checked before the result, exactly as the blocking path does: a child that
    // asked ends its turn without HERDR_RESULT, so it settles like a completion
    // while the artifact may already hold its assistant text.
    const question = await bestEffort(undefined, () =>
      readAgentQuestion(agent.resultFile),
    );
    if (question) {
      const claimedQuestion = await bestEffort(false, () =>
        claimDetachedAgent({ terminal_id: agent.terminalId }),
      );
      if (!claimedQuestion) continue;

      const spawnWarnings = agent.spawnWarnings ?? [];
      // The target stays open — including one-shots — and `question.md` stays on
      // disk, which is what keeps a parked one-shot reusable by label. The next
      // prompt clears it.
      pending.push({
        customType: AGENT_QUESTION_MESSAGE_TYPE,
        content: formatSpawnWarnings(
          formatAgentQuestion(agent.tabLabel, agent.agent, question),
          spawnWarnings,
        ),
        display: true,
        details: {
          tabLabel: agent.tabLabel,
          agent: agent.agent,
          paneId: agent.paneId,
          lifecycle: agent.lifecycle,
          question,
          ...spawnWarningDetails(spawnWarnings),
        },
      });
      await dropCollectedSpawnWarnings({ terminal_id: agent.terminalId });
      continue;
    }

    const result = await bestEffort(undefined, () =>
      readAgentResult(agent.resultFile),
    );
    // Settled without an artifact means the child produced nothing usable;
    // leave the claim so an explicit re-wait can still read the scrollback.
    if (!result) continue;

    const claimed = await bestEffort(false, () =>
      claimDetachedAgent({ terminal_id: agent.terminalId }),
    );
    if (!claimed) continue;

    // Nobody was waiting — that is the definition of this delivery path — so
    // ping the user through Herdr's own notification channel. Pane-layout
    // agents are already visible on screen, so they stay silent. Best effort:
    // a missing or failing notification never blocks the result delivery.
    if (agent.layout !== "pane") {
      await bestEffort(undefined, () =>
        execHerdr(
          buildAgentFinishedNotificationArgs(
            agent.tabLabel,
            agent.agent,
            result,
          ),
        ),
      );
    }

    // Routing through formatAgentOutput (trim + empty-output placeholder) is
    // equivalent to the old `${result}${closeNote}` only because the claim
    // above already proves readAgentResult returned a non-empty trimmed
    // string; readAgentResult trims and maps "" to undefined.
    let closeError: string | undefined;
    if (agent.lifecycle === "oneshot") {
      // One-shots are closed by whoever collects them. Until now that was
      // always the waiting tool call, which is why `oneshot` required
      // `wait: true`.
      closeError = await closeOneShot({
        layout: agent.layout,
        tabId: agent.tabId,
        paneId: agent.paneId,
        resultFile: agent.resultFile,
        lifecyclePane: { terminal_id: agent.terminalId },
      });
    }

    const resultWithWarnings = formatCollectedOutput(
      result,
      agent.tabLabel,
      closeError,
      agent.spawnWarnings ?? [],
    );
    pending.push({
      customType: AGENT_RESULT_MESSAGE_TYPE,
      content: [
        `Herdr agent ${agent.tabLabel} (${agent.agent}) finished on its own:`,
        "",
        resultWithWarnings,
      ].join("\n"),
      display: true,
      details: {
        tabLabel: agent.tabLabel,
        agent: agent.agent,
        paneId: agent.paneId,
        lifecycle: agent.lifecycle,
        // The renderer shows this on its own under a header; `content` keeps
        // the attribution inline because that is what the model reads.
        result: resultWithWarnings,
      },
    });
    await dropCollectedSpawnWarnings({ terminal_id: agent.terminalId });
  }

  if (pending.length === 0) return;

  // Only the final message triggers a turn. Triggering on the first would start
  // a turn the rest then have to queue behind as `steer`, which is what pushed a
  // second parallel question a whole turn later.
  const deliverAs = ctx.isIdle?.() === false ? "steer" : undefined;
  pending.forEach((message, index) => {
    const last = index === pending.length - 1;
    pi.sendMessage(message, {
      ...(last ? { triggerTurn: true } : {}),
      deliverAs,
    });
  });
}

async function updateAgentsWidget(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  if (widgetTicking) return;
  widgetTicking = true;
  try {
    const agents = await bestEffort<HerdrAgentInfo[]>([], loadAgentsForWidget);

    // Runs before the rendering short-circuits below: a detached agent is
    // hidden from the widget once collected, but its result still has to be
    // delivered.
    await bestEffort(undefined, () => deliverDetachedOutcomes(pi, ctx, agents));

    if (agents.length === 0) {
      stopAgentsWidgetPoller();
      ctx.ui.setWidget(AGENTS_WIDGET_ID, undefined);
      return;
    }

    // Only an empty *managed* set stops the poller. When agents exist but are
    // all hidden (the Orchestrator is blocking on them), keep ticking: one of
    // them can still flip to `blocked`, which is exactly the state the widget
    // must surface.
    const visible = visibleWidgetAgents(agents, awaitedAgentLabels);
    if (visible.length === 0) {
      ctx.ui.setWidget(AGENTS_WIDGET_ID, undefined);
      return;
    }

    ctx.ui.setWidget(
      AGENTS_WIDGET_ID,
      renderAgentWidgetLines(visible, Date.now(), themeWidgetPaint(ctx)),
      { placement: "aboveEditor" },
    );
  } finally {
    widgetTicking = false;
  }
}

function ensureAgentsWidget(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  void updateAgentsWidget(pi, ctx);

  const holder = globalThis as WidgetTimerHolder;
  if (holder.__herdrAgentsWidgetTimer) return;
  const timer = setInterval(() => {
    void updateAgentsWidget(pi, ctx);
  }, AGENTS_WIDGET_TICK_MS);
  timer.unref?.();
  holder.__herdrAgentsWidgetTimer = timer;
}

async function showNoAgentsDialog(ctx: ExtensionCommandContext): Promise<void> {
  await ctx.ui.custom<void>(
    (_tui, theme, _kb, done) => {
      const container = new Container();
      container.addChild(
        new DynamicBorder((str: string) => theme.fg("accent", str)),
      );
      container.addChild(
        new Text(theme.fg("accent", theme.bold("Herdr Agents")), 1, 0),
      );
      container.addChild(
        new Text("No managed Herdr agents.", 1, 0),
      );
      container.addChild(new Text(theme.fg("dim", "enter/esc close"), 1, 0));
      container.addChild(
        new DynamicBorder((str: string) => theme.fg("accent", str)),
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
  action: "focus" | "close";
  agent: HerdrAgentInfo;
}

async function pickAgentAction(
  ctx: ExtensionCommandContext,
  agents: HerdrAgentInfo[],
): Promise<AgentMenuAction | undefined> {
  const result = await ctx.ui.custom<{
    action: "focus" | "close";
    tabId: string;
  } | null>(
    (tui, theme, _kb, done) => {
      const colorStatus = (status: string) => {
        if (status === "working") return theme.fg("accent", status);
        if (status === "blocked") return theme.fg("warning", status);
        if (status === "done") return theme.fg("success", status);
        if (status === "idle") return theme.fg("success", status);
        return theme.fg("dim", status);
      };

      const items: SelectItem[] = agents.map((agent) => ({
        value: agent.tabId,
        label: `${agent.tabLabel} (${agent.agent})`,
        description: [
          `status:${colorStatus(agent.status)}`,
          `mode:${formatLifecycle(agent.lifecycle)}`,
          `pane:${agent.paneId}`,
          agent.cwd,
        ]
          .filter(Boolean)
          .join(" • "),
      }));

      const container = new Container();
      container.addChild(
        new DynamicBorder((str: string) => theme.fg("accent", str)),
      );
      container.addChild(
        new Text(theme.fg("accent", theme.bold("Herdr Agents")), 1, 0),
      );

      const selectList = new SelectList(items, Math.min(items.length, 12), {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      });
      selectList.onSelect = (item) =>
        done({ action: "focus", tabId: item.value });
      selectList.onCancel = () => done(null);

      container.addChild(selectList);
      container.addChild(
        new Text(
          theme.fg(
            "dim",
            "↑↓ navigate • enter focus • d/ctrl+d close • esc close",
          ),
          1,
          0,
        ),
      );
      container.addChild(
        new DynamicBorder((str: string) => theme.fg("accent", str)),
      );

      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          if (data === "d" || matchesKey(data, Key.ctrl("d"))) {
            const selected = selectList.getSelectedItem();
            if (selected) done({ action: "close", tabId: selected.value });
            return;
          }

          selectList.handleInput(data);
          tui.requestRender();
        },
      };
    },
    {
      overlay: true,
      overlayOptions: { width: "70%", minWidth: 60, maxHeight: "80%" },
    },
  );

  if (!result) return undefined;

  const agent = agents.find((agent) => agent.tabId === result.tabId);
  if (!agent) return undefined;

  return { action: result.action, agent };
}

async function showHerdrAgentsManager(
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/herdr-agents requires TUI mode", "error");
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

    if (selected.action === "focus") {
      await execHerdr(
        selected.agent.layout === "pane"
          ? ["agent", "focus", selected.agent.paneId]
          : // Tab ids are workspace-qualified, so this reaches Agents-workspace
            // agents too and makes Herdr switch to that workspace.
            ["tab", "focus", selected.agent.tabId],
      );
      ctx.ui.notify(`Focused Herdr agent "${selected.agent.tabLabel}"`, "info");
      return;
    }

    const question = await readAgentQuestion(selected.agent.resultFile);
    const settled =
      selected.agent.status === "idle" || selected.agent.status === "done";
    if (selected.agent.lifecycle === "oneshot" && (!settled || question)) {
      ctx.ui.notify(
        `Cannot close "${selected.agent.tabLabel}": it is still running or waiting on a question. Answer it or wait for it to finish so history can be saved.`,
        "warning",
      );
      continue;
    }
    if (selected.agent.lifecycle === "oneshot") {
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
          "error",
        );
        continue;
      }
      ctx.ui.notify(`Closed Herdr agent "${selected.agent.tabLabel}"`, "info");
      continue;
    }

    await execHerdr(
      selected.agent.layout === "pane"
        ? ["pane", "close", selected.agent.paneId]
        : ["tab", "close", selected.agent.tabId],
    );
    await bestEffort(undefined, () =>
      removeAgentTempFiles(selected.agent.resultFile),
    );
    if (selected.agent.layout === "pane") {
      await bestEffort(undefined, () => rebalanceCurrentPaneAgents());
    }
    ctx.ui.notify(`Closed Herdr agent "${selected.agent.tabLabel}"`, "info");
  }
}

let pendingRunDelegation: RunDelegationRequest | null = null;
let panePlacementQueue: Promise<void> = Promise.resolve();

async function acquirePanePlacementLock(): Promise<() => void> {
  const previous = panePlacementQueue;
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  panePlacementQueue = previous.then(() => current);
  await previous;
  return release;
}

function resumedDetails(resumed: boolean): { resumed?: boolean } {
  return resumed ? { resumed: true } : {};
}

function spawnWarningDetails(
  warnings: readonly string[],
): { spawnWarnings?: string[] } {
  return warnings.length > 0 ? { spawnWarnings: [...warnings] } : {};
}

async function dropCollectedSpawnWarnings(
  pane: Pick<PaneInfo, "terminal_id"> | undefined,
): Promise<void> {
  if (!pane?.terminal_id) return;
  await bestEffort(undefined, () => clearAgentSpawnWarnings(pane));
}

async function executeRewait(
  pi: ExtensionAPI,
  args: {
    agent: AgentProfile;
    tabLabel: string | undefined;
    baseLabel: string;
    layout: HerdrAgentLayout;
    wait: boolean;
    timeoutMs: number;
    signal?: AbortSignal;
    onUpdate?: AgentToolUpdateCallback<Record<string, unknown>>;
  },
) {
  const { agent, baseLabel, layout, wait, timeoutMs, signal, onUpdate } = args;
  if (!args.tabLabel?.trim()) {
    return {
      content: [
        {
          type: "text" as const,
          text: "tabLabel is required when task is omitted (re-wait mode).",
        },
      ],
      isError: true,
    };
  }

  const current = await getCurrentContext(signal);
  const state = await bestEffort(emptyHerdrAgentsState(), () =>
    persistPrunedAgentsState(current.panes),
  );
  // Tab and workspace layouts reuse by tab label; workspace tabs live in the
  // dedicated Agents workspace, so they are listed from there. Re-wait is a
  // pure lookup — it must never create the workspace, so a missing one just
  // means there is nothing to find.
  const usesTabs = layout === "tab" || layout === "workspace";
  const agentsWorkspaceId =
    layout === "workspace"
      ? await findAgentsWorkspaceId(
          getHerdrAgentsWorkspaceLabel(await loadHerdrAgentsConfig()),
          signal,
        )
      : undefined;
  const tabs =
    usesTabs && (layout !== "workspace" || agentsWorkspaceId)
      ? await listTabs(agentsWorkspaceId ?? current.workspaceId, signal)
      : [];
  const reusableTab = usesTabs
    ? findReusableAgentTab(current, tabs, baseLabel, state)
    : undefined;
  const reusablePane =
    layout === "pane"
      ? findReusableAgentPane(current, state, baseLabel)
      : undefined;
  const pane = reusableTab?.pane ?? reusablePane;
  const tabId = reusableTab?.tab.tab_id ?? reusablePane?.tab_id;
  const label = reusableTab?.tab.label ?? baseLabel;
  const stateKey = pane ? paneStateKey(pane) : undefined;
  const record = stateKey ? state.agents[stateKey] : undefined;
  const target = record?.automationName ?? pane?.pane_id;
  if (!pane || !tabId || !target) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No running Herdr agent named "${baseLabel}" found to re-wait on.`,
        },
      ],
      isError: true,
    };
  }

  onUpdate?.({
    content: [
      {
        type: "text",
        text: `Reconnecting to existing Herdr agent ${label} (${pane.pane_id})...`,
      },
    ],
    details: { tabId, paneId: pane.pane_id, tabLabel: label, agent },
  });

  if (!wait) {
    const spawnWarnings = record?.spawnWarnings ?? [];
    return {
      content: [
        {
          type: "text" as const,
          text: formatSpawnWarnings(
            `Herdr agent ${label} (${pane.pane_id}) is still running.`,
            spawnWarnings,
          ),
        },
      ],
      details: {
        tabId,
        paneId: pane.pane_id,
        tabLabel: label,
        agent,
        waited: false,
        ...spawnWarningDetails(spawnWarnings),
      },
    };
  }

  const blockedLabel = `waiting for ${label}`;
  pi.events.emit("herdr:blocked", { active: true, label: blockedLabel });
  beginAwaitingAgent(label);
  try {
    await waitForAgent(target, timeoutMs, signal);
    const settled = await readSettledAgentOutput(
      record?.resultFile,
      target,
      signal,
    );
    if ("question" in settled) {
      const spawnWarnings = record?.spawnWarnings ?? [];
      await dropCollectedSpawnWarnings(pane);
      return {
        content: [
          {
            type: "text" as const,
            text: formatSpawnWarnings(
              formatAgentQuestion(
                label,
                record?.agent ?? agent.name,
                settled.question,
              ),
              spawnWarnings,
            ),
          },
        ],
        details: {
          tabId,
          paneId: pane.pane_id,
          tabLabel: label,
          lifecycle: record?.lifecycle,
          closed: false,
          agent,
          waited: true,
          status: "question",
          ...spawnWarningDetails(spawnWarnings),
        },
      };
    }
    // An explicit re-wait collects the result, so release the poller's claim.
    await bestEffort(false, () => claimDetachedAgent(pane));
    let closed = false;
    let closeError: string | undefined;
    if (record?.lifecycle === "oneshot") {
      closeError = await closeOneShot({
        layout: record.layout,
        tabId,
        paneId: pane.pane_id,
        resultFile: record.resultFile,
        lifecyclePane: pane,
        signal,
      });
      closed = closeError === undefined;
    }
    const spawnWarnings = record?.spawnWarnings ?? [];
    const text = formatCollectedOutput(
      settled.output,
      label,
      closeError,
      spawnWarnings,
    );
    await dropCollectedSpawnWarnings(pane);
    return {
      content: [{ type: "text" as const, text }],
      details: {
        tabId,
        paneId: pane.pane_id,
        tabLabel: label,
        agent,
        waited: true,
        closed,
        closeError,
        ...spawnWarningDetails(spawnWarnings),
      },
    };
  } catch (error) {
    if (isRecoverableWaitInterrupt(error)) {
      const reason = waitInterruptReason(error);
      const spawnWarnings = record?.spawnWarnings ?? [];
      return {
        content: [
          {
            type: "text" as const,
            text: formatSpawnWarnings(
              formatWaitInterrupted(label, reason),
              spawnWarnings,
            ),
          },
        ],
        details: {
          tabId,
          paneId: pane.pane_id,
          tabLabel: label,
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
    endAwaitingAgent(label);
    pi.events.emit("herdr:blocked", {
      active: false,
      label: blockedLabel,
    });
  }
}

export default function herdrAgentsExtension(pi: ExtensionAPI) {
  if (process.env.HERDR_AGENT_CHILD === "1") {
    registerChildMode(pi);
    return;
  }

  registerHerdrAgentTool(pi);
  // A /reload leaves the previous instance's poller running with a stale ctx.
  stopAgentsWidgetPoller();

  // Delivered results arrive outside any turn the user started. With plain text
  // at the usual output padding they read as a continuation of the assistant's
  // own output, so they get an explicit bordered block with a header instead.
  const registerAgentBlockRenderer = (
    customType: string,
    suffix: string,
    tone: "accent" | "warning",
  ) => {
    pi.registerMessageRenderer(customType, (message, options, theme) => {
      const { expanded, outputPad } = options;
      const details = message.details as
        | {
            tabLabel?: string;
            agent?: string;
            result?: string;
            question?: string;
          }
        | undefined;
      const label = details?.tabLabel ?? "agent";
      const profile = details?.agent ? ` · ${details.agent}` : "";
      const border = (str: string) => theme.fg(tone, str);

      const box = new Box(outputPad, 0, (t) => theme.bg("customMessageBg", t));
      box.addChild(new DynamicBorder(border));
      box.addChild(
        new Text(
          theme.fg(tone, theme.bold(`Herdr agent ${label}${profile}${suffix}`)),
          1,
          0,
        ),
      );
      // The header carries the attribution the content also states for the
      // model's benefit, so display the bare body and avoid repeating it.
      box.addChild(
        new Text(details?.result ?? details?.question ?? message.content, 1, 0),
      );
      if (expanded && message.details) {
        box.addChild(
          new Text(
            theme.fg("dim", JSON.stringify(message.details, null, 2)),
            1,
            0,
          ),
        );
      }
      box.addChild(new DynamicBorder(border));
      return box;
    });
  };

  registerAgentBlockRenderer(AGENT_RESULT_MESSAGE_TYPE, "", "accent");
  // A question needs the Orchestrator to act, so it is toned apart from a result.
  registerAgentBlockRenderer(
    AGENT_QUESTION_MESSAGE_TYPE,
    " · asked a question",
    "warning",
  );

  pi.on("session_start", async (_event, ctx) => {
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
  pi.on("session_shutdown", async () => {
    stopAgentsWidgetPoller();
  });

  pi.on("before_agent_start", async (event) => {
    let instructions = GLOBAL_INSTRUCTIONS;

    if (pendingRunDelegation) {
      const runRequest = pendingRunDelegation;
      pendingRunDelegation = null;
      instructions = `${instructions}\n\n${buildRunTurnInstructions(runRequest.agent)}`;
    }

    return {
      systemPrompt: `${event.systemPrompt}\n\n${instructions}`,
    };
  });

  pi.registerCommand("run", {
    description: "Explicitly delegate a task to a Herdr agent",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const agents = ["scout", "researcher", "planner", "worker", "reviewer"];
      const [first = "", ...rest] = prefix.trimStart().split(/\s+/);
      const taskPrefix = rest.join(" ");

      if (!prefix.trim() || (!taskPrefix && !prefix.includes(" "))) {
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
          "Usage: /run [agent] <task> — e.g. /run scout find auth flow",
          "warning",
        );
        return;
      }

      if (!ctx.isIdle()) {
        ctx.ui.notify(
          "Agent is busy. Wait for the current turn to finish.",
          "warning",
        );
        return;
      }

      pendingRunDelegation = parsed;
      pi.sendUserMessage(formatRunUserMessage(parsed));
    },
  });

  pi.registerCommand("council", {
    description: "Ask one question to several models in parallel and consolidate",
    handler: async (args, ctx) => {
      const question = parseCouncilArgs(args);
      if (!question) {
        ctx.ui.notify(
          "Usage: /council <question> — asked to every model in council.json",
          "warning",
        );
        return;
      }

      if (!ctx.isIdle()) {
        ctx.ui.notify(
          "Agent is busy. Wait for the current turn to finish.",
          "warning",
        );
        return;
      }

      const configPath = join(getAgentDir(), "council.json");
      const { models, error } = await readCouncilConfig(configPath);
      if (models.length === 0) {
        ctx.ui.notify(
          error
            ? `council.json could not be read (${error})`
            : `No council models configured in ${configPath} — add {"models":["..."]}`,
          "warning",
        );
        return;
      }

      pi.sendUserMessage(formatCouncilUserMessage(question, models));
    },
  });

  pi.registerCommand("herdr-agents", {
    description: "Show, focus, and close managed Herdr agents",
    handler: async (_args, ctx) => {
      try {
        await showHerdrAgentsManager(ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to load Herdr agents: ${message}`, "error");
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
    name: "herdr_agent",
    label: "Herdr Agent",
    description:
      "Spawn a one-shot Herdr agent or reuse a persistent Herdr agent with a named profile from ~/.pi/agent/agents. Reusing a persistent agent requires lifecycle: 'persistent' and the same tabLabel on every follow-up call.",
    promptSnippet:
      "Delegate exploration, research, planning, review, and isolated implementation to a one-shot or persistent Herdr agent.",
    promptGuidelines: [
      "Use herdr_agent when global Delegation says isolated context helps; call after /run, a named role, or explicit delegation request.",
      "Follow the Herdr agents system instructions for lifecycle, self-contained tasks, independent parallel calls, avoiding duplicate work, and re-wait.",
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
          listable.map((item) => item.name).join(", ") || "none";
        return {
          content: [
            {
              type: "text",
              text: `Unknown Herdr agent: ${params.agent}. Available: ${available}`,
            },
          ],
          details: { availableAgents: listable },
          isError: true,
        };
      }

      // Detach is the default in UI sessions (the widget poller delivers the
      // result); headless sessions block because nothing would collect it.
      const wait = params.wait ?? !ctx.hasUI;
      const config = await loadHerdrAgentsConfig();
      const layout = getHerdrAgentsLayout(config);
      const lifecycle = params.lifecycle ?? "oneshot";
      let activeLifecycle = lifecycle;
      const persistent = lifecycle === "persistent";
      const timeoutMs = params.timeoutMs ?? 600000;
      const baseLabel = params.tabLabel?.trim() || titleCase(agent.name);
      const resumeClosed = params.resumeClosed === true;
      const owner = orchestratorIdentity(ctx);

      if (resumeClosed) {
        if (!params.task?.trim()) {
          return {
            content: [
              {
                type: "text",
                text: "resumeClosed requires a non-empty task. Omit resumeClosed and task to re-wait on a still-running agent.",
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
                type: "text",
                text: "resumeClosed requires an explicit non-empty tabLabel.",
              },
            ],
            details: { resumeClosed: true, waited: false },
            isError: true,
          };
        }
        if (persistent) {
          return {
            content: [
              {
                type: "text",
                text: "resumeClosed is only supported for one-shot agents. Use lifecycle: 'oneshot' or omit lifecycle.",
              },
            ],
            details: { resumeClosed: true, lifecycle, waited: false },
            isError: true,
          };
        }
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

      // Detached collection needs the widget poller, so any explicit
      // wait: false is forbidden where no poller runs.
      if (!wait && !ctx.hasUI) {
        return {
          content: [
            {
              type: "text",
              text: "wait: false requires a UI session with the agents widget poller; requires wait: true in a headless session because nothing would deliver the result or close the agent.",
            },
          ],
          details: { lifecycle, waited: false },
          isError: true,
        };
      }

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
        layout === "pane" || layout === "workspace"
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
        if (layout === "workspace") {
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
                  type: "text",
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
        const usesTabs = layout === "tab" || layout === "workspace";
        const tabs = usesTabs
          ? await listTabs(agentsWorkspaceId ?? current.workspaceId, signal)
          : [];
        const state = await bestEffort(emptyHerdrAgentsState(), () =>
          persistPrunedAgentsState(current.panes),
        );

        // Reuse is normally a persistent-only affordance, but a one-shot parked
        // on an unanswered question has to be reachable by label too: the
        // answer arrives as a normal `task`, and without reuse it would spawn a
        // second agent and orphan the parked one forever.
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
            !persistent &&
            !!candidateRecord &&
            (await bestEffort(undefined, () =>
              readAgentQuestion(candidateRecord.resultFile),
            )) !== undefined;

          // A task addressed by label to a live persistent agent without
          // lifecycle: "persistent" is almost certainly a failed reuse: the
          // default oneshot lifecycle would silently spawn a duplicate
          // agent ("... #2") instead of sending the task to the existing
          // pane. Fail loudly with the fix instead.
          if (
            !persistent &&
            !resumeClosed &&
            !answeringQuestion &&
            candidatePane &&
            candidateRecord?.lifecycle === "persistent"
          ) {
            return {
              content: [
                {
                  type: "text",
                  text: `A live persistent Herdr agent named "${baseLabel}" exists. To send this task to it, repeat lifecycle: "persistent" with the same tabLabel — omitting lifecycle defaults to "oneshot", which would spawn a duplicate agent instead of reusing it. If you actually want a fresh one-shot agent, keep lifecycle unset but pass a different tabLabel.`,
                },
              ],
              details: {
                tabLabel: baseLabel,
                paneId: candidatePane.pane_id,
                existingLifecycle: "persistent",
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
            if (decision.action === "reject") {
              return {
                content: [{ type: "text", text: decision.text }],
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

          if (
            (persistent ||
              answeringQuestion ||
              (resumeClosed &&
                candidateRecord?.lifecycle === "persistent")) &&
            candidatePane
          ) {
            reused = true;
            if (candidateRecord?.lifecycle === "persistent") {
              activeLifecycle = "persistent";
            }
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
                  type: "text",
                  text: "Cannot resume a closed agent: this Orchestrator session has no session id.",
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
                  type: "text",
                  text: `No closed one-shot Herdr agent named "${params.tabLabel!.trim()}" is owned by this Orchestrator session.`,
                },
              ],
              details: { resumeClosed: true, waited: false },
              isError: true,
            };
          }
          if (existing.status === "claimed") {
            return {
              content: [
                {
                  type: "text",
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
                  type: "text",
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
                  type: "text",
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
              content: [{ type: "text", text: claimed.error }],
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
            .join("\n\n");
          const tempFiles = await createAgentTempFiles(profilePrompt);
          resultFile = tempFiles.resultFile;
          sessionMetaFile = tempFiles.sessionMetaFile;
          systemFile = tempFiles.systemFile;
        }

        if (!reused && usesTabs) {
          if (!resumeClaim) tabLabel = uniqueLabel(baseLabel, tabs);
          const createOutput = await execHerdr(
            [
              "tab",
              "create",
              "--workspace",
              agentsWorkspaceId ?? current.workspaceId,
              "--label",
              tabLabel,
              "--cwd",
              resumeClaim?.cwd ?? ctx.cwd,
              ...herdrChildEnvArgs(sessionMetaFile),
              "--no-focus",
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
          if (!rootPane || typeof rootPane.pane_id !== "string") {
            throw new Error(
              `Malformed Herdr tab create output: missing result.root_pane.pane_id. Output: ${createOutput}`,
            );
          }
          paneId = rootPane.pane_id;
          agentPane = rootPane;
          tabId =
            typeof rootPane.tab_id === "string" ? rootPane.tab_id : undefined;

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
        // still leaves a same-label parallel persistent-spawn window, which the
        // reuse contract already rules out (reuse is sequential by tabLabel).
        // Best effort: close the known root shell tab `workspace create`
        // starts every new workspace with. Only the creating spawn does this,
        // and only by id — never by "empty pane" heuristics, which can race
        // a sibling spawn whose agent is not started yet.
        if (layout === "workspace") {
          if (
            agentsWorkspaceCreated &&
            !reused &&
            agentsWorkspaceRootTabId
          ) {
            await bestEffort(undefined, () =>
              execHerdr(
                ["tab", "close", agentsWorkspaceRootTabId],
                signal,
              ),
            );
          }
          releasePlacementOnce();
        }

        if (!reused && layout === "pane") {
          const managedAgents = listManagedWorkspaceAgents(
            current,
            state,
          ).filter(
            (item) =>
              item.layout === "pane" && item.tabId === current.currentTab,
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
              ["pane", "layout", "--pane", current.currentPane.pane_id],
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
              "pane",
              "split",
              splitTarget?.pane_id ?? current.currentPane.pane_id,
              "--direction",
              splitTarget ? "down" : "right",
              "--ratio",
              splitTarget ? "0.5" : "0.6",
              "--cwd",
              resumeClaim?.cwd ?? ctx.cwd,
              ...herdrChildEnvArgs(sessionMetaFile),
              "--no-focus",
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
          if (!createdPane || typeof createdPane.pane_id !== "string") {
            throw new Error(
              `Malformed Herdr pane split output: missing result.pane.pane_id. Output: ${createOutput}`,
            );
          }
          paneId = createdPane.pane_id;
          tabId = createdPane.tab_id || current.currentTab;
          agentPane = createdPane;
          await execHerdr(["pane", "rename", paneId, tabLabel], signal);
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
            ...(params.model?.trim() ? { modelOverride: params.model.trim() } : {}),
            ...(resumeClaim
              ? { sessionFile: resumeClaim.childSessionFile }
              : {}),
          });
          spawnWarnings = built.spawnWarnings;
          const piArgs = built.piArgs;

          onUpdate?.({
            content: [
              {
                type: "text",
                text: resumed
                  ? `Resuming Herdr agent ${tabLabel} (${paneId})...`
                  : `Starting Herdr agent ${tabLabel} (${paneId})...`,
              },
            ],
            details: {
              tabId,
              paneId,
              tabLabel,
              lifecycle,
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
            recordAgentLifecycle(agentPane!, activeLifecycle, {
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
        if (layout === "pane") {
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
                layout === "pane"
                  ? ["pane", "close", paneId!]
                  : ["tab", "close", tabId!],
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
        "",
        "Task from Orchestrator:",
        task,
        "",
        "Your final assistant response is captured as the structured result artifact.",
        `${RESULT_FILE_MARKER} ${resultFile}`,
      ].join("\n");

      await clearAgentResult(resultFile);
      // A leftover question from the previous turn would otherwise be reported
      // again as soon as this prompt finishes.
      await clearAgentQuestion(resultFile);

      onUpdate?.({
        content: [
          {
            type: "text",
            text: `${reused ? "Sending task to" : "Waiting for"} Herdr agent ${tabLabel} (${paneId})...`,
          },
        ],
        details: { tabId, paneId, tabLabel, lifecycle, reused, agent },
      });

      const blockedLabel = `waiting for ${tabLabel}`;
      if (wait) {
        pi.events.emit("herdr:blocked", {
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
                type: "text",
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
              lifecycle,
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
        if ("question" in settled) {
          await dropCollectedSpawnWarnings(agentPane);
          return {
            content: [
              {
                type: "text",
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
              lifecycle,
              reused,
              ...resumedDetails(resumed),
              closed: false,
              agent,
              waited: true,
              status: "question",
              ...spawnWarningDetails(spawnWarnings),
            },
          };
        }

        // Whoever collects first owns the result. Releasing the claim here stops
        // the poller from delivering the same result a second time.
        if (agentPane) {
          await bestEffort(false, () => claimDetachedAgent(agentPane!));
        }

        let closed = false;
        let closeError: string | undefined;
        if (activeLifecycle === "oneshot") {
          closeError = await closeOneShot({
            layout,
            tabId,
            paneId,
            resultFile,
            lifecyclePane: agentPane,
            signal,
          });
          closed = closeError === undefined;
        }

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
              type: "text",
              text,
            },
          ],
          details: {
            tabId,
            paneId,
            tabLabel,
            lifecycle,
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
                type: "text",
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
              lifecycle,
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
          pi.events.emit("herdr:blocked", {
            active: false,
            label: blockedLabel,
          });
        }
      }
    },
  });
}
}
