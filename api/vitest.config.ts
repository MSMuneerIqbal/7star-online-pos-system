import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // The pool is created at import time; keep suites in one process so we
    // don't open a Postgres pool per worker.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },

    // These integration tests run against a REMOTE Postgres (Neon,
    // ap-southeast-1), so a test doing a dozen round trips can easily exceed
    // Vitest's 5s default through latency alone rather than any real fault.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
