import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { freePort } from './ports';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json',
};

export interface StaticServer {
  url: string;
  close(): Promise<void>;
}

/** Serve a directory on a free localhost port. */
export async function serveDir(dir: string): Promise<StaticServer> {
  const port = await freePort();
  const server: Server = createServer((req, res) => {
    void serveFile(dir, req, res);
  });
  await new Promise<void>(r => server.listen(port, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise(r => server.close(() => r())),
  };
}

async function serveFile(dir: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = normalize(new URL(req.url ?? '/', 'http://x').pathname);
  const file = join(dir, path === '/' ? '/index.html' : path);
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}
