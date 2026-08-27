import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import test from "node:test";
import type { LayoutNode } from "./test-support/fake-herdr.ts";
import { type Harness, type HarnessOptions, createHarness } from "./test-support/harness.ts";

/**
 * Integration tests for the whole `herdr_agent` flow: the real extension runs
 * against a fake Herdr (real subprocess CLI calls, real socket API, real state
 * file, real result artifacts) with simulated Pi children. Only the terminal
 * and the child LLM are faked.
 */

async function withHarness(
  options: HarnessOptions,
  body: (harness: Harness) => Promise<void>,
): Promise<void> {
  const harness = await createHarness(options);
  try {
    await body(harness);
  } finally {
    await harness.dispose();
  }
}

function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function splitDirections(node: LayoutNode | undefined): string[] {
  if (!node || node.type === "pane") return [];
  return [
    node.direction,
    ...splitDirections(node.first),
    ...splitDirections(node.second),
  ];
}

test("spawns a one-shot pane agent, collects the artifact and closes it", async () => {
  await withHarness({}, async (harness) => {
    const result = await harness.call({
      agent: "scout",
      task: "Find the auth flow",
    });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /Result from scout_/);
    assert.equal(result.details.waited, true);
    assert.equal(result.details.closed, true);
    assert.equal(result.details.reused, false);

    // 60/40 split off the Orchestrator, child markers on the new pane.
    const split = harness.fake.callsMatching("pane", "split")[0];
    assert.ok(split, "expected a pane split");
    assert.equal(split[2], harness.fake.orchestratorPane.pane_id);
    assert.equal(flagValue(split, "--direction"), "right");
    assert.equal(flagValue(split, "--ratio"), "0.6");
    assert.equal(flagValue(split, "--cwd"), harness.cwd);
    assert.ok(split.includes("HERDR_AGENT_CHILD=1"));
    assert.ok(split.includes("PROCESS_LAUNCHED_BY_Q=1"));
    assert.ok(split.includes("--no-focus"));

    const start = harness.fake.callsMatching("agent", "start")[0];
    assert.ok(start);
    assert.equal(flagValue(start, "--kind"), "pi");
    assert.equal(flagValue(start, "--name"), "Scout");
    assert.match(start[2], /^scout_[0-9a-f]{8}$/);

    // The prompt carries the task and the result-file channel.
    const prompt = harness.fake.callsMatching("agent", "prompt")[0];
    assert.ok(prompt);
    assert.match(prompt[3], /Task from Orchestrator:\nFind the auth flow/);
    assert.match(prompt[3], /^HERDR_RESULT_FILE: \S+result\.md$/m);

    // Herdr is told the Orchestrator is blocked, then unblocked.
    assert.deepEqual(
      harness.events.map((event) => [
        event.name,
        (event.payload as { active: boolean }).active,
      ]),
      [
        ["herdr:blocked", true],
        ["herdr:blocked", false],
      ],
    );

    // Pane closed, layout back to a single pane, state pruned.
    assert.deepEqual(
      harness.fake.panes.map((pane) => pane.pane_id),
      [harness.fake.orchestratorPane.pane_id],
    );
    assert.equal(
      harness.fake.layoutFor(harness.fake.orchestratorPane.tab_id)?.type,
      "pane",
    );
    assert.deepEqual((await harness.readState()).agents, {});
  });
});

test("falls back to pane scrollback when the child writes no artifact", async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({
      transcript: "only scrollback, no HERDR_RESULT",
    }));

    const result = await harness.call({ agent: "scout", task: "Look around" });

    assert.equal(result.content[0].text, "only scrollback, no HERDR_RESULT");
    assert.equal(harness.fake.callsMatching("agent", "read").length, 1);
  });
});

