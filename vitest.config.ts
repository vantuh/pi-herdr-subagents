import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          testTimeout: 30_000,
          pool: 'forks',
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['e2e/**/*.test.ts'],
          testTimeout: 180_000,
        },
      },
    ],
  },
});
