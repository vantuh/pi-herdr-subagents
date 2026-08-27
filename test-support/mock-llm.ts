import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Scripted OpenAI-compatible model server for the e2e harness.
 *
 * The children are real Pi processes, so they need a real provider. This one
 * speaks `openai-completions` streaming, replays a scripted reply per request
 * and records every request body, which is how a test verifies what the child
 * was actually asked (and, for persistent agents, that history accumulated).
 */

export interface MockReply {
  /** Assistant text. With no toolCall this ends the turn. */
  text?: string;
  /** Emit a tool call instead of (or before) text. */
  toolCall?: { name: string; args: unknown };
  /**
   * How long to stall before the content chunk.
   *
   * Not cosmetic: Herdr's agent detection samples the pane, so an instant
   * reply can start and finish a turn without Herdr ever reporting `working`,
   * and the extension would then never see the lifecycle change it waits for.
   * Real models take seconds; so does this.
   */
  delayMs?: number;
}

export type MockLlmScript = (
  body: MockRequestBody,
  index: number,
) => MockReply | Promise<MockReply>;

export interface MockRequestBody {
  model?: string;
  stream?: boolean;
  messages?: Array<{ role: string; content: unknown; [key: string]: unknown }>;
  tools?: Array<{ function?: { name?: string } }>;
}

export const DEFAULT_RESULT_TEXT = [
  "HERDR_RESULT:",
  "- status: done",
  "- summary: MOCK_CHILD_OK",
  "- evidence: none",
  "- changes: none",
  "- next: none",
].join("\n");

/** Text of the last user message, flattened across content parts. */
export function lastUserText(body: MockRequestBody): string {
  const last = [...(body.messages ?? [])]
    .reverse()
    .find((message) => message.role === "user");
  if (typeof last?.content === "string") return last.content;
  if (!Array.isArray(last?.content)) return "";
  return last.content
    .map((part) => (part as { text?: string }).text ?? "")
    .join("\n");
}

/** True when the last message is a tool result, i.e. mid-turn continuation. */
export function isToolFollowUp(body: MockRequestBody): boolean {
  const messages = body.messages ?? [];
  const last = messages[messages.length - 1];
  if (last?.role === "tool") return true;
  return (
    Array.isArray(last?.content) &&
    last.content.some(
      (part) => (part as { type?: string }).type === "toolResult",
    )
  );
}

/** Names of the tools offered to the child in this request. */
export function offeredTools(body: MockRequestBody): string[] {
  return (body.tools ?? [])
    .map((tool) => tool.function?.name)
    .filter((name): name is string => !!name);
}

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class MockLlm {
  readonly requests: MockRequestBody[] = [];
  private script: MockLlmScript = () => ({ text: DEFAULT_RESULT_TEXT });
  private server?: Server;
  private baseUrlValue = "";

  get baseUrl(): string {
    return this.baseUrlValue;
  }

  setScript(script: MockLlmScript): void {
    this.script = script;
  }

  /** Requests whose last user message contains `needle`. */
  requestsMentioning(needle: string): MockRequestBody[] {
    return this.requests.filter((body) => lastUserText(body).includes(needle));
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        void this.respond(raw, res);
      });
    });

    await new Promise<void>((resolve) =>
      this.server?.listen(0, "127.0.0.1", resolve),
    );
    const { port } = this.server?.address() as AddressInfo;
    this.baseUrlValue = `http://127.0.0.1:${port}`;
    return this.baseUrlValue;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async respond(
    raw: string,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    let body: MockRequestBody = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = {};
    }
    const index = this.requests.length;
    this.requests.push(body);

    const reply = await this.script(body, index);
    const base = {
      id: `chatcmpl-mock-${index}`,
      object: "chat.completion.chunk",
      created: 0,
      model: body.model ?? "mock-model",
    };
    const usage = {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
    };

    const deltas: Array<Record<string, unknown>> = [];
    if (reply.text) deltas.push({ content: reply.text });
    if (reply.toolCall) {
      deltas.push({
        tool_calls: [
          {
            index: 0,
            id: `call_${index}`,
            type: "function",
            function: {
              name: reply.toolCall.name,
              arguments: JSON.stringify(reply.toolCall.args),
            },
          },
        ],
      });
    }
    const finishReason = reply.toolCall ? "tool_calls" : "stop";

    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ...base,
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: reply.text ?? "",
                ...(reply.toolCall
                  ? {
                      tool_calls: [
                        {
                          id: `call_${index}`,
                          type: "function",
                          function: {
                            name: reply.toolCall.name,
                            arguments: JSON.stringify(reply.toolCall.args),
                          },
                        },
                      ],
                    }
                  : {}),
              },
              finish_reason: finishReason,
            },
          ],
          usage,
        }),
      );
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (chunk: unknown) =>
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);

    send({
      ...base,
      choices: [
        { index: 0, delta: { role: "assistant", content: "" }, finish_reason: null },
      ],
    });
    await sleep(reply.delayMs ?? 1500);
    for (const delta of deltas) {
      send({ ...base, choices: [{ index: 0, delta, finish_reason: null }] });
    }
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] });
    send({ ...base, choices: [], usage });
    res.write("data: [DONE]\n\n");
    res.end();
  }
}
