import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 300_000,
    // Each file spawns its own SpacetimeDB and browsers; keep them sequential.
    fileParallelism: false,
    pool: 'forks',
  },
});
