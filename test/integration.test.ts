import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import type { LayoutNode } from "../test-support/fake-herdr.ts";
import {
  type Harness,
  type HarnessOptions,
  createHarness,
} from "../test-support/harness.ts";
import { setFailNextStateMutation, clearStateSaveFailures } from "../state.ts";

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
    clearStateSaveFailures();
    await harness.dispose();
  }
}

function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function writeHarnessCouncilConfig(content: string): Promise<void> {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (!agentDir) {
    throw new Error("expected PI_CODING_AGENT_DIR from the harness");
  }
  await fs.writeFile(path.join(agentDir, "council.json"), content, "utf8");
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
    {
      profiles: [
        {
          name: "worker",
          tools: ["read", "edit"],
          model: "sonnet",
          body: "WORKER PROFILE BODY",
        },
      ],
    },
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

test("model override replaces the profile model for a fresh spawn", async () => {
  await withHarness(
    {
      profiles: [
        {
          name: "worker",
          model: "sonnet",
          body: "WORKER PROFILE BODY",
        },
      ],
    },
    async (harness) => {
      const result = await harness.call({
        agent: "worker",
        task: "Slice one",
        model: "opus-5",
        lifecycle: "persistent",
      });
      assert.equal(result.isError ?? false, false);

      const start = harness.fake.callsMatching("agent", "start")[0];
      assert.ok(start);
      assert.equal(flagValue(start, "--model"), "opus-5");
      // Other profile settings are untouched.
      const systemFile = flagValue(start, "--append-system-prompt");
      assert.ok(systemFile);
      assert.match(await fs.readFile(systemFile, "utf8"), /WORKER PROFILE BODY/);
    },
  );
});

test("rejects a task addressed to a live persistent agent without lifecycle: persistent", async () => {
  await withHarness({}, async (harness) => {
    const first = await harness.call({
      agent: "scout",
      task: "First task",
      lifecycle: "persistent",
      tabLabel: "Scout — repo",
    });
    assert.equal(first.isError ?? false, false);

    // Omitted lifecycle must not silently spawn a duplicate "#2" agent.
    const duplicate = await harness.call({
      agent: "scout",
      task: "Follow-up task",
      tabLabel: "Scout — repo",
    });
    assert.equal(duplicate.isError, true);
    assert.match(
      duplicate.content[0].text,
      /persistent Herdr agent named "Scout — repo" exists/,
    );
    assert.match(duplicate.content[0].text, /lifecycle: "persistent"/);
    assert.equal(harness.fake.panes.length, 2); // orchestrator + agent
    assert.equal(harness.fake.callsMatching("agent", "start").length, 1);
    assert.equal(harness.fake.callsMatching("agent", "prompt").length, 1);

    // The corrected call reuses the existing pane.
    const fixed = await harness.call({
      agent: "scout",
      task: "Follow-up task",
      lifecycle: "persistent",
      tabLabel: "Scout — repo",
    });
    assert.equal(fixed.isError ?? false, false);
    assert.equal(fixed.details.reused, true);
    assert.equal(harness.fake.panes.length, 2);
    assert.equal(harness.fake.callsMatching("agent", "prompt").length, 2);
  });
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
    assert.match(
      result.content[0].text,
      /No running Herdr agent named "Ghost"/,
    );
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
    assert.match(
      result.content[0].text,
      /requires wait: true in a headless session/,
    );
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
    // Pane-layout agents are visible on screen, so no notification ping.
    assert.equal(harness.fake.callsMatching("notification", "show").length, 0);
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

test("spawns a one-shot into the Agents workspace and closes its tab", async () => {
  await withHarness({ layout: "workspace" }, async (harness) => {
    const result = await harness.call({ agent: "scout", task: "Find it" });

    assert.equal(result.details.closed, true);

    // The Agents workspace was resolved live and created once, unfocused.
    assert.ok(
      harness.fake.callsMatching("workspace", "list").length >= 1,
      "expected a workspace list lookup",
    );
    const create = harness.fake.callsMatching("workspace", "create")[0];
    assert.ok(create, "expected the Agents workspace to be created");
    assert.equal(flagValue(create, "--label"), "subagents");
    assert.ok(create.includes("--no-focus"));

    const workspaceCreate = harness.fake.callsMatching("workspace", "create")[0];
    assert.ok(workspaceCreate, "expected a workspace create");

    // The agent got its own tab in the new Agents workspace, not a split and
    // not a tab next to the Orchestrator.
    const tabCreate = harness.fake.callsMatching("tab", "create")[0];
    assert.ok(tabCreate, "expected a tab create");
    const agentsWorkspaceId = flagValue(tabCreate, "--workspace");
    assert.ok(
      agentsWorkspaceId && agentsWorkspaceId !== harness.fake.workspaceId,
      `expected a separate Agents workspace id, got ${agentsWorkspaceId}`,
    );
    assert.equal(flagValue(tabCreate, "--label"), "Scout");
    assert.ok(tabCreate.includes("--no-focus"));
    assert.equal(harness.fake.callsMatching("pane", "split").length, 0);
    assert.equal(harness.fake.ratioUpdates.length, 0);

    // Collection closed the agent tab, and the spawn dropped the empty root
    // shell tab the workspace started with; the Orchestrator workspace is
    // untouched, and real Herdr (and the fake) remove a workspace once its
    // last tab closes, so nothing is left behind.
    assert.equal(harness.fake.callsMatching("tab", "close").length, 2);
    assert.deepEqual(
      harness.fake.panes
        .filter((pane) => pane.workspace_id === harness.fake.workspaceId)
        .map((pane) => pane.pane_id),
      [harness.fake.orchestratorPane.pane_id],
    );
    assert.equal(
      harness.fake.workspaces.find(
        (workspace) => workspace.label === "subagents",
      ),
      undefined,
    );
    const history = (await harness.readState()).closedHistory;
    assert.equal(history[0]?.layout, "workspace");
    assert.equal(history[0]?.tabLabel, "Scout");
  });
});

test("recreates the Agents workspace after the user closed it by hand", async () => {
  await withHarness({ layout: "workspace" }, async (harness) => {
    await harness.call({
      agent: "scout",
      task: "stay",
      lifecycle: "persistent",
      tabLabel: "Scout One",
    });
    const first = harness.fake.workspaces.find(
      (workspace) => workspace.label === "subagents",
    );
    assert.ok(first);
    assert.equal(harness.fake.callsMatching("workspace", "create").length, 1);

    // The user closes the whole workspace; the next spawn must recover.
    assert.ok(harness.fake.closeWorkspaceById(first.workspace_id));

    const result = await harness.call({
      agent: "scout",
      task: "second",
      tabLabel: "Scout Two",
    });
    assert.equal(result.details.closed, true);
    assert.equal(harness.fake.callsMatching("workspace", "create").length, 2);
    const secondWorkspaceId = flagValue(
      harness.fake.callsMatching("tab", "create").at(-1)!,
      "--workspace",
    );
    assert.ok(secondWorkspaceId);
    assert.notEqual(secondWorkspaceId, first.workspace_id);
    // The second workspace emptied itself out again after the one-shot closed.
    assert.equal(
      harness.fake.workspaces.find(
        (workspace) => workspace.label === "subagents",
      ),
      undefined,
    );
  });
});

test("delivers an unseen done completion, notifies, and closes the one-shot", async () => {
  await withHarness({ layout: "workspace" }, async (harness) => {
    // The child settles as `done` — Herdr's marker for background work the
    // user has never seen — instead of `idle`.
    harness.fake.setBehavior(() => ({
      result: "Background done.",
      settleStatus: "done",
    }));

    const started = await harness.call({
      agent: "scout",
      task: "Background job",
      wait: false,
    });
    assert.equal(started.details.waited, false);

    await harness.waitFor(
      () => harness.messages.length > 0,
      "detached done-status delivery",
    );

    const [message] = harness.messages;
    assert.equal(message?.customType, "herdr_agent_result");
    assert.match(message?.content ?? "", /Background done\./);
    assert.equal(message?.triggerTurn, true);

    // Unseen completions ping the user through Herdr's own notifications.
    const notify = harness.fake.callsMatching("notification", "show")[0];
    assert.ok(notify, "expected a Herdr notification");
    assert.equal(notify[2], "Pi · Scout finished");
    assert.equal(flagValue(notify, "--body"), "Background done.");

    // Delivered exactly once, tab closed, state pruned.
    await harness.fire("session_start");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(harness.messages.length, 1);
    // Only the agent's own tab existed; the poller closed it and the emptied
    // workspace vanished with it.
    assert.equal(
      harness.fake.workspaces.find(
        (workspace) => workspace.label === "subagents",
      ),
      undefined,
    );
    assert.deepEqual((await harness.readState()).agents, {});
  });
});

test("/herdr-agents focuses an Agents-workspace agent via tab focus", async () => {
  await withHarness(
    { layout: "workspace", dialogInputs: [["\r"]] },
    async (harness) => {
      await harness.call({
        agent: "scout",
        task: "stay",
        lifecycle: "persistent",
        tabLabel: "Scout Ws",
      });

      await harness.runCommand("herdr-agents");

      const focus = harness.fake.callsMatching("tab", "focus")[0];
      assert.ok(focus, `expected a tab focus, calls: ${JSON.stringify(harness.fake.calls.slice(-4))}`);
      const agentsWorkspace = harness.fake.workspaces.find(
        (workspace) => workspace.label === "subagents",
      );
      assert.ok(agentsWorkspace);
      assert.ok(
        focus[2]?.startsWith(`${agentsWorkspace.workspace_id}:`),
        `expected a cross-workspace tab id, got ${focus[2]}`,
      );
      assert.match(
        harness.notifications.at(-1)?.message ?? "",
        /Focused Herdr agent "Scout Ws"/,
      );
      // The empty root tab was dropped at spawn; focusing must not close the
      // agent itself.
      assert.equal(
        harness.fake.panes.filter(
          (pane) => pane.workspace_id === agentsWorkspace.workspace_id,
        ).length,
        1,
      );
    },
  );
});

test("serializes parallel workspace spawns into one workspace and unique labels", async () => {
  await withHarness({ layout: "workspace" }, async (harness) => {
    // Keep all three agents live past the last placement so the assertions
    // describe three simultaneously existing tabs. Delay agent start so it
    // lands after other spawns' cleanup windows — pane.agent is unset until
    // start returns, which is what used to make a sibling spawn close a live
    // agent tab as "empty".
    harness.fake.delayAgentStart(400);
    harness.fake.setBehavior((turn) => ({
      result: `Result from ${turn.agentName}`,
      delayMs: 1200,
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

    // One shared Agents workspace, created exactly once.
    assert.equal(harness.fake.callsMatching("workspace", "create").length, 1);
    // Every agent got its own tab there, with a unique label.
    const creates = harness.fake.callsMatching("tab", "create");
    assert.equal(creates.length, 3);
    assert.deepEqual(
      creates.map((argv) => flagValue(argv, "--label")).sort(),
      ["Scout", "Scout #2", "Scout #3"],
    );
    assert.ok(creates.every((argv) => argv.includes("--no-focus")));
    assert.equal(harness.fake.callsMatching("pane", "split").length, 0);

    const calls = harness.fake.calls;
    const tabCreateIdx = calls.flatMap((argv, index) =>
      argv[0] === "tab" && argv[1] === "create" ? [index] : [],
    );
    const agentStartIdx = calls.flatMap((argv, index) =>
      argv[0] === "agent" && argv[1] === "start" ? [index] : [],
    );
    const tabCloseIdx = calls.flatMap((argv, index) =>
      argv[0] === "tab" && argv[1] === "close" ? [index] : [],
    );
    assert.equal(tabCreateIdx.length, 3);
    assert.equal(agentStartIdx.length, 3);
    // Root tab once (creating spawn) plus the three agent tabs at collection.
    assert.equal(tabCloseIdx.length, 4);
    const rootCloseId = calls[tabCloseIdx[0]!]![2];
    const collectionCloseIds = tabCloseIdx.slice(1).map((index) => calls[index]![2]);
    assert.ok(rootCloseId, "expected the creating spawn to close the root tab");
    assert.equal(collectionCloseIds.length, 3);
    assert.ok(
      collectionCloseIds.every((id) => id !== rootCloseId),
      "collection must close agent tabs, not the root tab again",
    );
    // Later spawns must not close anything between their tab create and
    // agent start — that window is where the empty-tab heuristic used to
    // kill a sibling whose agent was not started yet.
    for (let spawn = 1; spawn < 3; spawn++) {
      const createAt = tabCreateIdx[spawn]!;
      const startAt = agentStartIdx[spawn]!;
      const intervening = tabCloseIdx.filter(
        (index) => index > createAt && index < startAt,
      );
      assert.equal(
        intervening.length,
        0,
        `spawn ${spawn + 1} closed a tab between tab create and agent start`,
      );
    }
  });
});

test("re-wait in workspace mode is a pure lookup and never creates the workspace", async () => {
  await withHarness({ layout: "workspace" }, async (harness) => {
    const ghost = await harness.call({ agent: "scout", tabLabel: "Ghost" });
    assert.equal(ghost.isError, true);
    assert.match(ghost.content[0].text, /No running Herdr agent named "Ghost"/);
    // A missing workspace means "nothing to find", not a fresh workspace.
    assert.equal(harness.fake.callsMatching("workspace", "create").length, 0);

    // A live detached persistent agent is still findable and re-waitable.
    harness.fake.setBehavior(() => ({ neverSettle: true }));
    await harness.call({
      agent: "scout",
      task: "stay",
      lifecycle: "persistent",
      tabLabel: "Scout Live",
      wait: false,
    });
    const rewait = await harness.call({
      agent: "scout",
      tabLabel: "Scout Live",
      wait: false,
    });
    assert.match(rewait.content[0].text, /is still running/);
    // Still exactly the one workspace the spawn above created — the re-wait
    // added none.
    assert.equal(harness.fake.callsMatching("workspace", "create").length, 1);
  });
});

test("reuses a persistent agent by label across tasks in workspace mode", async () => {
  await withHarness({ layout: "workspace" }, async (harness) => {
    const first = await harness.call({
      agent: "scout",
      task: "first",
      lifecycle: "persistent",
      tabLabel: "Scout Ws",
    });
    assert.equal(first.details.reused, false);

    const second = await harness.call({
      agent: "scout",
      task: "second",
      lifecycle: "persistent",
      tabLabel: "Scout Ws",
    });
    assert.equal(second.details.reused, true);
    // Same agent tab, no duplicate workspace or spawn.
    assert.equal(harness.fake.callsMatching("tab", "create").length, 1);
    assert.equal(harness.fake.callsMatching("workspace", "create").length, 1);
  });
});

test("persistent follow-up reuse performs no spawn-phase tab close", async () => {
  await withHarness({ layout: "workspace" }, async (harness) => {
    await harness.call({
      agent: "scout",
      task: "first",
      lifecycle: "persistent",
      tabLabel: "Scout Ws",
    });
    const closesAfterFirst = harness.fake.callsMatching("tab", "close").length;
    // Creating spawn closes the workspace root tab; the agent tab stays open.
    assert.equal(closesAfterFirst, 1);

    await harness.call({
      agent: "scout",
      task: "second",
      lifecycle: "persistent",
      tabLabel: "Scout Ws",
    });
    assert.equal(
      harness.fake.callsMatching("tab", "close").length,
      closesAfterFirst,
      "reuse must not close tabs during spawn",
    );
  });
});

test("refuses a workspace.label that matches the Orchestrator's own workspace", async () => {
  await withHarness({ layout: "workspace" }, async (harness) => {
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    assert.ok(agentDir, "expected the harness to set PI_CODING_AGENT_DIR");
    await fs.writeFile(
      path.join(agentDir, "herdr-agents.json"),
      `${JSON.stringify({ layout: "workspace", workspace: { label: "main" } })}\n`,
    );

    const result = await harness.call({ agent: "scout", task: "nope" });
    assert.equal(result.isError, true);
    assert.match(
      result.content[0].text,
      /workspace\.label matches this Orchestrator's own workspace/,
    );
    assert.match(result.content[0].text, /herdr-agents\.json/);
    assert.equal(harness.fake.callsMatching("tab", "create").length, 0);
  });
});

test("resumeClosed archives and resumes in workspace mode", async () => {
  await withHarness({ layout: "workspace" }, async (harness) => {
    const first = await harness.call({
      agent: "scout",
      task: "Remember the token ALPHA-42.",
      tabLabel: "Scout Ws Resume",
    });
    assert.equal(first.details.closed, true);
    const history = (await harness.readState()).closedHistory;
    assert.equal(history.length, 1);

    const resumed = await harness.call({
      agent: "scout",
      task: "What token did I ask you to remember?",
      tabLabel: "Scout Ws Resume",
      resumeClosed: true,
    });
    assert.equal(resumed.details.resumed, true);
    assert.equal(resumed.details.closed, true);
    assert.match(resumed.content[0].text, /Result from scout_/);
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

test("/council injects the question and a persisted per-model spawn contract", async () => {
  await withHarness({}, async (harness) => {
    await writeHarnessCouncilConfig(
      JSON.stringify({ models: ["model-a", "model-b"] }),
    );
    const council = harness.commands.get("council");
    assert.ok(council, "expected a /council command");
    await council.handler("Why is X better than Y?", {
      isIdle: () => true,
      ui: { notify: () => undefined },
    });
    assert.equal(harness.userMessages.length, 1);
    const injected = harness.userMessages[0] ?? "";
    assert.match(injected, /^\[via \/council\] Why is X better than Y\?/);
    assert.match(injected, /model-a/);
    assert.match(injected, /model-b/);
    assert.match(injected, /wait: false/);
    assert.match(injected, /consolidate/);

    const after = (await harness.fire("before_agent_start", {
      systemPrompt: "BASE",
      prompt: "hi",
    })) as { systemPrompt: string };
    assert.doesNotMatch(after.systemPrompt, /\/council round table/);
    assert.doesNotMatch(after.systemPrompt, /Models: model-a, model-b/);
  });
});

test("/council refuses while busy and warns on an empty config", async () => {
  await withHarness({}, async (harness) => {
    await writeHarnessCouncilConfig(JSON.stringify({ models: [] }));
    const notifications: string[] = [];
    const commandCtx = {
      isIdle: () => true,
      ui: { notify: (message: string) => notifications.push(message) },
    };
    const council = harness.commands.get("council");
    assert.ok(council);

    // Busy guard fires before the config is even read.
    await council.handler("Why is X better than Y?", {
      ...commandCtx,
      isIdle: () => false,
    });
    assert.deepEqual(harness.userMessages, []);
    assert.match(notifications[0] ?? "", /busy/i);

    // Empty model list never injects a spawn contract.
    await council.handler("Why is X better than Y?", commandCtx);
    assert.deepEqual(harness.userMessages, []);
    assert.match(notifications[1] ?? "", /No council models/);

    // Empty question shows usage.
    await council.handler("   ", commandCtx);
    assert.match(notifications[2] ?? "", /Usage:/);
  });
});

// The scenarios below come from behaviors that were verified by hand during
// development and recorded in docs/session-findings.md.

test("targets the pane from HERDR_PANE_ID, not whatever Herdr reports as focused", async () => {
  // §5: focus can move to something the user clicked while a tool is running.
  await withHarness({}, async (harness) => {
    // Another pane holds focus; the Orchestrator is elsewhere.
    harness.fake.panes.push({
      pane_id: "w1:decoy",
      tab_id: harness.fake.orchestratorPane.tab_id,
      workspace_id: harness.fake.workspaceId,
      terminal_id: "term-decoy",
      focused: true,
      agent: "pi",
      agent_status: "idle",
      env: {},
    });
    harness.fake.focusedPaneId = "w1:decoy";

    await harness.call({ agent: "scout", task: "Find it" });

    const split = harness.fake.callsMatching("pane", "split")[0];
    assert.equal(split?.[2], harness.fake.orchestratorPane.pane_id);
  });
});

test("does not accept a reused agent's previous settled state as this turn's result", async () => {
  // §8: a persistent child still exposes its prior idle/done status, and the
  // old artifact is still on disk until this prompt clears it.
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior((turn) =>
      turn.turn === 1
        ? { result: "FIRST TURN RESULT" }
        : // Keep reporting the first turn's idle + seq for a while.
          { result: "SECOND TURN RESULT", staleWindowMs: 400 },
    );

    await harness.call({
      agent: "scout",
      task: "one",
      lifecycle: "persistent",
    });
    const second = await harness.call({
      agent: "scout",
      task: "two",
      lifecycle: "persistent",
    });

    assert.equal(second.details.reused, true);
    assert.match(second.content[0].text, /SECOND TURN RESULT/);
    assert.doesNotMatch(second.content[0].text, /FIRST TURN RESULT/);
    // It really had to wait it out rather than short-circuit on stale idle.
    assert.ok(harness.fake.callsMatching("agent", "wait").length >= 2);
  });
});

test("collects a child that finishes as done rather than idle", async () => {
  // §8: completed children can settle as either status.
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({
      result: "DONE-STATUS RESULT",
      settleStatus: "done",
    }));

    const result = await harness.call({ agent: "scout", task: "Find it" });

    assert.match(result.content[0].text, /DONE-STATUS RESULT/);
    assert.equal(result.details.closed, true);
  });
});

test("removes the managed temp directory with a one-shot but keeps it for a persistent agent", async () => {
  // §9: system.md and result.md share one private temp dir per agent.
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: "scout",
      task: "keep me",
      lifecycle: "persistent",
    });
    const persistentRecord = Object.values(
      (await harness.readState()).agents,
    )[0];
    const persistentDir = path.dirname(persistentRecord?.resultFile ?? "");
    assert.ok(persistentRecord?.resultFile);
    assert.deepEqual((await fs.readdir(persistentDir)).sort(), [
      "result.md",
      "session.json",
      "system.md",
    ]);

    await harness.call({
      agent: "scout",
      task: "close me",
      tabLabel: "Scout Oneshot",
    });
    // The one-shot's own directory is gone; the persistent one is untouched.
    const dirs = await fs.readdir(path.dirname(persistentDir));
    assert.equal(
      dirs.filter((name) => name.startsWith("herdr-agent-")).length,
      1,
    );
    assert.ok(
      await fs.stat(path.join(persistentDir, "result.md")).catch(() => null),
    );
  });
});

test("delivers two detached outcomes as one batch with a single turn trigger", async () => {
  // Two agents asking in parallel used to surface a whole turn apart, because
  // triggering on the first message made the rest queue behind that turn.
  await withHarness({ isIdle: false }, async (harness) => {
    harness.fake.setBehavior((turn) => ({
      question: `Question from ${turn.agentName}?`,
    }));

    // Neither child runs until both are spawned, so both settle in the same
    // poller tick — the condition the batching exists for.
    harness.fake.holdChildren();
    await harness.call({
      agent: "scout",
      task: "a",
      wait: false,
      tabLabel: "Scout A",
      lifecycle: "persistent",
    });
    await harness.call({
      agent: "scout",
      task: "b",
      wait: false,
      tabLabel: "Scout B",
      lifecycle: "persistent",
    });
    await harness.fake.releaseChildren();

    await harness.waitFor(
      () => harness.messages.length >= 2,
      "both detached questions delivered",
    );

    assert.equal(harness.messages.length, 2);
    assert.deepEqual(
      harness.messages.map((message) => message.customType),
      ["herdr_agent_question", "herdr_agent_question"],
    );
    // Only the last message starts a turn; both are steered because the
    // Orchestrator is mid-turn.
    assert.deepEqual(
      harness.messages.map((message) => message.triggerTurn),
      [undefined, true],
    );
    assert.deepEqual(
      harness.messages.map((message) => message.deliverAs),
      ["steer", "steer"],
    );
    assert.deepEqual(
      harness.messages.map((message) => message.details.tabLabel).sort(),
      ["Scout A", "Scout B"],
    );
  });
});

test("gives up on a pane that never frees up, without closing anything", async () => {
  // §12: the agent_pane_busy retry is bounded to five seconds.
  await withHarness({}, async (harness) => {
    harness.fake.failEveryStart("agent_pane_busy");

    await assert.rejects(
      () => harness.call({ agent: "scout", task: "Find it" }),
      (error: unknown) => {
        assert.match(String(error), /agent_pane_busy/);
        return true;
      },
    );

    // It retried rather than failing on the first attempt.
    assert.ok(harness.fake.callsMatching("agent", "start").length > 5);
    // The split pane is left for inspection, and no agent was recorded.
    assert.deepEqual((await harness.readState()).agents, {});
  });
});

test("/herdr-agents focuses a managed agent", async () => {
  await withHarness(
    // enter selects the single listed agent
    { dialogInputs: [["\r"]] },
    async (harness) => {
      await harness.call({
        agent: "scout",
        task: "stay",
        lifecycle: "persistent",
      });

      await harness.runCommand("herdr-agents");

      const focus = harness.fake.callsMatching("agent", "focus")[0];
      assert.ok(
        focus,
        `expected an agent focus, calls: ${JSON.stringify(harness.fake.calls.slice(-4))}`,
      );
      assert.equal(focus[2], harness.fake.paneByLabel("Scout")?.pane_id);
      assert.match(
        harness.notifications.at(-1)?.message ?? "",
        /Focused Herdr agent "Scout"/,
      );
      // Focusing must not close the agent.
      assert.equal(harness.fake.panes.length, 2);
    },
  );
});

test("/herdr-agents closes a managed agent and cleans up its temp directory", async () => {
  await withHarness(
    // d closes the selected agent, then the reopened list is cancelled
    { dialogInputs: [["d"]] },
    async (harness) => {
      await harness.call({
        agent: "scout",
        task: "stay",
        lifecycle: "persistent",
      });
      const record = Object.values((await harness.readState()).agents)[0];
      const tempDir = path.dirname(record?.resultFile ?? "");
      assert.ok(record?.resultFile);

      await harness.runCommand("herdr-agents");

      assert.deepEqual(
        harness.fake.panes.map((pane) => pane.pane_id),
        [harness.fake.orchestratorPane.pane_id],
      );
      assert.equal(await fs.stat(tempDir).catch(() => null), null);
      assert.match(
        harness.notifications.at(-1)?.message ?? "",
        /Closed Herdr agent "Scout"/,
      );
    },
  );
});

test("/herdr-agents reports an empty workspace instead of failing", async () => {
  await withHarness({}, async (harness) => {
    await harness.runCommand("herdr-agents");
    assert.deepEqual(harness.notifications, []);
    assert.deepEqual(harness.fake.callsMatching("pane", "close"), []);
  });
});

test("archives a completed one-shot and resumes it with --session", async () => {
  await withHarness({}, async (harness) => {
    const first = await harness.call({
      agent: "scout",
      task: "first slice",
      tabLabel: "Scout Resume",
    });
    assert.equal(first.details.closed, true);
    const history = (await harness.readState()).closedHistory ?? [];
    assert.equal(history.length, 1);
    assert.equal(history[0]?.tabLabel, "Scout Resume");
    assert.equal(history[0]?.status, "resumable");
    const sessionFile = history[0]?.childSessionFile;
    assert.ok(sessionFile && path.isAbsolute(sessionFile));

    const resumed = await harness.call({
      agent: "scout",
      task: "second slice",
      tabLabel: "Scout Resume",
      resumeClosed: true,
    });
    if (resumed.isError) {
      throw new Error(`resume failed: ${resumed.content[0].text}`);
    }
    assert.equal(resumed.details.resumed, true);
    assert.equal(resumed.details.closed, true);

    const starts = harness.fake.callsMatching("agent", "start");
    const resumeStart = starts.at(-1) ?? [];
    const separator = resumeStart.indexOf("--");
    const piArgs = resumeStart.slice(separator + 1);
    assert.equal(flagValue(piArgs, "--session"), sessionFile);
    assert.equal(piArgs.includes("--name"), false);

    const after = (await harness.readState()).closedHistory ?? [];
    assert.equal(after.length, 1);
    assert.equal(after[0]?.id, history[0]?.id);
    assert.equal(after[0]?.status, "resumable");
  });
});

test("resumeClosed errors when the child JSONL is missing or mismatched", async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: "scout",
      task: "first",
      tabLabel: "Scout Resume",
    });
    const history = (await harness.readState()).closedHistory ?? [];
    const sessionFile = history[0]?.childSessionFile;
    assert.ok(sessionFile);
    await fs.rm(sessionFile);

    const missing = await harness.call({
      agent: "scout",
      task: "again",
      tabLabel: "Scout Resume",
      resumeClosed: true,
    });
    assert.equal(missing.isError, true);
    assert.match(
      missing.content[0].text,
      /missing, corrupt, or does not match/,
    );
    assert.equal(harness.fake.callsMatching("agent", "start").length, 1);
  });
});

