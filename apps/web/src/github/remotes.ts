import {
  apiHost,
  fetchRemoteSourceAt,
  type FetchLike,
  parseRemoteRef,
  RemoteFetchError,
  type RemoteFetchOptions,
  type RemoteRef,
  type RemoteSourceCache,
  type RemoteSourceKey,
  resolveRemoteCommit,
} from '@ciatlas/core/remote-fetch';
import { readHostConfig } from '../app/config';
import type { RemoteNeed, RemotePoolFailure, RemotePoolSource } from '../worker/protocol';
import { type GitHubCache, openGitHubCache } from './cache';
import { pageFetch } from './client';

/**
 * Reading the remote workflows and actions a plan needs (M4 synthesis § 5.3), from the page's `github-*` chunk through
 * core's fetcher, anonymously, from the host's API (`/config.js`'s `apiUrl`): each at the commit its pin names (with
 * the digest the lockfile records), or its ref resolved live first. The worker chose the pins; this only reads. What
 * was read is kept in `simulci-cache`'s `remotes` store: an anonymous read is of a public repository.
 */

export interface RemotesRead {
  sources: RemotePoolSource[];
  failed: RemotePoolFailure[];
}

export interface RemotesOptions {
  fetch?: FetchLike;
  cache?: RemoteSourceCache;
  signal?: AbortSignal;
}

/** Remotes read at a time, as core reads a closure. */
const CONCURRENCY = 8;

let kept: RemoteSourceCache | undefined;

/** A file at a commit, in the cache, by its address (owner and repository lower-case, the file's path as it is). */
export function remoteCacheOf(cache: GitHubCache): RemoteSourceCache {
  const keyOf = (k: RemoteSourceKey): string =>
    `${[k.host, k.owner, k.repo, k.sha].join('/').toLowerCase()}/${k.file}`;
  // Read anonymously: GitHub serves only a public repository's files without a token.
  return { get: (k) => cache.get(keyOf(k)), set: (k, bytes) => cache.set(keyOf(k), bytes, true) };
}

/** Each need read, or why not; a need never throws. */
export async function readRemotes(
  needs: readonly RemoteNeed[],
  options: RemotesOptions = {},
): Promise<RemotesRead> {
  const { apiUrl } = readHostConfig();
  const opts: RemoteFetchOptions = {
    api: { apiUrl },
    fetch: options.fetch ?? pageFetch,
    cache: options.cache ?? (kept ??= remoteCacheOf(openGitHubCache('remotes'))),
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const read: RemotesRead = { sources: [], failed: [] };
  const queue = [...needs];
  const next = async (): Promise<void> => {
    for (let need = queue.shift(); need; need = queue.shift()) {
      const got = await readOne(need, opts, apiHost(apiUrl));
      if ('text' in got) read.sources.push(got);
      else read.failed.push(got);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, next));
  return read;
}

async function readOne(
  need: RemoteNeed,
  opts: RemoteFetchOptions,
  host: string,
): Promise<RemotePoolSource | RemotePoolFailure> {
  const ref = parseRemoteRef(need.ref, need.kind);
  if (!ref) return failureOf(need, 'other', `${need.ref} is not a remote reference`);
  try {
    return await sourceOf(need, ref, opts, host);
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    const kind = e instanceof RemoteFetchError ? e.kind : 'other';
    return failureOf(need, kind, e instanceof Error ? e.message : String(e));
  }
}

/** The need's file at its pin's commit, or at the commit its ref resolves to now, with the digest checked. */
async function sourceOf(
  need: RemoteNeed,
  ref: RemoteRef,
  opts: RemoteFetchOptions,
  host: string,
): Promise<RemotePoolSource> {
  const sha = need.pin?.sha ?? (await resolveRemoteCommit(ref, opts));
  const digest = need.digest === undefined ? {} : { expectDigest: need.digest };
  const source = await fetchRemoteSourceAt(ref, sha, { ...opts, ...digest });
  return {
    ref: need.ref,
    kind: need.kind,
    sha: source.sha,
    text: source.text,
    pinned: need.pin?.pinned ?? 'resolved',
    digest: source.digest,
    ...(source.host === host ? {} : { host: source.host }),
  };
}

/** A need not read, at the commit it was asked for: none when its ref was to be resolved, whichever step failed. */
const failureOf = (
  need: RemoteNeed,
  failure: RemotePoolFailure['failure'],
  message: string,
): RemotePoolFailure => ({
  ref: need.ref,
  kind: need.kind,
  failure,
  message,
  ...(need.pin ? { sha: need.pin.sha } : {}),
});
