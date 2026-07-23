import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    // Integration tests share one Postgres database — running them in
    // parallel workers risks cross-test interference (e.g. two files racing
    // to seed/reset the same tables). A single fork keeps runs deterministic;
    // this suite is small enough that the serialization cost is negligible.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 15000,
    hookTimeout: 30000,
  },
});
