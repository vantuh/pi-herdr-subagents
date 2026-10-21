import {
  DynamicBorder,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import { Box, Text } from '@earendil-works/pi-tui';

import { assistantText } from '../artifacts.ts';

export const AGENT_RESULT_MESSAGE_TYPE = 'agent_result';
export const AGENT_QUESTION_MESSAGE_TYPE = 'agent_question';

export function registerAgentMessageRenderers(pi: ExtensionAPI): void {
  // Delivered results arrive outside any turn the user started. With plain text
  // at the usual output padding they read as a continuation of the assistant's
  // own output, so they get an explicit bordered block with a header instead.
  const registerAgentBlockRenderer = (
    customType: string,
    suffix: string,
    tone: 'accent' | 'warning',
  ) => {
    pi.registerMessageRenderer(customType, (message, options, theme) => {
      const { expanded, outputPad } = options;
      const details = message.details as
        | {
            name?: string;
            agent?: string;
            result?: string;
            question?: string;
          }
        | undefined;
      const label = details?.name ?? 'agent';
      const profile = details?.agent ? ` · ${details.agent}` : '';
      const border = (str: string) => theme.fg(tone, str);

      const box = new Box(outputPad, 0, (t) => theme.bg('customMessageBg', t));
      box.addChild(new DynamicBorder(border));
      box.addChild(
        new Text(
          theme.fg(tone, theme.bold(`Agent ${label}${profile}${suffix}`)),
          1,
          0,
        ),
      );
      // The header carries the attribution the content also states for the
      // model's benefit, so display the bare body and avoid repeating it.
      const body =
        details?.result ?? details?.question ?? assistantText(message);
      box.addChild(new Text(body, 1, 0));
      if (expanded && message.details) {
        box.addChild(
          new Text(
            theme.fg('dim', JSON.stringify(message.details, null, 2)),
            1,
            0,
          ),
        );
      }
      box.addChild(new DynamicBorder(border));
      return box;
    });
  };

  registerAgentBlockRenderer(AGENT_RESULT_MESSAGE_TYPE, '', 'accent');
  // A question needs the Orchestrator to act, so it is toned apart from a result.
  registerAgentBlockRenderer(
    AGENT_QUESTION_MESSAGE_TYPE,
    ' · asked a question',
    'warning',
  );
}
