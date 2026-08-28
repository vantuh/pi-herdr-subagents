import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  discoverAgents,
  normalizeSkillList,
  resolveProfileSkills,
  resolveThinkingLevel,
} from "./agents.ts";
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

test("a non-string system-prompt in one file does not drop other profiles", async () => {
  await withProfileDirs(async ({ userAgents, projectRoot }) => {
    await fs.writeFile(
      path.join(userAgents, "bad.md"),
      "---\nname: bad\ndescription: junk prompt\nsystem-prompt: true\n---\n\nBAD\n",
    );
    await fs.writeFile(
      path.join(userAgents, "good.md"),
      "---\nname: good\ndescription: fine\n---\n\nBODY\n",
    );

    const agents = await discoverAgents(projectRoot);
    const byName = new Map(agents.map((agent) => [agent.name, agent]));
    assert.deepEqual([...byName.keys()].sort(), ["bad", "good"]);
    assert.equal(byName.get("bad")?.systemPromptMode, undefined);
    assert.equal(byName.get("good")?.systemPrompt, "BODY");
  });
});

test("non-string thinking is omitted at parse instead of throwing", async () => {
  await withProfileDirs(async ({ userAgents, projectRoot }) => {
    await fs.writeFile(
      path.join(userAgents, "bool.md"),
      "---\nname: bool\ndescription: yaml bool\nthinking: true\n---\n\nBODY\n",
    );

    const profile = (await discoverAgents(projectRoot)).at(0);
    assert.ok(profile);
    assert.equal(profile.thinking, undefined);
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

test("parses the profile frontmatter fields beyond the basics", async () => {
  await withProfileDirs(async ({ userAgents, projectRoot }) => {
    await fs.writeFile(
      path.join(userAgents, "full.md"),
      [
        "---",
        "name: full",
        "description: all fields",
        "model: sonnet",
        "thinking: high",
        "skills: hunk-review, tdd",
        "system-prompt: replace",
        "disable-model-invocation: true",
        "---",
        "",
        "BODY",
      ].join("\n"),
    );

    const agents = await discoverAgents(projectRoot);
    const profile = agents.find((agent) => agent.name === "full");
    assert.ok(profile);
    assert.equal(profile.thinking, "high");
    assert.deepEqual(profile.skills, ["hunk-review", "tdd"]);
    // The parser stores the mode; argv assembly is the spawn block's job.
    assert.equal(profile.systemPromptMode, "replace");
    assert.equal(profile.disableModelInvocation, true);
  });
});

test("leaves optional frontmatter fields undefined when they are omitted", async () => {
  await withProfileDirs(async ({ userAgents, projectRoot }) => {
    await fs.writeFile(
      path.join(userAgents, "plain.md"),
      "---\nname: plain\ndescription: bare\n---\n\nBODY\n",
    );

    const profile = (await discoverAgents(projectRoot)).at(0);
    assert.ok(profile);
    assert.equal(profile.thinking, undefined);
    assert.equal(profile.skills, undefined);
    assert.equal(profile.systemPromptMode, undefined);
    assert.equal(profile.disableModelInvocation, undefined);
  });
});

test("normalizes and rejects junk in optional frontmatter fields", async () => {
  await withProfileDirs(async ({ userAgents, projectRoot }) => {
    await fs.writeFile(
      path.join(userAgents, "junk.md"),
      [
        "---",
        "name: junk",
        "description: junk values",
        "skills: a, b , ,",
        "system-prompt: sideways",
        "---",
        "",
        "BODY",
      ].join("\n"),
    );

    const profile = (await discoverAgents(projectRoot)).at(0);
    assert.ok(profile);
    // Comma lists normalize like tools; trailing empties drop out.
    assert.deepEqual(profile.skills, ["a", "b"]);
    // Unknown modes stay undefined (append is the default anyway).
    assert.equal(profile.systemPromptMode, undefined);
  });
});

test("resolveThinkingLevel validates against pi's flag levels", () => {
  assert.equal(resolveThinkingLevel("high"), "high");
  assert.equal(resolveThinkingLevel("  HIGH "), "high");
  assert.equal(resolveThinkingLevel("xhigh"), "xhigh");
  assert.equal(resolveThinkingLevel("sideways"), undefined);
  assert.equal(resolveThinkingLevel(""), undefined);
  assert.equal(resolveThinkingLevel(undefined), undefined);
  assert.equal(resolveThinkingLevel(true), undefined);
  assert.equal(resolveThinkingLevel(1), undefined);
});

test("resolveProfileSkills maps names to file paths via pi's discovery", async () => {
  await withProfileDirs(async ({ userAgents, projectRoot }) => {
    const agentDir = process.env.PI_CODING_AGENT_DIR!;
    await fs.mkdir(path.join(agentDir, "skills", "hunk-review"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(agentDir, "skills", "hunk-review", "SKILL.md"),
      "---\nname: hunk-review\ndescription: review hunks\n---\n\nBODY\n",
    );
    // Project skills resolve from the orchestrator's cwd.
    const projectSkill = path.join(projectRoot, ".pi", "skills", "tdd");
    await fs.mkdir(projectSkill, { recursive: true });
    await fs.writeFile(
      path.join(projectSkill, "SKILL.md"),
      "---\nname: tdd\ndescription: red green refactor\n---\n\nBODY\n",
    );
    const agentsSkill = path.join(
      projectRoot,
      ".agents",
      "skills",
      "from-agents",
    );
    await fs.mkdir(agentsSkill, { recursive: true });
    await fs.writeFile(
      path.join(agentsSkill, "SKILL.md"),
      "---\nname: from-agents\ndescription: project agents skill\n---\n\nBODY\n",
    );

    const { found, missing } = await resolveProfileSkills(
      ["hunk-review", "tdd", "from-agents", "nonexistent"],
      projectRoot,
    );
    const byName = new Map(found.map((skill) => [skill.name, skill]));
    assert.deepEqual([...byName.keys()].sort(), [
      "from-agents",
      "hunk-review",
      "tdd",
    ]);
    assert.ok(
      byName.get("hunk-review")?.filePath.endsWith(
        path.join("skills", "hunk-review", "SKILL.md"),
      ),
    );
    assert.deepEqual(missing, ["nonexistent"]);
  });
});

test("resolveProfileSkills discovers enabled package skills", async () => {
  await withProfileDirs(async ({ projectRoot }) => {
    const agentDir = process.env.PI_CODING_AGENT_DIR!;
    const packageRoot = path.join(agentDir, "fixture-package");
    const packageSkill = path.join(packageRoot, "skills", "from-package");
    await fs.mkdir(packageSkill, { recursive: true });
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "fixture-package",
        version: "1.0.0",
        pi: { skills: ["./skills"] },
      }),
    );
    await fs.writeFile(
      path.join(packageSkill, "SKILL.md"),
      "---\nname: from-package\ndescription: package skill\n---\n\nBODY\n",
    );
    await fs.writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ packages: [packageRoot] }),
    );

    const resolved = await resolveProfileSkills(["from-package"], projectRoot);
    assert.deepEqual(resolved.missing, []);
    assert.equal(resolved.found[0]?.name, "from-package");
    assert.equal(
      resolved.found[0]?.filePath,
      path.join(packageSkill, "SKILL.md"),
    );
  });
});

