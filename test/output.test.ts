import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  formatAgentOutput,
  formatAssistantPreview,
  formatResultForDelivery,
  formatSpawnWarnings,
  RESULT_EXCERPT_HEAD_CHARS,
  RESULT_EXCERPT_TAIL_CHARS,
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
    'AGENT_RESULT_FILE: literal content, not a boundary',
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
    '(Agent Worker finished with no visible output.)',
  );
});

test('appends a close warning when closing the agent failed', () => {
  assert.equal(
    formatAgentOutput('done', 'Worker', 'target not found'),
    'done\n\nWarning: failed to close one-shot agent Worker: target not found',
  );
});

/**
 * Bounded delivery: the excerpt keeps whole lines, states the exact number of
 * dropped source units, and only ever runs when a durable report exists.
 */

function exactText(length: number): string {
  const lines: string[] = [];
  let used = 0;
  while (used < length) {
    const width = Math.min(100, length - used - (lines.length === 0 ? 0 : 1));
    lines.push('x'.repeat(width));
    used += width + (lines.length > 1 ? 1 : 0);
  }
  const text = lines.join('\n');
  assert.equal(text.length, length, 'fixture builder bug');
  return text;
}

function parseExcerpt(body: string): {
  head: string;
  tail: string;
  omitted: number;
  reportPath: string;
} {
  const marker = /\n\n… (\d+) characters omitted …\n\n/.exec(body);
  const path =
    /\n\nFull report saved to (\S+) \(kept 30 days\) — read it when you need the omitted part\.$/.exec(
      body,
    );
  if (!marker || !path) throw new Error(`not an excerpt: ${body}`);
  return {
    head: body.slice(0, marker.index),
    omitted: Number(marker[1]),
    tail: body.slice(marker.index + marker[0].length, path.index),
    reportPath: path[1],
  };
}

test('delivers a small result whole plus the report path', () => {
  const body = formatResultForDelivery({
    result: 'Findings\n\nAGENT_RESULT: done — short',
    tabLabel: 'Scout',
    reportPath: '/tmp/reports/a.md',
  });

  assert.equal(
    body,
    'Findings\n\nAGENT_RESULT: done — short\n\nFull report saved to /tmp/reports/a.md',
  );
  assert.ok(!body.includes('omitted'));
});

test('switches to the excerpt one unit above the retained budget', () => {
  const budget = RESULT_EXCERPT_HEAD_CHARS + RESULT_EXCERPT_TAIL_CHARS;
  const whole = formatResultForDelivery({
    result: exactText(budget),
    tabLabel: 'Scout',
    reportPath: '/tmp/reports/b.md',
  });

  assert.equal(
    whole,
    `${exactText(budget)}\n\nFull report saved to /tmp/reports/b.md`,
  );

  const over = formatResultForDelivery({
    result: exactText(budget + 1),
    tabLabel: 'Scout',
    reportPath: '/tmp/reports/c.md',
  });
  const excerpt = parseExcerpt(over);
  assert.equal(excerpt.head.length, 3_938);
  assert.equal(excerpt.tail.length, 1_961);
  assert.equal(excerpt.omitted, 102);
  // A retained-source budget, so the body may be longer than a barely-over
  // input: the marker and the path line are extra, never the dropped middle.
  assert.ok(over.length > budget + 1);
});

test('keeps whole lines at both ends and the final AGENT_RESULT line', () => {
  const report = [
    ...Array.from(
      { length: 40 },
      (_, index) => `finding ${index}: ${'evidence '.repeat(20).trim()}`,
    ),
    'AGENT_RESULT: done — one line summary',
  ].join('\n');
  const body = formatResultForDelivery({
    result: report,
    tabLabel: 'Scout',
    reportPath: '/tmp/reports/d.md',
  });
  const excerpt = parseExcerpt(body);

  assert.ok(excerpt.head.length <= RESULT_EXCERPT_HEAD_CHARS);
  assert.ok(excerpt.tail.length <= RESULT_EXCERPT_TAIL_CHARS);
  assert.ok(excerpt.head.length + excerpt.tail.length <= 6_000);
  assert.ok(report.startsWith(excerpt.head));
  assert.equal(report[excerpt.head.length], '\n');
  assert.ok(report.endsWith(excerpt.tail));
  assert.equal(report[report.length - excerpt.tail.length - 1], '\n');
  assert.equal(
    excerpt.omitted,
    report.length - excerpt.head.length - excerpt.tail.length,
  );
  assert.equal(
    excerpt.tail.split('\n').at(-1),
    'AGENT_RESULT: done — one line summary',
  );
});

test('cuts a single over-budget line by characters within each budget', () => {
  const report = 'x'.repeat(9_000);
  const body = formatResultForDelivery({
    result: report,
    tabLabel: 'Scout',
    reportPath: '/tmp/reports/e.md',
  });
  const excerpt = parseExcerpt(body);

  assert.ok(excerpt.head.length > 0 && excerpt.tail.length > 0);
  assert.equal(excerpt.head.length, RESULT_EXCERPT_HEAD_CHARS);
  assert.equal(excerpt.tail.length, RESULT_EXCERPT_TAIL_CHARS);
  assert.equal(excerpt.omitted, report.length - 6_000);
});