test("another Orchestrator session cannot resume this session's closed agent", async () => {
  await withHarness({}, async (first) => {
    await first.call({
      agent: "scout",
      task: "first",
      tabLabel: "Scout Resume",
    });
    const state = await first.readState();
    await withHarness({ sessionId: "other-orch" }, async (second) => {
      await fs.writeFile(
        second.statePath,
        `${JSON.stringify(state, null, 2)}\n`,
      );
      const result = await second.call({
        agent: "scout",
        task: "steal",
        tabLabel: "Scout Resume",
        resumeClosed: true,
      });
      assert.equal(result.isError, true);
      assert.match(
        result.content[0].text,
        /owned by this Orchestrator session/,
      );
    });
  });
});

test("concurrent resumeClosed has a single winner", async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: "scout",
      task: "first",
      tabLabel: "Scout Resume",
    });
    harness.fake.setBehavior(() => ({
      result: "resumed",
      delayMs: 400,
    }));
    const results = await Promise.all([
      harness.call({
        agent: "scout",
        task: "a",
        tabLabel: "Scout Resume",
        resumeClosed: true,
      }),
      harness.call({
        agent: "scout",
        task: "b",
        tabLabel: "Scout Resume",
        resumeClosed: true,
      }),
    ]);
    assert.equal(results.filter((item) => !item.isError).length, 1);
    assert.equal(results.filter((item) => item.isError).length, 1);
  });
});

