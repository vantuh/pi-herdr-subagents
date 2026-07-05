import { execFile } from "node:child_process";
import { promises as fs, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  getAgentDir,
  parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface AgentProfile {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
}

interface PaneInfo {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  focused?: boolean;
  agent?: string;
  agent_status?: string;
}

interface TabInfo {
  tab_id: string;
  label: string;
  focused?: boolean;
  agent_status?: string;
}

const GLOBAL_INSTRUCTIONS = `## Herdr agents

When isolated context helps, use \`herdr_agent\`.
Pick the smallest suitable agent profile.
Keep Herdr tabs persistent. Do not close delegated tabs or panes.
The current tab is Orchestrator.
Synthesize Herdr agent results yourself; do not blindly forward output.`;

const CHILD_PROTOCOL = `## Herdr persistent agent protocol

You are running in a persistent Herdr tab spawned by the Orchestrator.
Stay in this tab and do not close the tab or pane.
Do not spawn additional agents unless explicitly asked.
Keep work focused on the assigned task.

When finished, end with this exact format:

HERDR_RESULT:
- status: done | blocked
- summary: <short result>
- evidence: <files/commands/links inspected>
- changes: <none | files changed>
- next: <recommended next step>`;

function execHerdr(args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = execFile(
      "herdr",
      args,
      { signal, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const message = stderr?.trim() || error.message;
          reject(new Error(`herdr ${args.join(" ")} failed: ${message}`));
          return;
        }
        resolve(stdout);
      },
    );

    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          proc.kill("SIGTERM");
        },
        { once: true },
      );
    }
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellJoin(args: string[]): string {
  return args.map(shellQuote).join(" ");
}

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isDirectory(filePath: string): boolean {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let current = cwd;
  while (true) {
    const candidate = path.join(current, CONFIG_DIR_NAME, "agents");
    if (isDirectory(candidate)) return candidate;

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function loadAgentsFromDir(
  dir: string,
  source: "user" | "project",
): Promise<AgentProfile[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const agents: AgentProfile[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const filePath = path.join(dir, entry);

    let content: string;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
    if (!frontmatter.name || !frontmatter.description) continue;

    const tools = frontmatter.tools
      ?.split(",")
      .map((tool) => tool.trim())
      .filter(Boolean);

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: tools && tools.length > 0 ? tools : undefined,
      model: frontmatter.model,
      systemPrompt: body.trim(),
      source,
      filePath,
    });
  }

  return agents;
}

async function discoverAgents(cwd: string): Promise<AgentProfile[]> {
  const userDir = path.join(getAgentDir(), "agents");
  const projectDir = findNearestProjectAgentsDir(cwd);
  const userAgents = await loadAgentsFromDir(userDir, "user");
  const projectAgents = projectDir ? await loadAgentsFromDir(projectDir, "project") : [];

  const byName = new Map<string, AgentProfile>();
  for (const agent of userAgents) byName.set(agent.name, agent);
  for (const agent of projectAgents) byName.set(agent.name, agent);
  return Array.from(byName.values());
}

async function writeTempFile(prefix: string, content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-agent-"));
  const filePath = path.join(dir, `${prefix}.md`);
  await fs.writeFile(filePath, content, { encoding: "utf8", mode: 0o600 });
  return filePath;
}

async function getCurrentContext(signal?: AbortSignal): Promise<{
  panes: PaneInfo[];
  currentPane: PaneInfo;
  workspaceId: string;
  currentTab: string;
}> {
  const output = await execHerdr(["pane", "list"], signal);
  const panes = JSON.parse(output).result.panes as PaneInfo[];
  const envPaneId = process.env.HERDR_PANE_ID;
  const currentPane =
    (envPaneId ? panes.find((pane) => pane.pane_id === envPaneId) : undefined) ??
    panes.find((pane) => pane.focused);
  if (!currentPane) throw new Error("Could not find current Herdr pane.");
  return {
    panes,
    currentPane,
    workspaceId: currentPane.workspace_id,
    currentTab: currentPane.tab_id,
  };
}

async function listTabs(workspaceId: string, signal?: AbortSignal): Promise<TabInfo[]> {
  const output = await execHerdr(["tab", "list", "--workspace", workspaceId], signal);
  return JSON.parse(output).result.tabs as TabInfo[];
}

function uniqueLabel(baseLabel: string, tabs: TabInfo[]): string {
  const labels = new Set(tabs.map((tab) => tab.label));
  if (!labels.has(baseLabel)) return baseLabel;

  for (let i = 2; ; i++) {
    const candidate = `${baseLabel} #${i}`;
    if (!labels.has(candidate)) return candidate;
  }
}

