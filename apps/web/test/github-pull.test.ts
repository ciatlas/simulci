import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '@ciatlas/core/remote-fetch';
import { LISTED_FILES } from '../src/github/pull';
import { createSources } from '../src/input/sources';
import { memoryStore } from '../src/lib/idb';
import { fetchAgain, readRepository } from '../src/github/read';
import { parseRepoInput } from '../src/github/target';
import { repoAt, unlistedSentence } from '../src/lib/repo-words';
import { pullScenario, sourceDefault } from '../src/scenario/defaults';
import { sourceStore } from '../src/state/persist';
import { createSessionStore, type GitHubSource, type PullFacts } from '../src/state/store';
import { CHANGED_URL_LIMIT, readSearch, writeSearch } from '../src/state/url';
import type { Outline } from '../src/worker/protocol';

/**
 * Opening a pull request (M4 synthesis § 5.8): its link, the base repository read at the head commit (a fork's head
 * through the base repository, as GitHub serves it), the changed files one request per 100, none past GitHub's
 * 3,000, the scenario the page makes of it, the status line, what is stored, and what the URL takes.
 */

const CI = '.github/workflows/ci.yml';
const TEXT =
  'on:\n  pull_request:\n    paths: [src/**]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{ run: echo }]\n';

interface Fake {
  log: string[];
  fetch: FetchLike;
  head: string;
}

/** The files a pull request changes, every kind GitHub lists: added, modified, removed, renamed, copied. */
const listed = (count: number) =>
  Array.from({ length: count }, (_, i) => {
    const filename = `src/f${i}.ts`;
    const status = ['added', 'modified', 'removed', 'renamed', 'copied', 'changed'][i % 6]!;
    return status === 'renamed'
      ? { filename, status, previous_filename: `old/f${i}.ts` }
      : { filename, status };
  });

/**
 * `octo/ship` with pull request #42 at a head of its own (a SHA the test names, so no two tests share a cached tree):
 * its fork, or a branch of the repository itself, `files` changed, the head's `.github` holding ci.yml.
 */
function fakePull(seed: string, { files = 3, fork = true }: { files?: number; fork?: boolean } = {}): Fake {
  const head = seed.padEnd(40, '0');
  const tree = seed.padEnd(40, '1');
  const blob = seed.padEnd(40, '2');
  const log: string[] = [];
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        'content-type': 'application/json',
        'x-ratelimit-limit': '60',
        'x-ratelimit-remaining': '50',
      },
    });
  const answers: Record<string, () => Response> = {
    '/repos/octo/ship': () =>
      json({
        name: 'ship',
        full_name: 'octo/ship',
        owner: { login: 'octo' },
        default_branch: 'main',
        private: false,
      }),
    '/repos/octo/ship/pulls/42': () =>
      json({
        number: 42,
        state: 'open',
        // GitHub's answer for a fork, as recorded (actions/checkout#2593); a deleted fork's `repo` is null.
        head: { ref: 'feature', sha: head, repo: { full_name: fork ? 'someone/ship' : 'octo/ship' } },
        base: { ref: 'main', sha: 'b'.repeat(40), repo: { full_name: 'octo/ship' } },
        changed_files: files,
      }),
    [`/repos/octo/ship/git/trees/${head}`]: () =>
      json({
        sha: head,
        truncated: false,
        tree: [{ path: '.github', mode: '040000', type: 'tree', sha: tree }],
      }),
    [`/repos/octo/ship/git/trees/${tree}?recursive=1`]: () =>
      json({
        sha: tree,
        truncated: false,
        tree: [{ path: 'workflows/ci.yml', mode: '100644', type: 'blob', sha: blob, size: TEXT.length }],
      }),
    [`/repos/octo/ship/git/blobs/${blob}`]: () =>
      new Response(TEXT, { headers: { 'content-type': 'text/plain; charset=utf-8' } }),
    [`/repos/octo/ship/commits/${head}`]: () => new Response(head),
  };
  const fetch: FetchLike = (url) => {
    const { pathname, search, searchParams } = new URL(url);
    log.push(pathname + search);
    const page = /^\/repos\/octo\/ship\/pulls\/42\/files$/.test(pathname)
      ? Number(searchParams.get('page'))
      : 0;
    if (page)
      return Promise.resolve(json(listed(Math.min(files, LISTED_FILES)).slice((page - 1) * 100, page * 100)));
    const answer = answers[pathname + search];
    return Promise.resolve(answer ? answer() : json({ message: 'Not Found' }, 404));
  };
  return { log, fetch, head };
}

