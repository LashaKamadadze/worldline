/**
 * Spawns an isolated SpacetimeDB standalone server per test file.
 *
 * Isolation: random port, temp data dir, temp CLI root dir (`--root-dir`) so the
 * developer's own `cli.toml`, identities and tokens are never touched. The CLI
 * token minted for that root is the database owner, which lets tests read the
 * private `lf.*` tables over the HTTP SQL endpoint.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const MODULE_PATH = join(REPO_ROOT, 'examples/todo-module');
export const DB_NAME = 'todo-lf';

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') return reject(new Error('no port'));
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

export async function waitFor(
  pred: () => boolean | Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number; what?: string } = {}
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 25;
  const start = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${opts.what ?? 'condition'} after ${timeoutMs}ms`);
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

function run(args: string[], opts: { cwd?: string } = {}): string {
  const res = spawnSync('spacetime', args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  });
  if (res.status !== 0) {
    throw new Error(
      `spacetime ${args.join(' ')} failed (${res.status}):\n${res.stdout}\n${res.stderr}`
    );
  }
  return res.stdout;
}

export interface SqlResult {
  schema: { elements: { name: { some: string } | string; algebraic_type: unknown }[] };
  rows: unknown[][];
}

export class LiveServer {
  proc: ChildProcess | null = null;
  readonly port: number;
  readonly dataDir: string;
  readonly rootDir: string;
  readonly logs: string[] = [];
  #token: string | null = null;
  #serverAdded = false;
  #bundle: string | null = null;

  private constructor(port: number, dataDir: string, rootDir: string) {
    this.port = port;
    this.dataDir = dataDir;
    this.rootDir = rootDir;
  }

  get httpUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get wsUrl(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  static async start(
    opts: { port?: number; dataDir?: string; rootDir?: string } = {}
  ): Promise<LiveServer> {
    const port = opts.port ?? (await findFreePort());
    const base = await mkdtemp(join(tmpdir(), 'stdb-live-'));
    const server = new LiveServer(
      port,
      opts.dataDir ?? join(base, 'data'),
      opts.rootDir ?? join(base, 'root')
    );
    await server.#spawn();
    return server;
  }

  async #spawn(): Promise<void> {
    const proc = spawn(
      'spacetime',
      [
        'start',
        '--data-dir',
        this.dataDir,
        '--listen-addr',
        `127.0.0.1:${this.port}`,
        '--non-interactive',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    proc.stdout?.on('data', d => this.logs.push(String(d)));
    proc.stderr?.on('data', d => this.logs.push(String(d)));
    this.proc = proc;
    await waitFor(
      async () => {
        try {
          const r = await fetch(`${this.httpUrl}/v1/ping`, { signal: AbortSignal.timeout(1000) });
          return r.ok;
        } catch {
          return false;
        }
      },
      { timeoutMs: 60_000, intervalMs: 100, what: `server on ${this.port}` }
    );
  }

  /** Kill the process (SIGKILL by default: a crash, not a graceful shutdown). */
  async kill(signal: NodeJS.Signals = 'SIGKILL'): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    await new Promise<void>(resolve => {
      proc.once('exit', () => resolve());
      proc.kill(signal);
    });
  }

  /** Restart on the same port with the same data dir; databases and data survive. */
  async restart(): Promise<void> {
    await this.kill();
    await this.#spawn();
  }

  async stop(): Promise<void> {
    await this.kill();
    await rm(this.dataDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(this.rootDir, { recursive: true, force: true }).catch(() => undefined);
  }

  #cli(args: string[]): string {
    if (!this.#serverAdded) {
      run([
        '--root-dir',
        this.rootDir,
        'server',
        'add',
        '--url',
        this.httpUrl,
        '--no-fingerprint',
        '-d',
        'live',
      ]);
      this.#serverAdded = true;
    }
    return run(['--root-dir', this.rootDir, ...args]);
  }

  /** Build the example module once per process; publishing reuses the bundle. */
  static bundlePath(): string {
    if (!LiveServer.#builtBundle) {
      run(['build', '--module-path', MODULE_PATH]);
      LiveServer.#builtBundle = join(MODULE_PATH, 'dist', 'bundle.js');
    }
    return LiveServer.#builtBundle;
  }
  static #builtBundle: string | null = null;

  publish(name = DB_NAME, opts: { clear?: boolean } = {}): string {
    this.#bundle = LiveServer.bundlePath();
    const args = ['publish', '-s', 'live', '-y', '--js-path', this.#bundle, name];
    if (opts.clear ?? true) args.push('--delete-data=always');
    const out = this.#cli(args);
    const m = out.match(/identity: ([0-9a-f]{64})/);
    if (!m) throw new Error(`could not parse database identity from publish output:\n${out}`);
    return m[1];
  }

  async token(): Promise<string> {
    if (this.#token) return this.#token;
    this.#cli(['server', 'list']);
    const toml = await readFile(join(this.rootDir, 'config', 'cli.toml'), 'utf8');
    const m = toml.match(/spacetimedb_token\s*=\s*"([^"]+)"/);
    if (!m) throw new Error('no token in cli.toml');
    this.#token = m[1];
    return this.#token;
  }

  /** Run SQL as the database owner over HTTP. Returns the raw result sets. */
  async sql(query: string, db = DB_NAME): Promise<SqlResult[]> {
    const token = await this.token();
    const res = await fetch(`${this.httpUrl}/v1/database/${db}/sql`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
      body: query,
    });
    if (!res.ok) throw new Error(`sql failed ${res.status}: ${await res.text()}`);
    // SATS JSON writes u64/u128 columns as bare integers; JSON.parse would round
    // them to doubles (a uuid's u128 loses ~90 bits). Quote long integers first.
    const text = await res.text();
    const quoted = text.replace(/(?<=[\[,:]\s*)(-?\d{16,})(?=\s*[\],}])/g, '"$1"');
    return JSON.parse(quoted) as SqlResult[];
  }

  async sqlRows(query: string, db = DB_NAME): Promise<unknown[][]> {
    const r = await this.sql(query, db);
    return r[0]?.rows ?? [];
  }

  async sqlCount(table: string, db = DB_NAME): Promise<number> {
    return (await this.sqlRows(`SELECT * FROM ${table}`, db)).length;
  }
}
