/** Where the page runs: a static host (Vercel, `vite preview`, the image without a GitHub App) or the image's server. */
export type HostMode = 'static' | 'server';

/**
 * What the host tells the page about itself, through `globalThis.simulciConfig`, which /config.js sets before the app
 * boots: public/config.js on a static host, the image's own on the image. One build serves every host, and nothing in
 * it is a secret.
 */
export interface HostConfig {
  mode: HostMode;
  /** The GitHub the host works with, as an origin: github.com or a GHES instance. Links to GitHub start here. */
  githubUrl: string;
  /** GitHub's REST API for anonymous reads, with no trailing slash: api.github.com, or `<githubUrl>/api/v3` on GHES. */
  apiUrl: string;
  /** The server's GitHub App, for its install link. A server that offers sign-in names one. */
  appSlug?: string;
  /** Whether the server offers "Sign in with GitHub"; never on a static host. */
  signIn: boolean;
}

const DOTCOM = 'https://github.com';

/** The static host's config, and the page's config whenever /config.js is missing or malformed. */
export const STATIC_CONFIG: HostConfig = {
  mode: 'static',
  githubUrl: DOTCOM,
  apiUrl: 'https://api.github.com',
  signIn: false,
};

/** Reads the config /config.js left on the page; anything missing or malformed is a static host on github.com. */
export function readHostConfig(scope: object = globalThis): HostConfig {
  try {
    return parseHostConfig((scope as { simulciConfig?: unknown }).simulciConfig) ?? STATIC_CONFIG;
  } catch {
    return STATIC_CONFIG;
  }
}

function parseHostConfig(raw: unknown): HostConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const fields = raw as Record<string, unknown>;
  const { mode } = fields;
  if (mode !== 'static' && mode !== 'server') return undefined;
  const urls = parseUrls(fields.githubUrl, fields.apiUrl);
  const signIn = parseSignIn(mode, fields.appSlug, fields.signIn);
  return urls && signIn && { mode, ...urls, ...signIn };
}

/** GitHub's origin, and its API's base, which a GHES origin implies when the host leaves it out. */
function parseUrls(
  githubUrl: unknown,
  apiUrl: unknown,
): Pick<HostConfig, 'githubUrl' | 'apiUrl'> | undefined {
  const github = urlOf(githubUrl);
  if (!github || github.pathname !== '/') return undefined;
  if (apiUrl === undefined) return { githubUrl: github.origin, apiUrl: defaultApiUrl(github.origin) };
  const api = urlOf(apiUrl);
  return api && { githubUrl: github.origin, apiUrl: api.origin + api.pathname.replace(/\/+$/, '') };
}

const defaultApiUrl = (origin: string): string =>
  origin === DOTCOM ? STATIC_CONFIG.apiUrl : `${origin}/api/v3`;

/** Loopback hosts, where a server under test may serve plain http. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** An absolute https URL (http on loopback only), with no credentials, query or fragment. */
function urlOf(value: unknown): URL | undefined {
  if (typeof value !== 'string' || !URL.canParse(value)) return undefined;
  const url = new URL(value);
  return secure(url) && url.username + url.password + url.search + url.hash === '' ? url : undefined;
}

const secure = (url: URL): boolean =>
  url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));

/** A GitHub App's slug: lower-case letters, digits and hyphens. */
const isSlug = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z\d][a-z\d-]{0,99}$/.test(value);

const isFlag = (value: unknown): value is boolean => typeof value === 'boolean';

/** A field the host may leave out, or else one `is` accepts. */
const optional = <T>(value: unknown, is: (value: unknown) => value is T): value is T | undefined =>
  value === undefined || is(value);

/** Sign-in needs the server, and the App it signs in with. */
function parseSignIn(
  mode: HostMode,
  appSlug: unknown,
  signIn: unknown,
): Pick<HostConfig, 'appSlug' | 'signIn'> | undefined {
  if (!optional(appSlug, isSlug) || !optional(signIn, isFlag)) return undefined;
  const on = signIn === true;
  if (on && (mode !== 'server' || appSlug === undefined)) return undefined;
  return appSlug === undefined ? { signIn: on } : { appSlug, signIn: on };
}