afterEach(() => vi.unstubAllGlobals());

const pullOf = (over: Partial<PullFacts> = {}): PullFacts => ({
  number: 42,
  base: 'main',
  head: 'feature',
  fork: false,
  files: 2,
  changed: ['src/a.ts', { path: 'src/b.ts', status: 'added' }],
  ...over,
});

const source = (pull?: PullFacts): GitHubSource => ({
  kind: 'github',
  host: 'github.com',
  owner: 'octo',
  repo: 'ship',
  ref: '9b1e2c3'.padEnd(40, 'f'),
  sha: '9b1e2c3'.padEnd(40, 'f'),
  defaultBranch: 'main',
  private: false,
  readAt: 1,
  ...(pull ? { pull } : {}),
});

describe('a pull request’s link', () => {
  it('names the pull request, whichever tab of it is pasted, or `owner/repo#n`', () => {
    for (const input of [
      'https://github.com/octo/ship/pull/42',
      'github.com/octo/ship/pull/42/files',
      'https://github.com/octo/ship/pull/42#issuecomment-1',
      'octo/ship#42',
    ])
      expect(parseRepoInput(input), input).toEqual({
        ok: true,
        target: { owner: 'octo', repo: 'ship' },
        pull: 42,
      });
    for (const input of [
      'https://github.com/octo/ship/pull/0',
      'https://github.com/octo/ship/pulls',
      'octo/ship#x',
    ])
      expect(parseRepoInput(input), input).toEqual({ ok: false });
  });
});

describe('reading a pull request', () => {
  it('reads the base repository at a fork’s head, then its files, for 5 + N requests', async () => {
    const fake = fakePull('9b1e2c3');
    vi.stubGlobal('fetch', fake.fetch);
    const read = await readRepository({ owner: 'octo', repo: 'ship' }, { pull: 42 });
    expect(read.source).toMatchObject({ ref: fake.head, sha: fake.head, owner: 'octo', repo: 'ship' });
    expect(read.source.pull).toEqual({
      number: 42,
      base: 'main',
      head: 'feature',
      fork: true,
      files: 3,
      changed: [
        { path: 'src/f0.ts', status: 'added' },
        'src/f1.ts',
        { path: 'src/f2.ts', status: 'removed' },
      ],
    });
    expect(read.walked.files).toEqual({ [CI]: TEXT });
    expect(fake.log).toEqual([
      '/repos/octo/ship',
      '/repos/octo/ship/pulls/42',
      `/repos/octo/ship/git/trees/${fake.head}`,
      expect.stringMatching(/^\/repos\/octo\/ship\/git\/trees\/\w+\?recursive=1$/),
      expect.stringMatching(/^\/repos\/octo\/ship\/git\/blobs\/\w+$/),
      '/repos/octo/ship/pulls/42/files?per_page=100&page=1',
    ]);
    expect(read.requests).toBe(6);
  });

  it('lists 100 files a request, renames with where they came from and copies as added', async () => {
    const fake = fakePull('9b1e2c4', { files: 250, fork: false });
    vi.stubGlobal('fetch', fake.fetch);
    const { source: read } = await readRepository({ owner: 'octo', repo: 'ship' }, { pull: 42 });
    expect(fake.log.filter((r) => r.includes('/files'))).toEqual(
      [1, 2, 3].map((p) => `/repos/octo/ship/pulls/42/files?per_page=100&page=${p}`),
    );
    expect(read.pull?.fork).toBe(false);
    expect(read.pull?.changed).toHaveLength(250);
    expect(read.pull?.changed?.slice(3, 6)).toEqual([
      { path: 'src/f3.ts', status: 'renamed', from: 'old/f3.ts' },
      { path: 'src/f4.ts', status: 'added' },
      'src/f5.ts',
    ]);
  });

  it('asks nothing of the files past the 3,000 GitHub lists, and leaves them unknown', async () => {
    const fake = fakePull('9b1e2c5', { files: 3412 });
    vi.stubGlobal('fetch', fake.fetch);
    const { source: read } = await readRepository({ owner: 'octo', repo: 'ship' }, { pull: 42 });
    expect(fake.log.some((r) => r.includes('/files'))).toBe(false);
    expect(read.pull).toEqual({ number: 42, base: 'main', head: 'feature', fork: true, files: 3412 });
    expect(unlistedSentence(read)).toBe(
      'GitHub lists at most 3,000 files of a pull request, and #42 changes 3,412: which ones is unknown, so paths filters cannot decide.',
    );
    expect(pullScenario(read.pull!, read.sha)).not.toHaveProperty('changed');
  });

  it('says so when the repository has no such pull request', async () => {
    const fake = fakePull('9b1e2c6');
    vi.stubGlobal('fetch', fake.fetch);
    await expect(readRepository({ owner: 'octo', repo: 'ship' }, { pull: 7 })).rejects.toThrow(
      'octo/ship has no pull request #7.',
    );
  });

  it('fetches the head commit again for one request, and keeps the pull request', async () => {
    const fake = fakePull('9b1e2c7');
    vi.stubGlobal('fetch', fake.fetch);
    const { source: read } = await readRepository({ owner: 'octo', repo: 'ship' }, { pull: 42 });
    fake.log.length = 0;
    expect(await fetchAgain(read)).toEqual({ moved: false, requests: 1 });
    expect(fake.log).toEqual([`/repos/octo/ship/commits/${fake.head}`]);
  });
});