test('keeps a whole line ending exactly at each budget', () => {
  const atHeadBudget = `${'a'.repeat(RESULT_EXCERPT_HEAD_CHARS)}\n${'b'.repeat(1_000)}\n${'c'.repeat(3_000)}`;
  const head = parseExcerpt(
    formatResultForDelivery({
      result: atHeadBudget,
      tabLabel: 'Scout',
      reportPath: '/tmp/reports/h.md',
    }),
  ).head;
  assert.equal(head, 'a'.repeat(RESULT_EXCERPT_HEAD_CHARS));
  assert.equal(atHeadBudget[head.length], '\n');

  const overHeadBudget = `${'a'.repeat(3_000)}\n${'b'.repeat(1_000)}\n${'c'.repeat(3_000)}`;
  const shorter = parseExcerpt(
    formatResultForDelivery({
      result: overHeadBudget,
      tabLabel: 'Scout',
      reportPath: '/tmp/reports/i.md',
    }),
  ).head;
  // The line ending one unit past the budget is dropped whole, not cut.
  assert.equal(shorter, 'a'.repeat(3_000));

  const atTailBudget = `${'p'.repeat(4_001)}\n${'q'.repeat(1_995)}\nTAIL`;
  const tail = parseExcerpt(
    formatResultForDelivery({
      result: atTailBudget,
      tabLabel: 'Scout',
      reportPath: '/tmp/reports/j.md',
    }),
  ).tail;
  assert.equal(tail.length, RESULT_EXCERPT_TAIL_CHARS);
  assert.equal(atTailBudget[atTailBudget.length - tail.length - 1], '\n');
  assert.ok(tail.endsWith('TAIL'));
});

test('falls back to the character cut when the whole-line cut would be empty', () => {
  const report = `\n${'x'.repeat(9_000)}`;
  const excerpt = parseExcerpt(
    formatResultForDelivery({
      result: report,
      tabLabel: 'Scout',
      reportPath: '/tmp/reports/k.md',
    }),
  );
  // A whole-line head would be empty, so the character cut keeps the newline.
  assert.equal(excerpt.head.length, RESULT_EXCERPT_HEAD_CHARS);
  assert.equal(excerpt.head[0], '\n');
  assert.equal(excerpt.tail, 'x'.repeat(RESULT_EXCERPT_TAIL_CHARS));
  assert.equal(excerpt.omitted, 3_001);
});

test('trims blank edge lines but still counts them as omitted', () => {
  const report = `${'a'.repeat(3_000)}\n${'b'.repeat(3_000)}\n   \nTAIL\n\n`;
  const excerpt = parseExcerpt(
    formatResultForDelivery({
      result: report,
      tabLabel: 'Scout',
      reportPath: '/tmp/reports/l.md',
    }),
  );
  assert.equal(excerpt.head, 'a'.repeat(3_000));
  assert.equal(excerpt.tail, 'TAIL\n\n');
  assert.equal(excerpt.omitted, 3_006);
});

test('never leaves a lone surrogate at a character cut', () => {
  const report = `a${'😀'.repeat(4_000)}`;
  const body = formatResultForDelivery({
    result: report,
    tabLabel: 'Scout',
    reportPath: '/tmp/reports/f.md',
  });
  const excerpt = parseExcerpt(body);

  assert.ok(excerpt.head.isWellFormed());
  assert.ok(excerpt.tail.isWellFormed());
  assert.ok(excerpt.head.length > 0 && excerpt.tail.length > 0);
  // The cut shrinks inward by one unit so the pair at the cut stays whole.
  assert.equal(excerpt.head.length, RESULT_EXCERPT_HEAD_CHARS - 1);
  assert.equal(excerpt.tail.length, RESULT_EXCERPT_TAIL_CHARS);
  assert.equal(
    excerpt.omitted,
    report.length - excerpt.head.length - excerpt.tail.length,
  );

  const lined = `a${'😀'.repeat(4_000)}\nAGENT_RESULT: done — 😀 tail`;
  const linedBody = formatResultForDelivery({
    result: lined,
    tabLabel: 'Scout',
    reportPath: '/tmp/reports/g.md',
  });
  const linedExcerpt = parseExcerpt(linedBody);
  assert.ok(linedExcerpt.head.isWellFormed());
  assert.ok(linedExcerpt.tail.isWellFormed());
  assert.equal(
    linedExcerpt.omitted,
    lined.length - linedExcerpt.head.length - linedExcerpt.tail.length,
  );
});

test('keeps the full text when no report was written or attempted', () => {
  const report = exactText(9_000);

  assert.equal(
    formatResultForDelivery({ result: report, tabLabel: 'Scout' }),
    report,
  );
  assert.equal(
    formatResultForDelivery({
      result: report,
      tabLabel: 'Scout',
      reportError: 'EEXIST: nope',
    }),
    `${report}\n\nWarning: failed to save the full report for agent Scout: EEXIST: nope. Delivering the full result instead.`,
  );
});
