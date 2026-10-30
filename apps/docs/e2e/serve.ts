import { readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

/**
 * The static export (out/) served the way Vercel serves it (vercel.json): clean URLs, and the headers it sets on
 * every path. Run by the browser pass (playwright.config.ts) with Node's own TypeScript: `node e2e/serve.ts <port>`.
 */

const OUT = join(import.meta.dirname, '../out');
const PORT = Number(process.argv[2]);

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ico': 'image/x-icon',
};

interface VercelConfig {
  headers: { source: string; headers: { key: string; value: string }[] }[];
}

const vercel = JSON.parse(readFileSync(join(import.meta.dirname, '../vercel.json'), 'utf8')) as VercelConfig;
const everywhere = vercel.headers.find((h) => h.source === '/(.*)')!.headers;

/** The file a path names: itself, or with .html, or its index.html, as cleanUrls resolves it. */
function fileFor(path: string): string | undefined {
  const base = join(OUT, normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, ''));
  for (const candidate of [base, `${base}.html`, join(base, 'index.html')])
    if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
  return undefined;
}

/** search's index is JSON at a path without an extension, as vercel.json types it. */
const typeOf = (path: string, file: string): string =>
  path === '/api/search' ? TYPES['.json']! : (TYPES[extname(file)] ?? 'application/octet-stream');

createServer((req, res) => {
  for (const { key, value } of everywhere) res.setHeader(key, value);
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  const file = fileFor(path);
  if (file) res.writeHead(200, { 'content-type': typeOf(path, file) }).end(readFileSync(file));
  else res.writeHead(404, { 'content-type': TYPES['.html']! }).end(readFileSync(join(OUT, '404.html')));
}).listen(PORT);
