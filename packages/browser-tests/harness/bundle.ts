import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const PKG = resolve(import.meta.dirname, '..');
export const DIST = resolve(PKG, 'dist');
const SHIM = resolve(PKG, '../localfirst/src/sys-shim/index.ts');

const sysShimPlugin = {
  name: 'spacetime-sys-shim',
  setup(b: any) {
    b.onResolve({ filter: /^spacetime:sys@/ }, () => ({ path: SHIM }));
    // No node:* stubs on purpose: the browser bundle must prove that
    // 'stdb-localfirst/client' has no Node imports (NodeFsStorage lives in
    // 'stdb-localfirst/client/node').
    // `spacetimedb/server` ships a url-polyfill shim that does
    // `globalThis.window = globalThis.window || globalThis`. Fine in the host
    // and in Node, but in a browser `window` is a getter-only global and the
    // assignment throws, killing the whole page bundle at load time. Guard it.
    b.onLoad({ filter: /spacetimedb[\\/]dist[\\/]server[\\/]index\.mjs$/ }, async (args: { path: string }) => {
      const { readFile } = await import('node:fs/promises');
      const src = await readFile(args.path, 'utf8');
      const needle = 'globalThis.window=globalThis.window||globalThis';
      if (!src.includes(needle)) throw new Error('spacetimedb/server polyfill changed; update the browser patch');
      return {
        contents: src.replace(needle, 'typeof window==="undefined"&&(globalThis.window=globalThis)'),
        loader: 'js',
      };
    });
  },
};

const html = (script: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>stdb-localfirst browser test</title></head>
<body><pre id="log"></pre><script type="module" src="/${script}"></script></body></html>`;

/**
 * Bundle the page scripts. `app` needs the generated module bindings, so it is
 * only built after a module has been published (full-stack tests).
 */
export async function bundlePages(opts: { app: boolean }): Promise<string> {
  await mkdir(DIST, { recursive: true });
  const entryPoints: Record<string, string> = {
    opfs_page: resolve(PKG, 'page/opfs_page.ts'),
    opfs_worker: resolve(PKG, 'page/opfs_worker.ts'),
  };
  if (opts.app) entryPoints.app = resolve(PKG, 'page/app.ts');
  await build({
    entryPoints,
    outdir: DIST,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
    logLevel: 'error',
    plugins: [sysShimPlugin],
  });
  await writeFile(resolve(DIST, 'opfs.html'), html('opfs_page.js'));
  if (opts.app) await writeFile(resolve(DIST, 'index.html'), html('app.js'));
  return DIST;
}
