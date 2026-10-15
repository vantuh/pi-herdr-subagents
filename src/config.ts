import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { Static } from 'typebox';

import { parseJson } from './json.ts';
import { isHerdrAgentLayout, type HerdrAgentLayout } from './types.ts';

export const DEFAULT_HERDR_AGENTS_LAYOUT: HerdrAgentLayout = 'workspace';
export const DEFAULT_AGENTS_WORKSPACE_LABEL = 'subagents';

export const HERDR_AGENTS_CONFIG_FILE = 'herdr-agents.json';

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
export const HerdrAgentsConfig = Type.Object({
  /** User input: wrong leaf types drop that setting, never the siblings. */
  layout: Type.Optional(Type.Unknown()),
  workspace: Type.Optional(
    Type.Object({
      label: Type.Optional(Type.Unknown()),
    }),
  ),
});
export type HerdrAgentsConfig = Static<typeof HerdrAgentsConfig>;

export function herdrAgentsConfigPath(
  agentDir: string = getAgentDir(),
): string {
  return join(agentDir, HERDR_AGENTS_CONFIG_FILE);
}

function normalizeLayout(value: unknown): HerdrAgentLayout | undefined {
  const trimmed = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return isHerdrAgentLayout(trimmed) ? trimmed : undefined;
}

function normalizeLabel(value: unknown): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || undefined;
}

/** Reads herdr-agents.json; `{}` when missing or invalid. */
export async function loadHerdrAgentsConfig(
  path: string = herdrAgentsConfigPath(),
): Promise<HerdrAgentsConfig> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return {};
  }
  const parsed = parseJson(HerdrAgentsConfig, raw);
  if (!parsed) {
    return {};
  }
  const layout = normalizeLayout(parsed.layout);
  const label = normalizeLabel(parsed.workspace?.label);
  return {
    ...(layout ? { layout } : {}),
    ...(label ? { workspace: { label } } : {}),
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
  return (
    normalizeLabel(config.workspace?.label) ?? DEFAULT_AGENTS_WORKSPACE_LABEL
  );
}