test("a resumed one-shot can ask a question and be answered by label", async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: "scout",
      task: "first",
      tabLabel: "Scout Resume",
    });
    harness.fake.setBehavior(() => ({ question: "Which module?" }));
    const asked = await harness.call({
      agent: "scout",
      task: "continue",
      tabLabel: "Scout Resume",
      resumeClosed: true,
    });
    assert.equal(asked.details.status, "question");
    assert.equal(asked.details.closed, false);
    assert.equal(asked.details.resumed, true);

    harness.fake.setBehavior(() => ({ result: "answered" }));
    const answered = await harness.call({
      agent: "scout",
      task: "the auth module",
      tabLabel: "Scout Resume",
    });
    assert.equal(answered.details.reused, true);
    assert.equal(answered.details.closed, true);
    assert.match(answered.content[0].text, /answered/);
  });
});

test("detached one-shot completion archives before cleanup", async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: "scout",
      task: "background",
      wait: false,
      tabLabel: "Scout Detached Resume",
    });
    await harness.waitFor(async () => {
      const history = (await harness.readState()).closedHistory ?? [];
      // Wait for the final status: the record is staged first and promoted
      // to resumable after pane cleanup, so a bare length check races.
      return (
        history.length === 1 &&
        history[0]?.status === "resumable" &&
        harness.fake.panes.length === 1
      );
    }, "detached one-shot to archive and close");
    const history = (await harness.readState()).closedHistory ?? [];
    assert.equal(history[0]?.tabLabel, "Scout Detached Resume");
    assert.equal(history[0]?.status, "resumable");
  });
});

