import assert from 'node:assert/strict';

import { test } from 'vitest';

import { ASK_QUESTION_TOOL } from '../src/artifacts.ts';
import { buildChildToolAllowlist } from '../src/tool/child-args.ts';

/**
 * Child argv: tool allowlist construction.
 */

test('adds the question channel to a restricted tool profile', () => {
  assert.deepEqual(buildChildToolAllowlist(['read', 'grep']), [
    'read',
    'grep',
    ASK_QUESTION_TOOL,
  ]);
});

test('passes no tool allowlist when the profile does not restrict tools', () => {
  assert.equal(buildChildToolAllowlist(undefined), undefined);
  assert.equal(buildChildToolAllowlist([]), undefined);
});

test('does not duplicate an explicitly listed question tool', () => {
  assert.deepEqual(buildChildToolAllowlist(['read', ASK_QUESTION_TOOL]), [
    'read',
    ASK_QUESTION_TOOL,
  ]);
});

test('keeps profile tool order in the allowlist', () => {
  assert.deepEqual(buildChildToolAllowlist(['bash', 'read', 'edit']), [
    'bash',
    'read',
    'edit',
    ASK_QUESTION_TOOL,
  ]);
});
