import type { HerdrAgentLayout } from "./types.ts";

export const HERDR_AGENTS_LAYOUT_ENV = "HERDR_AGENTS_LAYOUT";
export const DEFAULT_HERDR_AGENTS_LAYOUT: HerdrAgentLayout = "pane";

export function getHerdrAgentsLayout(
  env: NodeJS.ProcessEnv = process.env,
): HerdrAgentLayout {
  return env[HERDR_AGENTS_LAYOUT_ENV]?.trim().toLowerCase() === "tab"
    ? "tab"
    : DEFAULT_HERDR_AGENTS_LAYOUT;
}
