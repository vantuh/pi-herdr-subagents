import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  ASK_QUESTION_TOOL,
  assistantText,
  findResultFileMarker,
  writeAgentQuestion,
  writeAgentResult,
} from "./utils.ts";

/**
 * Child-side half of the Herdr agent protocol. Runs only when
 * `HERDR_AGENT_CHILD=1`, so the delegation tool and the status widget stay out
 * of spawned agents.
 *
 * Both features hang off the result-file marker in the incoming prompt: the
 * result is written there, and the question file is derived from the same
 * directory.
 */
export function registerChildMode(pi: ExtensionAPI): void {
  let resultFile: string | undefined;

  pi.on("before_agent_start", async (event) => {
    resultFile = findResultFileMarker(event.prompt);
  });

  pi.on("message_end", async (event) => {
    if (!resultFile || event.message.role !== "assistant") return;
    const output = assistantText(event.message);
    if (output.trim()) await writeAgentResult(resultFile, output);
  });

  pi.registerTool({
    name: ASK_QUESTION_TOOL,
    label: "Ask Orchestrator",
    description:
      "Ask the Orchestrator one question when requirements are ambiguous or a decision would materially change scope. End your turn immediately after calling this; the answer arrives as your next prompt.",
    promptSnippet:
      "Ask the Orchestrator a single clarifying question instead of guessing.",
    promptGuidelines: [
      "Call ask_question only for genuine ambiguity or a scope-changing decision, not for details you can settle by reading the repo.",
      "After ask_question, end the turn immediately: no other tool calls and no HERDR_RESULT.",
    ],
    parameters: Type.Object({
      question: Type.String({
        description:
          "One specific question. Include the options you see and what you would pick by default.",
      }),
    }),

    async execute(_toolCallId, params) {
      const question = params.question.trim();
      if (!question) {
        return {
          content: [{ type: "text", text: "question must not be empty." }],
          isError: true,
        };
      }

      // Without a managed result file there is no channel back to the
      // Orchestrator, so asking would silently strand the agent.
      const written = await writeAgentQuestion(resultFile, question);
      if (!written) {
        return {
          content: [
            {
              type: "text",
              text: "No Orchestrator channel is available in this session, so the question cannot be delivered. Decide yourself, state the assumption you made, and continue.",
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: "Question sent to the Orchestrator. Reply with one short line saying you are waiting for the answer, then stop — do not emit HERDR_RESULT and do not call other tools. The answer will arrive as your next prompt.",
          },
        ],
        details: { questionFile: written },
      };
    },
  });
}
