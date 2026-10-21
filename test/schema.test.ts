import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  buildAgentSendParams,
  buildAgentSpawnParams,
  buildAgentStatusParams,
  buildAgentStopParams,
  describeAgentProfiles,
} from '../src/tool/schema.ts';

/**
 * The parameter schemas are the model-facing contract: renaming a field or
 * making a required one optional changes how every Orchestrator calls the
 * tools, and nothing else in the suite would notice.
 */

const verbSchemas = {
  agent_spawn: { schema: buildAgentSpawnParams(), required: ['agent', 'task'] },
  agent_send: { schema: buildAgentSendParams(), required: ['message', 'name'] },
  agent_stop: { schema: buildAgentStopParams(), required: ['name'] },
  agent_status: { schema: buildAgentStatusParams(), required: [] },
};

test('exposes exactly the documented parameters per tool', () => {
  assert.deepEqual(
    Object.keys(verbSchemas.agent_spawn.schema.properties).sort(),
    ['agent', 'name', 'task'],
  );
  assert.deepEqual(
    Object.keys(verbSchemas.agent_send.schema.properties).sort(),
    ['message', 'name'],
  );
  assert.deepEqual(Object.keys(verbSchemas.agent_stop.schema.properties), [
    'name',
  ]);
  assert.deepEqual(Object.keys(verbSchemas.agent_status.schema.properties), [
    'name',
  ]);
});

test('requires each verb its own parameters, with no mode chosen by omission', () => {
  for (const [tool, { schema, required }] of Object.entries(verbSchemas)) {
    assert.deepEqual(
      [...(schema.required ?? [])].sort(),
      required,
      `${tool} required parameters`,
    );
  }
});

test('declares parameter types the provider can validate', () => {
  for (const { schema } of Object.values(verbSchemas)) {
    for (const property of Object.values(
      schema.properties as Record<string, { type?: string }>,
    )) {
      assert.equal(property.type, 'string');
    }
  }
});

test('has no lifecycle, timeout, wait, action or resume parameters', () => {
  for (const { schema } of Object.values(verbSchemas)) {
    const names = Object.keys(schema.properties);
    for (const old of [
      'lifecycle',
      'timeoutMs',
      'wait',
      'action',
      'resumeClosed',
      'tabLabel',
    ]) {
      assert.ok(!names.includes(old), `${old} is not a parameter`);
    }
  }
});

test('describes every parameter for the model', () => {
  for (const [tool, { schema }] of Object.entries(verbSchemas)) {
    for (const [name, property] of Object.entries(
      schema.properties as Record<string, { description?: string }>,
    )) {
      assert.ok(
        (property.description ?? '').length > 10,
        `${tool}.${name} needs a description the model can act on`,
      );
    }
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

test('the dynamic agent listing shows each profile description', () => {
  const description = describeAgentProfiles([
    { name: 'scout', description: 'Fast codebase recon' },
    { name: 'ghost', description: '  ' },
  ]);
  assert.match(
    description,
    /Available: scout \(Fast codebase recon\), ghost\./,
  );
});

test('the agent listing falls back to the plain description', () => {
  assert.match(describeAgentProfiles([]), /Agent profile name/);
  assert.doesNotMatch(describeAgentProfiles([]), /Available:/);
  assert.match(
    describeAgentProfiles([
      { name: 'ghost', description: 'hidden', disableModelInvocation: true },
    ]),
    /Agent profile name/,
  );
  assert.doesNotMatch(
    describeAgentProfiles([
      { name: 'ghost', description: 'hidden', disableModelInvocation: true },
    ]),
    /hidden/,
  );
});
