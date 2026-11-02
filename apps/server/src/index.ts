import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { ConfigError, loadConfig } from './config';

/**
 * The image's entry, dist/server.mjs as /app/server.mjs: the web app's build sits beside it in /app/public. A bad
 * variable or a missing build stops the boot with a message and exit code 1. SIGTERM and SIGINT close the server, which
 * as PID 1 in a container has no default handler for them.
 */

const root = fileURLToPath(new URL('public', import.meta.url));

function boot(): void {
  const config = loadConfig();
  if (!existsSync(join(root, 'index.html')))
    throw new ConfigError(`no web app build in ${root} (index.html is missing)`);
  const server = serve({ fetch: createApp(config, root).fetch, port: config.port }, (info) => {
    console.log(`simulci serves the app on port ${info.port} (${config.mode.serve}, ${config.mode.github})`);
  });
  const stop = (): void => {
    server.close(() => process.exit(0));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

try {
  boot();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(`simulci: ${error.message}`);
  process.exit(1);
}
