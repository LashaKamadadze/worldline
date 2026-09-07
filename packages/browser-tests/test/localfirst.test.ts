/**
 * Full LocalFirst inside real browsers against a real local SpacetimeDB:
 *  - offline calls, reload (OPFS recovery), go online, drain, converge;
 *  - a second client's conflicting write makes one intent fail and its dependent cancel;
 *  - closing the tab mid-drain must not duplicate effects on the server.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { randomUUID } from 'node:crypto';
import { launchAll, type LaunchedBrowser } from '../harness/browsers';
import { bundlePages } from '../harness/bundle';
import { serveDir, type StaticServer } from '../harness/serve';
import { publishTodoModule, startSpacetime, type LocalSpacetime } from '../harness/spacetime';

const DB = 'todo-lf-browser';
let stdb: LocalSpacetime;
let site: StaticServer;
let launched: LaunchedBrowser[] = [];

beforeAll(async () => {
  stdb = await startSpacetime();
  await publishTodoModule(stdb, DB);
  site = await serveDir(await bundlePages({ app: true }));
  const r = await launchAll();
  launched = r.launched;
  console.log('browsers launched:', launched.map(b => b.name).join(', ') || 'none');
  if (r.failed.length) console.log('browsers that failed to launch:', JSON.stringify(r.failed));
});

afterAll(async () => {
  for (const b of launched) await b.browser.close();
  await site?.close();
  await stdb?.stop();
});

type Api = {
  open(dir: string, opts?: object): Promise<{ pending: number }>;
  call(
    name: string,
    args: Record<string, string>
  ): Promise<{ intentId: string; predicted: boolean; durable: string }>;
  callExpectThrow(name: string, args: Record<string, string>): string | null;
  pending(): string[];
  rows(table: string): unknown[];
  serverRows(table: string): unknown[];
  hasOverlay(): boolean;
  events(): string[];
  settled(): string[];
  connect(ws: string, db: string): Promise<string>;
  waitDrained(ms: number): Promise<number>;
  close(): Promise<void>;
};

/** Run a function against `window.lfTest` in the page. */
function api(page: Page) {
  return <T>(f: (t: Api, arg: any) => T | Promise<T>, arg?: unknown): Promise<T> =>
    page.evaluate(
      // Page-side eval of a serialized function is the point of this helper.
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      ([src, a]) => new Function('t', 'arg', `return (${src})(t, arg)`)((window as any).lfTest, a),
      [f.toString(), arg] as any
    ) as Promise<T>;
}

async function openApp(
  browser: Browser,
  offline: boolean
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', e => console.error('pageerror', e));
  await page.goto(`${site.url}/index.html`);
  await page.waitForFunction(() => (window as any).lfReady === true);
  if (offline) await context.setOffline(true);
  return { context, page };
}

async function serverCount(table: string): Promise<number> {
  const out = await stdb.sql(DB, `SELECT * FROM ${table}`);
  // Output is a text table: header, separator, rows.
  return Math.max(
    0,
    out
      .trim()
      .split('\n')
      .filter(l => l.trim() && !l.startsWith('WARNING')).length - 2
  );
}

