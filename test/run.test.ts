import assert from 'node:assert/strict';

import { describe, it } from 'vitest';

import { formatRunUserMessage, parseRunArgs } from '../src/run.ts';

describe('parseRunArgs', () => {
  const known = ['scout', 'oracle', 'Auditor'];

  it('parses a discovered agent and task', () => {
    assert.deepEqual(parseRunArgs('oracle find auth entry points', known), {
      agent: 'oracle',
      task: 'find auth entry points',
    });
  });

  it('matches case-insensitively but returns the real profile name', () => {
    assert.deepEqual(parseRunArgs('auditor check the diff', known), {
      agent: 'Auditor',
      task: 'check the diff',
    });
  });

  it('treats a word that is not a discovered profile as task text', () => {
    assert.deepEqual(parseRunArgs('reviewer check the diff', known), {
      task: 'reviewer check the diff',
    });
  });

  it('rejects empty input', () => {
    assert.equal(parseRunArgs('', known), null);
    assert.equal(parseRunArgs('   ', known), null);
  });

  it('rejects agent without task', () => {
    assert.equal(parseRunArgs('scout', known), null);
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
