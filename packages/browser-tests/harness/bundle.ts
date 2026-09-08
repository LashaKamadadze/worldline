import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { worldlineEsbuildPlugin } from '@kamadadze/worldline/bundler';

const PKG = resolve(import.meta.dirname, '..');
export const DIST = resolve(PKG, 'dist');

const html = (script: string) =>
  '<!doctype html><html><head><meta charset="utf-8">' +
  '<title>@kamadadze/worldline browser test</title></head>' +
  `<body><pre id="log"></pre><script type="module" src="/${script}"></script></body></html>`;

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
    plugins: [worldlineEsbuildPlugin()],
  });
  await writeFile(resolve(DIST, 'opfs.html'), html('opfs_page.js'));
  if (opts.app) await writeFile(resolve(DIST, 'index.html'), html('app.js'));
  return DIST;
}
