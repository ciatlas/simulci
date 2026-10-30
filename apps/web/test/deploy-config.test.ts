// @vitest-environment happy-dom
import { EditorView } from '@codemirror/view';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { config as zodConfig } from 'zod';
import { describeViolation } from '../src/worker/csp';
import { themeFor } from '../src/yaml/extensions';
// oxlint-disable-next-line import/no-unassigned-import -- what the engine worker imports, for its side effect
import '../src/worker/jitless';
import { cspFor, type HostMode, headerRules, headersFor, isNotFound, REWRITES, VERCEL } from '../headers.ts';
import { pathOf, servesFile } from '../vercel-headers.ts';
import { config as vercel } from '../vercel.ts';

/**
 * What every host serves (the header table, headers.ts, by mode), that vercel.ts gives Vercel the same, how the
 * preview finds the file a path names, and what the workers load first so that the CSP's refusals inside a worker are
 * seen (csp.ts, in both) and zod causes none (jitless.ts, in the engine worker). CodeMirror's styles go into a
 * constructed sheet, which the CSP's style-src allows, rather than a `<style>` element, which it refuses
 * (patches/style-mod@4.1.4.patch).
 */

const here = dirname(fileURLToPath(import.meta.url));

const MODES: Record<string, HostMode> = {
  'static, github.com': VERCEL,
  'static, GHES': { serve: 'static', github: 'ghes' },
  'server, github.com': { serve: 'server', github: 'github.com' },
  'server, GHES': { serve: 'server', github: 'ghes' },
};
const SERVER: HostMode = { serve: 'server', github: 'github.com' };

const directives = (policy: string): Record<string, string> =>
  Object.fromEntries(
    policy
      .split(';')
      .map((d) => d.trim().split(/\s+/))
      .filter((words) => words[0])
      .map(([name, ...values]) => [name, values.join(' ')]),
  );
const csp = (pathname: string, mode: HostMode): Record<string, string> =>
  directives(headersFor(pathname, mode).get('content-security-policy') ?? '');

/** The policy Vercel serves; only connect-src differs by mode. */
const POLICY = {
  'default-src': "'self'",
  'script-src': "'self'",
  'worker-src': "'self'",
  'connect-src': 'https://api.github.com',
  'img-src': "'self' data:",
  'style-src': "'self'",
  'font-src': "'self'",
  'base-uri': "'none'",
  'frame-ancestors': "'none'",
  'form-action': "'none'",
};

/** Where the page may fetch from in each mode. */
const CONNECT: Record<string, string> = {
  'static, github.com': 'https://api.github.com',
  'static, GHES': "'none'",
  'server, github.com': "'self' https://api.github.com",
  'server, GHES': "'self'",
};

/** A source's text outside its parenthesised groups, where path-to-regexp and a regular expression read alike. */
function outsideGroups(source: string): string {
  let depth = 0;
  let out = '';
  for (const char of source) {
    if (char === '(') depth++;
    if (depth === 0) out += char;
    if (char === ')') depth--;
  }
  return out;
}

describe('the header table', () => {
  it('writes every source so that Vercel and a regular expression read it alike: no :name, nothing special outside a group', () => {
    const rules = Object.values(MODES).flatMap(headerRules);
    for (const { source } of [...rules, ...REWRITES]) {
      expect(() => new RegExp(source)).not.toThrow();
      expect(outsideGroups(source)).toMatch(/^[\w/-]*$/);
    }
    expect(outsideGroups('/assets/:path*')).not.toMatch(/^[\w/-]*$/);
    expect(outsideGroups('/theme.js')).not.toMatch(/^[\w/-]*$/);
  });

  it('sends the CSP with every response in every mode, the page, its scripts and the worker scripts', () => {
    for (const [name, mode] of Object.entries(MODES))
      for (const path of [
        '/',
        '/some/link',
        '/theme.js',
        '/assets/index-a1.js',
        '/assets/engine.worker-a1.js',
      ])
        expect(csp(path, mode), `${name} ${path}`).toEqual({ ...POLICY, 'connect-src': CONNECT[name] });
  });

  it("lets the page fetch from github.com's API, from its server too on a server, and from nothing on a static host for a GHES", () => {
    const connect = Object.entries(MODES).map(([name, mode]) => [
      name,
      directives(cspFor(mode))['connect-src'],
    ]);
    expect(Object.fromEntries(connect)).toEqual(CONNECT);
  });

  it('keeps every response of every host out of the browsing context group of a window it opens', () => {
    for (const mode of Object.values(MODES))
      for (const path of ['/', '/some/link', '/config.js', '/assets/index-a1.js', '/api/session'])
        expect(headersFor(path, mode).get('cross-origin-opener-policy'), path).toBe('same-origin');
  });

  it('caches hashed assets for good and has everything else revalidated', () => {
    for (const mode of Object.values(MODES)) {
      const cache = (path: string) => headersFor(path, mode).get('cache-control');
      expect(cache('/assets/index-a1.js')).toBe('public, max-age=31536000, immutable');
      expect(cache('/assets/mona-sans-latin-wdth-normal-a1.woff2')).toBe(
        'public, max-age=31536000, immutable',
      );
      for (const path of ['/', '/index.html', '/theme.js', '/some/link'])
        expect(cache(path)).toBe('public, max-age=0, must-revalidate');
    }
  });

  it("keeps a server's API and sign-in answers out of every cache and every other origin; a static host has neither", () => {
    for (const path of [
      '/api/session',
      '/api/github/repos/o/r/contents/a.yml',
      '/auth/sign-in',
      '/auth/callback',
    ]) {
      expect(headersFor(path, SERVER).get('cache-control'), path).toBe('no-store');
      expect(headersFor(path, SERVER).get('cross-origin-resource-policy'), path).toBe('same-origin');
      expect(headersFor(path, VERCEL).get('cache-control'), path).toBe('public, max-age=0, must-revalidate');
      expect(headersFor(path, VERCEL).has('cross-origin-resource-policy'), path).toBe(false);
    }
    for (const path of ['/', '/apis', '/assets/api/x.js'])
      expect(headersFor(path, SERVER).has('cross-origin-resource-policy'), path).toBe(false);
  });

  it('answers a deep link with the page and a missing chunk with a 404', () => {
    expect(isNotFound('/some/link', false)).toBe(false);
    expect(isNotFound('/assets/index-gone.js', false)).toBe(true);
    expect(isNotFound('/assets/index-a1.js', true)).toBe(false);
  });
});

