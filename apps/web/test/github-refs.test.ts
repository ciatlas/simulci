import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '@ciatlas/core/remote-fetch';
import { createRepoClient, revalidating } from '../src/github/client';
import { listRefsOf, readRepository } from '../src/github/read';
import {
  highlighted,
  isFullSha,
  listRefs,
  MAX_PAGES,
  moreNote,
  type Ref,
  type RefLists,
  refChoice,
  refOptions,
  refProblem,
  stepped,
  wholeRef,
} from '../src/github/refs';
import { parseRepoInput } from '../src/github/target';
import { isTarget, repoAt } from '../src/lib/repo-words';

/**
 * The ref picker's refs (M4 synthesis § 5.6): the branches and tags GitHub lists, page by page up to the cap, what
 * Open reads for what is typed or picked (a SHA, a name git refuses, a name that is both a branch and a tag), a
 * link's path resolved whole, and what a failed list says.
 */

const API = 'https://api.github.com';
const SHA = '3f2a9c1'.padEnd(40, 'a');

/** `/repos/octo/ship/{branches,tags}` with `count` of each, `per_page` at a time, as GitHub pages them. */
function fakeLists(count: { branches: number; tags: number }, rate = { remaining: 59 }) {
  const log: string[] = [];
  const fetch: FetchLike = (url) => {
    const { pathname, searchParams, search } = new URL(url);
    log.push(pathname + search);
    const limits = {
      'x-ratelimit-limit': '60',
      'x-ratelimit-remaining': String(rate.remaining),
      'x-ratelimit-reset': String(Date.UTC(2026, 9, 30, 14, 5) / 1000),
    };
    if (rate.remaining === 0)
      return Promise.resolve(
        new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: limits }),
      );
    const kind = /^\/repos\/octo\/ship\/(branches|tags)$/.exec(pathname)?.[1] as
      | 'branches'
      | 'tags'
      | undefined;
    if (!kind)
      return Promise.resolve(new Response('{"message":"Not Found"}', { status: 404, headers: limits }));
    const per = Number(searchParams.get('per_page') ?? 30);
    const page = Number(searchParams.get('page') ?? 1);
    const names = Array.from({ length: count[kind] }, (_, i) => `${kind === 'tags' ? 'v' : 'b'}${i}`);
    const body = names.slice((page - 1) * per, page * per).map((name) => ({ name, commit: { sha: SHA } }));
    const last = Math.ceil(names.length / per);
    const link: Record<string, string> =
      page < last
        ? { link: `<${API}${pathname}?per_page=${per}&page=${page + 1}>; rel="next", <x>; rel="last"` }
        : {};
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json', ...limits, ...link },
      }),
    );
  };
  return { fetch, log };
}

