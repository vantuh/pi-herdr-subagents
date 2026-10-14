import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { formatRunUserMessage, parseRunArgs } from '../src/run.ts';

describe('parseRunArgs', () => {
  it('parses agent and task', () => {
    assert.deepEqual(parseRunArgs('scout find auth entry points'), {
      agent: 'scout',
      task: 'find auth entry points',
    });
  });

  it('parses task without agent', () => {
    assert.deepEqual(parseRunArgs('review the current diff'), {
      task: 'review the current diff',
    });
  });

  it('rejects empty input', () => {
    assert.equal(parseRunArgs(''), null);
    assert.equal(parseRunArgs('   '), null);
  });

  it('rejects agent without task', () => {
    assert.equal(parseRunArgs('scout'), null);
  });
});

describe('formatRunUserMessage', () => {
  it('includes agent when provided', () => {
    assert.equal(
      formatRunUserMessage({ agent: 'reviewer', task: 'check diff' }),
      '[via /run → reviewer] check diff',
    );
  });

  it('omits agent when not provided', () => {
    assert.equal(
      formatRunUserMessage({ task: 'check diff' }),
      '[via /run] check diff',
    );
  });
});
