import { promises as fs, statSync } from "node:fs";
import * as path from "node:path";
import {
  CONFIG_DIR_NAME,
  DefaultPackageManager,
  getAgentDir,
  loadSkills,
  parseFrontmatter,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentProfile } from "./types.ts";
import { normalizeTools } from "./utils.ts";

function isDirectory(filePath: string): boolean {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

/** Levels accepted by pi's `--thinking` flag. */
export const VALID_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** Unknown levels are ignored at spawn time, not a parse error. */
export function resolveThinkingLevel(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  const level = value.trim().toLowerCase();
  return (VALID_THINKING_LEVELS as readonly string[]).includes(level)
    ? level
    : undefined;
}

/**
 * `skills: none` and `skills: []` both mean "load no skills". An omitted
 * field stays undefined so the child keeps full discovery.
 */
export function normalizeSkillList(raw: unknown): string[] | undefined {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.toLowerCase() === "none" || trimmed === "[]") return [];
  }
  if (Array.isArray(raw)) {
    return raw.map((skill) => String(skill).trim()).filter(Boolean);
  }
  return normalizeTools(raw);
}

/**
 * Resolve profile skill names through the same discovery pi performs on
 * startup, including packages and project `.agents/skills`. Returns the found
 * skills (with spawn-ready `filePath`s) and the names that matched nothing —
 * the caller warns instead of failing the spawn.
 */
export async function resolveProfileSkills(
  names: readonly string[],
  cwd: string,
): Promise<{
  found: Array<{ name: string; filePath: string }>;
  missing: string[];
}> {
  if (names.length === 0) return { found: [], missing: [] };
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const packageManager = new DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager,
  });
  // Name resolution must be read-only. Missing configured packages are warned
  // about by Pi itself; spawning an agent must never install them implicitly.
  const resolved = await packageManager.resolve(async () => "skip");
  const skillPaths = resolved.skills
    .filter((resource) => resource.enabled)
    .map((resource) => resource.path);
  const { skills } = loadSkills({
    cwd,
    agentDir,
    skillPaths,
    // PackageManager already applies Pi's full discovery and enabled-resource
    // filtering, including .pi, .agents, configured paths, and packages.
    includeDefaults: false,
  });
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  const found: Array<{ name: string; filePath: string }> = [];
  const missing: string[] = [];
  for (const name of names) {
    const skill = byName.get(name);
    if (skill) found.push({ name: skill.name, filePath: skill.filePath });
    else missing.push(name);
  }
  return { found, missing };
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

    const { frontmatter, body } = parseFrontmatter<
      Record<string, string> & {
        tools?: string | string[];
        skills?: string | string[];
        "system-prompt"?: string;
        "disable-model-invocation"?: string | boolean;
      }
    >(content);
    if (!frontmatter.name || !frontmatter.description) continue;

    const tools = normalizeTools(frontmatter.tools);
    const skills = normalizeSkillList(frontmatter.skills);
    const promptMode = frontmatter["system-prompt"]?.trim().toLowerCase();
    const disableFlag = frontmatter["disable-model-invocation"];
    const disableModelInvocation =
      disableFlag === true || disableFlag === "true"
        ? true
        : disableFlag === false || disableFlag === "false"
          ? false
          : undefined;

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools,
      model: frontmatter.model,
      thinking: frontmatter.thinking,
      skills,
      systemPromptMode:
        promptMode === "replace" || promptMode === "append"
          ? promptMode
          : undefined,
      disableModelInvocation,
      systemPrompt: body.trim(),
      source,
      filePath,
    });
  }

  return agents;
}

export async function discoverAgents(cwd: string): Promise<AgentProfile[]> {
  const userDir = path.join(getAgentDir(), "agents");
  const projectDir = findNearestProjectAgentsDir(cwd);
  const userAgents = await loadAgentsFromDir(userDir, "user");
  const projectAgents = projectDir
    ? await loadAgentsFromDir(projectDir, "project")
    : [];

  const byName = new Map<string, AgentProfile>();
  for (const agent of userAgents) byName.set(agent.name, agent);
  for (const agent of projectAgents) byName.set(agent.name, agent);
  return Array.from(byName.values());
}
