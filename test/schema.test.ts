import assert from "node:assert/strict";
import test from "node:test";
import { buildHerdrAgentParams, describeAgentProfiles } from "../schema.ts";

/**
 * The parameter schema is the model-facing contract: renaming a field or
 * widening an enum changes how every Orchestrator calls the tool, and nothing
 * else in the suite would notice.
 */

const HerdrAgentParams = buildHerdrAgentParams();
test("exposes exactly the documented parameters", () => {
  assert.deepEqual(Object.keys(HerdrAgentParams.properties).sort(), [
    "agent",
    "lifecycle",
    "tabLabel",
    "task",
    "timeoutMs",
    "wait",
  ]);
});

test("requires only the agent profile", () => {
  // task is optional on purpose: omitting it is re-wait mode.
  assert.deepEqual(HerdrAgentParams.required, ["agent"]);
});

test("keeps lifecycle a two-value union", () => {
  const lifecycle = HerdrAgentParams.properties.lifecycle as {
    anyOf?: Array<{ const?: string }>;
  };
  const values = (lifecycle.anyOf ?? [])
    .map((variant) => variant.const)
    .filter((value): value is string => typeof value === "string");
  assert.deepEqual(values.sort(), ["oneshot", "persistent"]);
});

test("declares parameter types the provider can validate", () => {
  const properties = HerdrAgentParams.properties as Record<
    string,
    { type?: string }
  >;
  assert.equal(properties.agent?.type, "string");
  assert.equal(properties.task?.type, "string");
  assert.equal(properties.tabLabel?.type, "string");
  assert.equal(properties.wait?.type, "boolean");
  assert.equal(properties.timeoutMs?.type, "number");
});

test("describes every parameter for the model", () => {
  for (const [name, schema] of Object.entries(
    HerdrAgentParams.properties as Record<string, { description?: string }>,
  )) {
    assert.ok(
      (schema.description ?? "").length > 10,
      `${name} needs a description the model can act on`,
    );
  }
});

test("the dynamic agent listing drops disable-model-invocation profiles", () => {
  const description = describeAgentProfiles([
    { name: "scout" },
    { name: "secret", disableModelInvocation: true },
    { name: "scout" },
  ]);
  assert.match(description, /Available: scout\./);
  assert.doesNotMatch(description, /secret/);
  // No duplicates even if user and project define the same name.
  assert.doesNotMatch(description, /scout, scout/);
});

test("the agent listing falls back to the plain description", () => {
  assert.match(describeAgentProfiles([]), /Agent profile name/);
  assert.doesNotMatch(describeAgentProfiles([]), /Available:/);
  assert.match(
    describeAgentProfiles([{ name: "ghost", disableModelInvocation: true }]),
    /Agent profile name/,
  );
});