test("spawn failure after claim releases the closed history slot", async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: "scout",
      task: "first",
      tabLabel: "Scout Resume",
    });
    harness.fake.failEveryStart("agent_start_failed");
    await assert.rejects(() =>
      harness.call({
        agent: "scout",
        task: "again",
        tabLabel: "Scout Resume",
        resumeClosed: true,
      }),
    );
    const history = (await harness.readState()).closedHistory ?? [];
    assert.equal(history[0]?.status, "resumable");
  });
});

test("malformed target creation after claim rolls the history slot back", async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: "scout",
      task: "first",
      tabLabel: "Scout Resume",
    });
    harness.fake.malformCommand("pane split", "<html>nope</html>");
    await assert.rejects(() =>
      harness.call({
        agent: "scout",
        task: "again",
        tabLabel: "Scout Resume",
        resumeClosed: true,
      }),
    );
    const history = (await harness.readState()).closedHistory ?? [];
    assert.equal(history[0]?.status, "resumable");
    assert.equal(harness.fake.panes.length, 1);
  });
});

test("lifecycle write failure after start releases the claim and closes the partial target", async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: "scout",
      task: "first",
      tabLabel: "Scout Resume",
    });
    setFailNextStateMutation("lifecycle");
    await assert.rejects(() =>
      harness.call({
        agent: "scout",
        task: "again",
        tabLabel: "Scout Resume",
        resumeClosed: true,
      }),
    );
    const history = (await harness.readState()).closedHistory ?? [];
    assert.equal(history[0]?.status, "resumable");
    assert.equal(harness.fake.panes.length, 1);
  });
});

