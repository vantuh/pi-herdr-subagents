import { clearStateSaveFailures } from '../src/state/store.ts';
import { type Harness, type HarnessOptions, createHarness } from './harness.ts';

/**
 * Harness wrapper for the flow suites.
 *
 * Injected state-save failures stay armed for the next mutation, so they are
 * cleared before `dispose()` runs its own shutdown writes.
 */
export async function withHarness(
  options: HarnessOptions,
  body: (harness: Harness) => Promise<void>,
): Promise<void> {
  const harness = await createHarness(options);
  try {
    await body(harness);
  } finally {
    clearStateSaveFailures();
    await harness.dispose();
  }
}

/** Read the value of a `--flag value` pair from a recorded Herdr argv. */
export function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}
