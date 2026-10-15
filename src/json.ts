import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';

/**
 * `undefined` when the text is not JSON or does not match the schema.
 *
 * `Value.Check` only validates: it never coerces, so a present optional field
 * with the wrong type rejects the whole object.
 */
export function parseJson<T extends TSchema>(
  schema: T,
  text: string,
): Static<T> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  return Value.Check(schema, value) ? value : undefined;
}
