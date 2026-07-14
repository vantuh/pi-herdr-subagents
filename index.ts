import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";
import { discoverAgents } from "./agents.ts";
import { CHILD_PROTOCOL, GLOBAL_INSTRUCTIONS } from "./constants.ts";
import {
  execHerdr,
  findReusableAgentTab,
  getCurrentContext,
  listCurrentWorkspaceAgents,
  listPanes,
  listTabs,
  uniqueLabel,
  waitForAgentFinished,
} from "./herdr.ts";
import { HerdrAgentParams } from "./schema.ts";
import {
  deleteAgentLifecycle,
  emptyHerdrAgentsState,
  getKnownAgentLifecyclesByTabId,
  loadHerdrAgentsState,
  pruneHerdrAgentsState,
  recordAgentLifecycle,
  saveHerdrAgentsState,
} from "./state.ts";
import type { HerdrAgentInfo, HerdrAgentLifecycle, PaneInfo } from "./types.ts";
import {
  formatAgentOutput,
  shellJoin,
  shellQuote,
  shouldCloseTab,
  titleCase,
  writeTempFile,
} from "./utils.ts";

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

async function loadCurrentAgents(): Promise<HerdrAgentInfo[]> {
  const current = await getCurrentContext();
  const tabs = await listTabs(current.workspaceId);
  const state = await bestEffort(emptyHerdrAgentsState(), () => loadHerdrAgentsState());
  await bestEffort(undefined, async () => {
    if (pruneHerdrAgentsState(state, current.panes)) {
      await saveHerdrAgentsState(state);
    }
  });
  return listCurrentWorkspaceAgents(
    current,
    tabs,
    getKnownAgentLifecyclesByTabId(current.panes, state),
  );
}

async function showNoAgentsDialog(ctx: ExtensionCommandContext): Promise<void> {
  await ctx.ui.custom<void>(
    (_tui, theme, _kb, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder((str: string) => theme.fg("accent", str)));
      container.addChild(
        new Text(theme.fg("accent", theme.bold("Herdr Agents")), 1, 0),
      );
      container.addChild(
        new Text("No Herdr agents in the current workspace.", 1, 0),
      );
      container.addChild(
        new Text(theme.fg("dim", "enter/esc close"), 1, 0),
      );
      container.addChild(new DynamicBorder((str: string) => theme.fg("accent", str)));

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
  const result = await ctx.ui.custom<
    { action: "focus" | "close"; tabId: string } | null
  >(
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
      container.addChild(new DynamicBorder((str: string) => theme.fg("accent", str)));
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
      selectList.onSelect = (item) => done({ action: "focus", tabId: item.value });
      selectList.onCancel = () => done(null);

      container.addChild(selectList);
      container.addChild(
        new Text(
          theme.fg("dim", "↑↓ navigate • enter focus • d/ctrl+d close • esc close"),
          1,
          0,
        ),
      );
      container.addChild(new DynamicBorder((str: string) => theme.fg("accent", str)));

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
    { overlay: true, overlayOptions: { width: "70%", minWidth: 60, maxHeight: "80%" } },
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
      await execHerdr(["tab", "focus", selected.agent.tabId]);
      ctx.ui.notify(`Focused Herdr agent tab "${selected.agent.tabLabel}"`, "info");
      return;
    }

    await execHerdr(["tab", "close", selected.agent.tabId]);
    ctx.ui.notify(`Closed Herdr agent tab "${selected.agent.tabLabel}"`, "info");
  }
}

