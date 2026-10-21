import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { test } from 'vitest';

import {
  RESULT_EXCERPT_HEAD_CHARS,
  RESULT_EXCERPT_TAIL_CHARS,
} from '../src/output.ts';
import {
  herdrAgentReportsDir,
  saveAgentReport,
  setFailNextReportWrites,
} from '../src/reports.ts';
import { withHarness } from '../test-support/integration-harness.ts';

/**
 * Bounded delivery: the full result is archived before the one-shot closes,
 * the delivered text is excerpted only when that archive exists, and questions
 * and interrupted runs write nothing.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function longReport(marker: string): string {
  const middle = Array.from(
    { length: 60 },
    (_, index) => `finding ${index}: ${'evidence '.repeat(20).trim()}`,
  );
  return ['FIRST LINE OF THE REPORT', ...middle, marker].join('\n');
}

/** `<agent dir>/pi-herdr-subagents-results`, the directory the extension just used. */
async function reports(): Promise<string[]> {
  return await fs.readdir(herdrAgentReportsDir()).catch(() => []);
}

function reportPathIn(content: string): string | undefined {
  return /Full report saved to (\S+)/.exec(content)?.[1];
}

/** The delivered body, below the `Agent … finished on its own:` header. */
function bodyOf(content: string): string {
  return content.slice(content.indexOf('\n\n') + 2);
}

test('archives a long result and delivers a head/tail excerpt', async () => {
  await withHarness({}, async (harness) => {
    const text = longReport('AGENT_RESULT: done — long report');
    harness.fake.setBehavior(() => ({ result: text }));

    await harness.call({ agent: 'scout', task: 'Write a long report' });
    const record = Object.values((await harness.readState()).agents)[0];
    assert.ok(record?.resultFile);
    const tempDir = path.dirname(record.resultFile);

    const delivered = await harness.collect('Scout');
    const reportPath = reportPathIn(delivered.content);
    assert.ok(reportPath, 'expected a report path line');
    assert.match(delivered.content, /FIRST LINE OF THE REPORT/);
    assert.match(delivered.content, /AGENT_RESULT: done — long report/);
    assert.ok(/characters omitted/.test(delivered.content));

    assert.equal(await fs.readFile(reportPath, 'utf8'), text);
    // The save ran before the temp artifact was cleaned up.
    assert.equal(
      await fs.stat(tempDir).then(
        () => true,
        () => false,
      ),
      false,
    );

    // The excerpt keeps whole lines within each budget, and the count is exact.
    const body = bodyOf(delivered.content);
    const marker = /\n\n… (\d+) characters omitted …\n\n/.exec(body);
    assert.ok(marker);
    const head = body.slice(0, marker.index);
    const tail = body.slice(
      marker.index + marker[0].length,
      body.lastIndexOf('\n\nFull report saved to'),
    );
    assert.ok(text.startsWith(head));
    assert.ok(text.endsWith(tail));
    assert.ok(head.length <= RESULT_EXCERPT_HEAD_CHARS);
    assert.ok(tail.length <= RESULT_EXCERPT_TAIL_CHARS);
    assert.equal(
      Number(marker[1]),
      text.length - head.length - tail.length,
      'the omission count must match what the excerpt dropped',
    );

    // Delivered once: one archived report, and the same one after more ticks.
    assert.equal((await reports()).length, 1);

    // Delivered once, pane closed, state pruned.
    await harness.fire('session_start');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(harness.messages.length, 1);
    assert.equal((await reports()).length, 1);
    assert.equal(await fs.readFile(reportPath, 'utf8'), text);
    assert.deepEqual((await harness.readState()).agents, {});
  });
});

test('delivers a short result whole with only the report path added', async () => {
  await withHarness({}, async (harness) => {
    const text = 'Short answer.\n\nAGENT_RESULT: done — short';
    harness.fake.setBehavior(() => ({ result: text }));

    await harness.call({ agent: 'scout', task: 'Answer briefly' });
    const delivered = await harness.collect('Scout');

    assert.ok(!/characters omitted/.test(delivered.content));
    assert.match(
      delivered.content,
      /Short answer\.\n\nAGENT_RESULT: done — short\n\nFull report saved to \S+/,
    );
    const reportPath = reportPathIn(delivered.content);
    assert.equal(await fs.readFile(reportPath, 'utf8'), text);
  });
});

test('a failed report write still delivers the complete result', async () => {
  await withHarness({}, async (harness) => {
    const text = longReport('AGENT_RESULT: done — unarchived');
    harness.fake.setBehavior(() => ({ result: text }));
    setFailNextReportWrites(1);

    await harness.call({ agent: 'scout', task: 'Write a long report' });
    const record = Object.values((await harness.readState()).agents)[0];
    assert.ok(record?.resultFile);
    const tempDir = path.dirname(record.resultFile);

    const delivered = await harness.collect('Scout');
    assert.match(
      delivered.content,
      /Warning: failed to save the full report for agent Scout:/,
    );
    assert.ok(!/characters omitted/.test(delivered.content));
    assert.ok(!/Full report saved to/.test(delivered.content));
    assert.match(delivered.content, /FIRST LINE OF THE REPORT/);
    assert.match(delivered.content, /AGENT_RESULT: done — unarchived/);

    // Delivery, close and scratch cleanup all still happen.
    assert.equal(
      await fs.stat(tempDir).then(
        () => true,
        () => false,
      ),
      false,
    );
    await harness.fire('session_start');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(harness.messages.length, 1);
    assert.deepEqual((await harness.readState()).agents, {});
  });
});