test("failed resume spawn redacts session and temp paths from the error", async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: "scout",
      task: "first",
      tabLabel: "Scout Resume",
    });
    const history = (await harness.readState()).closedHistory ?? [];
    const sessionFile = history[0]?.childSessionFile;
    assert.ok(sessionFile);
    harness.fake.failEveryStart("agent_start_failed");
    await assert.rejects(
      () =>
        harness.call({
          agent: "scout",
          task: "again",
          tabLabel: "Scout Resume",
          resumeClosed: true,
        }),
      (error: unknown) => {
        const text = String(error);
        assert.equal(text.includes(sessionFile), false);
        assert.equal(text.includes("herdr-agent-"), false);
        assert.match(text, /agent_start_failed/);
        return true;
      },
    );
  });
});

test("missing continuation metadata does not close or archive a one-shot", async () => {
  await withHarness({}, async (harness) => {
    harness.fake.skipSessionMeta();
    const result = await harness.call({
      agent: "scout",
      task: "first",
      tabLabel: "Scout Missing Meta",
    });
    assert.equal(result.details.closed, false);
    assert.match(
      String(result.details.closeError),
      /session metadata is missing/,
    );
    assert.equal(harness.fake.panes.length, 2);
    const history = (await harness.readState()).closedHistory ?? [];
    assert.equal(history.length, 0);
  });
});

