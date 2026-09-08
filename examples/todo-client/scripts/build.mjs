// Bundles the demo for Node. `worldlineEsbuildPlugin` resolves the host-only
// `spacetime:sys@x.y` import inside `spacetimedb/server` to the shim. A browser
// app uses `worldlineVitePlugin()` from the same entry point.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { worldlineEsbuildPlugin } from '@kamadadze/worldline/bundler';

await build({
  entryPoints: [fileURLToPath(new URL('../src/demo.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('../dist/demo.mjs', import.meta.url)),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  plugins: [worldlineEsbuildPlugin()],
});
