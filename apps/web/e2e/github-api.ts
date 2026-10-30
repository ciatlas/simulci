import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, type Route } from '@playwright/test';

/**
 * api.github.com for the browser pass (M4 synthesis § 5.12): `ciatlas/flowpact` as recorded in
 * `e2e/fixtures/github/`, with the workflow files of `e2e/fixtures/flowpact/` in its `.github` tree, served through
 * `page.route`. The CSP is checked before the route, so these answers reach the page only because `connect-src`
 * allows the API. Every GET is counted, the rate limit goes down with each, and a test can move the branch to a new
 * commit with changed files, or spend the limit. Any other repository is one the workflows call (M4 synthesis § 5.3):
 * each ref resolves to a commit of its own, and each file at a commit is a node action or a reusable workflow.
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

/** What another repository serves: any ref's commit, and at any commit a node action or an empty reusable workflow. */
export function elsewhere(
  path: string,
  accept: string,
): { status: number; body: string; type: string } | undefined {
  const ref = /^\/repos\/[^/]+\/[^/]+\/commits\/([^/?]+)$/.exec(path);
  if (ref && accept === 'application/vnd.github.sha')
    return { status: 200, body: shaOf('commit', Buffer.from(path)), type: 'application/vnd.github.sha' };
  const file = /^\/repos\/[^/]+\/[^/]+\/contents\/(.+)\?ref=\w{40}$/.exec(path);
  if (!file) return undefined;
  const body = file[1]!.endsWith('action.yml')
    ? 'name: remote\nruns:\n  using: node20\n  main: index.js\n'
    : 'on: workflow_call\njobs:\n  remote:\n    runs-on: ubuntu-latest\n    steps: [{ run: echo }]\n';
  return { status: 200, body, type: 'text/plain; charset=utf-8' };
}

/** Whether a request is for a repository the workflows call, not the one opened. */
export const isElsewhere = (request: string): boolean =>
  request !== `/repos/${OWNER}/${REPO}` && !request.startsWith(`/repos/${OWNER}/${REPO}/`);

/**
 * Once a repository is open, the page reads the remotes its workflows call (M4 synthesis § 5.3): waits until it asked
 * for them and the status bar no longer says it is reading, so a later count of requests is not raced.
 */
export async function remotesRead(page: Page, github: FakeGitHub): Promise<void> {
  await expect.poll(() => github.requests.filter(isElsewhere).length).toBeGreaterThan(0);
  await expect(page.getByText('reading remotes from api.github.com…')).toHaveCount(0);
}

export interface FakeGitHub {
  /** Every GET, as `<path><search>`. */
  requests: string[];
  /** The commit `main` points at. */
  commit(): string;
  /** Moves `main` to a new commit where these files hold these texts. */
  push(files: Record<string, string>): void;
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

  const answer = (path: string, accept: string): { status: number; body: string | Buffer; type: string } => {
    if (path === '') return { status: 200, body: fixture('repo.json'), type: 'application/json' };
    if (path === '/commits/main' && accept === 'application/vnd.github.sha')
      return { status: 200, body: commit, type: 'application/vnd.github.sha' };
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
    return { status: 404, body: '{"message":"Not Found"}', type: 'application/json' };
  };

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
    const { status, body, type } = !isElsewhere(url.pathname)
      ? answer(path, accept)
      : (elsewhere(url.pathname + url.search, accept) ?? {
          status: 404,
          body: '{"message":"Not Found"}',
          type: 'application/json',
        });
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
    spend: () => {
      remaining = 0;
    },
  };
}