test("stage write failure keeps the live one-shot and does not expose resumable history", async () => {
  await withHarness({}, async (harness) => {
    harness.fake.holdChildren();
    await harness.call({
      agent: "scout",
      task: "background",
      wait: false,
      tabLabel: "Scout Stage Fail",
    });
    setFailNextStateMutation("stage");
    await harness.fake.releaseChildren();
    await harness.waitFor(async () => {
      const record = Object.values((await harness.readState()).agents)[0];
      return record?.detached !== true;
    }, "detached claim to settle after failed stage");
    assert.equal(harness.fake.panes.length, 2);
    const history = (await harness.readState()).closedHistory ?? [];
    assert.equal(
      history.filter((item) => item.status === "resumable").length,
      0,
    );
  });
});

test("close failure after staging keeps the live agent and is not resumable", async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({ result: "PRECIOUS RESULT" }));
    harness.fake.failCommand("pane close", "pane_close_failed");
    const result = await harness.call({
      agent: "scout",
      task: "Find it",
      tabLabel: "Scout Close Fail",
    });
    assert.equal(result.details.closed, false);
    assert.equal(harness.fake.panes.length, 2);
    const state = await harness.readState();
    assert.ok(Object.keys(state.agents).length > 0);
    assert.equal(
      (state.closedHistory ?? []).some((item) => item.status === "resumable"),
      false,
    );
    assert.equal(state.closedHistory[0]?.status, "staged");
  });
});

