import { z } from 'zod';
import type { HostMode } from '../../web/headers';

/**
 * The server's configuration, read from the environment once at boot: the only reader of `process.env`. A bad value
 * stops the boot with the variable's name. This version serves the app alone (static mode); sign-in with a GitHub App
 * comes later, and until it does the App's variables are refused rather than ignored.
 */

/** What /config.js tells the page, in the shape apps/web/src/app/config.ts reads. */
export interface PageConfig {
  mode: 'static';
  githubUrl: string;
  apiUrl?: string;
}

export interface Config {
  port: number;
  /** The row of the header table (apps/web/headers.ts) every response gets. */
  mode: HostMode;
  page: PageConfig;
}

/** A variable the environment set to something unusable, named in the message. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** An absolute https URL, or plain http on this machine; never with credentials, a query or a fragment. */
const webUrl = z.string().transform((value, ctx) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'is not an absolute URL' });
    return z.NEVER;
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname)))
    ctx.addIssue({ code: 'custom', message: 'must be https (plain http only on localhost)' });
  if (url.username || url.password || url.search || url.hash)
    ctx.addIssue({ code: 'custom', message: 'must have no credentials, query or fragment' });
  return url;
});

const later = z
  .never({ error: 'sign-in with a GitHub App is not in this version: unset it to serve the app alone' })
  .optional();

const NOT_A_PORT = { error: 'must be a port number, 1 to 65535' };

const EnvSchema = z.object({
  PORT: z.coerce.number(NOT_A_PORT).int(NOT_A_PORT).min(1, NOT_A_PORT).max(65_535, NOT_A_PORT).default(8080),
  PUBLIC_URL: webUrl.optional(),
  GITHUB_URL: webUrl
    .refine((url) => url.pathname === '/', 'must be an origin, with no path')
    .prefault('https://github.com'),
  GITHUB_API_URL: webUrl.optional(),
  GITHUB_APP_CLIENT_ID: later,
  GITHUB_APP_CLIENT_SECRET: later,
  GITHUB_APP_SLUG: later,
});

/** Reads the configuration; an empty variable counts as unset, as `docker run -e NAME=` leaves it. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const set = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ''),
  );
  const parsed = EnvSchema.safeParse(set);
  if (!parsed.success)
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('\n'),
    );
  const { PORT, PUBLIC_URL, GITHUB_URL, GITHUB_API_URL } = parsed.data;
  return {
    port: PORT,
    mode: {
      serve: 'static',
      github: GITHUB_URL.origin === 'https://github.com' ? 'github.com' : 'ghes',
      host: 'image',
      https: PUBLIC_URL?.protocol === 'https:',
    },
    page: {
      mode: 'static',
      githubUrl: GITHUB_URL.origin,
      ...(GITHUB_API_URL ? { apiUrl: GITHUB_API_URL.href.replace(/\/+$/, '') } : {}),
    },
  };
}
