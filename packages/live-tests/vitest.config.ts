import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// The consumer module and the library import `spacetimedb/server`, which imports the
// host-only `spacetime:sys@x.y` module; alias it to the shim so reducer bodies can run
// in Node for prediction.
const shim = fileURLToPath(new URL('../worldline/src/sys-shim/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /^spacetime:sys@.*$/, replacement: shim }],
  },
  test: {
    include: ['test/**/*.test.ts'],
    // Each test file spawns its own server; keep files sequential so port and CPU
    // usage stay predictable and timing measurements are meaningful.
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
    server: {
      deps: { inline: ['spacetimedb', 'todo-module', '@kamadadze/worldline'] },
    },
  },
});
