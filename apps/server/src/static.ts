import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono, MiddlewareHandler } from 'hono';
import { type HostMode, headersFor, isNotFound } from '../../web/headers';
import type { PageConfig } from './config';

/**
 * The web app's files (apps/web/dist, /app/public in the image) as Vercel serves them: the header table's headers on
 * every response, a file where one exists, the page for any other path but a missing `/assets/` chunk, which is a 404.
 * /config.js is the server's own, written from its environment, in place of the static host's file.
 */

/** Sets the table's headers for the path once the response is made, errors and 404s included, so nothing overwrites them. */
export const tableHeaders =
  (mode: HostMode): MiddlewareHandler =>
  async (c, next) => {
    await next();
    for (const [key, value] of headersFor(c.req.path, mode)) c.res.headers.set(key, value);
  };

/** The classic script the page runs before its module (apps/web/index.html), setting the host's mode. */
const configScript = (page: PageConfig): string => `globalThis.simulciConfig = ${JSON.stringify(page)};\n`;

export function serveApp(app: Hono, page: PageConfig, root: string): void {
  const script = configScript(page);
  app.get('/config.js', (c) => c.body(script, 200, { 'Content-Type': 'text/javascript; charset=utf-8' }));
  app.use(serveStatic({ root }));
  app.get(
    '*',
    (c, next) => (isNotFound(c.req.path, false) ? c.notFound() : next()),
    serveStatic({ root, path: 'index.html' }),
  );
}
