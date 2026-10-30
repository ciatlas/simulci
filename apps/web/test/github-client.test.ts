import { describe, expect, it } from 'vitest';
import type { FetchLike } from '@ciatlas/core/remote-fetch';
import { memoryCache, objectKey } from '../src/github/cache';
import { createRepoClient, failureSentence, rateSentence, revalidating } from '../src/github/client';
import { fetchAgain } from '../src/github/github';
import { commitOf, readAt, repoInfo } from '../src/github/repo';

/**
 * The GitHub source's reading (M4 synthesis § 5.5) against a fake API that answers as api.github.com does (the
 * shapes recorded from it on 2026-10-30): the cost cold and warm, the filter and the limits before any file is read,
 * the cache that keeps only what a public repository served, ETag revalidation, and the rate limit's sentence.
 */

const API = 'https://api.github.com';
const SHA = 'a3d3e9d828a704ecda3010cc034e6f31f80b02ff';
const GITHUB_TREE = '7b2e68800faf96e27cb8489ef0ba1ab4f2b2bad9';
const blob = (n: number): string => String(n).padStart(40, 'c');

interface Fake {
  fetch: FetchLike;
  /** Every request, as `accept path`. */
  log: string[];
  headers: Record<string, string>[];
}

const FILES: Record<string, { sha: string; text: string; size?: number }> = {
  '.github/workflows/ci.yml': { sha: blob(1), text: 'on: push\n' },
  '.github/workflows/release.yml': { sha: blob(2), text: '﻿on: release\r\n' },
  '.github/actions/setup/action.yml': { sha: blob(3), text: 'runs: { using: node20, main: x.js }\n' },
  '.github/simulci/tests/ci.test.yml': { sha: blob(4), text: 'workflow: ci.yml\n' },
  '.github/simulci/tests/__snapshots__/ci.test.snap.json': { sha: blob(5), text: '{}\n' },
  '.github/CODEOWNERS': { sha: blob(6), text: '* @octo\n' },
  '.github/workflows/huge.yml': { sha: blob(7), text: '', size: 3 * 1024 * 1024 },
};

/** The API of one repository, `octo/ship`, public unless said otherwise. */
function fakeApi({ private: hidden = false, truncated = false, rate = { remaining: 59 } } = {}): Fake {
  const log: string[] = [];
  const headers: Record<string, string>[] = [];
  const json = (body: unknown, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json', ...extra },
    });
  const fetch: FetchLike = (url, init) => {
    const { pathname, search } = new URL(url);
    const path = pathname + search;
    log.push(`${init.headers.accept} ${path}`);
    headers.push(init.headers);
    const limits = {
      'x-ratelimit-limit': '60',
      'x-ratelimit-remaining': String(rate.remaining),
      'x-ratelimit-reset': String(Date.UTC(2026, 9, 30, 14, 5) / 1000),
    };
    if (rate.remaining === 0)
      return Promise.resolve(
        new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: limits }),
      );
    const answer = route(path, init.headers);
    for (const [k, v] of Object.entries(limits)) answer.headers.set(k, v);
    return Promise.resolve(answer);
  };
  const repo = (h: Record<string, string>): Response =>
    h['if-none-match'] === 'W/"repo"'
      ? new Response(null, { status: 304, headers: { etag: 'W/"repo"' } })
      : json(
          { name: 'Ship', owner: { login: 'Octo' }, default_branch: 'trunk', private: hidden },
          { etag: 'W/"repo"' },
        );
  const routes: Record<string, (h: Record<string, string>) => Response> = {
    '/repos/octo/ship': repo,
    '/repos/Octo/Ship/commits/trunk': () =>
      new Response(SHA, {
        status: 200,
        headers: { 'content-type': 'application/vnd.github.sha', etag: `"${SHA}"` },
      }),
    '/repos/Octo/Ship/commits/nope': () => new Response('{}', { status: 422 }),
    [`/repos/Octo/Ship/git/trees/${SHA}`]: () =>
      json({
        sha: SHA,
        truncated: false,
        tree: [
          { path: '.github', mode: '040000', type: 'tree', sha: GITHUB_TREE },
          { path: 'action.yml', mode: '100644', type: 'blob', sha: blob(8), size: 9 },
          { path: 'README.md', mode: '100644', type: 'blob', sha: blob(9), size: 9 },
          { path: 'Action.yml', mode: '120000', type: 'blob', sha: blob(10), size: 9 },
        ],
      }),
    [`/repos/Octo/Ship/git/trees/${GITHUB_TREE}?recursive=1`]: () =>
      json({
        sha: GITHUB_TREE,
        truncated,
        tree: [
          { path: 'workflows', mode: '040000', type: 'tree', sha: blob(20) },
          ...Object.entries(FILES).map(([p, f]) => ({
            path: p.slice('.github/'.length),
            mode: '100644',
            type: 'blob',
            sha: f.sha,
            size: f.size ?? new TextEncoder().encode(f.text).byteLength,
          })),
        ],
      }),
  };
  const route = (path: string, h: Record<string, string>): Response =>
    routes[path]?.(h) ?? blobAt(path, h) ?? new Response('{"message":"Not Found"}', { status: 404 });
  return { fetch, log, headers };
}