test('an unusable reports directory degrades the same way', async () => {
  await withHarness({}, async (harness) => {
    const reportsDir = herdrAgentReportsDir();
    await fs.writeFile(reportsDir, 'not a directory', 'utf8');

    harness.fake.setBehavior(() => ({
      result: longReport('AGENT_RESULT: done — blocked dir'),
    }));
    await harness.call({ agent: 'scout', task: 'Write a long report' });
    const delivered = await harness.collect('Scout');

    assert.match(
      delivered.content,
      /Warning: failed to save the full report for agent Scout:/,
    );
    assert.ok(!/characters omitted/.test(delivered.content));
    assert.equal(await fs.readFile(reportsDir, 'utf8'), 'not a directory');
  });
});

test('a parked question writes no report and keeps the one-shot open', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({
      question: 'Cookie session or JWT?',
    }));

    await harness.call({ agent: 'scout', task: 'Find the auth flow' });
    const delivered = await harness.collect('Scout');

    assert.equal(delivered.customType, 'agent_question');
    assert.match(delivered.content, /Cookie session or JWT\?/);
    assert.ok(!/Full report saved to/.test(delivered.content));
    assert.deepEqual(await reports(), []);
  });
});

test('an interrupted run is not delivered and not archived', async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({ neverSettle: true }));
    await harness.call({ agent: 'scout', task: 'Long task that gets escaped' });
    const record = Object.values((await harness.readState()).agents)[0];
    assert.ok(record?.resultFile && record.automationName);

    // The child wrote partial text and Escape left the marker beside it.
    const tempDir = path.dirname(record.resultFile);
    await fs.writeFile(record.resultFile, 'PARTIAL_BEFORE_ESCAPE', 'utf8');
    await fs.writeFile(
      path.join(tempDir, 'interrupted'),
      'interrupted\n',
      'utf8',
    );
    await harness.fake.completeAgent(record.automationName, 'ignored');

    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(harness.messages, []);
    assert.deepEqual(await reports(), []);
  });
});

test('a resume turn archives its own report and leaves the first immutable', async () => {
  await withHarness({}, async (harness) => {
    const first = longReport('AGENT_RESULT: done — first slice');
    const second = longReport('AGENT_RESULT: done — second slice');
    harness.fake.setBehavior((turn) => ({
      result: turn.prompt.includes('Second slice') ? second : first,
    }));

    await harness.call({
      agent: 'scout',
      task: 'First slice',
      name: 'Scout Slice',
    });
    const firstDelivery = await harness.collect('Scout Slice');
    const firstReport = reportPathIn(firstDelivery.content);
    assert.ok(firstReport);
    const firstBytes = await fs.readFile(firstReport, 'utf8');
    assert.equal(firstBytes, first);

    await harness.callTool('agent_send', {
      name: 'Scout Slice',
      message: 'Second slice',
    });
    const secondDelivery = await harness.collect('Scout Slice');
    const secondReport = reportPathIn(secondDelivery.content);
    assert.ok(secondReport);

    assert.notEqual(secondReport, firstReport);
    assert.equal((await reports()).length, 2);
    assert.equal(await fs.readFile(firstReport, 'utf8'), firstBytes);
    assert.equal(await fs.readFile(secondReport, 'utf8'), second);
  });
});

test('the save sweeps expired reports without touching foreign ones', async () => {
  await withHarness({}, async (harness) => {
    const reportsDir = herdrAgentReportsDir();
    const now = new Date();
    const expired = await saveAgentReport({
      text: 'expired',
      tabLabel: 'Scout',
      now: new Date(now.getTime() - 31 * DAY_MS),
      reportsDir,
      suffix: () => '00000001',
    });
    const fresh = await saveAgentReport({
      text: 'fresh',
      tabLabel: 'Scout',
      now: new Date(now.getTime() - 29 * DAY_MS),
      reportsDir,
      suffix: () => '00000002',
    });
    await fs.writeFile(path.join(reportsDir, 'notes.md'), 'foreign', 'utf8');

    harness.fake.setBehavior(() => ({
      result: longReport('AGENT_RESULT: done — sweep'),
    }));
    await harness.call({ agent: 'scout', task: 'Write a long report' });
    await harness.collect('Scout');

    const kept = await reports();
    assert.ok(!kept.includes(path.basename(expired)));
    assert.ok(kept.includes(path.basename(fresh)));
    assert.ok(kept.includes('notes.md'));
  });
});
