import { type Harness, type HarnessOptions, createHarness } from './harness.ts';

/**
 * Harness wrapper for the contract suites: no state-save failure to clear, so
 * teardown is only the harness dispose.
 */
export async function withHarness(
  options: HarnessOptions,
  body: (harness: Harness) => Promise<void>,
): Promise<void> {
  const harness = await createHarness(options);
  try {
    await body(harness);
  } finally {
    await harness.dispose();
  }
}

/** Read the value of a `--flag value` pair from a recorded Herdr argv. */
export function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}
