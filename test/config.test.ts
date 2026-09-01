import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_HERDR_AGENTS_LAYOUT,
  getHerdrAgentsLayout,
  readCouncilConfig,
} from "../config.ts";

test("uses pane layout by default", () => {
  assert.equal(DEFAULT_HERDR_AGENTS_LAYOUT, "pane");
  assert.equal(getHerdrAgentsLayout({}), "pane");
});

test("allows tab layout through HERDR_AGENTS_LAYOUT", () => {
  assert.equal(getHerdrAgentsLayout({ HERDR_AGENTS_LAYOUT: "tab" }), "tab");
  assert.equal(getHerdrAgentsLayout({ HERDR_AGENTS_LAYOUT: " TAB " }), "tab");
});

test("falls back to pane for unsupported values", () => {
  assert.equal(getHerdrAgentsLayout({ HERDR_AGENTS_LAYOUT: "other" }), "pane");
});

let councilTmp: string | null = null;
test.after(async () => {
  if (councilTmp) {
    await rm(councilTmp, { recursive: true, force: true });
  }
});

// Lazy on purpose: a top-level await would defer test registration past the
// first awaited line, which breaks Bun's node:test compat in multi-file runs.
async function councilDir(): Promise<string> {
  councilTmp ??= await mkdtemp(join(tmpdir(), "council-config-"));
  return councilTmp;
}

async function writeCouncilConfig(content: string): Promise<string> {
  const path = join(await councilDir(), `council-${crypto.randomUUID()}.json`);
  await writeFile(path, content, "utf8");
  return path;
}

test("reads the council model list from a valid config", async () => {
  const path = await writeCouncilConfig(
    JSON.stringify({ models: ["a", "b", "c"] }),
  );
  assert.deepEqual(await readCouncilConfig(path), { models: ["a", "b", "c"] });
});

test("returns an empty model list for a missing config", async () => {
  assert.deepEqual(
    await readCouncilConfig(join(await councilDir(), "does-not-exist.json")),
    { models: [], error: "unreadable" },
  );
});

test("returns an empty model list for a malformed config", async () => {
  assert.deepEqual(
    await readCouncilConfig(await writeCouncilConfig("{not json")),
    { models: [], error: "not valid JSON" },
  );
  assert.deepEqual(
    await readCouncilConfig(await writeCouncilConfig(JSON.stringify([]))),
    { models: [] },
  );
  assert.deepEqual(
    await readCouncilConfig(
      await writeCouncilConfig(JSON.stringify({ models: "three" })),
    ),
    { models: [] },
  );
});

test("drops empty and non-string model entries", async () => {
  const path = await writeCouncilConfig(
    JSON.stringify({ models: ["a", "", 42, null, " b "] }),
  );
  assert.deepEqual(await readCouncilConfig(path), { models: ["a", "b"] });
});

test("dedupes models after trim", async () => {
  const path = await writeCouncilConfig(
    JSON.stringify({ models: ["a", " a ", "b", "a"] }),
  );
  assert.deepEqual(await readCouncilConfig(path), { models: ["a", "b"] });
});
