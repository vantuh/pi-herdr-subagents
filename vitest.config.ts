import { defineConfig } from 'vitest/config';

import { GUARDED_STATE_PATH } from './test-support/state-path-guard.ts';

// Every test process resolves the default state path to a throwaway file, so no
// leaked task can reach the live session's state; see the guard's teardown.
const stateEnv = { HERDR_AGENTS_STATE_PATH: GUARDED_STATE_PATH };
// Suites that drive the extension through the fake-Herdr harness.
const integrationFiles = [
  'test/integration.test.ts',
  'test/contract.test.ts',
  'test/ui-boundary.test.ts',
];

export default defineConfig({
  test: {
    globalSetup: ['./test-support/state-path-guard.ts'],
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: integrationFiles,
          testTimeout: 30_000,
          pool: 'forks',
          env: stateEnv,
        },
      },
      {
        test: {
          name: 'integration',
          include: integrationFiles,
          testTimeout: 30_000,
          pool: 'forks',
          env: stateEnv,
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['e2e/**/*.test.ts'],
          testTimeout: 180_000,
          env: stateEnv,
        },
      },
    ],
  },
});