test("/herdr-agents refuses to close a questioned one-shot", async () => {
  await withHarness({ dialogInputs: [["d"]] }, async (harness) => {
    harness.fake.setBehavior(() => ({ question: "Which module?" }));
    await harness.call({
      agent: "scout",
      task: "ask",
      tabLabel: "Scout Question Close",
    });
    await harness.runCommand("herdr-agents");
    assert.equal(harness.fake.panes.length, 2);
    assert.match(
      harness.notifications.at(-1)?.message ?? "",
      /Cannot close "Scout Question Close"/,
    );
    const history = (await harness.readState()).closedHistory ?? [];
    assert.equal(history.length, 0);
  });
});

test("/herdr-agents refuses to close an active resumed one-shot", async () => {
  await withHarness({ dialogInputs: [["d"]] }, async (harness) => {
    await harness.call({
      agent: "scout",
      task: "first",
      tabLabel: "Scout Resume Close",
    });
    harness.fake.setBehavior(() => ({ question: "Which module?" }));
    const asked = await harness.call({
      agent: "scout",
      task: "again",
      tabLabel: "Scout Resume Close",
      resumeClosed: true,
    });
    assert.equal(asked.details.status, "question");
    assert.equal(asked.details.closed, false);
    await harness.runCommand("herdr-agents");
    assert.equal(harness.fake.panes.length, 2);
    assert.match(
      harness.notifications.at(-1)?.message ?? "",
      /Cannot close "Scout Resume Close"/,
    );
    const history = (await harness.readState()).closedHistory ?? [];
    assert.equal(history[0]?.status, "claimed");
  });
});

test("aborted resume spawn still cleans up with an independent signal", async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: "scout",
      task: "first",
      tabLabel: "Scout Resume Abort",
    });
    harness.fake.delayAgentStart(800);
    const controller = new AbortController();
    const pending = harness.call(
      {
        agent: "scout",
        task: "again",
        tabLabel: "Scout Resume Abort",
        resumeClosed: true,
      },
      { signal: controller.signal },
    );
    await harness.waitFor(
      () => harness.fake.callsMatching("agent", "start").length > 1,
      "resume agent start to begin",
    );
    controller.abort();
    await assert.rejects(() => pending);
    const history = (await harness.readState()).closedHistory ?? [];
    assert.equal(history[0]?.status, "resumable");
    assert.equal(harness.fake.panes.length, 1);
  });
});

test("unconfirmed rollback close keeps the claim instead of a resumable duplicate", async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: "scout",
      task: "first",
      tabLabel: "Scout Resume CloseFail",
    });
    harness.fake.failEveryStart("agent_start_failed");
    harness.fake.failCommand("pane close", "pane_close_failed");
    await assert.rejects(() =>
      harness.call({
        agent: "scout",
        task: "again",
        tabLabel: "Scout Resume CloseFail",
        resumeClosed: true,
      }),
    );
    const history = (await harness.readState()).closedHistory ?? [];
    assert.equal(history[0]?.status, "claimed");
    assert.equal(harness.fake.panes.length, 2);
  });
});

test("prompt failure after a durable resume leaves the live generation recoverable", async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: "scout",
      task: "first",
      tabLabel: "Scout Resume Prompt",
    });
    harness.fake.failCommand("agent prompt", "agent_prompt_failed", {
      times: 1,
    });
    await assert.rejects(() =>
      harness.call({
        agent: "scout",
        task: "again",
        tabLabel: "Scout Resume Prompt",
        resumeClosed: true,
      }),
    );
    const state = await harness.readState();
    assert.equal(state.closedHistory[0]?.status, "claimed");
    assert.ok(Object.keys(state.agents).length > 0);
    assert.equal(harness.fake.panes.length, 2);
  });
});

