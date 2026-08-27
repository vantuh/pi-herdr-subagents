import assert from "node:assert/strict";
import test from "node:test";
import { exportPaneLayout } from "../herdr.ts";
import { createE2eHarness, type E2eHarness } from "../test-support/e2e-harness.ts";
import {
  DEFAULT_RESULT_TEXT,
  isToolFollowUp,
  lastUserText,
  offeredTools,
} from "../test-support/mock-llm.ts";

/**
 * End-to-end flows against a real Herdr server with real Pi children.
 * Slow by nature (each scenario boots a server and one or more Pi processes);
 * run with `bun run test:e2e`.
 */

async function withE2e(
  options: Parameters<typeof createE2eHarness>[0],
  body: (harness: E2eHarness) => Promise<void>,
): Promise<void> {
  const harness = await createE2eHarness(options);
  try {
    await body(harness);
  } finally {
    await harness.dispose();
  }
}

test("spawns a real Pi child in a real pane, collects its result and closes the pane", async () => {
  await withE2e({}, async (harness) => {
    const before = await harness.snapshot();
    assert.equal(before.panes.length, 1);

    const result = await harness.call({
      agent: "scout",
      task: "Report the magic word.",
    });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /MOCK_CHILD_OK/);
    assert.equal(result.details.closed, true);

    // The child really was a Pi process talking to the model.
    assert.ok(harness.llm.requests.length >= 1);
    const prompt = harness.llm.requestsMentioning("Report the magic word.");
    assert.equal(prompt.length, 1);

    // The pane is gone again.
    const after = await harness.snapshot();
    assert.deepEqual(
      after.panes.map((pane) => pane.pane_id),
      [harness.orchestratorPaneId],
    );
    assert.deepEqual((await harness.readState()).agents, {});
  });
});

test("reuses one persistent child process across two tasks and keeps its context", async () => {
  await withE2e({}, async (harness) => {
    const first = await harness.call({
      agent: "scout",
      task: "First slice: count the routers.",
      lifecycle: "persistent",
      tabLabel: "Scout E2E",
    });
    assert.match(first.content[0].text, /MOCK_CHILD_OK/);
    assert.equal(first.details.closed, false);

    const second = await harness.call({
      agent: "scout",
      task: "Second slice: now count the handlers.",
      lifecycle: "persistent",
      tabLabel: "Scout E2E",
    });
    assert.equal(second.details.reused, true);

    // Same Pi process, so the second request carries the first turn's history.
    const secondRequest = harness.llm.requestsMentioning(
      "Second slice: now count the handlers.",
    )[0];
    assert.ok(secondRequest, "expected the second task to reach the model");
    const history = JSON.stringify(secondRequest.messages);
    assert.match(history, /First slice: count the routers\./);

    // One pane, one child, still open and reusable.
    const snapshot = await harness.snapshot();
    assert.equal(snapshot.panes.length, 2);
    const child = snapshot.panes.find(
      (pane) => pane.pane_id !== harness.orchestratorPaneId,
    );
    assert.equal(child?.agent, "pi");
    const record = Object.values((await harness.readState()).agents)[0];
    assert.equal(record?.lifecycle, "persistent");
    assert.equal(record?.tabLabel, "Scout E2E");
  });
});

test("carries a real ask_question tool call from the child back to the Orchestrator", async () => {
  await withE2e(
    { profiles: [{ name: "scout", tools: ["read"] }] },
    async (harness) => {
      harness.llm.setScript((body) => {
        if (isToolFollowUp(body)) {
          return { text: "Waiting for the Orchestrator's answer." };
        }
        if (lastUserText(body).includes("ANSWER:")) {
          return { text: DEFAULT_RESULT_TEXT };
        }
        return {
          toolCall: {
            name: "ask_question",
            args: { question: "Cookie session or JWT?" },
          },
        };
      });

      const asked = await harness.call({
        agent: "scout",
        task: "Find the auth flow.",
      });

      assert.equal(asked.details.status, "question");
      assert.equal(asked.details.closed, false);
      assert.match(asked.content[0].text, /Cookie session or JWT\?/);

      // The restricted profile still got the question channel.
      assert.ok(
        offeredTools(harness.llm.requests[0] ?? {}).includes("ask_question"),
        `expected ask_question in ${JSON.stringify(offeredTools(harness.llm.requests[0] ?? {}))}`,
      );

      // Parked, not closed.
      assert.equal((await harness.snapshot()).panes.length, 2);

      const answered = await harness.call({
        agent: "scout",
        task: "ANSWER: cookie session.",
        tabLabel: "Scout",
      });

      assert.equal(answered.details.reused, true);
      assert.equal(answered.details.closed, true);
      assert.match(answered.content[0].text, /MOCK_CHILD_OK/);
      assert.deepEqual(
        (await harness.snapshot()).panes.map((pane) => pane.pane_id),
        [harness.orchestratorPaneId],
      );
    },
  );
});

test("stacks two real agent panes into a single right column", async () => {
  await withE2e({}, async (harness) => {
    await Promise.all([
      harness.call({
        agent: "scout",
        task: "one",
        lifecycle: "persistent",
        tabLabel: "Scout One",
      }),
      harness.call({
        agent: "scout",
        task: "two",
        lifecycle: "persistent",
        tabLabel: "Scout Two",
      }),
    ]);

    const snapshot = await harness.snapshot();
    assert.equal(snapshot.panes.length, 3);
    // All three live in the Orchestrator's tab: one column, not extra tabs.
    assert.equal(new Set(snapshot.panes.map((pane) => pane.tab_id)).size, 1);

    const layout = await exportPaneLayout(harness.orchestratorPaneId);
    assert.equal(layout.root.type, "split");
    if (layout.root.type !== "split") return;
    assert.equal(layout.root.direction, "right");
    assert.ok(
      Math.abs(layout.root.ratio - 0.6) < 0.02,
      `Orchestrator column should stay at 60%, got ${layout.root.ratio}`,
    );
    assert.equal(layout.root.second.type, "split");
    if (layout.root.second.type !== "split") return;
    assert.equal(layout.root.second.direction, "down");
    // Rebalanced to equal halves.
    assert.ok(
      Math.abs(layout.root.second.ratio - 0.5) < 0.02,
      `agent column should be even, got ${layout.root.second.ratio}`,
    );
  });
});
