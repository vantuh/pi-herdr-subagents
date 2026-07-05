import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./agents.ts";
import { CHILD_PROTOCOL, GLOBAL_INSTRUCTIONS } from "./constants.ts";
import {
  choosePaneForTab,
  execHerdr,
  getCurrentContext,
  listTabs,
  uniqueLabel,
  waitForAgentFinished,
} from "./herdr.ts";
import { HerdrAgentParams } from "./schema.ts";
import { shellJoin, shellQuote, titleCase, writeTempFile } from "./utils.ts";

export default function herdrAgentsExtension(pi: ExtensionAPI) {
  if (process.env.HERDR_AGENT_CHILD === "1") return;

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${GLOBAL_INSTRUCTIONS}`,
  }));

  pi.registerTool({
    name: "herdr_agent",
    label: "Herdr Agent",
    description:
      "Spawn or reuse a persistent Herdr tab running a fresh Pi agent with a named profile from ~/.pi/agent/agents.",
    promptSnippet:
      "Delegate isolated research, scouting, planning, review, testing, or implementation to a persistent Herdr tab.",
    promptGuidelines: [
      "Use herdr_agent when isolated context helps: broad codebase exploration, external research, review, planning, tests/logs, or independent implementation.",
      "Use herdr_agent with the smallest suitable profile and a self-contained task.",
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
      const timeoutMs = params.timeoutMs ?? 600000;
      const baseLabel = params.tabLabel?.trim() || titleCase(agent.name);
      const current = await getCurrentContext(signal);

      await execHerdr(
        ["tab", "rename", current.currentTab, "Orchestrator"],
        signal,
      );

      const tabs = await listTabs(current.workspaceId, signal);
      let tabLabel = baseLabel;
      let paneId: string | undefined;
      let reused = false;

      if (params.reuseExisting) {
        const existingTab = tabs.find((tab) => tab.label === baseLabel);
        const existingPane = existingTab
          ? choosePaneForTab(current.panes, existingTab.tab_id)
          : undefined;
        if (existingPane) {
          reused = true;
          paneId = existingPane.pane_id;
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
        paneId = JSON.parse(createOutput).result.root_pane.pane_id as string;
      }

      const taskPrompt = [
        `You are the ${agent.name} Herdr agent.`,
        "",
        "Task from Orchestrator:",
        params.task,
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
          details: { paneId, tabLabel, reused, agent },
        });
        await execHerdr(["pane", "run", paneId!, `@${taskPath}`], signal);
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
          details: { paneId, tabLabel, reused, agent },
        });
        await execHerdr(["pane", "run", paneId!, command], signal);
      }

      if (!wait) {
        return {
          content: [
            {
              type: "text",
              text: `Herdr agent started in tab ${tabLabel} (${paneId}).`,
            },
          ],
          details: { paneId, tabLabel, reused, agent, waited: false },
        };
      }

      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Waiting for Herdr agent ${tabLabel} (${paneId})...`,
          },
        ],
        details: { paneId, tabLabel, reused, agent },
      });

      const blockedLabel = `waiting for ${tabLabel}`;
      pi.events.emit("herdr:blocked", { active: true, label: blockedLabel });
      try {
        await waitForAgentFinished(paneId!, timeoutMs, signal);
        const output = await execHerdr(
          [
            "pane",
            "read",
            paneId!,
            "--source",
            "recent-unwrapped",
            "--lines",
            "180",
          ],
          signal,
        );

        return {
          content: [
            {
              type: "text",
              text:
                output.trim() ||
                `(Herdr agent ${tabLabel} finished with no visible output.)`,
            },
          ],
          details: { paneId, tabLabel, reused, agent, waited: true },
        };
      } finally {
        pi.events.emit("herdr:blocked", { active: false, label: blockedLabel });
      }
    },
  });
}
