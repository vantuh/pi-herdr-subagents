import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { HerdrAgentLayout } from "./types.ts";

export const DEFAULT_HERDR_AGENTS_LAYOUT: HerdrAgentLayout = "workspace";
export const DEFAULT_AGENTS_WORKSPACE_LABEL = "subagents";

export const HERDR_AGENTS_CONFIG_FILE = "herdr-agents.json";

/**
 * User configuration, read from `herdr-agents.json` in the Pi agent dir
 * (`~/.pi/agent/herdr-agents.json` by default). Same pattern as kiro-acp:
 * a missing or invalid file yields `{}`, so every field falls back to its
 * default and a broken config can never break spawning.
 *
 * State-file internals (`HERDR_AGENTS_STATE_PATH`, `HERDR_AGENTS_LOCK_WAIT_MS`,
 * `HERDR_AGENTS_CLAIM_LEASE_MS`) stay environment-only: they exist for test
 * harnesses and debugging, not for users.
 */
export interface HerdrAgentsConfig {
  /** Agent target layout. Default: "workspace". */
  layout?: HerdrAgentLayout;
  workspace?: {
    /** Label of the dedicated Agents workspace. Default: "subagents". */
    label?: string;
  };
}

export function herdrAgentsConfigPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, HERDR_AGENTS_CONFIG_FILE);
}

function normalizeLayout(value: unknown): HerdrAgentLayout | undefined {
  const trimmed = typeof value === "string" ? value.trim().toLowerCase() : "";
  return trimmed === "tab" || trimmed === "pane" || trimmed === "workspace"
    ? trimmed
    : undefined;
}

/** Reads herdr-agents.json; `{}` when missing or invalid. */
export async function loadHerdrAgentsConfig(
  path: string = herdrAgentsConfigPath(),
): Promise<HerdrAgentsConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  const config = parsed as HerdrAgentsConfig;
  const layout = normalizeLayout(config.layout);
  const label = config.workspace?.label;
  return {
    ...(layout ? { layout } : {}),
    ...(typeof label === "string" ? { workspace: { label } } : {}),
  };
}

export function getHerdrAgentsLayout(
  config: HerdrAgentsConfig = {},
): HerdrAgentLayout {
  return normalizeLayout(config.layout) ?? DEFAULT_HERDR_AGENTS_LAYOUT;
}

export function getHerdrAgentsWorkspaceLabel(
  config: HerdrAgentsConfig = {},
): string {
  const label = config.workspace?.label?.trim();
  return label || DEFAULT_AGENTS_WORKSPACE_LABEL;
}

export interface CouncilConfig {
  models: string[];
  error?: string;
}

/**
 * Reads the council model list from ~/.pi/agent/council.json at command
 * time. A missing, unreadable, or malformed file yields an empty list so the
 * /council command can warn instead of injecting a broken spawn contract.
 */
export async function readCouncilConfig(
  path: string = join(getAgentDir(), "council.json"),
): Promise<CouncilConfig> {
  try {
    const raw = await readFile(path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { models: [], error: "not valid JSON" };
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as { models?: unknown }).models)
    ) {
      return { models: [] };
    }
    const models = [
      ...new Set(
        ((parsed as { models: unknown[] }).models as unknown[])
          .filter(
            (model): model is string =>
              typeof model === "string" && model.trim().length > 0,
          )
          .map((model) => model.trim()),
      ),
    ];
    return { models };
  } catch {
    return { models: [], error: "unreadable" };
  }
}
