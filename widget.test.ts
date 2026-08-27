import assert from "node:assert/strict";
import test from "node:test";
import type { HerdrAgentInfo } from "./types.ts";
import {
  agentStatusView,
  formatElapsed,
  renderAgentWidgetLines,
  truncateLabel,
  type WidgetPaint,
} from "./widget.ts";

const NOW = Date.parse("2026-08-27T12:00:00.000Z");

function agent(overrides: Partial<HerdrAgentInfo> = {}): HerdrAgentInfo {
  return {
    tabId: "w1:tA",
    tabLabel: "Scout",
    paneId: "w1:p1",
    agent: "scout",
    status: "working",
    updatedAt: new Date(NOW - 83_000).toISOString(),
    ...overrides,
  };
}

test("formats elapsed time as mm:ss below an hour", () => {
  assert.equal(formatElapsed(0), "00:00");
  assert.equal(formatElapsed(9_000), "00:09");
  assert.equal(formatElapsed(83_000), "01:23");
  assert.equal(formatElapsed(3_599_000), "59:59");
});

test("formats elapsed time as h:mm:ss from an hour up", () => {
  assert.equal(formatElapsed(3_600_000), "1:00:00");
  assert.equal(formatElapsed(3_723_000), "1:02:03");
});

test("clamps negative elapsed time to zero", () => {
  assert.equal(formatElapsed(-5_000), "00:00");
});

test("maps herdr agent statuses to tones", () => {
  assert.deepEqual(agentStatusView("working"), {
    text: "working",
    tone: "active",
  });
  assert.deepEqual(agentStatusView("blocked"), {
    text: "blocked · attach to unblock",
    tone: "attention",
  });
  assert.deepEqual(agentStatusView("idle"), { text: "idle", tone: "quiet" });
  assert.deepEqual(agentStatusView("done"), { text: "done", tone: "quiet" });
});

test("treats unknown statuses as starting", () => {
  assert.deepEqual(agentStatusView("unknown"), {
    text: "starting",
    tone: "quiet",
  });
  assert.deepEqual(agentStatusView(""), { text: "starting", tone: "quiet" });
});

test("truncates labels longer than the column width", () => {
  assert.equal(truncateLabel("Scout", 10), "Scout");
  assert.equal(truncateLabel("0123456789", 10), "0123456789");
  assert.equal(truncateLabel("Scout — message-bus", 10), "Scout — m…");
});

test("renders nothing when there are no agents", () => {
  assert.deepEqual(renderAgentWidgetLines([], NOW), []);
});

test("renders a header and one row per agent", () => {
  const lines = renderAgentWidgetLines(
    [
      agent({ tabLabel: "Scout — message-bus" }),
      agent({
        tabLabel: "Reviewer",
        status: "blocked",
        updatedAt: new Date(NOW - 3_723_000).toISOString(),
      }),
    ],
    NOW,
  );

  assert.deepEqual(lines, [
    "Herdr agents · 2 · 1 working",
    "   01:23 Scout — message-bus  working",
    " 1:02:03 Reviewer             blocked · attach to unblock",
  ]);
});

test("aligns the label column when elapsed widths differ", () => {
  const lines = renderAgentWidgetLines(
    [
      agent({ tabLabel: "Scout" }),
      agent({
        tabLabel: "Reviewer",
        updatedAt: new Date(NOW - 3_723_000).toISOString(),
      }),
    ],
    NOW,
  );

  const starts = lines.slice(1).map((line) => line.search(/[A-Z]/));
  assert.equal(starts[0], starts[1]);
});

test("omits the working suffix when nothing is working", () => {
  const lines = renderAgentWidgetLines([agent({ status: "idle" })], NOW);
  assert.equal(lines[0], "Herdr agents · 1");
});

test("pads labels to a common width across rows", () => {
  const lines = renderAgentWidgetLines(
    [agent({ tabLabel: "A" }), agent({ tabLabel: "Reviewer" })],
    NOW,
  );

  const columns = lines.slice(1).map((line) => line.indexOf("working"));
  assert.equal(columns[0], columns[1]);
});

test("shows a placeholder when the task start time is missing or invalid", () => {
  const missing = renderAgentWidgetLines(
    [agent({ updatedAt: undefined })],
    NOW,
  );
  assert.match(missing[1], /^ --:-- /);

  const invalid = renderAgentWidgetLines([agent({ updatedAt: "nope" })], NOW);
  assert.match(invalid[1], /^ --:-- /);
});

test("applies paint per column and tone", () => {
  const paint: WidgetPaint = {
    header: (text) => `H(${text})`,
    elapsed: (text) => `E(${text})`,
    status: (text, tone) => `S:${tone}(${text})`,
  };

  const lines = renderAgentWidgetLines(
    [agent({ tabLabel: "Scout", status: "blocked" })],
    NOW,
    paint,
  );

  assert.equal(lines[0], "H(Herdr agents · 1)");
  assert.equal(
    lines[1],
    " E(01:23) Scout  S:attention(blocked · attach to unblock)",
  );
});