test("passes profile model and tool allowlist to the child, and keeps a persistent pane open", async () => {
  await withHarness(
    { profiles: [{ name: "worker", tools: ["read", "edit"], model: "sonnet", body: "WORKER PROFILE BODY" }] },
    async (harness) => {
      const first = await harness.call({
        agent: "worker",
        task: "Slice one",
        lifecycle: "persistent",
      });
      assert.equal(first.details.closed, false);

      const start = harness.fake.callsMatching("agent", "start")[0];
      assert.ok(start);
      assert.equal(flagValue(start, "--model"), "sonnet");
      // ask_question is force-added so a restricted child can still ask.
      assert.equal(flagValue(start, "--tools"), "read,edit,ask_question");

      const systemFile = flagValue(start, "--append-system-prompt");
      assert.ok(systemFile);
      const systemPrompt = await fs.readFile(systemFile, "utf8");
      assert.match(systemPrompt, /WORKER PROFILE BODY/);
      assert.match(systemPrompt, /## Herdr agent protocol/);

      // A second task reuses the same pane by label instead of splitting again.
      const second = await harness.call({
        agent: "worker",
        task: "Slice two",
        lifecycle: "persistent",
      });
      assert.equal(second.details.reused, true);
      assert.equal(harness.fake.callsMatching("pane", "split").length, 1);
      assert.equal(harness.fake.callsMatching("agent", "start").length, 1);
      assert.equal(harness.fake.callsMatching("agent", "prompt").length, 2);
      assert.match(second.content[0].text, /turn 2/);

      const state = await harness.readState();
      const records = Object.values(state.agents);
      assert.equal(records.length, 1);
      assert.equal(records[0]?.lifecycle, "persistent");
      assert.equal(records[0]?.tabLabel, "Worker");
      assert.equal(records[0]?.layout, "pane");
    },
  );
});

test("returns a child question early, keeps the one-shot parked, and answers it by label", async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior((turn) =>
      turn.turn === 1
        ? { question: "Cookie session or JWT?" }
        : { result: "Answered: cookie session" },
    );

    const asked = await harness.call({ agent: "scout", task: "Find auth" });
    assert.equal(asked.details.status, "question");
    assert.equal(asked.details.closed, false);
    assert.match(asked.content[0].text, /Cookie session or JWT\?/);
    assert.match(asked.content[0].text, /tabLabel "Scout"/);

    // Parked, not closed: pane and state record survive.
    assert.equal(harness.fake.panes.length, 2);
    const parked = Object.values((await harness.readState()).agents)[0];
    assert.equal(parked?.tabLabel, "Scout");
    const questionFile = parked?.resultFile?.replace(
      /result\.md$/,
      "question.md",
    );
    assert.ok(questionFile);
    assert.ok(await fs.stat(questionFile).catch(() => null));

    const answered = await harness.call({
      agent: "scout",
      task: "Use the cookie session",
      tabLabel: "Scout",
    });

    assert.equal(answered.details.reused, true);
    assert.equal(answered.details.closed, true);
    assert.match(answered.content[0].text, /Answered: cookie session/);
    // The parked one-shot was reused, not duplicated.
    assert.equal(harness.fake.callsMatching("pane", "split").length, 1);
    assert.equal(harness.fake.callsMatching("agent", "prompt").length, 2);
    assert.deepEqual(
      harness.fake.panes.map((pane) => pane.pane_id),
      [harness.fake.orchestratorPane.pane_id],
    );
    assert.equal(await fs.stat(questionFile).catch(() => null), null);
  });
});

test("serializes parallel spawns into one agent column and rebalances it", async () => {
  await withHarness({}, async (harness) => {
    // All three stay working past the last placement, so the assertions below
    // describe three simultaneously live agents. A label is only reserved while
    // its agent exists — a finished agent frees it again.
    harness.fake.setBehavior((turn) => ({
      result: `Result from ${turn.agentName}`,
      delayMs: 1500,
    }));

    const results = await Promise.all([
      harness.call({ agent: "scout", task: "one" }),
      harness.call({ agent: "scout", task: "two" }),
      harness.call({ agent: "scout", task: "three" }),
    ]);

    for (const result of results) {
      assert.equal(result.isError, undefined);
      assert.equal(result.details.closed, true);
    }

    const splits = harness.fake.callsMatching("pane", "split");
    assert.equal(splits.length, 3);
    // Exactly one right split: the agent column is created once, then stacked.
    assert.deepEqual(
      splits.map((argv) => flagValue(argv, "--direction")),
      ["right", "down", "down"],
    );

    // Labels stay unique, so reuse-by-label cannot cross-wire two agents.
    assert.deepEqual(
      harness.fake.callsMatching("pane", "rename").map((argv) => argv[3]),
      ["Scout", "Scout #2", "Scout #3"],
    );

    // The Orchestrator's own 60/40 split is never rebalanced (path []).
    assert.ok(harness.fake.ratioUpdates.length > 0);
    assert.ok(
      harness.fake.ratioUpdates.every((update) => update.path.length > 0),
    );
    // Three stacked agents means a 2/3 ratio at the top of the column.
    assert.ok(
      harness.fake.ratioUpdates.some(
        (update) => Math.abs(update.ratio - 2 / 3) < 0.01,
      ),
      `expected a 2/3 rebalance, got ${JSON.stringify(harness.fake.ratioUpdates)}`,
    );

    assert.deepEqual((await harness.readState()).agents, {});
  });
});

