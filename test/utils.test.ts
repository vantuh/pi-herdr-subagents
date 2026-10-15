import assert from 'node:assert/strict';

import { test } from 'vitest';

import { makeHerdrAgentName } from '../src/utils.ts';

/**
 * Shared helpers: Herdr automation names.
 */

test('generates valid unique Herdr automation names', () => {
  const first = makeHerdrAgentName('Code Reviewer');
  const second = makeHerdrAgentName('Code Reviewer');

  assert.match(first, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.notEqual(first, second);
});
