import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterAll, describe, expect, it } from 'vitest';
import { headersFor } from '../../web/headers';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';

/**
 * The server in static mode over a small build: what each path answers, and that every answer, a 304 and a 404
 * included, carries the header table's headers for its path in the image's mode.
 */

const root = mkdtempSync(join(tmpdir(), 'simulci-public-'));
mkdirSync(join(root, 'assets'));
const PAGE = `<!doctype html><title>simulci</title>${'<!-- padding -->'.repeat(100)}`;
writeFileSync(join(root, 'index.html'), PAGE);
writeFileSync(join(root, 'assets', 'index-a1.js'), 'console.log(1);');
// The static host's file, which the image must not serve.
writeFileSync(
  join(root, 'config.js'),
  "globalThis.simulciConfig = { mode: 'static', githubUrl: 'https://github.com' };",
);
afterAll(() => rmSync(root, { recursive: true }));

const config = loadConfig({ GITHUB_URL: 'https://ghes.example', PUBLIC_URL: 'https://simulci.example' });
const app = createApp(config, root);
const get = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers });

/** The table's headers the response lacks or has otherwise, one line per header. */
function drift(path: string, response: Response): string[] {
  return [...headersFor(path, config.mode)]
    .filter(([key, value]) => response.headers.get(key) !== value)
    .map(([key, value]) => `${path}: ${key} is ${response.headers.get(key)}, not ${value}`);
}

describe('the server in static mode', () => {
  it('answers /healthz with ok', async () => {
    const response = await get('/healthz');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });

  it('serves its own /config.js, uncached, as a script that sets the mode its environment gives', async () => {
    const response = await get('/config.js');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const scope: { simulciConfig?: unknown } = {};
    runInNewContext(await response.text(), { globalThis: scope });
    expect(scope.simulciConfig).toEqual({ mode: 'static', githubUrl: 'https://ghes.example' });
  });

  it('answers a deep link with the page, and a hashed asset with its file', async () => {
    for (const path of ['/', '/index.html', '/some/deep/link']) {
      const response = await get(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toMatch(/^text\/html/);
      expect(await response.text(), path).toBe(PAGE);
      expect(response.headers.get('cache-control'), path).toBe('public, max-age=0, must-revalidate');
    }
    const asset = await get('/assets/index-a1.js');
    expect(asset.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await asset.text()).toBe('console.log(1);');
  });

  it('answers a missing chunk, and a path that climbs out of the build, with a 404 rather than the page', async () => {
    for (const path of ['/assets/index-gone.js', '/assets/..%2F..%2Fpackage.json', '/assets/']) {
      const response = await get(path);
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).not.toContain('simulci');
    }
  });

  it('sends the table on every answer, a 304 and a 404 included, with HSTS behind https', async () => {
    const problems: string[] = [];
    for (const path of [
      '/',
      '/healthz',
      '/config.js',
      '/some/link',
      '/assets/index-a1.js',
      '/assets/gone.js',
    ])
      problems.push(...drift(path, await get(path)));
    const first = await get('/');
    const again = await get('/', { 'if-none-match': first.headers.get('etag') ?? '' });
    expect(again.status).toBe(304);
    problems.push(...drift('/', again));
    expect(problems).toEqual([]);
    expect(first.headers.get('strict-transport-security')).toBe('max-age=63072000');
    expect(first.headers.get('content-security-policy')).toContain("connect-src 'none'");
  });

  it('compresses what the browser accepts compressed', async () => {
    const response = await get('/', { 'accept-encoding': 'gzip, br' });
    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(response.headers.get('vary')).toBe('Accept-Encoding');
  });
});
