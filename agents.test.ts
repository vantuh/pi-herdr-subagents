import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { discoverAgents } from "./agents.ts";
import { applyEnv } from "./test-support/mock-extension.ts";

/**
 * Profile discovery (docs/session-findings.md §2): existing Pi agent profiles
 * are the only configuration source, and a project profile overrides a user
 * profile with the same name.
 */

async function withProfileDirs(
  body: (dirs: { userAgents: string; projectRoot: string }) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-agents-prof-"));
  const agentDir = path.join(root, "pi-agent");
  const userAgents = path.join(agentDir, "agents");
  const projectRoot = path.join(root, "repo", "packages", "deep");
  await fs.mkdir(userAgents, { recursive: true });
  await fs.mkdir(projectRoot, { recursive: true });
  const restoreEnv = applyEnv({ PI_CODING_AGENT_DIR: agentDir });
  try {
    await body({ userAgents, projectRoot });
  } finally {
    restoreEnv();
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("a project profile overrides a user profile with the same name", async () => {
  await withProfileDirs(async ({ userAgents, projectRoot }) => {
    await fs.writeFile(
      path.join(userAgents, "scout.md"),
      "---\nname: scout\ndescription: user scout\n---\n\nUSER BODY\n",
    );
    await fs.writeFile(
      path.join(userAgents, "reviewer.md"),
      "---\nname: reviewer\ndescription: user reviewer\n---\n\nREVIEWER\n",
    );

    // The project dir is found by walking up from cwd, not only in cwd itself.
    const projectAgents = path.join(projectRoot, "..", "..", ".pi", "agents");
    await fs.mkdir(projectAgents, { recursive: true });
    await fs.writeFile(
      path.join(projectAgents, "scout.md"),
      "---\nname: scout\ndescription: project scout\ntools: read, grep\nmodel: sonnet\n---\n\nPROJECT BODY\n",
    );

    const agents = await discoverAgents(projectRoot);
    const byName = new Map(agents.map((agent) => [agent.name, agent]));

    assert.deepEqual([...byName.keys()].sort(), ["reviewer", "scout"]);
    const scout = byName.get("scout");
    assert.equal(scout?.source, "project");
    assert.equal(scout?.description, "project scout");
    assert.equal(scout?.systemPrompt, "PROJECT BODY");
    assert.deepEqual(scout?.tools, ["read", "grep"]);
    assert.equal(scout?.model, "sonnet");
    // The untouched user profile survives, with no tool restriction.
    assert.equal(byName.get("reviewer")?.source, "user");
    assert.equal(byName.get("reviewer")?.tools, undefined);
  });
});

test("skips files that are not usable agent profiles", async () => {
  await withProfileDirs(async ({ userAgents, projectRoot }) => {
    await fs.writeFile(
      path.join(userAgents, "no-name.md"),
      "---\ndescription: missing name\n---\n\nBODY\n",
    );
    await fs.writeFile(
      path.join(userAgents, "no-description.md"),
      "---\nname: nodesc\n---\n\nBODY\n",
    );
    await fs.writeFile(path.join(userAgents, "notes.txt"), "not markdown\n");
    await fs.writeFile(
      path.join(userAgents, "good.md"),
      "---\nname: good\ndescription: fine\n---\n\nBODY\n",
    );

    const agents = await discoverAgents(projectRoot);
    assert.deepEqual(
      agents.map((agent) => agent.name),
      ["good"],
    );
  });
});

test("returns no profiles when neither directory exists", async () => {
  await withProfileDirs(async ({ projectRoot }) => {
    assert.deepEqual(await discoverAgents(projectRoot), []);
  });
});
