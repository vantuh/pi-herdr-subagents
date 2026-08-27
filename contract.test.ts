import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import {
  AGENT_QUESTION_MESSAGE_TYPE,
  AGENT_RESULT_MESSAGE_TYPE,
} from "./index.ts";
import { type Harness, type HarnessOptions, createHarness } from "./test-support/harness.ts";
import { AGENTS_WIDGET_ID } from "./widget.ts";

/**
 * Behavior lock for refactoring.
 *
 * `integration.test.ts` covers the flows an Orchestrator normally drives. This
 * file pins the rest of the observable contract: what the tool returns on every
 * failure path, which Herdr commands it emits, what it puts in `details`, and
 * how the commands, widget and renderers behave. A rewrite that keeps these
 * green keeps every caller working.
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

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

test("a successful one-shot reports the full details contract", async () => {
  await withHarness({}, async (harness) => {
    const result = await harness.call({ agent: "scout", task: "Find it" });

    assert.deepEqual(Object.keys(result.details).sort(), [
      "agent",
      "closeError",
      "closed",
      "lifecycle",
      "paneId",
      "reused",
      "tabId",
      "tabLabel",
      "waited",
    ]);
    assert.equal(result.details.lifecycle, "oneshot");
    assert.equal(result.details.tabLabel, "Scout");
    assert.equal(result.details.closeError, undefined);
    // The agent profile travels back whole, not just by name.
    assert.equal(result.details.agent.name, "scout");
    assert.equal(result.details.agent.source, "project");
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "text");
  });
});

test("reads the pane with the documented scrollback window when no artifact exists", async () => {
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({ transcript: "scrollback only" }));

    await harness.call({ agent: "scout", task: "Find it" });

    const read = harness.fake.callsMatching("agent", "read")[0];
    assert.ok(read);
    assert.equal(flagValue(read, "--source"), "recent-unwrapped");
    assert.equal(flagValue(read, "--lines"), "180");
  });
});

test("keeps the child's output when closing its pane fails", async () => {
  // Losing a collected result because cleanup failed would be the worst
  // possible trade, so the warning is appended instead of replacing it.
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({ result: "PRECIOUS RESULT" }));
    harness.fake.failCommand("pane close", "pane_close_failed");

    const result = await harness.call({ agent: "scout", task: "Find it" });

    assert.match(result.content[0].text, /PRECIOUS RESULT/);
    assert.match(result.content[0].text, /Warning: failed to close one-shot/);
    assert.equal(result.details.closed, false);
    assert.match(String(result.details.closeError), /pane_close_failed/);
    assert.equal(result.isError, undefined);
    // The pane is still there, so it stays visible to the user and the widget.
    assert.equal(harness.fake.panes.length, 2);
  });
});

// ---------------------------------------------------------------------------
// Failure paths that surface as thrown errors
// ---------------------------------------------------------------------------

test("reports malformed Herdr output with the command and the payload", async () => {
  await withHarness({}, async (harness) => {
    harness.fake.malformCommand("pane split", "<html>nope</html>");

    await assert.rejects(
      () => harness.call({ agent: "scout", task: "Find it" }),
      (error: unknown) => {
        assert.match(String(error), /Malformed Herdr pane split output/);
        assert.match(String(error), /<html>nope<\/html>/);
        return true;
      },
    );
  });
});

test("reports a pane split that returns no pane id", async () => {
  await withHarness({}, async (harness) => {
    harness.fake.malformCommand("pane split", JSON.stringify({ result: {} }));

    await assert.rejects(
      () => harness.call({ agent: "scout", task: "Find it" }),
      (error: unknown) => {
        assert.match(String(error), /missing result\.pane\.pane_id/);
        return true;
      },
    );
  });
});

test("reports a malformed snapshot instead of guessing the current pane", async () => {
  await withHarness({}, async (harness) => {
    harness.fake.malformCommand(
      "api snapshot",
      JSON.stringify({ result: { snapshot: { panes: [] } } }),
    );

    await assert.rejects(
      () => harness.call({ agent: "scout", task: "Find it" }),
      (error: unknown) => {
        assert.match(String(error), /Malformed Herdr api snapshot response/);
        return true;
      },
    );
  });
});

test("refuses to work when it cannot identify its own pane", async () => {
  await withHarness({ paneIdEnv: "w1:does-not-exist" }, async (harness) => {
    // Nothing focused either, so there is no fallback.
    harness.fake.orchestratorPane.focused = false;
    harness.fake.focusedPaneId = "";

    await assert.rejects(
      () => harness.call({ agent: "scout", task: "Find it" }),
      (error: unknown) => {
        assert.match(String(error), /Could not find current Herdr pane/);
        return true;
      },
    );
    assert.deepEqual(harness.fake.callsMatching("pane", "split"), []);
  });
});

test("runs the whole flow even when the state file is unusable", async () => {
  // State is bookkeeping: docs call it best-effort, and it must never abort
  // execution or swallow the child's result.
  await withHarness({}, async (harness) => {
    await fs.mkdir(harness.statePath, { recursive: true });

    const result = await harness.call({ agent: "scout", task: "Find it" });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /Result from scout_/);
    assert.equal(result.details.closed, true);
  });
});

// ---------------------------------------------------------------------------
// Re-wait mode
// ---------------------------------------------------------------------------

test("re-wait with wait: false only reports that the agent is still running", async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: "scout",
      task: "long",
      lifecycle: "persistent",
      tabLabel: "Scout RW",
    });
    const before = harness.fake.calls.length;

    const result = await harness.call({
      agent: "scout",
      tabLabel: "Scout RW",
      wait: false,
    });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /is still running/);
    assert.equal(result.details.waited, false);
    // No prompt, no wait, no close: it only looked the agent up.
    const after = harness.fake.calls.slice(before);
    assert.deepEqual(
      after.filter((argv) =>
        ["prompt", "wait", "close"].includes(argv[1] ?? ""),
      ),
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// Detached delivery
// ---------------------------------------------------------------------------

test("delivers a detached persistent result without closing the agent", async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: "scout",
      task: "background",
      wait: false,
      lifecycle: "persistent",
      tabLabel: "Scout Detached",
    });

    await harness.waitFor(
      () => harness.messages.length > 0,
      "detached persistent delivery",
    );

    const [message] = harness.messages;
    assert.equal(message?.customType, AGENT_RESULT_MESSAGE_TYPE);
    assert.equal(message?.details.lifecycle, "persistent");
    // Still alive and reusable; only one-shots are closed on delivery.
    assert.equal(harness.fake.panes.length, 2);
    assert.deepEqual(harness.fake.callsMatching("pane", "close"), []);
    const record = Object.values((await harness.readState()).agents)[0];
    assert.equal(record?.detached, undefined);
    assert.equal(record?.lifecycle, "persistent");
  });
});

test("keeps the claim when a detached agent settles with nothing to deliver", async () => {
  // Without an artifact there is no usable result, so the flag stays set and an
  // explicit re-wait can still read the scrollback.
  await withHarness({}, async (harness) => {
    harness.fake.setBehavior(() => ({ transcript: "only scrollback" }));

    await harness.call({
      agent: "scout",
      task: "background",
      wait: false,
      lifecycle: "persistent",
      tabLabel: "Scout Silent",
    });

    await harness.waitFor(async () => {
      const record = Object.values((await harness.readState()).agents)[0];
      return record?.detached === true && harness.fake.panes.length === 2;
    }, "agent settled while still claimed");

    // Give the poller a couple of ticks to prove it stays quiet.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.deepEqual(harness.messages, []);
    const record = Object.values((await harness.readState()).agents)[0];
    assert.equal(record?.detached, true);
  });
});

// ---------------------------------------------------------------------------
// Tab layout
// ---------------------------------------------------------------------------

test("reuses a persistent tab by label and keeps new tab labels unique", async () => {
  await withHarness({ layout: "tab" }, async (harness) => {
    const first = await harness.call({
      agent: "scout",
      task: "one",
      lifecycle: "persistent",
    });
    assert.equal(first.details.reused, false);
    assert.equal(flagValue(harness.fake.callsMatching("tab", "create")[0] ?? [], "--label"), "Scout");

    const reused = await harness.call({
      agent: "scout",
      task: "two",
      lifecycle: "persistent",
    });
    assert.equal(reused.details.reused, true);
    assert.equal(harness.fake.callsMatching("tab", "create").length, 1);

    // A different label cannot reuse it, and the label stays collision-free.
    await harness.call({
      agent: "scout",
      task: "three",
      lifecycle: "persistent",
      tabLabel: "Scout",
    });
    assert.equal(harness.fake.callsMatching("tab", "create").length, 1);
  });
});

test("looks the tab up by label when tab create omits the tab id", async () => {
  await withHarness({ layout: "tab" }, async (harness) => {
    harness.fake.omitCreatedTabId();

    const result = await harness.call({ agent: "scout", task: "one" });

    // Recovered silently: the flow completed and the tab was closed by id.
    assert.equal(result.isError, undefined);
    assert.equal(result.details.closed, true);
    assert.ok(result.details.tabId);
    assert.ok(harness.fake.callsMatching("tab", "list").length >= 1);
    assert.equal(harness.fake.callsMatching("tab", "close")[0]?.[2], result.details.tabId);
  });
});

// ---------------------------------------------------------------------------
// Widget lifecycle
// ---------------------------------------------------------------------------

test("shows live agents in the widget and clears it once none remain", async () => {
  // d closes the selected agent in the manager overlay.
  await withHarness({ dialogInputs: [["d"]] }, async (harness) => {
    await harness.call({
      agent: "scout",
      task: "stay",
      lifecycle: "persistent",
      tabLabel: "Scout Widget",
    });

    await harness.waitFor(
      () => harness.widgets.has(AGENTS_WIDGET_ID),
      "widget to appear",
    );
    const lines = harness.widgets.get(AGENTS_WIDGET_ID) as string[];
    assert.ok(
      lines.join("\n").includes("Scout Widget"),
      `widget should list the agent: ${JSON.stringify(lines)}`,
    );

    await harness.runCommand("herdr-agents");
    assert.equal(harness.fake.panes.length, 1);

    await harness.waitFor(
      () => !harness.widgets.has(AGENTS_WIDGET_ID),
      "widget to clear after the last agent is gone",
    );
  });
});

test("hides an agent from the widget while the Orchestrator blocks on it", async () => {
  await withHarness({}, async (harness) => {
    // Slow enough that a poller tick lands while the tool is still waiting.
    harness.fake.setBehavior(() => ({ result: "late", delayMs: 2500 }));

    const pending = harness.call({
      agent: "scout",
      task: "slow",
      lifecycle: "persistent",
      tabLabel: "Scout Awaited",
    });
    await harness.waitFor(
      () => harness.fake.callsMatching("agent", "wait").length > 0,
      "the wait to start",
    );
    await harness.fire("session_start");
    assert.equal(harness.widgets.has(AGENTS_WIDGET_ID), false);

    await pending;
    // No longer awaited, so it becomes visible again.
    await harness.waitFor(
      () => harness.widgets.has(AGENTS_WIDGET_ID),
      "widget to reappear after the wait ended",
    );
  });
});

// ---------------------------------------------------------------------------
// Commands and renderers
// ---------------------------------------------------------------------------

test("/run refuses to delegate while a turn is in flight", async () => {
  await withHarness({ isIdle: false }, async (harness) => {
    await harness.runCommand("run", "scout find the auth flow");

    assert.deepEqual(harness.userMessages, []);
    assert.match(harness.notifications.at(-1)?.message ?? "", /Agent is busy/);
  });
});

test("/run explains itself when given no task", async () => {
  await withHarness({}, async (harness) => {
    await harness.runCommand("run", "   ");
    assert.deepEqual(harness.userMessages, []);
    assert.match(
      harness.notifications.at(-1)?.message ?? "",
      /Usage: \/run \[agent\] <task>/,
    );

    // A bare profile name with no task is also not a delegation.
    await harness.runCommand("run", "scout");
    assert.deepEqual(harness.userMessages, []);
  });
});

test("/run completes agent names, then stops offering completions", async () => {
  await withHarness({}, async (harness) => {
    const command = harness.commands.get("run") as {
      getArgumentCompletions?: (prefix: string) => Array<{ value: string }> | null;
    };
    assert.ok(command.getArgumentCompletions);

    const all = command.getArgumentCompletions("") ?? [];
    assert.deepEqual(
      all.map((item) => item.value.trim()),
      ["scout", "researcher", "planner", "worker", "reviewer"],
    );
    assert.deepEqual(
      (command.getArgumentCompletions("re") ?? []).map((i) => i.value.trim()),
      ["researcher", "reviewer"],
    );
    // Once a task is being typed there is nothing to complete.
    assert.equal(command.getArgumentCompletions("scout find the "), null);
    assert.equal(command.getArgumentCompletions("nonsense"), null);
  });
});

test("/herdr-agents needs TUI mode", async () => {
  await withHarness({}, async (harness) => {
    const command = harness.commands.get("herdr-agents");
    assert.ok(command);
    await command.handler("", {
      mode: "print",
      ui: { notify: (message: string, level?: string) => harness.notifications.push({ message, level }) },
    });

    assert.match(
      harness.notifications.at(-1)?.message ?? "",
      /requires TUI mode/,
    );
  });
});

test("/herdr-agents surfaces a Herdr failure as a notification", async () => {
  await withHarness({}, async (harness) => {
    harness.fake.failCommand("api snapshot", "server_not_running");

    await harness.runCommand("herdr-agents");

    assert.match(
      harness.notifications.at(-1)?.message ?? "",
      /Failed to load Herdr agents/,
    );
  });
});

test("renders delivered results and questions as their own blocks", async () => {
  await withHarness({}, async (harness) => {
    for (const customType of [
      AGENT_RESULT_MESSAGE_TYPE,
      AGENT_QUESTION_MESSAGE_TYPE,
    ]) {
      const renderer = harness.renderers.get(customType) as (
        message: unknown,
        options: unknown,
        theme: unknown,
      ) => { render: (width: number) => string[] };
      assert.ok(renderer, `${customType} needs a renderer`);

      const component = renderer(
        {
          content: "inline attribution the model reads",
          details: {
            tabLabel: "Scout",
            agent: "scout",
            result: "BODY TEXT",
            question: "BODY TEXT",
          },
        },
        { expanded: false, outputPad: 1 },
        {
          fg: (_c: string, t: string) => t,
          bg: (_c: string, t: string) => t,
          bold: (t: string) => t,
        },
      );

      const rendered = component.render(80).join("\n");
      assert.match(rendered, /Herdr agent Scout · scout/);
      assert.match(rendered, /BODY TEXT/);
      // The header carries the attribution, so the inline copy is not repeated.
      assert.doesNotMatch(rendered, /inline attribution/);
    }
  });
});

// ---------------------------------------------------------------------------
// Bookkeeping
// ---------------------------------------------------------------------------

test("does not touch the layout while a single agent is alone in the column", async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: "scout",
      task: "solo",
      lifecycle: "persistent",
    });

    // Rebalancing two or more agents is the only reason to move ratios.
    assert.deepEqual(harness.fake.ratioUpdates, []);
  });
});

test("prunes state records for panes Herdr no longer reports", async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: "scout",
      task: "one",
      lifecycle: "persistent",
      tabLabel: "Scout Stale",
    });
    const statePath = harness.statePath;
    const before = JSON.parse(await fs.readFile(statePath, "utf8"));
    before.agents["terminal:ghost"] = {
      lifecycle: "persistent",
      tabLabel: "Ghost",
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(statePath, JSON.stringify(before));

    // Any path that lists managed agents reconciles the file.
    await harness.runCommand("herdr-agents");

    const after = await harness.readState();
    assert.deepEqual(Object.keys(after.agents).filter((key) => key.includes("ghost")), []);
    assert.equal(Object.keys(after.agents).length, 1);
  });
});

test("writes the state file with owner-only permissions", async () => {
  await withHarness({}, async (harness) => {
    await harness.call({
      agent: "scout",
      task: "one",
      lifecycle: "persistent",
    });

    const stats = await fs.stat(harness.statePath);
    assert.equal(stats.mode & 0o777, 0o600);
    // Same for the artifacts, which carry task and result text.
    const record = Object.values((await harness.readState()).agents)[0];
    const artifactDir = path.dirname(record?.resultFile ?? "");
    const system = await fs.stat(path.join(artifactDir, "system.md"));
    assert.equal(system.mode & 0o777, 0o600);
  });
});