/** A file's bytes, as `Accept: application/vnd.github.raw+json` asks for them. */
function blobAt(path: string, h: Record<string, string>): Response | undefined {
  const sha = /^\/repos\/Octo\/Ship\/git\/blobs\/(\w+)$/.exec(path)?.[1];
  const text = sha === blob(8) ? 'name: x\n' : Object.values(FILES).find((f) => f.sha === sha)?.text;
  if (text === undefined || h.accept !== 'application/vnd.github.raw+json') return undefined;
  return new Response(new TextEncoder().encode(text), {
    status: 200,
    headers: { 'content-type': 'text/plain' },
  });
}

async function open(fake: Fake, cache = memoryCache()) {
  const client = createRepoClient({ apiUrl: API, fetch: fake.fetch });
  const info = await repoInfo(client, { owner: 'octo', repo: 'ship' });
  const sha = await commitOf(client, info, info.defaultBranch);
  const walked = await readAt({ client, cache, host: 'github.com' }, info, sha);
  return { client, info, sha, walked, cache };
}

describe('reading a public repository', () => {
  it('costs 4 + N cold: the repository, the commit, two trees and each file the page keeps', async () => {
    const fake = fakeApi();
    const { client, info, sha, walked } = await open(fake);
    expect(info).toEqual({ owner: 'Octo', repo: 'Ship', defaultBranch: 'trunk', private: false });
    expect(sha).toBe(SHA);
    expect(Object.keys(walked.files).sort()).toEqual([
      '.github/actions/setup/action.yml',
      '.github/simulci/tests/__snapshots__/ci.test.snap.json',
      '.github/simulci/tests/ci.test.yml',
      '.github/workflows/ci.yml',
      '.github/workflows/release.yml',
      'action.yml',
    ]);
    expect(walked.skipped).toEqual([{ path: '.github/workflows/huge.yml', bytes: 3 * 1024 * 1024 }]);
    // Byte-exact: the BOM and the line endings are what reading found.
    expect(walked.files['.github/workflows/release.yml']).toBe('on: release\r\n');
    expect(walked.meta['.github/workflows/release.yml']).toEqual({ bom: true, eol: 'crlf', utf8: true });
    expect(client.requests()).toBe(4 + 6);
    expect(fake.log.slice(0, 4)).toEqual([
      'application/vnd.github+json /repos/octo/ship',
      'application/vnd.github.sha /repos/Octo/Ship/commits/trunk',
      `application/vnd.github+json /repos/Octo/Ship/git/trees/${SHA}`,
      `application/vnd.github+json /repos/Octo/Ship/git/trees/${GITHUB_TREE}?recursive=1`,
    ]);
    // Anonymous: no token, nor any header that could carry one.
    expect(fake.headers.every((h) => !('authorization' in h))).toBe(true);
  });

  it('costs 2 when the ref has not moved: the trees and the files come from the cache', async () => {
    const fake = fakeApi();
    const { cache } = await open(fake);
    const again = fakeApi();
    const { client, walked } = await open(again, cache);
    expect(client.requests()).toBe(2);
    expect(Object.keys(walked.files)).toHaveLength(6);
  });

  it('keeps nothing a private repository served', async () => {
    const cache = memoryCache();
    await open(fakeApi({ private: true }), cache);
    expect(await cache.get(objectKey('github.com', 'blob', blob(1)))).toBeUndefined();
    expect(await cache.get(objectKey('github.com', 'tree', SHA))).toBeUndefined();
    const again = fakeApi({ private: true });
    expect((await open(again, cache)).client.requests()).toBe(10);
  });

  it('refuses a .github tree GitHub truncated, before reading a file', async () => {
    const fake = fakeApi({ truncated: true });
    await expect(open(fake)).rejects.toThrow(
      "This repository's .github directory is too large to read (GitHub truncated its tree).",
    );
    expect(fake.log).toHaveLength(4);
  });

  it('says what it cannot find', async () => {
    const fake = fakeApi();
    const client = createRepoClient({ apiUrl: API, fetch: fake.fetch });
    await expect(repoInfo(client, { owner: 'octo', repo: 'boat' })).rejects.toThrow(
      'octo/boat is not a public repository on GitHub',
    );
    const info = await repoInfo(client, { owner: 'octo', repo: 'ship' });
    await expect(commitOf(client, info, 'nope')).rejects.toThrow(
      'Octo/Ship has no branch, tag or commit named nope',
    );
  });

  it('says when the rate limit is used up, and when it resets', async () => {
    const fake = fakeApi({ rate: { remaining: 0 } });
    const client = createRepoClient({ apiUrl: API, fetch: fake.fetch });
    const failure = await repoInfo(client, { owner: 'octo', repo: 'ship' }).catch((e: unknown) => e);
    const reset = new Date(Date.UTC(2026, 9, 30, 14, 5)).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    expect(failureSentence(failure, client.api.rateLimit())).toBe(
      `GitHub allows 60 requests an hour without signing in; this browser has used them. They reset at ${reset}.`,
    );
    expect(rateSentence(client.api.rateLimit())).toBe('0 of 60 requests left this hour');
    expect(rateSentence({})).toBeUndefined();
    expect(failureSentence(new Error('no answer'), {})).toBe('no answer');
  });
});

