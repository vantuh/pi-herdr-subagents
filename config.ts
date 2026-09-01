import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { HerdrAgentLayout } from "./types.ts";

export const HERDR_AGENTS_LAYOUT_ENV = "HERDR_AGENTS_LAYOUT";
export const DEFAULT_HERDR_AGENTS_LAYOUT: HerdrAgentLayout = "pane";

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

export function getHerdrAgentsLayout(
  env: NodeJS.ProcessEnv = process.env,
): HerdrAgentLayout {
  return env[HERDR_AGENTS_LAYOUT_ENV]?.trim().toLowerCase() === "tab"
    ? "tab"
    : DEFAULT_HERDR_AGENTS_LAYOUT;
}
