// Bundles the demo for Node. The one thing a plain `node` run cannot do is
// resolve the host-only `spacetime:sys@x.y` import inside `spacetimedb/server`,
// so a tiny plugin points it at the shim. A browser app does the same with a
// Vite `resolve.alias`.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const shim = fileURLToPath(new URL('../../../packages/localfirst/src/sys-shim/index.ts', import.meta.url));

await build({
  entryPoints: [fileURLToPath(new URL('../src/demo.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('../dist/demo.mjs', import.meta.url)),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  plugins: [
    {
      name: 'spacetime-sys-shim',
      setup(b) {
        b.onResolve({ filter: /^spacetime:sys@/ }, () => ({ path: shim }));
      },
    },
  ],
});
