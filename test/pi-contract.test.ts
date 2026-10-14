import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildChildToolArgs } from "../src/utils.ts";

const model = {
  id: "fixture",
  name: "Fixture",
  api: "openai-completions",
  provider: "mock",
  baseUrl: "http://127.0.0.1:1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32000,
  maxTokens: 4096,
} as const;

function tool(name: string, exposure: "direct" | "codemode" | "model-only") {
  return {
    name,
    label: name,
    description: name,
    exposure,
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text" as const, text: name }], details: undefined };
    },
  };
}

// Use Pi's real tool registry: inactive MCP tools can still be callable.
test("restricted profiles filter MCP tools from Pi's callable registry", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-pi-tools-"));
  try {
    for (const [names, expected] of [
      [["read", "codemode"], []],
      [["read", "codemode", "mcp__allowed__*"], ["mcp__allowed__write"]],
      [["*"], ["mcp__allowed__write", "mcp__other__write"]],
      [undefined, ["mcp__allowed__write", "mcp__other__write"]],
    ] as const) {
      const args = buildChildToolArgs(names);
      const toolsIndex = args.indexOf("--tools");
      const excludeIndex = args.indexOf("--exclude-tools");
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir: root,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await loader.reload();
      const { session } = await createAgentSession({
        cwd: root,
        agentDir: root,
        model,
        settingsManager: SettingsManager.inMemory(),
        sessionManager: SessionManager.inMemory(root),
        resourceLoader: loader,
        tools: toolsIndex < 0 ? undefined : args[toolsIndex + 1].split(","),
        excludeTools: excludeIndex < 0 ? undefined : args[excludeIndex + 1].split(","),
        customTools: [
          tool("codemode", "direct"),
          tool("ask_question", "model-only"),
          tool("mcp__allowed__write", "codemode"),
          tool("mcp__other__write", "codemode"),
        ],
      });
      try {
        assert.deepEqual(
          session
            .getAllTools()
            .filter((t) => t.name.startsWith("mcp__"))
            .map((t) => t.name),
          expected,
        );
        assert.ok(session.getActiveToolNames().includes("ask_question"));
      } finally {
        session.dispose();
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
