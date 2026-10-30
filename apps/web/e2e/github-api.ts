import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page, Route } from '@playwright/test';

/**
 * api.github.com for the browser pass (M4 synthesis § 5.12): `ciatlas/flowpact` as recorded in
 * `e2e/fixtures/github/`, with the workflow files of `e2e/fixtures/flowpact/` in its `.github` tree, served through
 * `page.route`. The CSP is checked before the route, so these answers reach the page only because `connect-src`
 * allows the API. Every GET is counted, the rate limit goes down with each, and a test can move the branch to a new
 * commit with changed files, make a branch or a tag at the commit `main` is at, or spend the limit. A ref resolves as
 * git resolves one: a full SHA, `refs/heads/…` and `refs/tags/…`, then a bare name, a tag before a branch.
 */

const here = import.meta.dirname;
const fixture = (name: string): string => readFileSync(join(here, 'fixtures/github', name), 'utf8');
const json = (name: string): unknown => JSON.parse(fixture(name));

export const OWNER = 'ciatlas';
export const REPO = 'flowpact';
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;

interface Entry {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
}

/** The workflow files the repository holds at first, by path. */
export const WORKFLOWS: Record<string, string> = Object.fromEntries(
  readdirSync(join(here, 'fixtures/flowpact'))
    .filter((f) => f.endsWith('.yml'))
    .map((f) => [`.github/workflows/${f}`, readFileSync(join(here, 'fixtures/flowpact', f), 'utf8')]),
);

/** A git object's SHA. */
const shaOf = (type: string, bytes: Buffer): string =>
  createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');

interface Answer {
  status: number;
  body: string | Buffer;
  type: string;
}

const NOT_FOUND: Answer = { status: 404, body: '{"message":"Not Found"}', type: 'application/json' };

export interface FakeGitHub {
  /** Every GET, as `<path><search>`. */
  requests: string[];
  /** The commit `main` points at. */
  commit(): string;
  /** Moves `main` to a new commit where these files hold these texts. */
  push(files: Record<string, string>): void;
  /** A branch or a tag named so, at the commit `main` is at now. */
  branch(name: string): void;
  tag(name: string): void;
  /** Spends the hour's requests: every request now answers 403. */
  spend(): void;
}

