import assert from 'node:assert/strict';

import { describe, it } from 'vitest';

import {
  buildRunTurnInstructions,
  CHILD_PROTOCOL,
  GLOBAL_INSTRUCTIONS,
} from '../src/prompts.ts';

describe('prompts', () => {
  it('CHILD_PROTOCOL prohibits recursive delegation', () => {
    assert.ok(CHILD_PROTOCOL.includes('Do not start other agents'));
  });

  it('GLOBAL_INSTRUCTIONS names the four agent tools and the one-shot contract', () => {
    for (const tool of [
      'agent_spawn',
      'agent_send',
      'agent_stop',
      'agent_status',
    ]) {
      assert.ok(GLOBAL_INSTRUCTIONS.includes(tool), tool);
    }
    assert.doesNotMatch(
      GLOBAL_INSTRUCTIONS,
      /herdr_agent|resumeClosed|tabLabel/,
    );
    assert.ok(
      GLOBAL_INSTRUCTIONS.includes('Agents close after delivering a result'),
    );
    // Profiles are user-defined: the prompt must not name any of them.
    assert.doesNotMatch(
      GLOBAL_INSTRUCTIONS,
      /\b(scout|researcher|worker|reviewer)\b/,
    );
    assert.doesNotMatch(buildRunTurnInstructions(), /\b(scout|researcher)\b/);
  });

  it('GLOBAL_INSTRUCTIONS drops persistent/standby mechanics', () => {
    assert.ok(!GLOBAL_INSTRUCTIONS.includes('persistent'));
    assert.ok(!GLOBAL_INSTRUCTIONS.includes('lifecycle:'));
    assert.ok(!GLOBAL_INSTRUCTIONS.includes('standby'));
    assert.ok(!GLOBAL_INSTRUCTIONS.includes('timeoutMs'));
  });

  it('GLOBAL_INSTRUCTIONS covers delivery without blocking', () => {
    assert.ok(
      GLOBAL_INSTRUCTIONS.includes('returns once the task is submitted'),
    );
  });

  it('GLOBAL_INSTRUCTIONS does not use proactive delegation', () => {
    assert.ok(!GLOBAL_INSTRUCTIONS.includes('openai-codex'));
    assert.ok(!GLOBAL_INSTRUCTIONS.includes('Proactively use'));
  });

  it('GLOBAL_INSTRUCTIONS covers status checks', () => {
    assert.ok(
      GLOBAL_INSTRUCTIONS.includes('Check an agent with `agent_status`'),
    );
    assert.ok(GLOBAL_INSTRUCTIONS.includes('Never wait for it'));
  });

  it('buildRunTurnInstructions names agent when provided', () => {
    assert.ok(buildRunTurnInstructions('scout').includes('agent: "scout"'));
    assert.ok(buildRunTurnInstructions().includes('smallest suitable'));
  });
});
