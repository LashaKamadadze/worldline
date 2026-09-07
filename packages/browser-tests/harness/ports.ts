import { createServer } from 'node:net';

/** Ask the OS for a free TCP port on 127.0.0.1. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (!address || typeof address === 'string') return reject(new Error('no port'));
      const port = address.port;
      srv.close(() => resolve(port));
    });
  });
}