test("keeps a single right column when a third agent joins two live ones", async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: "scout",
      task: "one",
      lifecycle: "persistent",
      tabLabel: "Scout A",
    });
    await harness.call({
      agent: "scout",
      task: "two",
      lifecycle: "persistent",
      tabLabel: "Scout B",
    });
    await harness.call({
      agent: "scout",
      task: "three",
      lifecycle: "persistent",
      tabLabel: "Scout C",
    });

    const root = harness.fake.layoutFor(harness.fake.orchestratorPane.tab_id);
    const directions = splitDirections(root);
    assert.equal(directions.filter((d) => d === "right").length, 1);
    assert.equal(directions.filter((d) => d === "down").length, 2);
    assert.equal(root?.type === "split" ? root.ratio : undefined, 0.6);
    assert.equal(harness.fake.panes.length, 4);
  });
});

test("retries agent start while the child shell is still busy", async () => {
  await withHarness({}, async (harness) => {
    harness.fake.queueStartFailures("agent_pane_busy", "agent_pane_busy");

    const result = await harness.call({ agent: "scout", task: "Find it" });

    assert.equal(result.isError, undefined);
    assert.equal(harness.fake.callsMatching("agent", "start").length, 3);
  });
});

test("recovers from a transient agent kind mismatch by waiting and renaming", async () => {
  await withHarness({}, async (harness) => {
    harness.fake.queueStartFailures("agent_kind_mismatch");

    const result = await harness.call({ agent: "scout", task: "Find it" });

    assert.equal(result.isError, undefined);
    // Started once (the launch did happen), then renamed to the requested name.
    assert.equal(harness.fake.callsMatching("agent", "start").length, 1);
    const rename = harness.fake.callsMatching("agent", "rename")[0];
    assert.ok(rename, "expected the automation name to be reassigned");
    assert.match(rename[3], /^scout_[0-9a-f]{8}$/);
    assert.ok(harness.fake.callsMatching("agent", "get").length > 0);
  });
});

test("nudges Enter once when the prompt lands in the composer but never submits", async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({
      stalled: true,
      result: "Result after the Enter nudge",
    }));

    const result = await harness.call({ agent: "scout", task: "Find it" });

    assert.match(result.content[0].text, /Result after the Enter nudge/);
    const nudges = harness.fake.callsMatching("agent", "send-keys");
    assert.equal(nudges.length, 1);
    assert.equal(nudges[0]?.[3], "enter");
  });
});

test("returns a soft re-wait hint on wait timeout and collects the result on re-wait", async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({ neverSettle: true }));

    const timedOut = await harness.call({
      agent: "scout",
      task: "Long job",
      timeoutMs: 400,
    });

    assert.equal(timedOut.details.interrupted, true);
    assert.equal(timedOut.details.interruptReason, "timeout");
    assert.match(timedOut.content[0].text, /omit task to re-wait/);
    // Nothing was closed and no second prompt was sent.
    assert.equal(harness.fake.panes.length, 2);

    const record = Object.values((await harness.readState()).agents)[0];
    assert.ok(record?.automationName);
    await harness.fake.completeAgent(record.automationName, "Late result");

    const reWaited = await harness.call({ agent: "scout", tabLabel: "Scout" });

    assert.match(reWaited.content[0].text, /Late result/);
    assert.equal(reWaited.details.closed, true);
    assert.equal(harness.fake.callsMatching("agent", "prompt").length, 1);
    assert.deepEqual(
      harness.fake.panes.map((pane) => pane.pane_id),
      [harness.fake.orchestratorPane.pane_id],
    );
  });
});

test("treats an aborted wait as recoverable and leaves the child running", async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({ neverSettle: true }));

    const controller = new AbortController();
    const pending = harness.call(
      { agent: "scout", task: "Long job" },
      { signal: controller.signal },
    );
    await harness.waitFor(
      () => harness.fake.callsMatching("agent", "wait").length > 0,
      "agent wait to start",
    );
    controller.abort();

    const result = await pending;
    assert.equal(result.details.interrupted, true);
    assert.equal(result.details.interruptReason, "aborted");
    assert.equal(harness.fake.panes.length, 2);
  });
});

test("rejects re-wait for a label that has no running agent", async () => {
  await withHarness({}, async (harness) => {
    const result = await harness.call({ agent: "scout", tabLabel: "Ghost" });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /No running Herdr agent named "Ghost"/);
  });
});

test("requires a label for re-wait mode", async () => {
  await withHarness({}, async (harness) => {
    const result = await harness.call({ agent: "scout" });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /tabLabel is required/);
  });
});

