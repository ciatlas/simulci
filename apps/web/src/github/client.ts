import {
  createGitHubClient,
  type FetchLike,
  type GitHubClient,
  RemoteFetchError,
} from '@ciatlas/core/remote-fetch';
import { LIMITS } from '../input/limits';
import { clockOf } from '../state/snapshot';

/**
 * The anonymous REST client of a GitHub source (M4 synthesis § 5.5), in the page's `github-*` chunk: core's client
 * (`@ciatlas/core/remote-fetch`: retries, failure kinds, the rate limit each response reports) over a `fetch` that
 * revalidates what it read before. A response with an ETag is kept in memory, and the next request for it says
 * `If-None-Match`: a 304 hands back the body kept, so a ref that has not moved costs no download. Without a token
 * GitHub still counts a 304 (probed 2026-10-30), so revalidation saves bytes, not requests; the browser's own HTTP
 * cache is left out (`no-store`), so Fetch again never sees an answer up to a minute old. Nothing here holds a token.
 */

/** A response kept for revalidation: its ETag, its body, its media type and its pages' `Link`. */
export interface Kept {
  etag: string;
  body: Uint8Array;
  type: string | null;
  /** A 304 need not repeat it, and a list's next page is named there. */
  link?: string;
}

/** How many responses are kept for revalidation; the oldest goes first. */
const KEPT = 64;

/**
 * Git objects (`/git/trees/{sha}`, `/git/blobs/{sha}`) never change: the source's cache keeps them, by SHA, so only the
 * answers that move are revalidated (the repository, a ref's commit). Their bodies are small.
 */
const moves = (url: string): boolean => !new URL(url).pathname.includes('/git/');

const noStore = (init: Parameters<FetchLike>[1]): Parameters<FetchLike>[1] =>
  ({ ...init, cache: 'no-store' }) as Parameters<FetchLike>[1];

/** The body kept, answered as the 200 it stands for, with the 304's headers (its rate limit among them). */
function fromKept(res: Response, kept: Kept): Response {
  const headers = new Headers(res.headers);
  if (kept.type) headers.set('content-type', kept.type);
  if (kept.link && !headers.has('link')) headers.set('link', kept.link);
  headers.delete('content-length');
  return new Response(kept.body.slice(), { status: 200, headers });
}

/** The answers kept for revalidation, by media type and URL: one map for the page's life, shared by every read. */
export type Revalidation = Map<string, Kept>;

/** The largest body kept for revalidation; a larger answer is left to core's limits, unkept. */
const KEPT_BYTES = 256 * 1024;

/** A `fetch` that revalidates: `If-None-Match` for a URL it read with an ETag, the body kept on a 304. */
export function revalidating(fetch: FetchLike, kept: Revalidation = new Map(), max = KEPT): FetchLike {
  const keep = (key: string, entry: Kept): void => {
    kept.delete(key);
    kept.set(key, entry);
    for (const oldest of kept.keys()) {
      if (kept.size <= max) break;
      kept.delete(oldest);
    }
  };
  return async (url, init) => {
    if (!moves(url)) return fetch(url, noStore(init));
    const key = `${init.headers.accept ?? ''}\n${url}`;
    const before = kept.get(key);
    const headers = before ? { ...init.headers, 'if-none-match': before.etag } : init.headers;
    const res = await fetch(url, noStore({ ...init, headers }));
    if (res.status === 304 && before) {
      keep(key, before);
      return fromKept(res, before);
    }
    const etag = keepable(res);
    if (!etag) return res;
    const body = new Uint8Array(await res.arrayBuffer());
    const link = res.headers.get('link');
    keep(key, { etag, body, type: res.headers.get('content-type'), ...(link ? { link } : {}) });
    return new Response(body.slice(), { status: res.status, headers: res.headers });
  };
}

/** The ETag of an answer worth keeping: a success that has one, small enough. */
function keepable(res: Response): string | undefined {
  const etag = res.headers.get('etag');
  if (!res.ok || !etag) return undefined;
  return Number(res.headers.get('content-length') ?? 0) > KEPT_BYTES ? undefined : etag;
}

/** A client of the API, and the requests it sent. */
export interface RepoClient {
  api: GitHubClient;
  /** Requests sent so far (a revalidated one counts: GitHub counts it). */
  requests(): number;
}

export interface ClientOptions {
  apiUrl: string;
  fetch?: FetchLike;
  signal?: AbortSignal;
  /** The answers kept for revalidation across clients; by default this client's own. */
  kept?: Revalidation;
}

/** The page's own `fetch`, called unbound (a page's `window.fetch` throws when called as a method of another object). */
const pageFetch: FetchLike = (url, init) => globalThis.fetch(url, init);

export function createRepoClient({ apiUrl, fetch = pageFetch, signal, kept }: ClientOptions): RepoClient {
  let requests = 0;
  const counted: FetchLike = (url, init) => {
    requests++;
    return fetch(url, init);
  };
  const api = createGitHubClient({
    api: { apiUrl },
    fetch: revalidating(counted, kept),
    ...(signal ? { signal } : {}),
    // The page's per-file limit; a tree of `.github` can be larger than core's 1 MB default too.
    maxFileBytes: LIMITS.fileBytes,
  });
  return { api, requests: () => requests };
}

/** The rate limit as the last response reported it. */
export type RateLimit = ReturnType<GitHubClient['rateLimit']>;

/**
 * Why reading from GitHub failed, as the page says it: a used-up rate limit says how many requests an hour GitHub
 * allows without signing in and when they come back; anything else, what core's client said.
 */
export function failureSentence(e: unknown, rate: RateLimit): string {
  if (e instanceof RemoteFetchError && e.kind === 'rate-limit' && rate.remaining === 0) {
    const reset = rate.resetAt === undefined ? '' : ` They reset at ${clockOf(rate.resetAt)}.`;
    return `GitHub allows ${rate.limit ?? 60} requests an hour without signing in; this browser has used them.${reset}`;
  }
  return e instanceof Error ? e.message : String(e);
}

/** "41 of 60 requests left this hour", once a response said so. */
export function rateSentence(rate: RateLimit): string | undefined {
  if (rate.remaining === undefined || rate.limit === undefined) return undefined;
  return `${rate.remaining} of ${rate.limit} requests left this hour`;
}
