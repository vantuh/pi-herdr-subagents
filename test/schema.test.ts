import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  buildHerdrAgentParams,
  describeAgentProfiles,
} from '../src/tool/schema.ts';

/**
 * The parameter schema is the model-facing contract: renaming a field or
 * widening an enum changes how every Orchestrator calls the tool, and nothing
 * else in the suite would notice.
 */

const HerdrAgentParams = buildHerdrAgentParams();
test('exposes exactly the documented parameters', () => {
  assert.deepEqual(Object.keys(HerdrAgentParams.properties).sort(), [
    'agent',
    'resumeClosed',
    'tabLabel',
    'task',
  ]);
});

test('requires only the agent profile', () => {
  // task is optional on purpose: omitting it checks a live agent's status.
  assert.deepEqual(HerdrAgentParams.required, ['agent']);
});

test('has no lifecycle or timeout parameters', () => {
  const names = Object.keys(HerdrAgentParams.properties);
  assert.ok(!names.includes('lifecycle'));
  assert.ok(!names.includes('timeoutMs'));
});

test('declares parameter types the provider can validate', () => {
  const properties = HerdrAgentParams.properties as Record<
    string,
    { type?: string }
  >;
  assert.equal(properties.agent?.type, 'string');
  assert.equal(properties.task?.type, 'string');
  assert.equal(properties.tabLabel?.type, 'string');
  assert.equal(properties.resumeClosed?.type, 'boolean');
});

test('has no wait property', () => {
  assert.equal(
    (HerdrAgentParams.properties as Record<string, unknown>).wait,
    undefined,
  );
});

test('task description says omitting it checks status', () => {
  const task = HerdrAgentParams.properties.task as { description?: string };
  assert.match(task.description ?? '', /Omit to check a live agent/);
  assert.match(task.description ?? '', /does not send a new prompt/);
});

test('resumeClosed description names the continuation contract', () => {
  const resume = HerdrAgentParams.properties.resumeClosed as {
    description?: string;
  };
  assert.match(resume.description ?? '', /accumulated context/);
  assert.match(resume.description ?? '', /tabLabel/);
  assert.match(resume.description ?? '', /Never resumes over a live agent/);
});

test('describes every parameter for the model', () => {
  for (const [name, schema] of Object.entries(
    HerdrAgentParams.properties as Record<string, { description?: string }>,
  )) {
    assert.ok(
      (schema.description ?? '').length > 10,
      `${name} needs a description the model can act on`,
    );
  }
});

test('the dynamic agent listing drops disable-model-invocation profiles', () => {
  const description = describeAgentProfiles([
    { name: 'scout' },
    { name: 'secret', disableModelInvocation: true },
    { name: 'scout' },
  ]);
  assert.match(description, /Available: scout\./);
  assert.doesNotMatch(description, /secret/);
  // No duplicates even if user and project define the same name.
  assert.doesNotMatch(description, /scout, scout/);
});

test('the agent listing falls back to the plain description', () => {
  assert.match(describeAgentProfiles([]), /Agent profile name/);
  assert.doesNotMatch(describeAgentProfiles([]), /Available:/);
  assert.match(
    describeAgentProfiles([{ name: 'ghost', disableModelInvocation: true }]),
    /Agent profile name/,
  );
});
