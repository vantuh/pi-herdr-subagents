import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import herdrAgentsExtension from "../index.ts";
import { applyEnv, createMockHost } from "../test-support/mock-extension.ts";
import { RESULT_FILE_MARKER } from "../utils.ts";

/**
 * Child-mode contract (docs/session-findings.md §4): with
 * `HERDR_AGENT_CHILD=1` the extension must not offer delegation or inject
 * Orchestrator guidance, but must still capture the child's final answer and
 * expose the question channel.
 */

async function withChildHost(
  body: (host: ReturnType<typeof createMockHost>, tmp: string) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-agents-child-"));
  const tmp = path.join(root, "tmp");
  await fs.mkdir(tmp, { recursive: true });
  const restoreEnv = applyEnv({ TMPDIR: tmp, HERDR_AGENT_CHILD: "1" });
  try {
    const host = createMockHost({ cwd: root });
    herdrAgentsExtension(host.pi);
    await body(host, tmp);
  } finally {
    restoreEnv();
    await fs.rm(root, { recursive: true, force: true });
  }
}

/** A managed artifact path, as the Orchestrator would create it. */
async function managedResultFile(tmp: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmp, "herdr-agent-"));
  return path.join(dir, "result.md");
}

test("a child registers the question channel but never delegation", async () => {
  await withChildHost(async (host) => {
    assert.deepEqual([...host.tools.keys()], ["ask_question"]);
    assert.equal(host.tools.has("herdr_agent"), false);
    // No Orchestrator commands, renderers or instruction injection either.
    assert.deepEqual([...host.commands.keys()], []);
    assert.deepEqual([...host.renderers.keys()], []);
    const result = await host.fire("before_agent_start", {
      systemPrompt: "BASE",
      prompt: "hi",
    });
    assert.equal(result, undefined);
  });
});

test("a child persists its final assistant message to the result artifact", async () => {
  await withChildHost(async (host, tmp) => {
    const resultFile = await managedResultFile(tmp);
    await host.fire("before_agent_start", {
      systemPrompt: "BASE",
      prompt: `Do the thing.\n${RESULT_FILE_MARKER} ${resultFile}`,
    });

    await host.fire("message_end", {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "HERDR_RESULT:\n- status: done" }],
      },
    });
    assert.equal(
      await fs.readFile(resultFile, "utf8"),
      "HERDR_RESULT:\n- status: done",
    );

    // Each finalized message overwrites, so the last answer wins.
    await host.fire("message_end", {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "final" }],
      },
    });
    assert.equal(await fs.readFile(resultFile, "utf8"), "final");

    // A user message and a blank answer must not touch the artifact.
    await host.fire("message_end", {
      message: { role: "user", content: [{ type: "text", text: "ignored" }] },
    });
    await host.fire("message_end", {
      message: { role: "assistant", content: [{ type: "text", text: "   " }] },
    });
    assert.equal(await fs.readFile(resultFile, "utf8"), "final");
  });
});

test("a child writes nothing when the prompt carries no result channel", async () => {
  await withChildHost(async (host, tmp) => {
    await host.fire("before_agent_start", {
      systemPrompt: "BASE",
      prompt: "Do the thing with no marker.",
    });
    await host.fire("message_end", {
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    });

    const entries = await fs.readdir(tmp);
    assert.deepEqual(entries, []);
  });
});

test("ask_question writes the question beside the result file", async () => {
  await withChildHost(async (host, tmp) => {
    const resultFile = await managedResultFile(tmp);
    await host.fire("before_agent_start", {
      systemPrompt: "BASE",
      prompt: `Task\n${RESULT_FILE_MARKER} ${resultFile}`,
    });

    const tool = host.tools.get("ask_question");
    const result = await tool.execute("call-1", {
      question: "Cookie or JWT?",
    });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /Question sent to the Orchestrator/);
    const questionFile = path.join(path.dirname(resultFile), "question.md");
    assert.equal(result.details.questionFile, questionFile);
    assert.equal(await fs.readFile(questionFile, "utf8"), "Cookie or JWT?");
    // Asking is not answering: the result artifact stays absent.
    assert.equal(await fs.stat(resultFile).catch(() => null), null);
  });
});

test("ask_question fails loudly instead of stranding the child", async () => {
  await withChildHost(async (host) => {
    // No before_agent_start marker at all: there is no channel back.
    const tool = host.tools.get("ask_question");
    const noChannel = await tool.execute("call-1", { question: "Anything?" });
    assert.equal(noChannel.isError, true);
    assert.match(noChannel.content[0].text, /No Orchestrator channel/);
    assert.match(noChannel.content[0].text, /Decide yourself/);

    const empty = await tool.execute("call-2", { question: "   " });
    assert.equal(empty.isError, true);
    assert.match(empty.content[0].text, /must not be empty/);
  });
});
