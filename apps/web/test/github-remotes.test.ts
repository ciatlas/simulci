import { createHash } from 'node:crypto';
import type { FetchLike } from '@ciatlas/core/remote-fetch';
import { describe, expect, it } from 'vitest';
import { memoryCache } from '../src/github/cache';
import { readRemotes, remoteCacheOf } from '../src/github/remotes';
import type { RemoteNeed } from '../src/worker/protocol';

/** The remotes' reader in the `github-*` chunk (M4 synthesis § 5.3): what it asks api.github.com, and what it hands back. */

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const deploy = 'on: workflow_call\njobs: {}\n';
const act = 'name: act\nruns:\n  using: node20\n  main: x.js\n';
const digestOf = (text: string): string => `sha256-${createHash('sha256').update(text).digest('base64')}`;

/** api.github.com as a table of paths; anything else is a 404. Each request is recorded. */
function fakeApi(table: Record<string, string>) {
  const asked: string[] = [];
  const fetch: FetchLike = (url) => {
    const { pathname, search } = new URL(url);
    asked.push(`${pathname}${search}`);
    const body = table[`${pathname}${search}`];
    return Promise.resolve(
      new Response(body ?? '{"message":"Not Found"}', { status: body === undefined ? 404 : 200 }),
    );
  };
  return { fetch, asked };
}

const DEPLOY: RemoteNeed = {
  ref: 'Octo/Ship/.github/workflows/deploy.yml@v1',
  kind: 'workflow',
  depth: 1,
  pin: { sha: A, pinned: 'lockfile' },
  digest: digestOf(deploy),
};
const ACT: RemoteNeed = { ref: 'octo/act@v2', kind: 'action', depth: 1 };

describe('reading remotes', () => {
  it('reads a pinned ref at its commit, and resolves an unpinned one first', async () => {
    const api = fakeApi({
      [`/repos/Octo/Ship/contents/.github/workflows/deploy.yml?ref=${A}`]: deploy,
      '/repos/octo/act/commits/v2': B,
      [`/repos/octo/act/contents/action.yml?ref=${B}`]: act,
    });
    const read = await readRemotes([DEPLOY, ACT], { fetch: api.fetch, cache: remoteCacheOf(memoryCache()) });
    expect(read.failed).toEqual([]);
    expect(read.sources.sort((x, y) => x.ref.localeCompare(y.ref))).toEqual([
      { ref: ACT.ref, kind: 'action', sha: B, text: act, pinned: 'resolved', digest: digestOf(act) },
      {
        ref: DEPLOY.ref,
        kind: 'workflow',
        sha: A,
        text: deploy,
        pinned: 'lockfile',
        digest: digestOf(deploy),
      },
    ]);
  });

  it('says why a need was not read, at the commit it was asked for (none when resolving failed)', async () => {
    const api = fakeApi({ [`/repos/Octo/Ship/contents/.github/workflows/deploy.yml?ref=${A}`]: 'tampered' });
    const read = await readRemotes([DEPLOY, ACT], { fetch: api.fetch, cache: remoteCacheOf(memoryCache()) });
    expect(read.sources).toEqual([]);
    const [unresolved, tampered] = read.failed.sort((x, y) => x.ref.localeCompare(y.ref));
    expect(tampered).toMatchObject({ ref: DEPLOY.ref, failure: 'digest', sha: A });
    expect(unresolved).toMatchObject({ ref: ACT.ref, failure: 'not-found' });
    expect(unresolved).not.toHaveProperty('sha');
  });

  it('keeps what it read in the cache, and reads it from there the next time', async () => {
    const cache = remoteCacheOf(memoryCache());
    const table = { [`/repos/Octo/Ship/contents/.github/workflows/deploy.yml?ref=${A}`]: deploy };
    const first = fakeApi(table);
    await readRemotes([DEPLOY], { fetch: first.fetch, cache });
    expect(first.asked).toHaveLength(1);
    const again = fakeApi(table);
    const read = await readRemotes([DEPLOY], { fetch: again.fetch, cache });
    expect(again.asked).toEqual([]);
    expect(read.sources.map((s) => s.text)).toEqual([deploy]);
  });

  it('refuses a ref that is not a remote reference without asking anything', async () => {
    const api = fakeApi({});
    const read = await readRemotes([{ ref: 'not a ref', kind: 'action', depth: 1 }], { fetch: api.fetch });
    expect(read.failed).toEqual([expect.objectContaining({ failure: 'other' })]);
    expect(api.asked).toEqual([]);
  });
});