test("resolveProfileSkills returns empty without work for empty names", async () => {
  const result = await resolveProfileSkills([], "/whatever");
  assert.deepEqual(result, { found: [], missing: [], diagnostics: [] });
});

test("resolveProfileSkills surfaces diagnostics for a broken requested skill", async () => {
  await withProfileDirs(async ({ projectRoot }) => {
    const agentDir = process.env.PI_CODING_AGENT_DIR!;
    const broken = path.join(agentDir, "skills", "broken-skill");
    await fs.mkdir(broken, { recursive: true });
    await fs.writeFile(
      path.join(broken, "SKILL.md"),
      "---\nname: broken-skill\n---\n\nno description\n",
    );

    const resolved = await resolveProfileSkills(["broken-skill"], projectRoot);
    assert.deepEqual(resolved.found, []);
    assert.deepEqual(resolved.missing, ["broken-skill"]);
    assert.ok(
      resolved.diagnostics.some((line) =>
        line.includes("description") || line.includes("SKILL.md"),
      ),
      `expected a diagnostic, got ${JSON.stringify(resolved.diagnostics)}`,
    );
  });
});

test("skills: none and an empty YAML list both mean no skills", async () => {
  await withProfileDirs(async ({ userAgents, projectRoot }) => {
    await fs.writeFile(
      path.join(userAgents, "lean.md"),
      "---\nname: lean\ndescription: no skills\nskills: none\n---\n\nBODY\n",
    );
    await fs.writeFile(
      path.join(userAgents, "empty.md"),
      "---\nname: empty\ndescription: empty list\nskills: []\n---\n\nBODY\n",
    );

    const byName = new Map(
      (await discoverAgents(projectRoot)).map((agent) => [agent.name, agent]),
    );
    // Distinct from undefined, which keeps the child's full skill discovery.
    assert.deepEqual(byName.get("lean")?.skills, []);
    assert.deepEqual(byName.get("empty")?.skills, []);
  });
});

test("normalizeSkillList keeps empty arrays as an explicit no-skills list", () => {
  assert.deepEqual(normalizeSkillList([]), []);
  assert.deepEqual(normalizeSkillList("none"), []);
  assert.deepEqual(normalizeSkillList("[]"), []);
  assert.equal(normalizeSkillList(undefined), undefined);
});