test("close success plus finalize failure still lets a later resume succeed", async () => {
  await withHarness({}, async (harness) => {
    setFailNextStateMutation("finalize", 3);
    const first = await harness.call({
      agent: "scout",
      task: "first",
      tabLabel: "Scout Resume Finalize",
    });
    assert.equal(first.isError, undefined);
    assert.equal(harness.fake.panes.length, 1);
    const history = (await harness.readState()).closedHistory ?? [];
    assert.equal(history[0]?.status, "resumable");
    const resumed = await harness.call({
      agent: "scout",
      task: "second",
      tabLabel: "Scout Resume Finalize",
      resumeClosed: true,
    });
    assert.equal(resumed.isError, undefined);
    assert.equal(resumed.details.resumed, true);
    assert.equal(resumed.details.closed, true);
  });
});

test("resumeClosed does not spawn over a live working agent", async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: "scout",
      task: "first",
      tabLabel: "Scout Live Working",
    });
    harness.fake.setBehavior(() => ({ neverSettle: true }));
    await harness.call({
      agent: "scout",
      task: "live",
      wait: false,
      tabLabel: "Scout Live Working",
    });
    await harness.waitFor(
      () =>
        harness.fake.panes.some(
          (pane) =>
            pane !== harness.fake.orchestratorPane &&
            pane.agent_status === "working",
        ),
      "live agent to report working",
    );
    const blocked = await harness.call({
      agent: "scout",
      task: "resume anyway",
      tabLabel: "Scout Live Working",
      resumeClosed: true,
    });
    assert.equal(blocked.isError, true);
    assert.match(blocked.content[0].text, /still working/);
    assert.equal(harness.fake.callsMatching("agent", "start").length, 2);
  });
});

test("resumeClosed does not spawn over a settled detached live agent", async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: "scout",
      task: "first",
      tabLabel: "Scout Live Settled",
    });
    harness.fake.holdChildren();
    await harness.call({
      agent: "scout",
      task: "background",
      wait: false,
      tabLabel: "Scout Live Settled",
    });
    await harness.fake.releaseChildren();
    await harness.waitFor(
      () =>
        harness.fake.panes.some(
          (pane) =>
            pane !== harness.fake.orchestratorPane &&
            pane.agent_status === "idle",
        ),
      "detached live agent to settle",
    );
    const blocked = await harness.call({
      agent: "scout",
      task: "resume anyway",
      tabLabel: "Scout Live Settled",
      resumeClosed: true,
    });
    assert.equal(blocked.isError, true);
    assert.match(blocked.content[0].text, /waiting to be collected|still open/);
    assert.equal(harness.fake.callsMatching("agent", "start").length, 2);
  });
});

test("resumeClosed resolves project skills from the archived cwd", async () => {
  await withHarness(
    { profiles: [{ name: "scout", skills: ["tdd"] }] },
    async (harness) => {
      const otherDir = path.join(path.dirname(harness.cwd), "archived project");
      await fs.mkdir(path.join(otherDir, ".pi", "skills", "tdd"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(otherDir, ".pi", "skills", "tdd", "SKILL.md"),
        "---\nname: tdd\ndescription: red green\n---\n\nBODY\n",
      );
      await harness.call({
        agent: "scout",
        task: "first",
        tabLabel: "Scout Cwd",
      });
      const statePath = harness.statePath;
      const state = JSON.parse(await fs.readFile(statePath, "utf8"));
      const record = state.closedHistory[0];
      const sessionFile = record.childSessionFile as string;
      const raw = await fs.readFile(sessionFile, "utf8");
      const [headerLine, ...rest] = raw.split("\n");
      const header = JSON.parse(headerLine);
      header.cwd = otherDir;
      await fs.writeFile(
        sessionFile,
        [JSON.stringify(header), ...rest].join("\n"),
      );
      record.cwd = otherDir;
      await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

      const resumed = await harness.call({
        agent: "scout",
        task: "second",
        tabLabel: "Scout Cwd",
        resumeClosed: true,
      });
      if (resumed.isError) {
        throw new Error(`resume failed: ${resumed.content[0].text}`);
      }
      const starts = harness.fake.callsMatching("agent", "start");
      const resumeStart = starts.at(-1) ?? [];
      const separator = resumeStart.indexOf("--");
      const piArgs = resumeStart.slice(separator + 1);
      const skill = flagValue(piArgs, "--skill");
      assert.ok(
        skill?.includes(path.join("archived project", ".pi", "skills", "tdd")),
      );
      const split = harness.fake.callsMatching("pane", "split").at(-1) ?? [];
      assert.equal(flagValue(split, "--cwd"), otherDir);
    },
  );
});

test("failed resume spawn redacts session paths that contain whitespace", async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: "scout",
      task: "first",
      tabLabel: "Scout Space Path",
    });
    const state = JSON.parse(await fs.readFile(harness.statePath, "utf8"));
    const sessionFile = state.closedHistory[0].childSessionFile as string;
    const spaced = path.join(path.dirname(sessionFile), "child session.jsonl");
    await fs.rename(sessionFile, spaced);
    const raw = await fs.readFile(spaced, "utf8");
    const [headerLine, ...rest] = raw.split("\n");
    await fs.writeFile(spaced, [headerLine, ...rest].join("\n"));
    state.closedHistory[0].childSessionFile = spaced;
    await fs.writeFile(
      harness.statePath,
      `${JSON.stringify(state, null, 2)}\n`,
    );
    harness.fake.failEveryStart("agent_start_failed");
    await assert.rejects(
      () =>
        harness.call({
          agent: "scout",
          task: "again",
          tabLabel: "Scout Space Path",
          resumeClosed: true,
        }),
      (error: unknown) => {
        const text = String(error);
        assert.equal(text.includes(spaced), false);
        assert.equal(text.includes("child session.jsonl"), false);
        assert.match(text, /agent_start_failed/);
        return true;
      },
    );
  });
});
