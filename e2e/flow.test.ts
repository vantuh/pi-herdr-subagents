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

test("continues a closed one-shot via resumeClosed and keeps its context", async () => {
  await withE2e({}, async (harness) => {
    const first = await harness.call({
      agent: "scout",
      task: "First slice: count the routers.",
      tabLabel: "Scout E2E",
    });
    assert.match(first.content[0].text, /MOCK_CHILD_OK/);
    assert.equal(first.details.closed, true);

    const second = await harness.call({
      agent: "scout",
      task: "Second slice: now count the handlers.",
      tabLabel: "Scout E2E",
      resumeClosed: true,
    });
    assert.equal(second.details.resumed, true);

    // The resumed child runs with the archived session, so the second
    // request carries the first turn's history.
    const secondRequest = harness.llm.requestsMentioning(
      "Second slice: now count the handlers.",
    )[0];
    assert.ok(secondRequest, "expected the second task to reach the model");
    const history = JSON.stringify(secondRequest.messages);
    assert.match(history, /First slice: count the routers\./);

    // The continued one-shot closed again after collection.
    const snapshot = await harness.snapshot();
    assert.deepEqual(
      snapshot.panes.map((pane) => pane.pane_id),
      [harness.orchestratorPaneId],
    );
    assert.deepEqual((await harness.readState()).agents, {});
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
    // Children stall long enough to stay live while the layout is checked.
    harness.llm.setScript(() => ({
      delayMs: 30000,
      text: "Still working.",
    }));
    // Detached spawns keep both children live while the layout is checked.
    await Promise.all([
      harness.callRaw({
        agent: "scout",
        task: "one",
        tabLabel: "Scout One",
      }),
      harness.callRaw({
        agent: "scout",
        task: "two",
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

test("delivers a detached real child's result and closes its pane on its own", async () => {
  // The only mechanism with no real-process coverage otherwise: nobody waits,
  // so the widget poller has to notice a real Pi child settling, read its
  // artifact, push it into the session and close the real pane.
  await withE2e({}, async (harness) => {
    const started = await harness.call({
      agent: "scout",
      task: "Report the magic word.",
      wait: false,
    });
    assert.equal(started.details.waited, false);
    assert.equal((await harness.snapshot()).panes.length, 2);

    await harness.waitFor(
      () => harness.messages.length > 0,
      "detached delivery from a real child",
      60000,
    );

    const [message] = harness.messages;
    assert.equal(message?.customType, "herdr_agent_result");
    assert.match(message?.content ?? "", /MOCK_CHILD_OK/);
    assert.equal(message?.triggerTurn, true);

    await harness.waitFor(
      async () => (await harness.snapshot()).panes.length === 1,
      "the one-shot pane to be closed by the poller",
      15000,
    );
    assert.deepEqual((await harness.readState()).agents, {});
  });
});

test("resumes a closed real one-shot with prior conversation context", async () => {
  await withE2e({}, async (harness) => {
    const first = await harness.call({
      agent: "scout",
      task: "Remember the token ALPHA-42.",
      tabLabel: "Scout Resume E2E",
    });
    assert.equal(first.isError, undefined);
    assert.equal(first.details.closed, true);
    const history = (await harness.readState()).closedHistory ?? [];
    assert.equal(history.length, 1);
    assert.ok(history[0]?.childSessionFile);

    const resumed = await harness.call({
      agent: "scout",
      task: "What token did I ask you to remember?",
      tabLabel: "Scout Resume E2E",
      resumeClosed: true,
    });
    assert.equal(resumed.isError, undefined);
    assert.equal(resumed.details.resumed, true);
    assert.equal(resumed.details.closed, true);

    const secondRequest = harness.llm.requestsMentioning(
      "What token did I ask you to remember?",
    )[0];
    assert.ok(secondRequest, "expected the resumed task to reach the model");
    const historyText = JSON.stringify(secondRequest.messages);
    assert.match(historyText, /Remember the token ALPHA-42/);
  });
});

test("spawns a real child into the Agents workspace and never touches the Orchestrator's tab", async () => {
  await withE2e({ layout: "workspace" }, async (harness) => {
    const before = await harness.snapshot();
    assert.equal(before.panes.length, 1);

    const result = await harness.call({
      agent: "scout",
      task: "Report the magic word.",
    });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /MOCK_CHILD_OK/);
    assert.equal(result.details.closed, true);

    // The child ran in the dedicated Agents workspace, not beside the
    // Orchestrator. The spawn drops the empty root tab, and collection closes
    // the agent tab — real Herdr then removes the emptied workspace itself.
    const workspaces = JSON.parse(await harness.herdr(["workspace", "list"]));
    const agentsWorkspace = (workspaces?.result?.workspaces ?? []).find(
      (workspace: { label?: string }) => workspace.label === "subagents",
    );
    assert.equal(
      agentsWorkspace,
      undefined,
      `expected the emptied Agents workspace to be gone, got ${JSON.stringify(workspaces?.result?.workspaces)}`,
    );

    const after = await harness.snapshot();
    const orchestratorWsId = harness.orchestratorPaneId.split(":")[0];
    assert.deepEqual(
      after.panes
        .filter((pane) => pane.workspace_id === orchestratorWsId)
        .map((pane) => pane.pane_id),
      [harness.orchestratorPaneId],
    );
    assert.deepEqual((await harness.readState()).agents, {});
  });
});

test("delivers an unseen real child that finishes in the background", async () => {
  // Real-Herdr coverage for background completion: nobody waits and the
  // child's tab is never focused by any UI. The poller has to notice the
  // settled child, read its artifact, push the result into the session and
  // close the tab. Herdr reports such work as `done`; in a fully headless
  // harness its seen/unseen heuristic is not deterministic run-to-run, so the
  // strict `done` semantics are pinned by the FakeHerdr integration test and
  // cross-checked here with a server-side wait witness.
  await withE2e({ layout: "workspace" }, async (harness) => {
    const started = await harness.call({
      agent: "scout",
      task: "Report the magic word.",
      wait: false,
    });
    assert.equal(started.details.waited, false);

    // Server-side witness: resolves only if the unseen child really reached
    // Herdr's `done` state while its tab was still open. If the poller closes
    // it first, the wait reports unknown-agent and the snapshot statuses below
    // are the remaining evidence.
    const record = Object.values((await harness.readState()).agents)[0];
    assert.ok(record?.automationName);
    const doneWitness = harness
      .herdr([
        "agent",
        "wait",
        record.automationName!,
        "--until",
        "done",
        "--timeout",
        "30000",
      ])
      .then(() => true)
      .catch(() => false);

    const seenStatuses = new Set<string>();
    await harness.waitFor(
      async () => {
        const snapshot = await harness.snapshot();
        for (const pane of snapshot.panes) {
          if (pane.agent === "pi" && pane.pane_id !== harness.orchestratorPaneId) {
            seenStatuses.add(pane.agent_status ?? "");
          }
        }
        return harness.messages.length > 0;
      },
      "detached delivery from an unseen real child",
      60000,
    );

    // Whatever Herdr called the settled state, it was a finished one, and the
    // child really reached `done` server-side in the witnessed runs.
    assert.ok(
      seenStatuses.has("done") ||
        seenStatuses.has("idle") ||
        (await doneWitness),
      `expected a settled unseen child, saw: ${[...seenStatuses].join(", ") || "nothing"}`,
    );

    const [message] = harness.messages;
    assert.equal(message?.customType, "herdr_agent_result");
    assert.match(message?.content ?? "", /MOCK_CHILD_OK/);
    assert.equal(message?.triggerTurn, true);

    await harness.waitFor(
      async () => {
        const snapshot = await harness.snapshot();
        const orchestratorWsId = harness.orchestratorPaneId.split(":")[0];
        const remaining = snapshot.panes.filter(
          (pane) =>
            pane.workspace_id === orchestratorWsId &&
            pane.pane_id !== harness.orchestratorPaneId,
        );
        return remaining.length === 0;
      },
      "the unseen one-shot tab to be closed by the poller",
      15000,
    );
    assert.deepEqual((await harness.readState()).agents, {});
  });
});
