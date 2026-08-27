import { promises as fs } from "node:fs";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/**
 * Mock Pi host shared by the integration harness (fake Herdr) and the e2e
 * harness (real Herdr, real Pi children).
 *
 * It implements only the `ExtensionAPI` / `ExtensionContext` surface this
 * extension actually touches, and records everything the extension pushes back
 * into the session so tests can assert on it.
 */

export interface SentMessage {
  customType: string;
  content: string;
  display: boolean;
  details: Record<string, unknown>;
  triggerTurn?: boolean;
  deliverAs?: string;
}

export interface EmittedEvent {
  name: string;
  payload: unknown;
}

export interface AgentProfileFixture {
  name: string;
  description?: string;
  tools?: string[];
  model?: string;
  body?: string;
}

/** The registry is untyped here on purpose: tests only need name + execute. */
type CapturedTool = any;

export interface MockHost {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  tools: Map<string, CapturedTool>;
  messages: SentMessage[];
  userMessages: string[];
  events: EmittedEvent[];
  notifications: Array<{ message: string; level?: string }>;
  widgets: Map<string, unknown>;
  commands: Map<string, { handler: (args: string, ctx: unknown) => unknown }>;
  renderers: Map<string, unknown>;
  /** Fire an extension lifecycle event (e.g. `session_start`). */
  fire(event: string, payload?: Record<string, unknown>): Promise<unknown>;
}

export function createMockHost(options: {
  cwd: string;
  hasUI?: boolean;
  isIdle?: boolean;
}): MockHost {
  const messages: SentMessage[] = [];
  const userMessages: string[] = [];
  const events: EmittedEvent[] = [];
  const notifications: Array<{ message: string; level?: string }> = [];
  const widgets = new Map<string, unknown>();
  const commands = new Map<
    string,
    { handler: (args: string, ctx: unknown) => unknown }
  >();
  const renderers = new Map<string, unknown>();
  const tools = new Map<string, CapturedTool>();
  const handlers = new Map<
    string,
    Array<(event: unknown, ctx: unknown) => unknown>
  >();

  const ctx = {
    cwd: options.cwd,
    hasUI: options.hasUI ?? true,
    mode: "tui",
    isIdle: () => options.isIdle ?? true,
    signal: undefined,
    ui: {
      theme: {
        fg: (_color: string, text: string) => text,
        bg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      },
      setWidget: (id: string, content: unknown) => {
        if (content === undefined) widgets.delete(id);
        else widgets.set(id, content);
      },
      notify: (message: string, level?: string) =>
        notifications.push({ message, level }),
      custom: async () => null,
    },
  } as unknown as ExtensionContext;

  const pi = {
    on: (event: string, handler: (e: unknown, c: unknown) => unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool: (tool: CapturedTool) => tools.set(tool.name, tool),
    registerCommand: (
      name: string,
      command: { handler: (args: string, ctx: unknown) => unknown },
    ) => commands.set(name, command),
    registerMessageRenderer: (customType: string, renderer: unknown) =>
      renderers.set(customType, renderer),
    sendMessage: (
      message: Omit<SentMessage, "triggerTurn" | "deliverAs">,
      sendOptions?: { triggerTurn?: boolean; deliverAs?: string },
    ) => messages.push({ ...message, ...sendOptions }),
    sendUserMessage: (content: string) => userMessages.push(content),
    events: {
      emit: (name: string, payload: unknown) => events.push({ name, payload }),
      on: () => undefined,
      off: () => undefined,
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    ctx,
    tools,
    messages,
    userMessages,
    events,
    notifications,
    widgets,
    commands,
    renderers,
    fire: async (event, payload = {}) => {
      let last: unknown;
      for (const handler of handlers.get(event) ?? []) {
        last = await handler({ type: event, ...payload }, ctx);
      }
      return last;
    },
  };
}

/** Set env vars (undefined deletes) and return a restore function. */
export function applyEnv(
  vars: Record<string, string | undefined>,
): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

export async function writeAgentProfiles(
  dir: string,
  profiles: readonly AgentProfileFixture[],
): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  for (const profile of profiles) {
    const lines = [
      "---",
      `name: ${profile.name}`,
      `description: ${profile.description ?? `${profile.name} test profile`}`,
    ];
    if (profile.tools) lines.push(`tools: ${profile.tools.join(", ")}`);
    if (profile.model) lines.push(`model: ${profile.model}`);
    lines.push("---", "", profile.body ?? `You are the ${profile.name}.`);
    await fs.writeFile(
      path.join(dir, `${profile.name}.md`),
      `${lines.join("\n")}\n`,
      "utf8",
    );
  }
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
