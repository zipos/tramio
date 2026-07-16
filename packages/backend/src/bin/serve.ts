/**
 * Thin runner around `buildServer()`. Used for local development; the
 * factory is what tests and integration harnesses import directly.
 *
 * Usage:
 *   npm run backend:dev                              # 0.0.0.0:8080
 *   PORT=9000 HOST=127.0.0.1 npm run backend:dev
 */
import { join } from 'node:path';

import { buildServer } from '../server';
import { createBackendStore } from '../store';
import { createDevBackendStoreOptions, createDevKeyRegistry } from '../devBootstrap';

async function main(): Promise<void> {
  const port = Number.parseInt(process.env.PORT ?? '8080', 10);
  const host = process.env.HOST ?? '0.0.0.0';
  const repoRoot = join(__dirname, '..', '..', '..', '..');

  const server = buildServer({
    logger: true,
    keys: createDevKeyRegistry(repoRoot),
    store: createBackendStore(createDevBackendStoreOptions(repoRoot)),
  });

  await server.listen({ port, host });
  // eslint-disable-next-line no-console
  console.warn(`[@tramio/backend] listening on http://${host}:${port}`);
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[@tramio/backend] fatal:', err);
  process.exitCode = 1;
});
