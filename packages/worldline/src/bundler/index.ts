/**
 * Bundler plugins for apps that run module code in the browser or in Node.
 *
 * Two things stand between `spacetimedb/server` and a non-host runtime:
 *  1. it imports the virtual `spacetime:sys@x.y` module, which only the host
 *     provides; the plugin aliases it to `@kamadadze/worldline/sys-shim`;
 *  2. its URL polyfill assigns `globalThis.window`, which browsers expose as a
 *     getter-only global, so the assignment throws at load. The plugin rewrites
 *     that one statement to a guarded form. The exact needle is asserted so an
 *     SDK upgrade that changes the polyfill fails the build instead of the page.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SYS_SPECIFIER = /^spacetime:sys@/;
const SERVER_ENTRY = /spacetimedb[\\/]dist[\\/]server[\\/]index\.mjs$/;
const WINDOW_NEEDLE = 'globalThis.window=globalThis.window||globalThis';
const WINDOW_GUARDED = 'typeof window==="undefined"&&(globalThis.window=globalThis)';

/** Absolute path of the shim, for bundlers that want a file path rather than a specifier. */
export const SYS_SHIM_PATH = fileURLToPath(new URL('../sys-shim/index.ts', import.meta.url));

/** Apply the window guard to the SDK's server entry source. Throws if the SDK changed. */
export function patchServerEntry(source: string): string {
  if (!source.includes(WINDOW_NEEDLE)) {
    throw new Error('worldline: spacetimedb/server polyfill changed; update the bundler plugin');
  }
  return source.replace(WINDOW_NEEDLE, WINDOW_GUARDED);
}

interface EsbuildPluginBuild {
  onResolve(options: { filter: RegExp }, cb: (args: { path: string }) => { path: string }): void;
  onLoad(
    options: { filter: RegExp },
    cb: (args: { path: string }) => Promise<{ contents: string; loader: 'js' }>
  ): void;
}

/** esbuild plugin: `plugins: [worldlineEsbuildPlugin()]`. */
export function worldlineEsbuildPlugin(): {
  name: string;
  setup(build: EsbuildPluginBuild): void;
} {
  return {
    name: '@kamadadze/worldline',
    setup(build) {
      build.onResolve({ filter: SYS_SPECIFIER }, () => ({ path: SYS_SHIM_PATH }));
      build.onLoad({ filter: SERVER_ENTRY }, async args => ({
        contents: patchServerEntry(await readFile(args.path, 'utf8')),
        loader: 'js',
      }));
    },
  };
}

/** Vite / Rollup plugin: `plugins: [worldlineVitePlugin()]`. */
export function worldlineVitePlugin(): {
  name: string;
  enforce: 'pre';
  resolveId(id: string): string | null;
  transform(code: string, id: string): string | null;
} {
  return {
    name: '@kamadadze/worldline',
    enforce: 'pre',
    resolveId(id) {
      return SYS_SPECIFIER.test(id) ? SYS_SHIM_PATH : null;
    },
    transform(code, id) {
      return SERVER_ENTRY.test(id) ? patchServerEntry(code) : null;
    },
  };
}
