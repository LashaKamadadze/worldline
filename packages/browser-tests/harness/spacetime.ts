import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { freePort } from './ports';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
export const MODULE_PATH = join(REPO_ROOT, 'examples/todo-module');
export const BINDINGS_DIR = resolve(import.meta.dirname, '../generated/module_bindings');

export interface LocalSpacetime {
  port: number;
  httpUrl: string;
  wsUrl: string;
  dataDir: string;
  configDir: string;
  process: ChildProcess;
  /** Run a CLI command against this server with an isolated config. */
  cli(
    args: string[],
    opts?: { timeoutMs?: number }
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  sql(db: string, query: string): Promise<string>;
  stop(): Promise<void>;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 120_000) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolvePromise, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => (stdout += d));
    child.stderr.on('data', d => (stderr += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} ${args.join(' ')} timed out\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.on('error', reject);
    child.on('exit', code => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function waitForPing(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/v1/ping`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`SpacetimeDB at ${url} did not answer /v1/ping within ${timeoutMs}ms`);
}

/**
 * Start a throwaway `spacetime start` on a free port with its own data dir and
 * an isolated CLI config dir (so nothing touches the user's ~/.config).
 */
export async function startSpacetime(): Promise<LocalSpacetime> {
  const port = await freePort();
  const dataDir = await mkdtemp(join(tmpdir(), 'worldline-data-'));
  const configDir = await mkdtemp(join(tmpdir(), 'worldline-config-'));
  const httpUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}`;
  const env = { ...process.env, HOME: configDir, XDG_CONFIG_HOME: join(configDir, '.config') };
  const proc = spawn(
    'spacetime',
    ['start', '--data-dir', dataDir, '--listen-addr', `127.0.0.1:${port}`, '--non-interactive'],
    { env, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let log = '';
  proc.stdout.on('data', d => (log += d));
  proc.stderr.on('data', d => (log += d));
  try {
    await waitForPing(httpUrl, 60_000);
  } catch (e) {
    proc.kill('SIGKILL');
    throw new Error(`${(e as Error).message}\n--- server log ---\n${log.slice(-4000)}`);
  }
  const cli = (args: string[], opts?: { timeoutMs?: number }) =>
    run('spacetime', args, env, opts?.timeoutMs);
  // Register the server under a nickname so every command can use `-s local-test`.
  const add = await cli([
    'server',
    'add',
    '--url',
    httpUrl,
    '--no-fingerprint',
    '--default',
    'local-test',
  ]);
  if (add.code !== 0) {
    proc.kill('SIGKILL');
    throw new Error(`spacetime server add failed: ${add.stdout}\n${add.stderr}`);
  }
  return {
    port,
    httpUrl,
    wsUrl,
    dataDir,
    configDir,
    process: proc,
    cli,
    async sql(db, query) {
      const r = await cli(['sql', '-s', 'local-test', db, query]);
      if (r.code !== 0) throw new Error(`spacetime sql failed: ${r.stdout}\n${r.stderr}`);
      return r.stdout;
    },
    async stop() {
      proc.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 300));
      proc.kill('SIGKILL');
      await rm(dataDir, { recursive: true, force: true });
      await rm(configDir, { recursive: true, force: true });
    },
  };
}

/** Publish the example module as `db` and (re)generate TypeScript bindings. */
export async function publishTodoModule(server: LocalSpacetime, db: string): Promise<void> {
  const pub = await server.cli(
    ['publish', '-s', 'local-test', '-y', '--delete-data=always', db, '--module-path', MODULE_PATH],
    { timeoutMs: 300_000 }
  );
  if (pub.code !== 0) throw new Error(`spacetime publish failed:\n${pub.stdout}\n${pub.stderr}`);
  const gen = await server.cli(
    [
      'generate',
      '-y',
      '--lang',
      'typescript',
      '--out-dir',
      BINDINGS_DIR,
      '--module-path',
      MODULE_PATH,
    ],
    { timeoutMs: 300_000 }
  );
  if (gen.code !== 0) throw new Error(`spacetime generate failed:\n${gen.stdout}\n${gen.stderr}`);
}