export async function fakeGitHub(page: Page): Promise<FakeGitHub> {
  const headers = json('headers.json') as Record<string, string>;
  const root = json('root-tree.json') as { tree: Entry[] };
  const recorded = json('github-tree.json') as { tree: Entry[] };
  const blobs = new Map<string, Buffer>();
  const add = (text: string | Buffer): string => {
    const bytes = Buffer.from(text);
    const sha = shaOf('blob', bytes);
    blobs.set(sha, bytes);
    return sha;
  };
  const action = root.tree.find((e) => e.path === 'action.yml')!;
  blobs.set(action.sha, Buffer.from(fixture('action.yml')));

  let files = { ...WORKFLOWS };
  let commits = 0;
  let commit = '';
  const trees = new Map<string, Entry[]>();
  const commitShas = new Set<string>();
  const branches = new Map<string, string>();
  const tags = new Map<string, string>();
  const heads = (): Map<string, string> => new Map([['main', commit], ...branches]);
  const resolve = (ref: string): string | undefined => {
    if (/^[0-9a-f]{40}$/.test(ref)) return commitShas.has(ref) ? ref : undefined;
    const qualified = /^refs\/(heads|tags)\/(.+)$/.exec(ref);
    if (qualified) return (qualified[1] === 'heads' ? heads() : tags).get(qualified[2]!);
    return tags.get(ref) ?? heads().get(ref);
  };
  const build = (): void => {
    const others = recorded.tree.filter((e) => !e.path.startsWith('workflows/'));
    const workflows = Object.entries(files).map(([path, text]) => ({
      path: path.slice('.github/'.length),
      mode: '100644',
      type: 'blob',
      sha: add(text),
      size: Buffer.byteLength(text),
    }));
    const github: Entry[] = [...others, ...workflows];
    const githubSha = shaOf('tree', Buffer.from(JSON.stringify(github)));
    commit = shaOf('commit', Buffer.from(`${++commits} ${githubSha}`));
    commitShas.add(commit);
    trees.set(githubSha, github);
    trees.set(
      commit,
      root.tree.map((e) => (e.path === '.github' ? { ...e, sha: githubSha } : e)),
    );
  };
  build();

  const requests: string[] = [];
  let remaining = 60;
  const reset = String(Math.floor(Date.UTC(2026, 9, 30, 14, 5) / 1000));
  const limits = (): Record<string, string> => ({
    ...headers,
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-reset': reset,
    'x-ratelimit-used': String(60 - remaining),
  });

  /** The repository, a ref's commit, the lists of branches and tags. */
  const refAnswer = (path: string, accept: string): Answer | undefined => {
    if (path === '') return { status: 200, body: fixture('repo.json'), type: 'application/json' };
    const at = /^\/commits\/([^?]+)$/.exec(path);
    if (at && accept === 'application/vnd.github.sha') {
      const sha = resolve(decodeURIComponent(at[1]!));
      return sha
        ? { status: 200, body: sha, type: 'application/vnd.github.sha' }
        : { status: 422, body: '{"message":"No commit found for SHA"}', type: 'application/json' };
    }
    const list = /^\/(branches|tags)\?per_page=100&page=(\d+)$/.exec(path);
    if (list) {
      const named = list[2] === '1' ? [...(list[1] === 'branches' ? heads() : tags)] : [];
      const body = named.map(([name, sha]) => ({ name, commit: { sha, url: `${API}/commits/${sha}` } }));
      return { status: 200, body: JSON.stringify(body), type: 'application/json' };
    }
    return undefined;
  };

  /** A tree or a blob, by SHA. */
  const objectAnswer = (path: string, accept: string): Answer | undefined => {
    const tree = /^\/git\/trees\/(\w+)(\?recursive=1)?$/.exec(path);
    if (tree && trees.has(tree[1]!))
      return {
        status: 200,
        body: JSON.stringify({
          sha: tree[1],
          url: `${API}/git/trees/${tree[1]}`,
          tree: trees.get(tree[1]!),
          truncated: false,
        }),
        type: 'application/json',
      };
    const blob = /^\/git\/blobs\/(\w+)$/.exec(path);
    if (blob && blobs.has(blob[1]!) && accept === 'application/vnd.github.raw+json')
      return { status: 200, body: blobs.get(blob[1]!)!, type: 'text/plain; charset=utf-8' };
    return undefined;
  };

  const answer = (path: string, accept: string): Answer =>
    refAnswer(path, accept) ?? objectAnswer(path, accept) ?? NOT_FOUND;

  const handle = async (route: Route): Promise<void> => {
    const request = route.request();
    const url = new URL(request.url());
    // The preflight a request with X-GitHub-Api-Version needs, as GitHub answers it.
    if (request.method() === 'OPTIONS')
      return route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'Authorization, If-None-Match, X-GitHub-Api-Version',
          'access-control-allow-methods': 'GET',
        },
      });
    requests.push(url.pathname + url.search);
    if (remaining === 0)
      return route.fulfill({
        status: 403,
        headers: limits(),
        contentType: 'application/json',
        body: '{"message":"API rate limit exceeded for 127.0.0.1."}',
      });
    remaining--;
    const path = (url.pathname + url.search).slice(`/repos/${OWNER}/${REPO}`.length);
    const accept = request.headers().accept ?? '';
    const { status, body, type } = url.pathname.startsWith(`/repos/${OWNER}/${REPO}`)
      ? answer(path, accept)
      : NOT_FOUND;
    await route.fulfill({ status, headers: limits(), contentType: type, body });
  };
  await page.route('https://api.github.com/**', handle);

  return {
    requests,
    commit: () => commit,
    push: (changed) => {
      files = { ...files, ...changed };
      build();
    },
    branch: (name) => {
      branches.set(name, commit);
    },
    tag: (name) => {
      tags.set(name, commit);
    },
    spend: () => {
      remaining = 0;
    },
  };
}