function choosePaneForTab(panes: PaneInfo[], tabId: string): PaneInfo | undefined {
  const tabPanes = panes.filter((pane) => pane.tab_id === tabId);
  return tabPanes.find((pane) => pane.agent === "pi") ?? tabPanes[0];
}

const HerdrAgentParams = Type.Object({
  agent: Type.String({
    description: "Agent profile name from ~/.pi/agent/agents/*.md, e.g. researcher, scout, reviewer, planner, worker.",
  }),
  task: Type.String({ description: "Self-contained task to give the Herdr agent." }),
  tabLabel: Type.Optional(
    Type.String({ description: "Herdr tab label. Defaults to the agent role, e.g. Researcher." }),
  ),
  wait: Type.Optional(
    Type.Boolean({ description: "Wait for the Herdr agent to finish and read its result. Default: true." }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({ description: "Wait timeout in milliseconds. Default: 600000." }),
  ),
  reuseExisting: Type.Optional(
    Type.Boolean({
      description:
        "Reuse an existing tab with the same label and send the task there. Default: false for fresh context.",
    }),
  ),
});

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
    promptSnippet: "Delegate isolated research, scouting, planning, review, testing, or implementation to a persistent Herdr tab.",
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
          content: [{ type: "text", text: `Unknown Herdr agent: ${params.agent}. Available: ${available}` }],
          details: { availableAgents: agents },
          isError: true,
        };
      }

      const wait = params.wait ?? true;
      const timeoutMs = params.timeoutMs ?? 600000;
      const baseLabel = params.tabLabel?.trim() || titleCase(agent.name);
      const current = await getCurrentContext(signal);

      await execHerdr(["tab", "rename", current.currentTab, "Orchestrator"], signal);

      const tabs = await listTabs(current.workspaceId, signal);
      let tabLabel = baseLabel;
      let paneId: string;
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
          ["tab", "create", "--workspace", current.workspaceId, "--label", tabLabel, "--no-focus"],
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
          content: [{ type: "text", text: `Sending task to existing Herdr tab ${tabLabel} (${paneId})...` }],
          details: { paneId, tabLabel, reused, agent },
        });
        await execHerdr(["pane", "run", paneId!, `@${taskPath}`], signal);
      } else {
        const profilePrompt = [agent.systemPrompt, CHILD_PROTOCOL].filter(Boolean).join("\n\n");
        const promptPath = await writeTempFile("system", profilePrompt);
        const piArgs = ["pi", "--name", tabLabel];
        if (agent.model) piArgs.push("--model", agent.model);
        if (agent.tools?.length) piArgs.push("--tools", agent.tools.join(","));
        piArgs.push("--append-system-prompt", promptPath, `@${taskPath}`);

        const command = `cd ${shellQuote(ctx.cwd)} && HERDR_AGENT_CHILD=1 ${shellJoin(piArgs)}`;
        onUpdate?.({
          content: [{ type: "text", text: `Starting Herdr tab ${tabLabel} (${paneId!})...` }],
          details: { paneId, tabLabel, reused, agent },
        });
        await execHerdr(["pane", "run", paneId!, command], signal);
      }

      if (!wait) {
        return {
          content: [{ type: "text", text: `Herdr agent started in tab ${tabLabel} (${paneId!}).` }],
          details: { paneId: paneId!, tabLabel, reused, agent, waited: false },
        };
      }

      onUpdate?.({
        content: [{ type: "text", text: `Waiting for Herdr agent ${tabLabel} (${paneId!})...` }],
        details: { paneId: paneId!, tabLabel, reused, agent },
      });

      const blockedLabel = `waiting for ${tabLabel}`;
      pi.events.emit("herdr:blocked", { active: true, label: blockedLabel });
      try {
        await execHerdr(["wait", "agent-status", paneId!, "--status", "done", "--timeout", String(timeoutMs)], signal);
        const output = await execHerdr(
          ["pane", "read", paneId!, "--source", "recent-unwrapped", "--lines", "180"],
          signal,
        );

        return {
          content: [{ type: "text", text: output.trim() || `(Herdr agent ${tabLabel} finished with no visible output.)` }],
          details: { paneId: paneId!, tabLabel, reused, agent, waited: true },
        };
      } finally {
        pi.events.emit("herdr:blocked", { active: false, label: blockedLabel });
      }
    },
  });
}
