import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// The consumer's SpacetimeDB module imports `spacetimedb/server`, which imports the
// host-only `spacetime:sys@x.y` module. Outside the host we alias it to the shim so
// reducer bodies can run against the local store.
const shim = fileURLToPath(new URL('./src/sys-shim/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /^spacetime:sys@.*$/, replacement: shim }],
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    server: {
      // Inline the SDK so vite processes it and the `spacetime:sys` alias applies
      // inside `spacetimedb/server` (otherwise Node's loader rejects the scheme).
      deps: { inline: ['spacetimedb'] },
    },
  },
});
