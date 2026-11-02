import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { etag } from 'hono/etag';
import type { Config } from './config';
import { serveApp, tableHeaders } from './static';

/**
 * The server: `/healthz` for the orchestrator, then the web app's files from `root`. Responses are compressed and carry
 * an ETag, so a revalidated page or script costs a 304, as on Vercel.
 */
export function createApp(config: Config, root: string): Hono {
  const app = new Hono();
  app.use(tableHeaders(config.mode), compress(), etag());
  app.get('/healthz', (c) => c.text('ok'));
  serveApp(app, config.page, root);
  return app;
}
