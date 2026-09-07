/**
 * OPFS storage adapter in real browsers: adapter contract on the main thread
 * (createWritable) and inside a Worker (createSyncAccessHandle), persistence
 * across reload, torn-log recovery on real files, and requestPersistence().
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { launchAll, type LaunchedBrowser } from '../harness/browsers';
import { bundlePages } from '../harness/bundle';
import { serveDir, type StaticServer } from '../harness/serve';

let server: StaticServer;
let launched: LaunchedBrowser[] = [];
let failed: { name: string; error: string }[] = [];

beforeAll(async () => {
  server = await serveDir(await bundlePages({ app: false }));
  ({ launched, failed } = await launchAll());
  console.log('browsers launched:', launched.map(b => b.name).join(', ') || 'none');
  if (failed.length) console.log('browsers that failed to launch:', JSON.stringify(failed));
});

afterAll(async () => {
  for (const b of launched) await b.browser.close();
  await server?.close();
});

async function openPage(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', e => console.error('pageerror', e));
  await page.goto(`${server.url}/opfs.html`);
  await page.waitForFunction(() => (window as any).opfsReady === true);
  return { context, page };
}

describe('OPFS adapter', () => {
  it('launched at least one browser', () => {
    expect(launched.length).toBeGreaterThan(0);
  });

  for (const name of ['chromium', 'firefox', 'webkit'] as const) {
    describe(name, () => {
      const get = () => launched.find(b => b.name === name);
      let supported: boolean | undefined;

      /** Returns the browser, or skips (loudly) when it is absent or has no OPFS. */
      const need = async (skip: () => void): Promise<Browser | undefined> => {
        const b = get();
        if (!b) {
          skip();
          return undefined;
        }
        if (supported === undefined) {
          const { context, page } = await openPage(b.browser);
          supported = await page.evaluate(() => (window as any).opfsTest.supported());
          await context.close();
          if (!supported)
            console.log(`${name}: navigator.storage.getDirectory is absent; OPFS tests skipped`);
        }
        if (!supported) {
          skip();
          return undefined;
        }
        return b.browser;
      };

      it('reports OPFS support and answers requestPersistence with a boolean within 10s', async ({
        skip,
      }) => {
        const b = get();
        if (!b) return skip();
        const { context, page } = await openPage(b.browser);
        const isSupported = await page.evaluate(() => (window as any).opfsTest.supported());
        expect(typeof isSupported).toBe('boolean');
        // Firefox shows a permission prompt for persist(); headless never answers it.
        // The adapter must not hang on that.
        const started = Date.now();
        const persisted = await page.evaluate(() => (window as any).opfsTest.requestPersistence());
        expect(typeof persisted).toBe('boolean');
        expect(Date.now() - started).toBeLessThan(10_000);
        await context.close();
      });

      it('main thread: append/read/write/remove round trips and binary safety', async ({
        skip,
      }) => {
        const browser = await need(skip);
        if (!browser) return;
        const b = { browser };
        const { context, page } = await openPage(b.browser);
        const r = await page.evaluate(() => (window as any).opfsTest.roundTrip('rt-main'));
        expect(r).toMatchObject({
          missing: null,
          appended: 'hello world',
          written: 'replaced',
          afterAppend: 'replaced+tail',
          removed: null,
          binaryOk: true,
          syncAccessHandle: false,
        });
        await context.close();
      });

      it('worker: same contract through createSyncAccessHandle', async ({ skip }) => {
        const browser = await need(skip);
        if (!browser) return;
        const b = { browser };
        const { context, page } = await openPage(b.browser);
        const r = await page.evaluate(() => (window as any).opfsTest.workerRoundTrip('rt-worker'));
        expect(r).toMatchObject({
          missing: null,
          appended: 'hello world',
          written: 'replaced',
          afterAppend: 'replaced+tail',
          removed: null,
          binaryOk: true,
          syncAccessHandle: true,
        });
        await context.close();
      });

      it('data written before reload is readable after reload', async ({ skip }) => {
        const browser = await need(skip);
        if (!browser) return;
        const b = { browser };
        const { context, page } = await openPage(b.browser);
        await page.evaluate(() => (window as any).opfsTest.write('persist', 'f', 'one'));
        await page.evaluate(() => (window as any).opfsTest.append('persist', 'f', '+two'));
        await page.reload();
        await page.waitForFunction(() => (window as any).opfsReady === true);
        expect(await page.evaluate(() => (window as any).opfsTest.read('persist', 'f'))).toBe(
          'one+two'
        );
        await context.close();
      });

      it('IntentLog recovers a torn tail on real OPFS files (main thread and worker)', async ({
        skip,
      }) => {
        const browser = await need(skip);
        if (!browser) return;
        const b = { browser };
        const { context, page } = await openPage(b.browser);
        for (const op of ['tornLog', 'workerTornLog']) {
          const r = await page.evaluate(op => (window as any).opfsTest[op](`torn-${op}`), op);
          expect(r).toMatchObject({
            recoveredPending: 1,
            recoveredTorn: true,
            movedSlot: true,
            afterAppendPending: 2,
            afterAppendTorn: false,
          });
          expect(r.args).toEqual([
            [1, 2, 3],
            [3, 4, 5],
          ]);
        }
        await context.close();
      });
    });
  }
});
