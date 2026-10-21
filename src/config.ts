import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getAgentDir } from '@earendil-works/pi-coding-agent';

import {
  ConfigLayoutField,
  ConfigWorkspaceField,
  isHerdrAgentLayout,
  type HerdrAgentLayout,
  type HerdrAgentsConfig,
} from './config/schema.ts';
import { parseJson } from './json.ts';

export const DEFAULT_HERDR_AGENTS_LAYOUT: HerdrAgentLayout = 'workspace';
export const DEFAULT_AGENTS_WORKSPACE_LABEL = 'subagents';

export const HERDR_AGENTS_CONFIG_FILE = 'pi-herdr-subagents.json';

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

/** Reads pi-herdr-subagents.json; `{}` when missing or invalid. */
export async function loadHerdrAgentsConfig(
  path: string = herdrAgentsConfigPath(),
): Promise<HerdrAgentsConfig> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return {};
  }
  const layout = normalizeLayout(parseJson(ConfigLayoutField, raw)?.layout);
  const label = normalizeLabel(
    parseJson(ConfigWorkspaceField, raw)?.workspace?.label,
  );
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