describe('revalidation', () => {
  it('asks again with the ETag, takes the body kept on a 304, and leaves git objects and the HTTP cache out', async () => {
    const seen: { url: string; headers: Record<string, string>; cache?: string }[] = [];
    const inner: FetchLike = (url, init) => {
      seen.push({ url, headers: init.headers, cache: (init as RequestInit).cache });
      if (init.headers['if-none-match'] === '"v1"')
        return Promise.resolve(
          new Response(null, { status: 304, headers: { etag: '"v1"', 'x-ratelimit-remaining': '7' } }),
        );
      return Promise.resolve(
        new Response('{"a":1}', {
          status: 200,
          headers: { etag: '"v1"', 'content-type': 'application/json' },
        }),
      );
    };
    const fetch = revalidating(inner);
    const signal = new AbortController().signal;
    const ask = (url: string) => fetch(url, { headers: { accept: 'application/vnd.github+json' }, signal });
    expect(await (await ask(`${API}/repos/o/r`)).text()).toBe('{"a":1}');
    const second = await ask(`${API}/repos/o/r`);
    expect([second.status, await second.text(), second.headers.get('x-ratelimit-remaining')]).toEqual([
      200,
      '{"a":1}',
      '7',
    ]);
    expect(second.headers.get('content-type')).toBe('application/json');
    await ask(`${API}/repos/o/r/git/trees/abc`);
    await ask(`${API}/repos/o/r/git/trees/abc`);
    expect(seen.map((s) => [new URL(s.url).pathname, s.headers['if-none-match'], s.cache])).toEqual([
      ['/repos/o/r', undefined, 'no-store'],
      ['/repos/o/r', '"v1"', 'no-store'],
      ['/repos/o/r/git/trees/abc', undefined, 'no-store'],
      ['/repos/o/r/git/trees/abc', undefined, 'no-store'],
    ]);
  });

  it('revalidates across reads that share what they kept, as Fetch again does', async () => {
    const fake = fakeApi();
    const kept = new Map();
    await repoInfo(createRepoClient({ apiUrl: API, fetch: fake.fetch, kept }), {
      owner: 'octo',
      repo: 'ship',
    });
    const again = createRepoClient({ apiUrl: API, fetch: fake.fetch, kept });
    expect(await repoInfo(again, { owner: 'octo', repo: 'ship' })).toMatchObject({ defaultBranch: 'trunk' });
    expect(fake.headers.map((h) => h['if-none-match'])).toEqual([undefined, 'W/"repo"']);
  });

  it('refuses to fetch a source again from a host it was not read from', async () => {
    const source = {
      kind: 'github' as const,
      host: 'ghe.example',
      owner: 'octo',
      repo: 'ship',
      ref: 'main',
      sha: SHA,
      defaultBranch: 'main',
      private: false,
      readAt: 0,
    };
    await expect(fetchAgain(source)).rejects.toThrow(
      'octo/ship was read from ghe.example; this page reads github.com. Open it again.',
    );
  });

  it('keeps 64 answers, the least recently used going first', async () => {
    const seen: (string | undefined)[] = [];
    const fetch = revalidating(
      (url, init) => {
        seen.push(init.headers['if-none-match']);
        return Promise.resolve(new Response('x', { status: 200, headers: { etag: `"${url}"` } }));
      },
      new Map(),
      2,
    );
    const signal = new AbortController().signal;
    const ask = (n: number) => fetch(`${API}/repos/o/r${n}`, { headers: { accept: 'a' }, signal });
    await ask(1);
    await ask(2);
    await ask(3);
    seen.length = 0;
    await ask(1);
    await ask(3);
    expect(seen).toEqual([undefined, `"${API}/repos/o/r3"`]);
  });
});

describe('the content cache', () => {
  it('keeps only what a repository seen public served, and lets the oldest go past its size', async () => {
    const cache = memoryCache(10);
    const bytes = (n: number) => new Uint8Array(n).fill(n);
    await cache.set('a', bytes(4), false);
    expect(await cache.get('a')).toBeUndefined();
    await cache.set('a', bytes(4), true);
    await cache.set('b', bytes(4), true);
    await cache.set('c', bytes(4), true);
    expect([await cache.get('a'), await cache.get('b'), await cache.get('c')].map((b) => b?.length)).toEqual([
      undefined,
      4,
      4,
    ]);
    await cache.set('d', bytes(11), true);
    expect(await cache.get('d')).toBeUndefined();
    expect(objectKey('GitHub.com', 'tree-r', 'ABC')).toBe('github.com/tree-r/abc');
  });
});
