import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { resolveProfileSkills, resolveThinkingLevel } from '../agents.ts';
import { ASK_QUESTION_TOOL, SESSION_META_ENV } from '../artifacts.ts';
import type { AgentProfile } from '../types.ts';

export function herdrChildEnvArgs(sessionMetaFile?: string): string[] {
  const args = [
    '--env',
    'HERDR_AGENT_CHILD=1',
    '--env',
    'PROCESS_LAUNCHED_BY_Q=1',
  ];
  if (sessionMetaFile) {
    args.push('--env', `${SESSION_META_ENV}=${sessionMetaFile}`);
  }
  return args;
}

export function orchestratorIdentity(ctx: ExtensionContext): {
  sessionId?: string;
  sessionFile?: string;
} {
  const sessionId = ctx.sessionManager?.getSessionId()?.trim();
  const sessionFile = ctx.sessionManager?.getSessionFile()?.trim();
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(sessionFile ? { sessionFile } : {}),
  };
}

export async function buildChildPiArgs(options: {
  agent: AgentProfile;
  tabLabel: string;
  systemFile: string;
  cwd: string;
  sessionFile?: string;
}): Promise<{ piArgs: string[]; spawnWarnings: string[] }> {
  const spawnWarnings: string[] = [];
  const piArgs: string[] = [];
  if (!options.sessionFile) {
    piArgs.push('--name', options.tabLabel);
  } else {
    piArgs.push('--session', options.sessionFile);
  }
  if (options.agent.model) piArgs.push('--model', options.agent.model);
  if (options.agent.thinking) {
    const level = resolveThinkingLevel(options.agent.thinking);
    if (level) {
      piArgs.push('--thinking', level);
    } else {
      spawnWarnings.push(
        `Unknown thinking level "${options.agent.thinking}" ignored.`,
      );
    }
  }
  if (Array.isArray(options.agent.skills)) {
    const resolved = await resolveProfileSkills(
      options.agent.skills,
      options.cwd,
    );
    piArgs.push('--no-skills');
    for (const skill of resolved.found) {
      piArgs.push('--skill', skill.filePath);
    }
    if (resolved.missing.length > 0) {
      spawnWarnings.push(`Skills not found: ${resolved.missing.join(', ')}.`);
    }
    spawnWarnings.push(...resolved.diagnostics);
  }
  piArgs.push(...buildChildToolArgs(options.agent.tools));
  piArgs.push(
    options.agent.systemPromptMode === 'replace'
      ? '--system-prompt'
      : '--append-system-prompt',
    options.systemFile,
  );
  return { piArgs, spawnWarnings };
}

/**
 * Keep the question channel available in a restricted profile. Pi preserves
 * unlisted MCP tools unless they are explicitly filtered separately.
 *
 * Returns undefined when the profile does not restrict tools — then no flag is
 * passed at all and `ask_question` is available anyway.
 */
export function buildChildToolAllowlist(
  tools: readonly string[] | undefined,
): string[] | undefined {
  if (!tools?.length) return undefined;
  return [...new Set([...tools, ASK_QUESTION_TOOL])];
}

export function buildChildToolArgs(
  tools: readonly string[] | undefined,
): string[] {
  const allowlist = buildChildToolAllowlist(tools);
  if (!allowlist) return [];
  const args = ['--tools', allowlist.join(',')];
  if (!allowlist.some((name) => name === '*' || name.startsWith('mcp__'))) {
    args.push('--exclude-tools', 'mcp__*');
  }
  return args;
}
