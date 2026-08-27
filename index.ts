import {
  DynamicBorder,
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
import { discoverAgents } from "./agents.ts";
import { registerChildMode } from "./child.ts";
import { getHerdrAgentsLayout } from "./config.ts";
import {
  buildRunTurnInstructions,
  CHILD_PROTOCOL,
  formatAgentQuestion,
  GLOBAL_INSTRUCTIONS,
} from "./constants.ts";
import {
  formatRunUserMessage,
  parseRunArgs,
  type RunDelegationRequest,
} from "./run.ts";
import {
  buildEqualAgentSplitRatios,
  chooseAgentColumnSplitTarget,
  execHerdr,
  exportPaneLayout,
  findReusableAgentPane,
  findReusableAgentTab,
  getCurrentContext,
  listManagedWorkspaceAgents,
  listPanes,
  listTabs,
  promptAgent,
  readAgent,
  setLayoutSplitRatio,
  startAgent,
  uniqueLabel,
  waitForAgent,
} from "./herdr.ts";
import { HerdrAgentParams } from "./schema.ts";
import {
  claimDetachedAgent,
  deleteAgentLifecycle,
  emptyHerdrAgentsState,
  loadHerdrAgentsState,
  paneStateKey,
  pruneHerdrAgentsState,
  recordAgentLifecycle,
  saveHerdrAgentsState,
} from "./state.ts";
import type { HerdrAgentInfo, HerdrAgentLifecycle, PaneInfo } from "./types.ts";
import {
  buildChildToolAllowlist,
  clearAgentQuestion,
  clearAgentResult,
  createAgentTempFiles,
  createResultFile,
  formatAgentOutput,
  formatWaitInterrupted,
  isRecoverableWaitInterrupt,
  makeHerdrAgentName,
  readAgentQuestion,
  readAgentResult,
  removeAgentTempFiles,
  RESULT_FILE_MARKER,
  shouldCloseTab,
  titleCase,
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

async function rebalanceCurrentPaneAgents(signal?: AbortSignal): Promise<void> {
  const current = await getCurrentContext(signal);
  const state = await loadHerdrAgentsState();
  if (pruneHerdrAgentsState(state, current.panes)) {
    await saveHerdrAgentsState(state);
  }
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

async function loadCurrentAgents(): Promise<HerdrAgentInfo[]> {
  const current = await getCurrentContext();
  const state = await bestEffort(emptyHerdrAgentsState(), () =>
    loadHerdrAgentsState(),
  );
  await bestEffort(undefined, async () => {
    if (pruneHerdrAgentsState(state, current.panes)) {
      await saveHerdrAgentsState(state);
    }
  });
  return listManagedWorkspaceAgents(current, state);
}

// Unlike loadCurrentAgents(), this deliberately skips prune/save: it runs on a
// one-second timer, and writing the state file for a read-only display would be
// wasteful. Stale records are still reconciled by the paths that do prune.
async function loadAgentsForWidget(): Promise<HerdrAgentInfo[]> {
  const current = await getCurrentContext();
  const state = await loadHerdrAgentsState();
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

/**
 * Deliver results of agents nobody is waiting for.
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
 */
async function deliverDetachedResults(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  agents: readonly HerdrAgentInfo[],
): Promise<void> {
  for (const agent of agents) {
    if (!agent.detached || !agent.terminalId) continue;
    if (!isSettledAgentStatus(agent.status)) continue;

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

    let closeNote = "";
    if (agent.lifecycle === "oneshot") {
      // One-shots are closed by whoever collects them. Until now that was
      // always the waiting tool call, which is why `oneshot` required
      // `wait: true`.
      try {
        await execHerdr(
          agent.layout === "tab"
            ? ["tab", "close", agent.tabId]
            : ["pane", "close", agent.paneId],
        );
        await bestEffort(undefined, () =>
          deleteAgentLifecycle({ terminal_id: agent.terminalId }),
        );
        await bestEffort(undefined, () =>
          removeAgentTempFiles(agent.resultFile),
        );
        if (agent.layout !== "tab") {
          await bestEffort(undefined, () => rebalanceCurrentPaneAgents());
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        closeNote = `\n\nWarning: failed to close one-shot Herdr agent ${agent.tabLabel}: ${message}`;
      }
    }

    pi.sendMessage(
      {
        customType: AGENT_RESULT_MESSAGE_TYPE,
        content: [
          `Herdr agent ${agent.tabLabel} (${agent.agent}) finished on its own:`,
          "",
          result,
          closeNote,
        ].join("\n"),
        display: true,
        details: {
          tabLabel: agent.tabLabel,
          agent: agent.agent,
          paneId: agent.paneId,
          lifecycle: agent.lifecycle,
          // The renderer shows this on its own under a header; `content` keeps
          // the attribution inline because that is what the model reads.
          result: `${result}${closeNote}`,
        },
      },
      {
        triggerTurn: true,
        deliverAs: ctx.isIdle?.() === false ? "steer" : undefined,
      },
    );
  }
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
    await bestEffort(undefined, () => deliverDetachedResults(pi, ctx, agents));

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
        new Text("No Herdr agents in the current workspace.", 1, 0),
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
          : ["tab", "focus", selected.agent.tabId],
      );
      ctx.ui.notify(`Focused Herdr agent "${selected.agent.tabLabel}"`, "info");
      return;
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

export default function herdrAgentsExtension(pi: ExtensionAPI) {
  if (process.env.HERDR_AGENT_CHILD === "1") {
    registerChildMode(pi);
    return;
  }

  // A /reload leaves the previous instance's poller running with a stale ctx.
  stopAgentsWidgetPoller();

  // Delivered results arrive outside any turn the user started. With plain text
  // at the usual output padding they read as a continuation of the assistant's
  // own output, so they get an explicit bordered block with a header instead.
  pi.registerMessageRenderer(
    AGENT_RESULT_MESSAGE_TYPE,
    (message, options, theme) => {
      const { expanded, outputPad } = options;
      const details = message.details as
        { tabLabel?: string; agent?: string; result?: string } | undefined;
      const label = details?.tabLabel ?? "agent";
      const profile = details?.agent ? ` · ${details.agent}` : "";
      const border = (str: string) => theme.fg("accent", str);

      const box = new Box(outputPad, 0, (t) => theme.bg("customMessageBg", t));
      box.addChild(new DynamicBorder(border));
      box.addChild(
        new Text(
          theme.fg("accent", theme.bold(`Herdr agent ${label}${profile}`)),
          1,
          0,
        ),
      );
      // The header carries the attribution the content also states for the
      // model's benefit, so display the bare result and avoid repeating it.
      box.addChild(new Text(details?.result ?? message.content, 1, 0));
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
    },
  );

  pi.on("session_start", async (_event, ctx) => {
    ensureAgentsWidget(pi, ctx);
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

  pi.registerCommand("herdr-agents", {
    description: "Show and kill Herdr agents in the current workspace",
    handler: async (_args, ctx) => {
      try {
        await showHerdrAgentsManager(ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to load Herdr agents: ${message}`, "error");
      }
    },
  });

  pi.registerTool({
    name: "herdr_agent",
    label: "Herdr Agent",
    description:
      "Spawn a one-shot Herdr agent or reuse a persistent Herdr agent with a named profile from ~/.pi/agent/agents.",
    promptSnippet:
      "Delegate exploration, research, planning, review, and isolated implementation to a one-shot or persistent Herdr agent.",
    promptGuidelines: [
      "Use herdr_agent when global Delegation says isolated context helps; call after /run, a named role, or explicit delegation request.",
      "Follow the Herdr agents system instructions for lifecycle, self-contained tasks, independent parallel calls, avoiding duplicate work, and re-wait.",
    ],
    parameters: HerdrAgentParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const agents = await discoverAgents(ctx.cwd);
      const agent = agents.find((item) => item.name === params.agent);
      if (!agent) {
        const available = agents.map((item) => item.name).join(", ") || "none";
        return {
          content: [
            {
              type: "text",
              text: `Unknown Herdr agent: ${params.agent}. Available: ${available}`,
            },
          ],
          details: { availableAgents: agents },
          isError: true,
        };
      }

      const wait = params.wait ?? true;
      const layout = getHerdrAgentsLayout();
      const lifecycle = params.lifecycle ?? "oneshot";
      const persistent = lifecycle === "persistent";
      const closeAfterWait = shouldCloseTab(lifecycle);
      const timeoutMs = params.timeoutMs ?? 600000;
      const baseLabel = params.tabLabel?.trim() || titleCase(agent.name);

      if (params.task === undefined) {
        // Re-wait mode: no new task, just reconnect to an existing tab that is
        // (expected to be) still running — e.g. after a previous call to this
        // tool timed out while the agent kept working. It only invokes the
        // server-owned agent wait, so no prompt is re-sent into a busy pane.
        if (!params.tabLabel?.trim()) {
          return {
            content: [
              {
                type: "text",
                text: "tabLabel is required when task is omitted (re-wait mode).",
              },
            ],
            isError: true,
          };
        }

        const current = await getCurrentContext(signal);
        const state = await bestEffort(emptyHerdrAgentsState(), () =>
          loadHerdrAgentsState(),
        );
        const tabs =
          layout === "tab" ? await listTabs(current.workspaceId, signal) : [];
        const reusableTab =
          layout === "tab"
            ? findReusableAgentTab(current, tabs, baseLabel)
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
                type: "text",
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
          return {
            content: [
              {
                type: "text",
                text: `Herdr agent ${label} (${pane.pane_id}) is still running.`,
              },
            ],
            details: {
              tabId,
              paneId: pane.pane_id,
              tabLabel: label,
              agent,
              waited: false,
            },
          };
        }

        const blockedLabel = `waiting for ${label}`;
        pi.events.emit("herdr:blocked", { active: true, label: blockedLabel });
        beginAwaitingAgent(label);
        try {
          await waitForAgent(target, timeoutMs, signal);
          const pendingQuestion = await readAgentQuestion(record?.resultFile);
          if (pendingQuestion) {
            return {
              content: [
                {
                  type: "text",
                  text: formatAgentQuestion(
                    label,
                    record?.agent ?? agent.name,
                    pendingQuestion,
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
              },
            };
          }
          const artifact = await readAgentResult(record?.resultFile);
          const output = artifact ?? (await readAgent(target, signal));
          // An explicit re-wait collects the result, so release the poller's claim.
          await bestEffort(false, () => claimDetachedAgent(pane));
          let closed = false;
          let closeError: string | undefined;
          if (record?.lifecycle === "oneshot") {
            try {
              await execHerdr(
                record.layout === "tab"
                  ? ["tab", "close", tabId]
                  : ["pane", "close", pane.pane_id],
                signal,
              );
              await bestEffort(undefined, () => deleteAgentLifecycle(pane));
              await bestEffort(undefined, () =>
                removeAgentTempFiles(record.resultFile),
              );
              if (record.layout !== "tab") {
                await bestEffort(undefined, () =>
                  rebalanceCurrentPaneAgents(signal),
                );
              }
              closed = true;
            } catch (error) {
              closeError =
                error instanceof Error ? error.message : String(error);
            }
          }
          const text = formatAgentOutput(output, label, closeError);
          return {
            content: [{ type: "text", text }],
            details: {
              tabId,
              paneId: pane.pane_id,
              tabLabel: label,
              agent,
              waited: true,
              closed,
              closeError,
            },
          };
        } catch (error) {
          if (isRecoverableWaitInterrupt(error)) {
            const reason = waitInterruptReason(error);
            return {
              content: [
                {
                  type: "text",
                  text: formatWaitInterrupted(label, reason),
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

      // A detached one-shot is closed by the poller after it delivers the
      // result, so this only has to stay forbidden where no poller runs.
      if (lifecycle === "oneshot" && !wait && !ctx.hasUI) {
        return {
          content: [
            {
              type: "text",
              text: "lifecycle: 'oneshot' requires wait: true in a headless session: without the agents widget poller nothing would deliver the result or close the agent.",
            },
          ],
          details: { lifecycle, waited: false },
          isError: true,
        };
      }

      const task = params.task;
      if (task === undefined) {
        // Unreachable: the re-wait branch above returns early when task is
        // omitted. This satisfies the type checker that `task` is a string
        // from here on.
        throw new Error("Unreachable: task is required past this point.");
      }

      let tabLabel = baseLabel;
      let tabId: string | undefined;
      let paneId: string | undefined;
      let agentPane: PaneInfo | undefined;
      let automationName: string | undefined;
      let resultFile: string | undefined;
      let reused = false;
      const releasePlacement =
        layout === "pane" ? await acquirePanePlacementLock() : () => {};

      try {
        // Refresh context only after acquiring the short placement lock so
        // parallel calls see panes and labels created by earlier calls.
        const current = await getCurrentContext(signal);

        await execHerdr(["tab", "rename", current.currentTab, "agent"], signal);

        const tabs =
          layout === "tab" ? await listTabs(current.workspaceId, signal) : [];
        const state = await bestEffort(emptyHerdrAgentsState(), () =>
          loadHerdrAgentsState(),
        );

        // Reuse is normally a persistent-only affordance, but a one-shot parked
        // on an unanswered question has to be reachable by label too: the
        // answer arrives as a normal `task`, and without reuse it would spawn a
        // second agent and orphan the parked one forever.
        {
          const candidateTab =
            layout === "tab"
              ? findReusableAgentTab(current, tabs, baseLabel)
              : undefined;
          const candidatePane =
            layout === "tab"
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

          if ((persistent || answeringQuestion) && candidatePane) {
            reused = true;
            tabId = candidateTab?.tab.tab_id ?? candidatePane.tab_id;
            if (candidateTab) tabLabel = candidateTab.tab.label;
            paneId = candidatePane.pane_id;
            agentPane = candidatePane;
            automationName = candidateRecord?.automationName;
            resultFile = candidateRecord?.resultFile;
          }
        }

        if (!reused && layout === "tab") {
          tabLabel = uniqueLabel(baseLabel, tabs);
          const createOutput = await execHerdr(
            [
              "tab",
              "create",
              "--workspace",
              current.workspaceId,
              "--label",
              tabLabel,
              "--cwd",
              ctx.cwd,
              "--env",
              "HERDR_AGENT_CHILD=1",
              "--env",
              "PROCESS_LAUNCHED_BY_Q=1",
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
            const createdTabs = await listTabs(current.workspaceId, signal);
            tabId = createdTabs.find((tab) => tab.label === tabLabel)?.tab_id;
          }
        }

        if (!reused && layout === "pane") {
          const managedAgents = listManagedWorkspaceAgents(
            current,
            state,
          ).filter(
            (item) =>
              item.layout === "pane" && item.tabId === current.currentTab,
          );
          tabLabel = uniqueLabel(
            baseLabel,
            managedAgents.map((item) => ({
              tab_id: item.paneId,
              label: item.tabLabel,
            })),
          );
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
              ctx.cwd,
              "--env",
              "HERDR_AGENT_CHILD=1",
              "--env",
              "PROCESS_LAUNCHED_BY_Q=1",
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
          const profilePrompt = [agent.systemPrompt, CHILD_PROTOCOL]
            .filter(Boolean)
            .join("\n\n");
          const tempFiles = await createAgentTempFiles(profilePrompt);
          resultFile = tempFiles.resultFile;
          const piArgs = ["--name", tabLabel];
          if (agent.model) piArgs.push("--model", agent.model);
          const toolAllowlist = buildChildToolAllowlist(agent.tools);
          if (toolAllowlist) piArgs.push("--tools", toolAllowlist.join(","));
          piArgs.push("--append-system-prompt", tempFiles.systemFile);

          onUpdate?.({
            content: [
              {
                type: "text",
                text: `Starting Herdr agent ${tabLabel} (${paneId})...`,
              },
            ],
            details: { tabId, paneId, tabLabel, lifecycle, reused, agent },
          });
          await startAgent(automationName, paneId, piArgs, signal);
          agentPane =
            (await listPanes(signal)).find((pane) => pane.pane_id === paneId) ??
            agentPane;
        } else {
          resultFile ??= await createResultFile();
        }

        if (agentPane) {
          await bestEffort(undefined, () =>
            recordAgentLifecycle(agentPane!, lifecycle, {
              tabLabel,
              agent: agent.name,
              automationName,
              resultFile,
              layout,
              // Nobody is waiting for this one, so the poller owns its result.
              detached: !wait,
            }),
          );
        }
        if (layout === "pane") {
          await bestEffort(undefined, () => rebalanceCurrentPaneAgents(signal));
        }
      } finally {
        releasePlacement();
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
        pi.events.emit("herdr:blocked", { active: true, label: blockedLabel });
        beginAwaitingAgent(tabLabel);
      }
      try {
        await promptAgent(target, taskPrompt, { wait, timeoutMs }, signal);

        if (!wait) {
          return {
            content: [
              {
                type: "text",
                text: `Herdr agent ${tabLabel} started (${paneId}).`,
              },
            ],
            details: {
              tabId,
              paneId,
              tabLabel,
              lifecycle,
              reused,
              agent,
              waited: false,
            },
          };
        }

        // Checked before the result: a child that asked ends its turn without
        // HERDR_RESULT, so the wait fires on idle exactly like a completion.
        // The agent stays open — including one-shots — until it really finishes.
        const question = await readAgentQuestion(resultFile);
        if (question) {
          return {
            content: [
              {
                type: "text",
                text: formatAgentQuestion(tabLabel, agent.name, question),
              },
            ],
            details: {
              tabId,
              paneId,
              tabLabel,
              lifecycle,
              reused,
              closed: false,
              agent,
              waited: true,
              status: "question",
            },
          };
        }

        const artifact = await readAgentResult(resultFile);
        const output = artifact ?? (await readAgent(target, signal));
        // Whoever collects first owns the result. Releasing the claim here stops
        // the poller from delivering the same result a second time.
        if (agentPane) {
          await bestEffort(false, () => claimDetachedAgent(agentPane!));
        }

        let closed = false;
        let closeError: string | undefined;
        if (closeAfterWait) {
          try {
            await execHerdr(
              layout === "pane"
                ? ["pane", "close", paneId]
                : ["tab", "close", tabId],
              signal,
            );
            if (agentPane) {
              await bestEffort(undefined, () =>
                deleteAgentLifecycle(agentPane!),
              );
            }
            await bestEffort(undefined, () => removeAgentTempFiles(resultFile));
            if (layout === "pane") {
              await bestEffort(undefined, () =>
                rebalanceCurrentPaneAgents(signal),
              );
            }
            closed = true;
          } catch (error) {
            closeError = error instanceof Error ? error.message : String(error);
          }
        }

        const text = formatAgentOutput(output, tabLabel, closeError);

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
            closed,
            closeError,
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
                text: formatWaitInterrupted(tabLabel, reason),
              },
            ],
            details: {
              tabId,
              paneId,
              tabLabel,
              lifecycle,
              reused,
              agent,
              waited: false,
              interrupted: true,
              interruptReason: reason,
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
