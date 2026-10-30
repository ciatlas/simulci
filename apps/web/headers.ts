/**
 * The response headers of every host that serves the app, by path and mode: Vercel (vercel.ts), `vite preview`
 * (vercel-headers.ts) and the server. A host serves the files alone (`static`) or runs the server with a GitHub App
 * (`server`), and reads github.com or a GitHub Enterprise Server; only the CSP's `connect-src` and the server's own
 * paths differ between modes. Every `source` is written as a plain regular expression (`/assets/(.*)`, no `:name`
 * parameters), so Vercel and a regular expression read it alike, anchored at both ends. Nothing here reads a file or
 * the environment, so any host can import it.
 */

export interface HostMode {
  /** `static`: the files alone (Vercel, `vite preview`, the image with no App). `server`: the image with a GitHub App. */
  serve: 'static' | 'server';
  /** The GitHub the app reads: github.com, or a GitHub Enterprise Server. */
  github: 'github.com' | 'ghes';
}

/** The mode Vercel serves, and `vite preview` with it. */
export const VERCEL: HostMode = { serve: 'static', github: 'github.com' };

export interface HeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}

export interface Rewrite {
  source: string;
  destination: string;
}

/** Every path but the hashed assets: a deep link is the page, a missing chunk is not. */
const OUTSIDE_ASSETS = '/((?!assets/).*)';

/**
 * Where the page fetches from: github.com's API for a public repository (the page's `github-*` chunk, never a worker);
 * nothing on a static host that reads a GitHub Enterprise Server, which hides the GitHub source; on a server, its own
 * proxy too.
 */
const CONNECT: Record<HostMode['serve'], Record<HostMode['github'], string>> = {
  static: { 'github.com': 'https://api.github.com', ghes: "'none'" },
  server: { 'github.com': "'self' https://api.github.com", ghes: "'self'" },
};

/** The Content-Security-Policy, one directive per entry, in the order it is sent. */
export function cspFor(mode: HostMode): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "worker-src 'self'",
    `connect-src ${CONNECT[mode.serve][mode.github]}`,
    "img-src 'self' data:",
    "style-src 'self'",
    "font-src 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** The table: every rule whose source matches a path applies, in order, a later key winning. */
export function headerRules(mode: HostMode): HeaderRule[] {
  const rules: HeaderRule[] = [
    {
      source: '/(.*)',
      headers: [
        { key: 'Content-Security-Policy', value: cspFor(mode) },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        // No window the page opens (a link to github.com) shares its browsing context group.
        { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
      ],
    },
    {
      source: '/assets/(.*)',
      headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
    },
    {
      source: OUTSIDE_ASSETS,
      headers: [{ key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' }],
    },
  ];
  if (mode.serve === 'server')
    rules.push({
      source: '/(api|auth)/(.*)',
      headers: [
        { key: 'Cache-Control', value: 'no-store' },
        { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
      ],
    });
  return rules;
}

/** The page answers every path outside the assets that no file serves. */
export const REWRITES: Rewrite[] = [{ source: OUTSIDE_ASSETS, destination: '/index.html' }];

const matches = (source: string, pathname: string): boolean => new RegExp(`^${source}$`).test(pathname);

/** The headers a path gets in a mode, keys in lower case. */
export function headersFor(pathname: string, mode: HostMode): Map<string, string> {
  const out = new Map<string, string>();
  for (const rule of headerRules(mode)) {
    if (!matches(rule.source, pathname)) continue;
    for (const { key, value } of rule.headers) out.set(key.toLowerCase(), value);
  }
  return out;
}

/** A path answered with 404: no file serves it and no rewrite takes it (a missing `/assets/` chunk). */
export const isNotFound = (pathname: string, fileExists: boolean): boolean =>
  !fileExists && !REWRITES.some((rule) => matches(rule.source, pathname));