describe('vercel.ts', () => {
  it("gives Vercel the table's headers and rewrites in Vercel's mode, and is the project's only config file", () => {
    expect(vercel.headers).toEqual(headerRules(VERCEL));
    expect(vercel.rewrites).toEqual(REWRITES);
    expect(vercel.outputDirectory).toBe('dist');
    for (const other of ['vercel.json', 'vercel.toml'])
      expect(existsSync(join(here, '..', other)), other).toBe(false);
  });
});

describe('the preview finds the file a path names', () => {
  const dist = mkdtempSync(join(tmpdir(), 'simulci-dist-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'assets', 'index-a1.js'), '');
  writeFileSync(join(dist, 'index.html'), '');
  afterAll(() => rmSync(dist, { recursive: true }));

  it('in dist, never a directory', () => {
    expect(servesFile(dist, '/assets/index-a1.js')).toBe(true);
    expect(servesFile(dist, '/index.html')).toBe(true);
    for (const path of ['/', '/assets', '/assets/', '/assets/index-gone.js'])
      expect(servesFile(dist, path)).toBe(false);
  });

  it('never outside dist, and an encoded slash stays part of a name', () => {
    expect(pathOf('/assets/..%2F..%2Fpackage.json')).toBe('/assets/..%2F..%2Fpackage.json');
    expect(servesFile(dist, pathOf('/assets/..%2F..%2Fpackage.json'))).toBe(false);
    expect(servesFile(dist, '/../package.json')).toBe(false);
    expect(pathOf('/%E0%A4%A')).toBe('/%E0%A4%A');
    expect(pathOf('/some%20link?wf=ci.yml')).toBe('/some link');
  });
});

describe('the workers under the CSP', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('load csp.ts before anything else, and the engine worker jitless.ts before the engine', () => {
    const imports = (file: string): string[] =>
      [...readFileSync(join(here, '../src/worker', file), 'utf8').matchAll(/^import .*?'([^']+)';$/gm)].map(
        (m) => m[1]!,
      );
    const engine = imports('engine.worker.ts');
    expect(engine.slice(0, 2)).toEqual(['./csp', './jitless']);
    expect(engine).toContain('@simulci/engine');
    expect(imports('layout.worker.ts')[0]).toBe('./csp');
  });

  it('say what the CSP refused as an error on the console', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const event = Object.assign(new Event('securitypolicyviolation'), {
      blockedURI: 'eval',
      effectiveDirective: 'script-src',
      sourceFile: 'https://x.test/assets/engine.worker-a1.js',
      lineNumber: 145,
    });
    dispatchEvent(event);
    expect(error).toHaveBeenCalledWith(
      'the CSP refused eval (script-src) at https://x.test/assets/engine.worker-a1.js:145',
    );
    const inline = { blockedURI: '', effectiveDirective: 'style-src', sourceFile: 'x.js', lineNumber: 1 };
    expect(describeViolation(inline as SecurityPolicyViolationEvent)).toBe(
      'the CSP refused an inline source (style-src) at x.js:1',
    );
  });

  it('build zod parsers without new Function', () => {
    expect(zodConfig().jitless).toBe(true);
  });
});

describe('CodeMirror under the CSP', () => {
  it('mounts its styles in a constructed sheet, never a <style> element', () => {
    const view = new EditorView({ parent: document.body, extensions: themeFor(false) });
    try {
      expect(document.querySelectorAll('style')).toHaveLength(0);
      const rules = document.adoptedStyleSheets.flatMap((sheet) => [...sheet.cssRules].map((r) => r.cssText));
      expect(rules.some((rule) => rule.includes('.cm-scroller'))).toBe(true);
    } finally {
      view.destroy();
    }
  });
});