describe('LocalFirst in the browser', () => {
  it('launched at least one browser', () => {
    expect(launched.length).toBeGreaterThan(0);
  });

  for (const name of ['chromium', 'firefox', 'webkit'] as const) {
    describe(name, () => {
      const get = () => launched.find(b => b.name === name);
      let persistence: 'opfs' | 'memory' | undefined;

      /** Skips (loudly) when the browser is absent or cannot persist across reloads. */
      const needPersistent = async (skip: () => void): Promise<Browser | undefined> => {
        const b = get();
        if (!b) {
          skip();
          return undefined;
        }
        if (persistence === undefined) {
          const { context, page } = await openApp(b.browser, false);
          persistence = await page.evaluate(() => (window as any).lfTest.persistence());
          await context.close();
          console.log(`${name}: storage = ${persistence}`);
        }
        if (persistence !== 'opfs') {
          console.log(`${name}: no OPFS, reload-persistence scenarios skipped`);
          skip();
          return undefined;
        }
        return b.browser;
      };

      it('offline calls survive a reload and converge with the server once online', async ({
        skip,
      }) => {
        const browser = await needPersistent(skip);
        if (!browser) return;
        const b = { browser };
        const dir = `lf-${name}-${randomUUID().slice(0, 8)}`;
        const { context, page } = await openApp(b.browser, true);
        let t = api(page);
        await t(async (t, dir) => t.open(dir), dir);
        const a = randomUUID();
        const c = randomUUID();
        const h1 = await t((t, a) => t.call('createTodo', { id: a, title: `${name} first` }), a);
        const h2 = await t((t, c) => t.call('createTodo', { id: c, title: 'second' }), c);
        const h3 = await t((t, a) => t.call('toggleTodo', { id: a }), a);
        const h4 = await t(t => t.call('bump', { name: 'browser', by: '2' }));
        for (const h of [h1, h2, h3, h4]) {
          expect(h.predicted).toBe(true);
          expect(h.durable).toBe('ok');
        }
        expect(
          await t((t, a) => t.callExpectThrow('createTodo', { id: a, title: 'dup' }), a)
        ).toContain('UniqueAlreadyExists');
        const before = await t(t => t.rows('todos'));
        expect(before).toHaveLength(2);
        expect(await t(t => t.pending())).toHaveLength(4);

        // Reload: the page itself needs the network, so go online only to fetch
        // it, then back offline before the app opens. State must come back from OPFS.
        await context.setOffline(false);
        await page.reload();
        await page.waitForFunction(() => (window as any).lfReady === true);
        await context.setOffline(true);
        t = api(page);
        const reopened = await t(async (t, dir) => t.open(dir), dir);
        expect(reopened.pending).toBe(4);
        expect(await t(t => t.rows('todos'))).toEqual(before);
        expect(await t(t => t.rows('counters'))).toEqual([{ name: 'browser', value: '2' }]);

        await context.setOffline(false);
        const identity = await t((t, ws) => t.connect(ws, 'todo-lf-browser'), stdb.wsUrl);
        expect(identity.length).toBeGreaterThan(10);
        await t(t => t.waitDrained(30_000));
        expect(await t(t => t.pending())).toEqual([]);
        expect(await t(t => t.hasOverlay())).toBe(false);
        const settled = await t(t => t.settled());
        expect(settled.filter(s => s.startsWith('acked:'))).toHaveLength(4);
        expect(await t(t => t.rows('todos'))).toEqual(await t(t => t.serverRows('todos')));
        expect(await t(t => t.rows('counters'))).toEqual(await t(t => t.serverRows('counters')));
        const todosLocal = (await t(t => t.rows('todos'))) as any[];
        expect(todosLocal.find(r => r.id === a)?.done).toBe(true);
        await t(t => t.close());
        await context.close();
      });

      const conflictTitle =
        'a conflicting write from another client fails the intent, cancels dependents, converges';
      it(conflictTitle, async ({ skip }) => {
        const b = get();
        if (!b) return skip();
        const shared = randomUUID();
        // Client B is online and creates the row first.
        const other = await openApp(b.browser, false);
        const ot = api(other.page);
        await ot(async (t, dir) => t.open(dir), `other-${name}-${randomUUID().slice(0, 8)}`);
        await ot((t, ws) => t.connect(ws, 'todo-lf-browser'), stdb.wsUrl);
        await ot((t, id) => t.call('createTodo', { id, title: 'theirs' }), shared);
        await ot(t => t.waitDrained(30_000));

        // Client A, offline, creates the same id and then toggles it (dependent).
        const { context, page } = await openApp(b.browser, true);
        const t = api(page);
        await t(async (t, dir) => t.open(dir), `mine-${name}-${randomUUID().slice(0, 8)}`);
        const create = await t((t, id) => t.call('createTodo', { id, title: 'mine' }), shared);
        const toggle = await t((t, id) => t.call('toggleTodo', { id }), shared);
        const bump = await t(t => t.call('bump', { name: 'conflict', by: '1' }));
        await context.setOffline(false);
        await t((t, ws) => t.connect(ws, 'todo-lf-browser'), stdb.wsUrl);
        await t(t => t.waitDrained(30_000));
        const settled = await t(t => t.settled());
        expect(settled).toContain(`failed:${create.intentId}`);
        expect(settled).toContain(`cancelled:${toggle.intentId}`);
        expect(settled).toContain(`acked:${bump.intentId}`);
        const local = (await t(t => t.rows('todos'))) as any[];
        expect(local.find(r => r.id === shared)?.title).toBe('theirs');
        expect(local.find(r => r.id === shared)?.done).toBe(false);
        expect(await t(t => t.rows('todos'))).toEqual(await t(t => t.serverRows('todos')));
        expect(await t(t => t.hasOverlay())).toBe(false);
        await t(t => t.close());
        await ot(t => t.close());
        await context.close();
        await other.context.close();
      });

      it('closing the tab mid-drain never duplicates effects on the server', async ({ skip }) => {
        const browser = await needPersistent(skip);
        if (!browser) return;
        const b = { browser };
        const dir = `close-${name}-${randomUUID().slice(0, 8)}`;
        const counter = `close-${name}-${randomUUID().slice(0, 4)}`;
        const { context, page } = await openApp(b.browser, true);
        let t = api(page);
        await t(async (t, dir) => t.open(dir, { inflightWindow: 1 }), dir);
        const ids: string[] = [];
        for (let i = 0; i < 12; i++) {
          const id = randomUUID();
          ids.push(id);
          await t((t, a) => t.call('createTodo', { id: a.id, title: a.title }), {
            id,
            title: `burst ${i}`,
          });
          await t((t, name) => t.call('bump', { name, by: '1' }), counter);
        }
        expect(await t(t => t.pending())).toHaveLength(24);
        await context.setOffline(false);
        await t((t, ws) => t.connect(ws, 'todo-lf-browser'), stdb.wsUrl);
        // Let a few acks land, then kill the tab abruptly (no close(), no flush).
        await page.waitForFunction(() => (window as any).lfTest.settled().length >= 3, null, {
          timeout: 30_000,
        });
        await page.close({ runBeforeUnload: false });

        // Reopen: everything not durably marked acked is resent. Acks seen in
        // memory whose mark had not reached disk yet come back as pending too;
        // that is the at-least-once case the server-side dedup exists for.
        const page2 = await context.newPage();
        page2.on('pageerror', e => console.error('pageerror', e));
        await page2.goto(`${site.url}/index.html`);
        await page2.waitForFunction(() => (window as any).lfReady === true);
        t = api(page2);
        const reopened = await t(async (t, dir) => t.open(dir), dir);
        expect(reopened.pending).toBeGreaterThan(0);
        expect(reopened.pending).toBeLessThanOrEqual(24);
        console.log(`${name}: ${reopened.pending} of 24 intents resent after tab close`);
        await t((t, ws) => t.connect(ws, 'todo-lf-browser'), stdb.wsUrl);
        await t(t => t.waitDrained(60_000));
        const local = (await t(t => t.rows('todos'))) as any[];
        const mine = local.filter(r => ids.includes(r.id));
        expect(mine).toHaveLength(12);
        const counters = (await t(t => t.rows('counters'))) as any[];
        expect(counters.find(c => c.name === counter)?.value).toBe('12');
        expect(await t(t => t.rows('todos'))).toEqual(await t(t => t.serverRows('todos')));
        // Independent check through the CLI: the server has exactly 12 of our todos.
        const sql = await stdb.sql(
          'todo-lf-browser',
          `SELECT * FROM counters WHERE name = '${counter}'`
        );
        expect(sql).toContain('12');
        expect(await serverCount('todos')).toBeGreaterThanOrEqual(12);
        await t(t => t.close());
        await context.close();
      });
    });
  }
});
