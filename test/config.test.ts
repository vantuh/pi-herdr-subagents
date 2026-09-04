import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_AGENTS_WORKSPACE_LABEL,
  DEFAULT_HERDR_AGENTS_LAYOUT,
  getHerdrAgentsLayout,
  getHerdrAgentsWorkspaceLabel,
  herdrAgentsConfigPath,
  loadHerdrAgentsConfig,
  readCouncilConfig,
} from "../config.ts";

test("uses the workspace layout by default", async () => {
  assert.equal(DEFAULT_HERDR_AGENTS_LAYOUT, "workspace");
  assert.equal(getHerdrAgentsLayout({}), "workspace");
  assert.equal(getHerdrAgentsLayout(await loadHerdrAgentsConfig("/does/not/exist.json")), "workspace");
});

test("allows pane and tab layouts through the config", () => {
  assert.equal(getHerdrAgentsLayout({ layout: "pane" }), "pane");
  assert.equal(getHerdrAgentsLayout({ layout: "tab" }), "tab");
  assert.equal(getHerdrAgentsLayout({ layout: "workspace" }), "workspace");
});

test("falls back to the workspace layout for unsupported values", async () => {
  assert.equal(
    getHerdrAgentsLayout(
      await loadHerdrAgentsConfig(await writeConfigFile('{"layout":"other"}')),
    ),
    "workspace",
  );
});

test("workspace label defaults to subagents", () => {
  assert.equal(DEFAULT_AGENTS_WORKSPACE_LABEL, "subagents");
  assert.equal(getHerdrAgentsWorkspaceLabel({}), "subagents");
});

test("workspace label is configurable and trimmed", () => {
  assert.equal(
    getHerdrAgentsWorkspaceLabel({ workspace: { label: " Pi Agents " } }),
    "Pi Agents",
  );
});

test("blank workspace label falls back to the default", () => {
  assert.equal(
    getHerdrAgentsWorkspaceLabel({ workspace: { label: "   " } }),
    "subagents",
  );
});

let configTmp: string | null = null;
let councilTmp: string | null = null;
test.after(async () => {
  if (configTmp) {
    await rm(configTmp, { recursive: true, force: true });
  }
  if (councilTmp) {
    await rm(councilTmp, { recursive: true, force: true });
  }
});

// Lazy on purpose: a top-level await would defer test registration past the
// first awaited line, which breaks Bun's node:test compat in multi-file runs.
async function tmpDir(): Promise<string> {
  configTmp ??= await mkdtemp(join(tmpdir(), "herdr-agents-config-"));
  return configTmp;
}

async function writeConfigFile(content: string): Promise<string> {
  const path = join(await tmpDir(), `config-${crypto.randomUUID()}.json`);
  await writeFile(path, content, "utf8");
  return path;
}

test("config path sits in the given agent dir", () => {
  assert.equal(herdrAgentsConfigPath("/agents"), "/agents/herdr-agents.json");
});

test("reads a valid config file", async () => {
  const path = await writeConfigFile(
    JSON.stringify({ layout: "tab", workspace: { label: "Pi Agents" } }),
  );
  const config = await loadHerdrAgentsConfig(path);
  assert.equal(getHerdrAgentsLayout(config), "tab");
  assert.equal(getHerdrAgentsWorkspaceLabel(config), "Pi Agents");
});

test("returns an empty config for a missing file", async () => {
  assert.deepEqual(
    await loadHerdrAgentsConfig(join(await tmpDir(), "missing.json")),
    {},
  );
});

test("returns an empty config for invalid JSON", async () => {
  assert.deepEqual(
    await loadHerdrAgentsConfig(await writeConfigFile("{not json")),
    {},
  );
});

test("returns an empty config for a non-object file", async () => {
  assert.deepEqual(
    await loadHerdrAgentsConfig(await writeConfigFile(JSON.stringify(["tab"]))),
    {},
  );
  assert.deepEqual(
    await loadHerdrAgentsConfig(await writeConfigFile('"tab"')),
    {},
  );
});

test("drops unknown layout values but keeps the rest", async () => {
  const config = await loadHerdrAgentsConfig(
    await writeConfigFile(
      JSON.stringify({ layout: "splits", workspace: { label: "X" } }),
    ),
  );
  assert.deepEqual(config, { workspace: { label: "X" } });
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
