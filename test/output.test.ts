import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  formatAgentOutput,
  formatAssistantPreview,
  formatSpawnWarnings,
} from '../src/output.ts';

/**
 * Output formatting: assistant previews, agent text, and spawn/close
 * warnings.
 */

test('previews assistant text verbatim', () => {
  const text = [
    '• keep this bullet',
    '──────',
    'repeated',
    'repeated',
    'HERDR_RESULT_FILE: literal content, not a boundary',
    '↑12 additions and 52 tok/s stay',
  ].join('\n');

  assert.equal(formatAssistantPreview(text), text);
});

test('caps the preview to the most recent lines with a truncation marker', () => {
  const raw = Array.from({ length: 80 }, (_, index) => `line ${index}`).join(
    '\n',
  );
  const lines = formatAssistantPreview(raw).split('\n');

  assert.equal(lines[0], '… (truncated)');
  assert.equal(lines.length, 31);
  assert.equal(lines.at(-1), 'line 79');
  assert.equal(lines[1], 'line 50');
});

test('caps the preview characters with a truncation marker', () => {
  const preview = formatAssistantPreview(`${'a'.repeat(3_000)}\nTAIL`);

  assert.match(preview, /^… \(truncated\)\n/);
  assert.ok(preview.length < 2_100);
  assert.match(preview, /TAIL$/);
});

test('formats agent output text', () => {
  assert.equal(formatAgentOutput('  hello  \n', 'Worker'), 'hello');
});

test('appends spawn warnings to model-facing result text', () => {
  assert.equal(formatSpawnWarnings('done', []), 'done');
  assert.equal(
    formatSpawnWarnings('done', ['Skills not found: ghost.']),
    'done\n\nSpawn warnings:\n- Skills not found: ghost.',
  );
});

test('falls back to a placeholder for empty agent output', () => {
  assert.equal(
    formatAgentOutput('   \n', 'Worker'),
    '(Herdr agent Worker finished with no visible output.)',
  );
});

test('appends a close warning when closing the agent failed', () => {
  assert.equal(
    formatAgentOutput('done', 'Worker', 'target not found'),
    'done\n\nWarning: failed to close one-shot Herdr agent Worker: target not found',
  );
});