describe('what the page makes of a pull request', () => {
  const outline = (types?: { narrowed: boolean; allowed: string[] }): Outline =>
    ({
      workflows: [
        { path: '.github/workflows/push.yml', callable: false, events: [{ event: 'push' }] },
        {
          path: CI,
          callable: false,
          events: [{ event: 'pull_request', ...(types ? { types } : {}) }],
        },
      ],
    }) as unknown as Outline;

  it('is the page’s own scenario for the source: nothing marked, the workflow it runs in focus', () => {
    expect(sourceDefault(outline(), source(pullOf({ fork: true })))).toEqual({
      scenario: {
        event: 'pull_request',
        number: 42,
        base: 'main',
        head: 'feature',
        sha: source().sha,
        changed: ['src/a.ts', { path: 'src/b.ts', status: 'added' }],
        actor: { fork: true },
      },
      assumed: [],
      focus: CI,
    });
    // A repository opened at a ref keeps the first workflow's.
    expect(sourceDefault(outline(), source()).scenario.event).toBe('push');
  });

  it('chooses an activity type, marked, where a narrowed `types:` needs one', () => {
    const d = sourceDefault(outline({ narrowed: true, allowed: ['labeled', 'opened'] }), source(pullOf()));
    expect(d.scenario.action).toBe('labeled');
    expect(d.assumed).toEqual(['action']);
  });

  it('names it in the status line', () => {
    expect(repoAt(source(pullOf()))).toBe('octo/ship #42 (head 9b1e2c3)');
    expect(unlistedSentence(source(pullOf()))).toBeUndefined();
  });

  it('is stored and comes back with the source', async () => {
    const kv = memoryStore();
    const opened = source(pullOf());
    await sourceStore(kv).save(opened, { [CI]: TEXT });
    expect(await sourceStore(kv).load()).toMatchObject({ kind: 'github', source: opened });
    await kv.set('current', { kind: 'github', source: { ...opened, pull: 42 }, buffers: [] });
    expect(await sourceStore(kv).load()).toBeUndefined();
  });

  it('leaves changed files too long for a URL out of it, and the rest in', () => {
    const many = Array.from({ length: 400 }, (_, i) => `packages/some-package/src/file-${i}.ts`);
    expect(JSON.stringify(many).length).toBeGreaterThan(CHANGED_URL_LIMIT);
    const scenario = { event: 'pull_request', number: 42 };
    expect(readSearch(writeSearch({ scenario: { ...scenario, changed: many } })).scenario).toEqual(scenario);
    expect(readSearch(writeSearch({ scenario: { ...scenario, changed: ['a.ts'] } })).scenario).toEqual({
      ...scenario,
      changed: ['a.ts'],
    });
  });

  it('replaces the scenario the author had, as the page’s own, once the files are open', async () => {
    const store = createSessionStore();
    store.getState().setScenario({ event: 'push', branch: 'dev' });
    const opened = source(pullOf());
    const sources = createSources({
      store,
      persist: sourceStore(memoryStore()),
      github: () =>
        Promise.resolve({
          readRepository: () =>
            Promise.resolve({
              source: opened,
              walked: { files: { [CI]: TEXT }, meta: {}, skipped: [] },
              requests: 6,
            }),
          fetchAgain: () => Promise.reject(new Error('unused')),
        }),
    });
    expect(await sources.openGitHub({ owner: 'octo', repo: 'ship' }, { pull: 42 })).toMatchObject({
      ok: true,
    });
    expect(store.getState().source).toBe(opened);
    expect(store.getState().scenarioFrom).toBe('default');
    expect(store.getState().scenario).toEqual(pullScenario(opened.pull!, opened.sha));
  });
});