test("rejects an unknown agent profile before touching Herdr", async () => {
  await withHarness({}, async (harness) => {
    const result = await harness.call({ agent: "nope", task: "anything" });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unknown Herdr agent: nope/);
    assert.match(result.content[0].text, /scout/);
    assert.equal(harness.fake.calls.length, 0);
  });
});

test("refuses a detached one-shot without a UI poller to collect it", async () => {
  await withHarness({ hasUI: false }, async (harness) => {
    const result = await harness.call({
      agent: "scout",
      task: "Find it",
      wait: false,
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /requires wait: true in a headless session/);
    assert.equal(harness.fake.calls.length, 0);
  });
});

test("delivers a detached result through the widget poller and closes the one-shot", async () => {
  await withHarness({}, async (harness) => {
    const started = await harness.call({
      agent: "scout",
      task: "Background job",
      wait: false,
    });

    assert.equal(started.details.waited, false);
    assert.match(started.content[0].text, /started/);
    // Nobody is waiting, so the poller owns the result.
    const record = Object.values((await harness.readState()).agents)[0];
    assert.equal(record?.detached, true);

    await harness.waitFor(
      () => harness.messages.length > 0,
      "detached result delivery",
    );

    const [message] = harness.messages;
    assert.equal(message?.customType, "herdr_agent_result");
    assert.match(message?.content ?? "", /finished on its own/);
    assert.match(message?.content ?? "", /Result from scout_/);
    assert.equal(message?.triggerTurn, true);
    assert.equal(message?.details.tabLabel, "Scout");

    // Delivered exactly once, pane closed, state pruned.
    await harness.fire("session_start");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(harness.messages.length, 1);
    assert.deepEqual(
      harness.fake.panes.map((pane) => pane.pane_id),
      [harness.fake.orchestratorPane.pane_id],
    );
    assert.deepEqual((await harness.readState()).agents, {});
  });
});

test("delivers a detached question without closing the agent", async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({ question: "Which module first?" }));

    await harness.call({
      agent: "scout",
      task: "Background job",
      wait: false,
      tabLabel: "Scout Detached",
    });

    await harness.waitFor(
      () => harness.messages.length > 0,
      "detached question delivery",
    );

    const [message] = harness.messages;
    assert.equal(message?.customType, "herdr_agent_question");
    assert.match(message?.content ?? "", /Which module first\?/);
    assert.equal(message?.details.tabLabel, "Scout Detached");
    // Still open and reusable by label.
    assert.equal(harness.fake.panes.length, 2);
    const record = Object.values((await harness.readState()).agents)[0];
    assert.equal(record?.detached, undefined);
    assert.equal(record?.tabLabel, "Scout Detached");
  });
});

test("uses tabs instead of panes when the tab layout is configured", async () => {
  await withHarness({ layout: "tab" }, async (harness) => {
    const result = await harness.call({ agent: "scout", task: "Find it" });

    assert.equal(result.details.closed, true);
    const create = harness.fake.callsMatching("tab", "create")[0];
    assert.ok(create, "expected a tab create");
    assert.equal(flagValue(create, "--label"), "Scout");
    assert.ok(create.includes("HERDR_AGENT_CHILD=1"));
    assert.equal(harness.fake.callsMatching("pane", "split").length, 0);
    assert.equal(harness.fake.callsMatching("tab", "close").length, 1);
    // No pane column to rebalance in tab layout.
    assert.equal(harness.fake.ratioUpdates.length, 0);
  });
});

test("injects Orchestrator instructions, and /run instructions for one turn", async () => {
  await withHarness({}, async (harness) => {
    const base = (await harness.fire("before_agent_start", {
      systemPrompt: "BASE",
      prompt: "hi",
    })) as { systemPrompt: string };
    assert.match(base.systemPrompt, /^BASE\n\n## Herdr agents/);
    assert.doesNotMatch(base.systemPrompt, /\/run delegation/);

    const run = harness.commands.get("run");
    assert.ok(run, "expected a /run command");
    await run.handler("scout find the auth flow", {
      isIdle: () => true,
      ui: { notify: () => undefined },
    });
    assert.deepEqual(harness.userMessages, [
      "[via /run → scout] find the auth flow",
    ]);

    const delegating = (await harness.fire("before_agent_start", {
      systemPrompt: "BASE",
      prompt: "hi",
    })) as { systemPrompt: string };
    assert.match(delegating.systemPrompt, /## \/run delegation/);
    assert.match(delegating.systemPrompt, /agent: "scout"/);

    // The /run authorization is single-turn.
    const after = (await harness.fire("before_agent_start", {
      systemPrompt: "BASE",
      prompt: "hi",
    })) as { systemPrompt: string };
    assert.doesNotMatch(after.systemPrompt, /\/run delegation/);
  });
});
