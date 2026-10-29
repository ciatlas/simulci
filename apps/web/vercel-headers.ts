import { existsSync, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { resolve, sep } from 'node:path';
import type { Plugin } from 'vite';
import { type HostMode, headersFor, isNotFound, VERCEL } from './headers.ts';

/**
 * Vercel's routing away from Vercel: `vite preview` answers with the header table's headers (headers.ts) and its
 * rewrites too, as vercel.ts has Vercel do, so the browser pass (e2e/) runs the app under the deployment's CSP and
 * cache rules.
 */

/**
 * Sets the headers now and again when the response starts: Vite's own HTML answer sets `Cache-Control: no-cache`
 * after every middleware has run, and the static files keep what was set before them.
 */
function applyOnWrite(res: ServerResponse, headers: Map<string, string>): void {
  const apply = (): void => {
    for (const [key, value] of headers) res.setHeader(key, value);
  };
  apply();
  const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => ServerResponse;
  res.writeHead = (...args: unknown[]) => {
    apply();
    return writeHead(...args);
  };
}

/** The request's path as the static server reads it: decodeURI keeps an encoded `/` encoded; a bad escape stays. */
export function pathOf(url: string | undefined): string {
  const raw = new URL(url ?? '/', 'http://preview').pathname;
  try {
    return decodeURI(raw);
  } catch {
    return raw;
  }
}

/** Whether a file of `dist` serves the path: a directory does not, and nothing outside `dist` is looked at. */
export function servesFile(dist: string, pathname: string): boolean {
  const file = resolve(dist, `.${pathname}`);
  return file.startsWith(`${dist}${sep}`) && existsSync(file) && statSync(file).isFile();
}

/** `vite preview` answers with a mode's headers, and with 404 where Vercel would (not with the SPA's page). */
export function vercelHeaders(mode: HostMode = VERCEL): Plugin {
  return {
    name: 'simulci:vercel-headers',
    configurePreviewServer(server) {
      const dist = resolve(server.config.root, server.config.build.outDir);
      server.middlewares.use((req, res, next) => {
        const pathname = pathOf(req.url);
        applyOnWrite(res, headersFor(pathname, mode));
        if (!isNotFound(pathname, servesFile(dist, pathname))) return next();
        res.statusCode = 404;
        res.end();
      });
    },
  };
}
