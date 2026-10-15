import assert from 'node:assert/strict';

import { Type } from 'typebox';
import { test } from 'vitest';

import { parseJson } from '../src/json.ts';

const Pane = Type.Object({
  pane_id: Type.String(),
  focused: Type.Optional(Type.Boolean()),
});

test('returns undefined for text that is not JSON', () => {
  assert.equal(parseJson(Pane, 'this is not json'), undefined);
  assert.equal(parseJson(Pane, ''), undefined);
});

test('returns undefined when the shape does not match', () => {
  assert.equal(parseJson(Pane, '{}'), undefined);
  assert.equal(parseJson(Pane, '{"pane_id":5}'), undefined);
  assert.equal(parseJson(Pane, '[]'), undefined);
});

test('returns the parsed value unchanged', () => {
  assert.deepEqual(parseJson(Pane, '{"pane_id":"p1"}'), { pane_id: 'p1' });
  assert.deepEqual(parseJson(Pane, '{"pane_id":"p1","focused":true}'), {
    pane_id: 'p1',
    focused: true,
  });
});

test('allows unknown fields so new Herdr fields never break parsing', () => {
  assert.deepEqual(
    parseJson(Pane, '{"pane_id":"p1","agent_status":"idle","zoom":2}'),
    { pane_id: 'p1', agent_status: 'idle', zoom: 2 },
  );
});

test('a present optional field with the wrong type rejects the object', () => {
  assert.equal(parseJson(Pane, '{"pane_id":"p1","focused":"yes"}'), undefined);
});

test('validates nested and array shapes', () => {
  const List = Type.Object({
    tabs: Type.Array(
      Type.Object({
        tab_id: Type.String(),
        label: Type.Optional(Type.String()),
      }),
    ),
  });
  assert.deepEqual(
    parseJson(List, '{"tabs":[{"tab_id":"t1","label":"Scout"}]}'),
    { tabs: [{ tab_id: 't1', label: 'Scout' }] },
  );
  assert.equal(parseJson(List, '{"tabs":[{"label":"Scout"}]}'), undefined);
  assert.equal(parseJson(List, '{"tabs":{}}'), undefined);
});

test('accepts literal-discriminated unions', () => {
  const Status = Type.Union([
    Type.Literal('resumable'),
    Type.Literal('staged'),
  ]);
  assert.equal(parseJson(Status, '"staged"'), 'staged');
  assert.equal(parseJson(Status, '"claimed"'), undefined);
});

test('rejects a number where a string was coerced', () => {
  const Count = Type.Object({ n: Type.Number() });
  assert.equal(parseJson(Count, '{"n":"1"}'), undefined);
  assert.deepEqual(parseJson(Count, '{"n":1}'), { n: 1 });
});