export default function herdrAgentsExtension(pi: ExtensionAPI) {
  if (process.env.HERDR_AGENT_CHILD === "1") return;

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${GLOBAL_INSTRUCTIONS}`,
  }));

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
      "Spawn a one-shot Herdr agent or reuse a persistent Herdr tab with a named profile from ~/.pi/agent/agents.",
    promptSnippet:
      "Delegate exploration, research, planning, review, and isolated implementation to a one-shot or persistent Herdr agent.",
    promptGuidelines: [
      "Use herdr_agent when global Delegation says isolated context helps; honor explicit role requests and delegation asks.",
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
      const lifecycle = params.lifecycle ?? "oneshot";
      const persistent = lifecycle === "persistent";
      const closeAfterWait = shouldCloseTab(lifecycle);
      const timeoutMs = params.timeoutMs ?? 600000;
      const baseLabel = params.tabLabel?.trim() || titleCase(agent.name);

      if (params.task === undefined) {
        // Re-wait mode: no new task, just reconnect to an existing tab that is
        // (expected to be) still running — e.g. after a previous call to this
        // tool timed out while the agent kept working. Skips `pane run`
        // entirely so it never re-sends a prompt into a busy pane.
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
        const tabs = await listTabs(current.workspaceId, signal);
        const reusable = findReusableAgentTab(current, tabs, baseLabel);
        if (!reusable) {
          return {
            content: [
              {
                type: "text",
                text: `No running Herdr tab named "${baseLabel}" found to re-wait on.`,
              },
            ],
            isError: true,
          };
        }

        const { tab, pane } = reusable;
        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Reconnecting to existing Herdr tab ${tab.label} (${pane.pane_id})...`,
            },
          ],
          details: { tabId: tab.tab_id, paneId: pane.pane_id, tabLabel: tab.label, agent },
        });

        if (!wait) {
          return {
            content: [
              {
                type: "text",
                text: `Herdr agent tab ${tab.label} (${pane.pane_id}) is still running.`,
              },
            ],
            details: {
              tabId: tab.tab_id,
              paneId: pane.pane_id,
              tabLabel: tab.label,
              agent,
              waited: false,
            },
          };
        }

        const blockedLabel = `waiting for ${tab.label}`;
        pi.events.emit("herdr:blocked", { active: true, label: blockedLabel });
        try {
          await waitForAgentFinished(pane.pane_id, timeoutMs, signal);
          const output = await execHerdr(
            ["pane", "read", pane.pane_id, "--source", "recent-unwrapped", "--lines", "180"],
            signal,
          );
          const text = formatAgentOutput(output, tab.label);
          return {
            content: [{ type: "text", text }],
            details: {
              tabId: tab.tab_id,
              paneId: pane.pane_id,
              tabLabel: tab.label,
              agent,
              waited: true,
            },
          };
        } finally {
          pi.events.emit("herdr:blocked", { active: false, label: blockedLabel });
        }
      }

      if (lifecycle === "oneshot" && !wait) {
        return {
          content: [
            {
              type: "text",
              text: "lifecycle: 'oneshot' requires wait: true so the one-shot tab can be closed after completion.",
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

      const current = await getCurrentContext(signal);

      await execHerdr(
        ["tab", "rename", current.currentTab, "Orchestrator"],
        signal,
      );

      const tabs = await listTabs(current.workspaceId, signal);
      let tabLabel = baseLabel;
      let tabId: string | undefined;
      let paneId: string | undefined;
      let agentPane: PaneInfo | undefined;
      let reused = false;

      if (persistent) {
        const reusable = findReusableAgentTab(current, tabs, baseLabel);
        if (reusable) {
          reused = true;
          tabId = reusable.tab.tab_id;
          tabLabel = reusable.tab.label;
          paneId = reusable.pane.pane_id;
          agentPane = reusable.pane;
        }
      }

      if (!reused) {
        tabLabel = uniqueLabel(baseLabel, tabs);
        const createOutput = await execHerdr(
          [
            "tab",
            "create",
            "--workspace",
            current.workspaceId,
            "--label",
            tabLabel,
            "--no-focus",
          ],
          signal,
        );
        let createResult;
        try {
          createResult = JSON.parse(createOutput)?.result;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
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
        tabId = typeof rootPane.tab_id === "string" ? rootPane.tab_id : undefined;

        if (!tabId) {
          // Fallback when `tab create` output omits tab_id. Assumes serial tool
          // calls and a unique label, since concurrent creates could return
          // the wrong tab for this label.
          const createdTabs = await listTabs(current.workspaceId, signal);
          tabId = createdTabs.find((tab) => tab.label === tabLabel)?.tab_id;
        }
      }

      if (!tabId || !paneId) {
        throw new Error(`Could not identify Herdr tab or pane for ${tabLabel}.`);
      }

      if (!agentPane?.terminal_id) {
        // terminal_id is required to key lifecycle state (state.ts paneStateKey).
        // If it's still missing after this lookup, lifecycle won't be persisted
        // for this pane, which is a best-effort miss, not a fatal error.
        agentPane = (await listPanes(signal)).find((pane) => pane.pane_id === paneId);
      }
      if (agentPane) {
        await bestEffort(undefined, () =>
          recordAgentLifecycle(agentPane!, lifecycle, {
            tabLabel,
            agent: agent.name,
          }),
        );
      }

      const taskPrompt = [
        `You are the ${agent.name} Herdr agent.`,
        "",
        "Task from Orchestrator:",
        task,
      ].join("\n");
      const taskPath = await writeTempFile("task", taskPrompt);

      if (reused) {
        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Sending task to existing Herdr tab ${tabLabel} (${paneId})...`,
            },
          ],
          details: { tabId, paneId, tabLabel, lifecycle, reused, agent },
        });
        await execHerdr(["pane", "run", paneId, `@${taskPath}`], signal);
      } else {
        const profilePrompt = [agent.systemPrompt, CHILD_PROTOCOL]
          .filter(Boolean)
          .join("\n\n");
        const promptPath = await writeTempFile("system", profilePrompt);
        const piArgs = ["pi", "--name", tabLabel];
        if (agent.model) piArgs.push("--model", agent.model);
        if (agent.tools?.length) piArgs.push("--tools", agent.tools.join(","));
        piArgs.push("--append-system-prompt", promptPath, `@${taskPath}`);

        const command = `cd ${shellQuote(ctx.cwd)} && HERDR_AGENT_CHILD=1 ${shellJoin(piArgs)}`;
        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Starting Herdr tab ${tabLabel} (${paneId})...`,
            },
          ],
          details: { tabId, paneId, tabLabel, lifecycle, reused, agent },
        });
        await execHerdr(["pane", "run", paneId, command], signal);
      }

      if (!wait) {
        return {
          content: [
            {
              type: "text",
              text: `Herdr agent started in tab ${tabLabel} (${paneId}).`,
            },
          ],
          details: { tabId, paneId, tabLabel, lifecycle, reused, agent, waited: false },
        };
      }

      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Waiting for Herdr agent ${tabLabel} (${paneId})...`,
          },
        ],
        details: { tabId, paneId, tabLabel, lifecycle, reused, agent },
      });

      const blockedLabel = `waiting for ${tabLabel}`;
      pi.events.emit("herdr:blocked", { active: true, label: blockedLabel });
      try {
        await waitForAgentFinished(paneId, timeoutMs, signal, {
          requireActiveFirst: reused,
        });
        const output = await execHerdr(
          [
            "pane",
            "read",
            paneId,
            "--source",
            "recent-unwrapped",
            "--lines",
            "180",
          ],
          signal,
        );

        let closed = false;
        let closeError: string | undefined;
        if (closeAfterWait) {
          try {
            await execHerdr(["tab", "close", tabId], signal);
            if (agentPane) {
              await bestEffort(undefined, () => deleteAgentLifecycle(agentPane!));
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
      } finally {
        pi.events.emit("herdr:blocked", { active: false, label: blockedLabel });
      }
    },
  });
}