const ref = (name: string, kind: Ref['kind']): Ref => ({ name, kind, sha: SHA });
const lists = (branches: string[], tags: string[], more = { branches: false, tags: false }): RefLists => ({
  branches: { refs: branches.map((n) => ref(n, 'branch')), more: more.branches },
  tags: { refs: tags.map((n) => ref(n, 'tag')), more: more.tags },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the lists of branches and tags', () => {
  it('asks for 100 a page and stops at the last page', async () => {
    const fake = fakeLists({ branches: 130, tags: 3 });
    const client = createRepoClient({ apiUrl: API, fetch: fake.fetch });
    const branches = await listRefs(client, { owner: 'octo', repo: 'ship' }, 'branch');
    expect(branches.refs).toHaveLength(130);
    expect(branches.more).toBe(false);
    expect(branches.refs[0]).toEqual({ name: 'b0', kind: 'branch', sha: SHA });
    const tags = await listRefs(client, { owner: 'octo', repo: 'ship' }, 'tag');
    expect(tags).toEqual({ refs: ['v0', 'v1', 'v2'].map((n) => ref(n, 'tag')), more: false });
    expect(fake.log).toEqual([
      '/repos/octo/ship/branches?per_page=100&page=1',
      '/repos/octo/ship/branches?per_page=100&page=2',
      '/repos/octo/ship/tags?per_page=100&page=1',
    ]);
  });

  it(`reads at most ${MAX_PAGES} pages of each, and says GitHub has more`, async () => {
    const fake = fakeLists({ branches: 450, tags: 250 });
    const client = createRepoClient({ apiUrl: API, fetch: fake.fetch });
    const branches = await listRefs(client, { owner: 'octo', repo: 'ship' }, 'branch');
    expect(branches.refs).toHaveLength(200);
    expect(branches.more).toBe(true);
    expect(fake.log).toHaveLength(MAX_PAGES);
    expect(moreNote({ branches, tags: { refs: [], more: false } })).toBe(
      'GitHub has more branches than the first 200 listed: type the name of another.',
    );
    expect(moreNote(lists([], [], { branches: true, tags: true }))).toBe(
      'GitHub has more branches and tags than the first 200 listed: type the name of another.',
    );
    expect(moreNote(lists(['main'], ['v1']))).toBeUndefined();
  });

  it('encodes the names in the path', async () => {
    const log: string[] = [];
    const fetch: FetchLike = (url) => {
      log.push(new URL(url).pathname);
      return Promise.resolve(
        new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    };
    const client = createRepoClient({ apiUrl: API, fetch });
    await listRefs(client, { owner: 'octo', repo: 'a#b?c' }, 'tag');
    expect(log).toEqual(['/repos/octo/a%23b%3Fc/tags']);
  });

  it('says what it could not list, and when the rate limit is spent', async () => {
    const client = createRepoClient({ apiUrl: API, fetch: fakeLists({ branches: 1, tags: 1 }).fetch });
    await expect(listRefs(client, { owner: 'octo', repo: 'boat' }, 'branch')).rejects.toThrow(
      'GitHub did not list the branches of octo/boat',
    );

    vi.stubGlobal('fetch', fakeLists({ branches: 1, tags: 1 }, { remaining: 0 }).fetch);
    const reset = new Date(Date.UTC(2026, 9, 30, 14, 5)).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    await expect(listRefsOf({ owner: 'octo', repo: 'ship' })).rejects.toThrow(
      `GitHub allows 60 requests an hour without signing in; this browser has used them. They reset at ${reset}.`,
    );
  });

  it('refuses a link’s ref git would refuse, before a request', async () => {
    const fake = fakeLists({ branches: 1, tags: 1 });
    vi.stubGlobal('fetch', fake.fetch);
    await expect(readRepository({ owner: 'octo', repo: 'ship', ref: '..' })).rejects.toThrow(
      '“..” cannot be the name of a branch, tag or commit.',
    );
    expect(fake.log).toEqual([]);
  });

  it('keeps the next page’s link across a revalidation, so a list GitHub answers 304 is not cut short', async () => {
    const fake = fakeLists({ branches: 150, tags: 0 });
    let seen = 0;
    const etagged: FetchLike = async (url, init) => {
      const res = await fake.fetch(url, init);
      const headers = new Headers(res.headers);
      headers.set('etag', `W/"${new URL(url).search}"`);
      // GitHub's 304 carries the rate limit, not the Link.
      if (init.headers['if-none-match'] === headers.get('etag'))
        return new Response(null, { status: 304, headers: { 'x-ratelimit-remaining': '58' } });
      seen++;
      return new Response(await res.arrayBuffer(), { status: res.status, headers });
    };
    const kept = new Map();
    const read = () =>
      listRefs(
        createRepoClient({ apiUrl: API, fetch: revalidating(etagged, kept), kept }),
        {
          owner: 'octo',
          repo: 'ship',
        },
        'branch',
      );
    expect((await read()).refs).toHaveLength(150);
    const again = await read();
    expect(again.refs).toHaveLength(150);
    expect(seen).toBe(2);
  });

  it('reads both lists for the picker, two requests for small ones', async () => {
    const fake = fakeLists({ branches: 2, tags: 1 });
    vi.stubGlobal('fetch', fake.fetch);
    expect(await listRefsOf({ owner: 'octo', repo: 'ship' })).toEqual(lists(['b0', 'b1'], ['v0']));
    expect(fake.log).toHaveLength(2);
  });
});

describe('what Open reads for the picker', () => {
  it('knows a full SHA in either case, and nothing shorter or longer', () => {
    expect(isFullSha(SHA)).toBe(true);
    expect(isFullSha(SHA.toUpperCase())).toBe(true);
    expect(isFullSha(SHA.slice(0, 39))).toBe(false);
    expect(isFullSha(`${SHA}0`)).toBe(false);
    expect(isFullSha('g'.repeat(40))).toBe(false);
  });

  it('reads the default branch for nothing, a SHA in lower case, and a name as typed', () => {
    expect(refChoice('  ')).toEqual({ ok: true });
    expect(refChoice(SHA.toUpperCase())).toEqual({ ok: true, ref: SHA });
    expect(refChoice(' feature/x ')).toEqual({ ok: true, ref: 'feature/x' });
    expect(refChoice('v1.2.0')).toEqual({ ok: true, ref: 'v1.2.0' });
    // A short SHA goes to GitHub as typed: it may be a branch's name.
    expect(refChoice('3f2a9c1')).toEqual({ ok: true, ref: '3f2a9c1' });
  });

  it('refuses a name git would refuse, before any request', () => {
    for (const bad of [
      '..',
      'a..b',
      'a b',
      'a~1',
      'a^',
      'a:b',
      'a?',
      'a*',
      'a[b',
      'a\\b',
      'a\u0001',
      '/a',
      'a/',
      'a//b',
      'a.',
      'a.lock',
      'a.lock/b',
      '.a',
      'a/.b',
      '@',
      'a@{1}',
    ]) {
      expect(refProblem(bad), bad).toBe(`“${bad}” cannot be the name of a branch, tag or commit.`);
      expect(refChoice(bad).ok, bad).toBe(false);
    }
    for (const good of ['main', 'feature/x', 'v1.2.0', 'release-2026.10', 'a@b', 'ünïcode', 'refs/tags/v1'])
      expect(refProblem(good), good).toBeUndefined();
  });

  it('reads a name that is both a branch and a tag as the kind picked', () => {
    const both = lists(['main', 'v1'], ['v1', 'v2']);
    expect(refChoice('v1', ref('v1', 'tag'), both)).toEqual({ ok: true, ref: 'refs/tags/v1' });
    expect(refChoice('v1', ref('v1', 'branch'), both)).toEqual({ ok: true, ref: 'refs/heads/v1' });
    // Only one of a kind, or typed rather than picked: as it is.
    expect(refChoice('v2', ref('v2', 'tag'), both)).toEqual({ ok: true, ref: 'v2' });
    expect(refChoice('v1', undefined, both)).toEqual({ ok: true, ref: 'v1' });
    // Picked, then typed over.
    expect(refChoice('v1x', ref('v1', 'tag'), both)).toEqual({ ok: true, ref: 'v1x' });
  });

  it('resolves a link’s path whole, the longest branch or tag first', () => {
    const parsed = parseRepoInput('https://github.com/octo/ship/tree/feature/x/.github/workflows');
    expect(parsed).toEqual({
      ok: true,
      target: { owner: 'octo', repo: 'ship', ref: 'feature' },
      segments: ['feature', 'x', '.github', 'workflows'],
    });
    const segments = parsed.ok ? (parsed.segments ?? []) : [];
    expect(wholeRef(segments, lists(['main', 'feature', 'feature/x'], []))).toBe('feature/x');
    expect(wholeRef(segments, lists(['main'], ['feature']))).toBe('feature');
    expect(wholeRef(segments, lists(['main'], []))).toBeUndefined();
    expect(parseRepoInput('https://github.com/octo/ship/tree/main')).toEqual({
      ok: true,
      target: { owner: 'octo', repo: 'ship', ref: 'main' },
    });
  });

  it('shows as current only the option the field names, of the kind picked, and steps round the ends', () => {
    const all = refOptions(lists(['main', 'v1'], ['v1', 'v1.1']), '', 'main');
    expect(highlighted(all, 'main')).toBe(0);
    expect(highlighted(all, 'v1', ref('v1', 'tag'))).toBe(2);
    expect(highlighted(all, 'v1', ref('v1', 'branch'))).toBe(1);
    expect(highlighted(all, 'v1')).toBe(1);
    // Typed, not listed: none, so Enter leaves it as typed.
    expect(highlighted(all, 'v')).toBe(-1);
    expect([
      stepped(-1, 1, 4),
      stepped(-1, -1, 4),
      stepped(3, 1, 4),
      stepped(0, -1, 4),
      stepped(1, 1, 4),
    ]).toEqual([0, 3, 0, 3, 2]);
  });

  it('lists the default branch first, then the branches, then the tags, holding what is typed', () => {
    const all = lists(['dev', 'main', 'Feature/X'], ['v1', 'v2']);
    expect(refOptions(all, '', 'main').map((r) => `${r.kind}:${r.name}`)).toEqual([
      'branch:main',
      'branch:dev',
      'branch:Feature/X',
      'tag:v1',
      'tag:v2',
    ]);
    expect(refOptions(all, 'feat', 'main').map((r) => r.name)).toEqual(['Feature/X']);
    expect(refOptions(all, ' V ', 'main').map((r) => r.name)).toEqual(['dev', 'v1', 'v2']);
    expect(refOptions(all, '', 'gone').map((r) => r.name)).toEqual(['dev', 'main', 'Feature/X', 'v1', 'v2']);
  });

  it('names a source opened at a commit by its short SHA once', () => {
    const source = {
      kind: 'github' as const,
      host: 'github.com',
      owner: 'octo',
      repo: 'ship',
      ref: SHA,
      sha: SHA,
      defaultBranch: 'main',
      private: false,
      readAt: 0,
    };
    expect(repoAt(source)).toBe('octo/ship @ 3f2a9c1');
    expect(repoAt({ ...source, ref: 'v1.0.0' })).toBe('octo/ship @ v1.0.0 (3f2a9c1)');
    // A link naming the commit in capitals is the source opened from it.
    expect(isTarget(source, { owner: 'octo', repo: 'ship', ref: SHA.toUpperCase() })).toBe(true);
    expect(isTarget({ ...source, ref: 'Main' }, { owner: 'octo', repo: 'ship', ref: 'main' })).toBe(false);
  });
});
