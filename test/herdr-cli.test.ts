import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  mapPromptError,
  parseAgentSnapshot,
  parseStartedAgentSnapshot,
  startedAgentReady,
} from '../src/herdr/agent.ts';
import {
  HerdrCliError,
  redactHerdrArgs,
  sanitizeHerdrOutput,
  sensitiveArgValues,
} from '../src/herdr/cli.ts';

/**
 * Herdr CLI boundary: prompt errors, argv redaction/sanitization and agent
 * snapshot parsing.
 */

test('maps agent_blocked prompt failures to an actionable orchestrator error', () => {
  const secret = 'SECRET_PROMPT_TEXT';
  const blocked = new HerdrCliError(
    `herdr agent prompt worker_ab12 ${secret} failed [agent_blocked]: blocked`,
    'agent_blocked',
    ['agent', 'prompt', 'worker_ab12', secret],
  );

  assert.throws(
    () => mapPromptError(blocked, 'worker_ab12'),
    (error: unknown) => {
      assert.ok(error instanceof HerdrCliError);
      assert.equal(error.code, 'agent_blocked');
      assert.match(
        error.message,
        /attach with `herdr agent attach worker_ab12`/,
      );
      assert.match(error.message, /resolve it before re-prompting/);
      assert.deepEqual(error.args, [
        'agent',
        'prompt',
        'worker_ab12',
        '<prompt>',
      ]);
      assert.ok(!error.message.includes(secret));
      assert.ok(!error.args.includes(secret));
      return true;
    },
  );

  const busy = new HerdrCliError(
    'herdr agent prompt worker_ab12 <prompt> failed [agent_pane_busy]: busy',
    'agent_pane_busy',
    ['agent', 'prompt', 'worker_ab12', '<prompt>'],
  );
  assert.throws(
    () => mapPromptError(busy, 'worker_ab12'),
    (error: unknown) => error === busy,
  );

  const plain = new Error('network down');
  assert.throws(
    () => mapPromptError(plain, 'worker_ab12'),
    (error: unknown) => error === plain,
  );
});

test('redacts session, system-prompt, and managed temp paths from Herdr argv', () => {
  const session = '/tmp/herdr-pi-sessions/child.jsonl';
  const system = '/tmp/herdr-agent-xyz/system.md';
  const meta = '/tmp/herdr-agent-xyz/session.json';
  const redacted = redactHerdrArgs([
    'agent',
    'start',
    'scout_ab12',
    '--pane',
    'pane-1',
    '--',
    '--session',
    session,
    '--append-system-prompt',
    system,
    '--env',
    `HERDR_AGENT_SESSION_META=${meta}`,
  ]);
  assert.equal(redacted.includes(session), false);
  assert.equal(redacted.includes(system), false);
  assert.equal(redacted.includes(meta), false);
  assert.equal(redacted[redacted.indexOf('--session') + 1], '<redacted>');
  assert.equal(
    redacted[redacted.indexOf('--append-system-prompt') + 1],
    '<redacted>',
  );
});

test('sanitizes exact argv values including paths with spaces from Herdr stderr', () => {
  const session = '/tmp/my project/herdr-pi-sessions/child session.jsonl';
  const temp = '/tmp/herdr-agent-xyz/system file.md';
  const args = [
    'agent',
    'start',
    'scout_ab12',
    '--',
    '--session',
    session,
    '--append-system-prompt',
    temp,
  ];
  const quoted = `failed '${session}' and "${temp}"`;
  const unquoted = `cmd ${session} ${temp}`;
  const sensitive = sensitiveArgValues(args);
  assert.ok(sensitive.includes(session));
  assert.ok(sensitive.includes(temp));
  for (const text of [quoted, unquoted, JSON.stringify({ cmd: args })]) {
    const safe = sanitizeHerdrOutput(text, sensitive);
    assert.equal(safe.includes(session), false);
    assert.equal(safe.includes(temp), false);
  }
});

test('recognizes Pi after a transient startup kind mismatch', () => {
  const kiro = parseStartedAgentSnapshot(
    JSON.stringify({
      result: { agent: { agent: 'kiro', agent_status: 'working' } },
    }),
  );
  const pi = parseStartedAgentSnapshot(
    JSON.stringify({
      result: { agent: { agent: 'pi', agent_status: 'idle' } },
    }),
  );

  assert.equal(startedAgentReady(kiro, 'pi'), false);
  assert.equal(startedAgentReady(pi, 'pi'), true);
  assert.equal(
    startedAgentReady({ agent: 'pi', status: 'working' }, 'pi'),
    false,
  );
});

test('parses only real completion sequences from agent get', () => {
  for (const completion of [undefined, null, 0, 13]) {
    const snapshot = parseAgentSnapshot(
      JSON.stringify({
        result: {
          agent: {
            agent_status: 'idle',
            state_change_seq: 12,
            completion_seq: completion,
          },
        },
      }),
    );
    assert.deepEqual(snapshot, {
      status: 'idle',
      stateChangeSeq: 12,
      completionSeq: typeof completion === 'number' ? completion : undefined,
    });
  }
});
