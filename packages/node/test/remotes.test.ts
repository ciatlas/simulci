import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type FetchLike, type GitHubApi, memoryRemoteCache } from '@ciatlas/core';
import { REMOTES_LOCK_FILE, type RemotesLock, type RemotesMode, serializeRemotesLock } from '@simulci/engine';
import { describe, expect, it } from 'vitest';
import {
  githubAccess,
  githubComFallback,
  loadRemotes,
  type RemotesHost,
  readRemotesLockAt,
  updateRemotesLock,
} from '../src/remotes';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const SHA_D = 'd'.repeat(40);
const TOKEN = 'ghp_secretTOKEN0123456789';
const COM_TOKEN = 'ghp_comTOKEN9876543210';

const DEPLOY = 'octo/ship/.github/workflows/deploy.yml@v1';
const ACT = 'octo/act@v1';
const BUILD_AT_A = `octo/ship/.github/workflows/build.yml@${SHA_A}`;

const ACTION_YML = 'name: act\nruns:\n  using: node20\n  main: index.js\n';
const DEPLOY_YML = [
  'on: workflow_call',
  'jobs:',
  '  inner:',
  '    uses: ./.github/workflows/build.yml',
  '  steps:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  `      - uses: ${ACT}`,
  '',
].join('\n');
const BUILD_YML =
  'on: workflow_call\njobs:\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n';

/** The checkout's workflows: one calls the remote workflow, one runs the remote action. */
const CI_YML = [
  'on: push',
  'jobs:',
  '  call:',
  `    uses: ${DEPLOY}`,
  '  build:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  `      - uses: ${ACT}`,
  '',
].join('\n');
const FILES = { '.github/workflows/ci.yml': CI_YML };

const digestOf = (text: string) => `sha256-${createHash('sha256').update(text).digest('base64')}`;

interface Repo {
  refs: Record<string, string>;
  files: Record<string, Record<string, string>>;
}

/** octo/ship has deploy.yml and build.yml at A; octo/act has its action.yml at C (v1) and D (v2). */
const REPOS = (): Record<string, Repo> => ({
  'octo/ship': {
    refs: { v1: SHA_A },
    files: {
      [SHA_A]: { '.github/workflows/deploy.yml': DEPLOY_YML, '.github/workflows/build.yml': BUILD_YML },
      [SHA_B]: { '.github/workflows/deploy.yml': DEPLOY_YML, '.github/workflows/build.yml': BUILD_YML },
    },
  },
  'octo/act': {
    refs: { v1: SHA_C },
    files: { [SHA_C]: { 'action.yml': ACTION_YML }, [SHA_D]: { 'action.yml': `${ACTION_YML}# v2\n` } },
  },
});

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** A GitHub REST API serving `repos` under `apiUrl`: commits (the SHA accept) and raw contents at a commit. */
function fakeGitHub(repos: Record<string, Repo>, apiUrl = 'https://api.github.com', delay?: () => number) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    if (delay) await new Promise((done) => setTimeout(done, delay()));
    const text = answer(repos, apiUrl, new URL(url));
    return text === undefined ? new Response('', { status: 404 }) : new Response(text);
  };
  return { fetch, calls };
}

/** What the fake API serves at a URL, or undefined for a 404 (another host included). */
function answer(repos: Record<string, Repo>, apiUrl: string, u: URL): string | undefined {
  const m = routeOf(apiUrl, u);
  const repo = m && repos[`${m[1]}/${m[2]}`.toLowerCase()];
  if (!repo) return undefined;
  const name = decodeURIComponent(m[4]!);
  return m[3] === 'contents' ? contentOf(repo, u.searchParams.get('ref'), name) : commitOf(repo, name);
}

/** owner, repo, `commits` or `contents`, and the rest, of a URL under the API. */
function routeOf(apiUrl: string, u: URL): RegExpExecArray | null {
  const base = new URL(apiUrl);
  const path = u.origin === base.origin ? u.pathname.slice(base.pathname.replace(/\/$/, '').length) : '';
  return /^\/repos\/([^/]+)\/([^/]+)\/(commits|contents)\/(.+)$/.exec(path);
}

const contentOf = (repo: Repo, sha: string | null, path: string) => repo.files[sha ?? '']?.[path];

const commitOf = (repo: Repo, ref: string) => repo.refs[ref] ?? (repo.files[ref] ? ref : undefined);

function checkout(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'simulci-remotes-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const lockText = (remotes: RemotesLock['remotes'], unreadable?: RemotesLock['unreadable']) =>
  serializeRemotesLock({ version: 1, remotes, ...(unreadable ? { unreadable } : {}) });

const entry = (sha: string, kind: 'workflow' | 'action', file: string, text: string) => ({
  sha,
  kind,
  file,
  digest: digestOf(text),
});

/** The lockfile `remotes update` writes for REPOS with nothing pinned elsewhere. */
const FULL_LOCK = () =>
  lockText({
    [DEPLOY]: entry(SHA_A, 'workflow', '.github/workflows/deploy.yml', DEPLOY_YML),
    [BUILD_AT_A]: entry(SHA_A, 'workflow', '.github/workflows/build.yml', BUILD_YML),
    [ACT]: entry(SHA_C, 'action', 'action.yml', ACTION_YML),
  });

const API: GitHubApi = { apiUrl: 'https://api.github.com', token: TOKEN };

function host(mode: RemotesMode, fetch: FetchLike, more: Partial<RemotesHost> = {}): RemotesHost {
  return { mode, api: API, fetch, ...more };
}

const pins = (load: Awaited<ReturnType<typeof loadRemotes>>) =>
  load.remotes.sources.map((s) => `${s.ref} ${s.sha.slice(0, 1)} ${s.pinned}`);

describe('loadRemotes: where each commit comes from (§ 2.5)', () => {
  it('off reads nothing', async () => {
    const gh = fakeGitHub(REPOS());
    const root = checkout({ [REMOTES_LOCK_FILE]: FULL_LOCK() });
    const load = await loadRemotes(root, FILES, host('off', gh.fetch));
    expect(load.remotes).toEqual({ sources: [] });
    expect(gh.calls).toEqual([]);
  });

  it('lock without a lockfile reads rows 1–3 only: a moving ref is not read, and nothing is said', async () => {
    const gh = fakeGitHub(REPOS());
    const files = {
      '.github/workflows/ci.yml': CI_YML.replace(DEPLOY, `octo/ship/.github/workflows/deploy.yml@${SHA_A}`),
    };
    const load = await loadRemotes(checkout(), files, host('lock', gh.fetch));
    // Row 1 reads deploy.yml at its SHA; row 3 reads its ./ at the same commit. octo/act@v1 has no pin.
    expect(pins(load)).toEqual([
      `octo/ship/.github/workflows/build.yml@${SHA_A} a parent`,
      `octo/ship/.github/workflows/deploy.yml@${SHA_A} a sha-ref`,
    ]);
    expect(load.issues).toEqual([]);
    expect(gh.calls.some((c) => c.url.includes('/commits/'))).toBe(false);
  });

  it('a full ref to the checkout’s own repository is a remote, read at its ref (lab R10)', async () => {
    const self = `octo/ship/.github/workflows/build.yml@${SHA_A}`;
    const files = { '.github/workflows/ci.yml': `on: push\njobs:\n  c:\n    uses: ${self}\n` };
    const load = await loadRemotes(
      checkout(),
      { ...files, '.github/workflows/build.yml': 'not this one' },
      host('lock', fakeGitHub(REPOS()).fetch),
    );
    expect(load.remotes.sources.map((s) => [s.ref, s.pinned, s.text])).toEqual([
      [self, 'sha-ref', BUILD_YML],
    ]);
  });

  it('row 4: lock reads the lockfile commits and resolves nothing', async () => {
    const gh = fakeGitHub(REPOS());
    const root = checkout({ [REMOTES_LOCK_FILE]: FULL_LOCK() });
    // The tags have moved since the update: the lockfile still decides.
    const repos = REPOS();
    repos['octo/ship']!.refs.v1 = SHA_B;
    const moved = fakeGitHub(repos);
    const load = await loadRemotes(root, FILES, host('lock', moved.fetch));
    expect(pins(load)).toEqual([`${ACT} c lockfile`, `${BUILD_AT_A} a parent`, `${DEPLOY} a lockfile`]);
    expect(moved.calls.some((c) => c.url.includes('/commits/'))).toBe(false);
    expect(gh.calls).toEqual([]);
  });

  it('lock with a lockfile that lacks a ref: not read, remote-not-locked', async () => {
    const gh = fakeGitHub(REPOS());
    const root = checkout({
      [REMOTES_LOCK_FILE]: lockText(
        { [ACT]: entry(SHA_C, 'action', 'action.yml', ACTION_YML) },
        { [DEPLOY]: 'access' },
      ),
    });
    const load = await loadRemotes(root, FILES, host('lock', gh.fetch));
    expect(pins(load)).toEqual([`${ACT} c lockfile`]);
    expect(load.issues).toEqual([
      {
        code: 'remote-not-locked',
        severity: 'warning',
        message: `${DEPLOY} is not in ${REMOTES_LOCK_FILE} (the last update could not read it: access)`,
      },
    ]);
    expect(gh.calls.map((c) => c.url)).toEqual([
      'https://api.github.com/repos/octo/act/contents/action.yml?ref=cccccccccccccccccccccccccccccccccccccccc',
    ]);
  });

  it('row 5: fetch resolves what nothing pins, with remote-unpinned', async () => {
    const gh = fakeGitHub(REPOS());
    const root = checkout({
      [REMOTES_LOCK_FILE]: lockText({ [ACT]: entry(SHA_C, 'action', 'action.yml', ACTION_YML) }),
    });
    const load = await loadRemotes(root, FILES, host('fetch', gh.fetch));
    expect(pins(load)).toEqual([`${ACT} c lockfile`, `${BUILD_AT_A} a parent`, `${DEPLOY} a resolved`]);
    expect(load.issues.map((i) => i.code)).toEqual(['remote-unpinned']);
    expect(gh.calls.filter((c) => c.url.includes('/commits/')).map((c) => c.url)).toEqual([
      'https://api.github.com/repos/octo/ship/commits/v1',
    ]);
  });

  it('row 2: the running workflow’s actions.lock pins an action, and wins over the lockfile with a mismatch', async () => {
    const gh = fakeGitHub(REPOS());
    const root = checkout({
      [REMOTES_LOCK_FILE]: FULL_LOCK(),
      '.github/workflows/actions.lock': actionsLock({ '.github/workflows/ci.yml': [ACT] }, { [ACT]: SHA_D }),
    });
    const load = await loadRemotes(root, FILES, host('lock', gh.fetch));
    // ci.yml runs octo/act at D; inside deploy.yml (a remote), the caller's lock does not apply: the lockfile's C.
    expect(pins(load)).toEqual([
      `${ACT} c lockfile`,
      `${ACT} d actions-lock`,
      `${BUILD_AT_A} a parent`,
      `${DEPLOY} a lockfile`,
    ]);
    expect(load.issues.map((i) => i.code)).toEqual(['remote-pin-mismatch']);
  });

  it('row 2 applies per running file: a local action takes the pin of the workflows that run it', async () => {
    const gh = fakeGitHub(REPOS());
    const files = {
      '.github/workflows/ci.yml':
        'on: push\njobs:\n  b:\n    runs-on: x\n    steps:\n      - uses: ./.github/actions/local\n',
      '.github/workflows/other.yml': `on: push\njobs:\n  b:\n    runs-on: x\n    steps:\n      - uses: ${ACT}\n`,
      '.github/actions/local/action.yml': `runs:\n  using: composite\n  steps:\n    - uses: ${ACT}\n`,
    };
    const covered = actionsLock({ '.github/workflows/ci.yml': [ACT] }, { [ACT]: SHA_D });
    const one = await loadRemotes(
      checkout({ '.github/workflows/actions.lock': covered }),
      files,
      host('lock', gh.fetch),
    );
    // other.yml is not covered, so it does not vote; ci.yml runs the local action, so its pin applies there.
    expect(pins(one)).toEqual([`${ACT} d actions-lock`]);

    const uncovered = actionsLock({ '.github/workflows/other.yml': [] }, { [ACT]: SHA_D });
    const none = await loadRemotes(
      checkout({ '.github/workflows/actions.lock': uncovered }),
      files,
      host('lock', gh.fetch),
    );
    expect(pins(none)).toEqual([]);
  });

  it('row 2 never pins a reusable workflow, and a broken actions.lock is named and not used', async () => {
    const gh = fakeGitHub(REPOS());
    const lock = actionsLock({ '.github/workflows/ci.yml': [DEPLOY] }, { 'octo/ship@v1': SHA_B });
    const load = await loadRemotes(
      checkout({ '.github/workflows/actions.lock': lock }),
      FILES,
      host('lock', gh.fetch),
    );
    expect(pins(load)).toEqual([]);
    const broken = await loadRemotes(
      checkout({ '.github/workflows/actions.lock': 'version: [' }),
      FILES,
      host('lock', gh.fetch),
    );
    expect(broken.lockErrors).toEqual([expect.stringMatching(/^\.github\/workflows\/actions\.lock: /)]);
    const dir = checkout();
    mkdirSync(join(dir, '.github/workflows/actions.lock'), { recursive: true });
    const unreadable = await loadRemotes(dir, FILES, host('lock', gh.fetch));
    expect(unreadable.lockErrors).toEqual([
      expect.stringMatching(/^\.github\/workflows\/actions\.lock: EISDIR/),
    ]);
  });

  it('a lockfile that cannot be read is named, and the checkout reads as if it had none', async () => {
    const gh = fakeGitHub(REPOS());
    const lines: string[] = [];
    const load = await loadRemotes(
      checkout({ [REMOTES_LOCK_FILE]: 'version: 2\nremotes: {}\n' }),
      FILES,
      host('lock', gh.fetch, { log: (l) => lines.push(l) }),
    );
    expect(load.lockErrors).toEqual([`${REMOTES_LOCK_FILE}: version: Invalid input: expected 1`]);
    expect(lines).toEqual([`not used: ${REMOTES_LOCK_FILE}: version: Invalid input: expected 1`]);
    expect(load.remotes.sources).toEqual([]);
    expect(load.lock).toBeUndefined();
  });
});

describe('loadRemotes: determinism (§ 3.12)', () => {
  it('the same checkout, lockfile and actions.lock give the same inputs, whatever the order of files or answers', async () => {
    const root = checkout({ [REMOTES_LOCK_FILE]: FULL_LOCK() });
    const other = { '.github/workflows/z.yml': CI_YML.replace('jobs:', 'name: z\njobs:') };
    const runs = await Promise.all(
      [0, 1, 2, 3].map((i) => {
        const gh = fakeGitHub(REPOS(), undefined, () => Math.random() * 5);
        const files = i % 2 ? { ...other, ...FILES } : { ...FILES, ...other };
        return loadRemotes(root, files, host('lock', gh.fetch));
      }),
    );
    for (const run of runs.slice(1)) expect(run).toEqual(runs[0]);
    expect(runs[0]!.remotes.sources.map((s) => s.ref)).toEqual([ACT, BUILD_AT_A, DEPLOY]);
  });

  it('with a warm cache, lock asks nothing', async () => {
    const root = checkout({ [REMOTES_LOCK_FILE]: FULL_LOCK() });
    const cache = memoryRemoteCache();
    const cold = await loadRemotes(root, FILES, host('lock', fakeGitHub(REPOS()).fetch, { cache }));
    const none: FetchLike = () => Promise.reject(new Error('asked'));
    const warm = await loadRemotes(root, FILES, host('lock', none, { cache }));
    expect(warm).toEqual(cold);
    const offline = await loadRemotes(root, FILES, host('lock', none, { cache, offline: true }));
    expect(offline).toEqual(cold);
  });

  it('offline, an uncached body is unreadable and named, and nothing is asked', async () => {
    const root = checkout({ [REMOTES_LOCK_FILE]: FULL_LOCK() });
    const gh = fakeGitHub(REPOS());
    const load = await loadRemotes(root, FILES, host('lock', gh.fetch, { offline: true }));
    expect(gh.calls).toEqual([]);
    expect(load.remotes.sources).toEqual([]);
    expect(load.remotes.failed).toEqual([
      {
        ref: ACT,
        kind: 'action',
        failure: 'unreachable',
        message: 'github.com not asked (offline: only the cache is read)',
      },
      {
        ref: DEPLOY,
        kind: 'workflow',
        failure: 'unreachable',
        message: 'github.com not asked (offline: only the cache is read)',
      },
    ]);
  });
});

describe('loadRemotes: digests and hosts (failure mode 6)', () => {
  it('a body whose digest is not the lockfile’s is not used', async () => {
    const repos = REPOS();
    repos['octo/act']!.files[SHA_C]!['action.yml'] = `${ACTION_YML}# tampered\n`;
    const load = await loadRemotes(
      checkout({ [REMOTES_LOCK_FILE]: FULL_LOCK() }),
      FILES,
      host('lock', fakeGitHub(repos).fetch),
    );
    expect(load.remotes.sources.map((s) => s.ref)).toEqual([BUILD_AT_A, DEPLOY]);
    expect(load.remotes.failed).toEqual([
      {
        ref: ACT,
        kind: 'action',
        failure: 'digest',
        message: expect.stringMatching(
          /^the digest of octo\/act\/action\.yml at ccccccc is sha256-.+, not sha256-/,
        ),
      },
    ]);
  });

  it('a cached body with another digest is read again, and the right one is used', async () => {
    const cache = memoryRemoteCache();
    const key = { host: 'github.com', owner: 'octo', repo: 'act', sha: SHA_C, file: 'action.yml' };
    await cache.set(key, new TextEncoder().encode('poisoned'));
    const gh = fakeGitHub(REPOS());
    const load = await loadRemotes(
      checkout({ [REMOTES_LOCK_FILE]: FULL_LOCK() }),
      FILES,
      host('lock', gh.fetch, { cache }),
    );
    expect(load.remotes.sources.find((s) => s.ref === ACT)?.text).toBe(ACTION_YML);
    expect(new TextDecoder().decode(await cache.get(key))).toBe(ACTION_YML);
  });

  it('the lockfile’s host never decides where a request goes', async () => {
    const lock = lockText({
      [ACT]: { ...entry(SHA_C, 'action', 'action.yml', ACTION_YML), host: 'evil.example' },
    });
    const gh = fakeGitHub(REPOS());
    const load = await loadRemotes(checkout({ [REMOTES_LOCK_FILE]: lock }), FILES, host('lock', gh.fetch));
    expect(gh.calls.map((c) => new URL(c.url).origin)).toEqual(['https://api.github.com']);
    expect(load.remotes.sources.map((s) => [s.ref, s.host])).toEqual([[ACT, undefined]]);
  });

  it('GHES falls back to github.com only when asked, with its own token, and a wrong body fails the digest', async () => {
    const ghes = fakeGitHub({}, 'https://ghes.example/api/v3');
    const com = fakeGitHub(REPOS());
    const both: FetchLike = (url, init) =>
      url.startsWith('https://ghes.example/') ? ghes.fetch(url, init) : com.fetch(url, init);
    const root = checkout({
      [REMOTES_LOCK_FILE]: lockText({
        [ACT]: { ...entry(SHA_C, 'action', 'action.yml', ACTION_YML), host: 'github.com' },
      }),
    });
    const api = { apiUrl: 'https://ghes.example/api/v3', token: TOKEN };
    const fallback = { apiUrl: 'https://api.github.com', token: COM_TOKEN };
    const load = await loadRemotes(root, FILES, { mode: 'lock', api, fallback, fetch: both });
    expect(load.remotes.sources.map((s) => [s.ref, s.host])).toEqual([[ACT, 'github.com']]);
    expect(unique(authorizations([...ghes.calls, ...com.calls]))).toEqual([
      ['https://ghes.example', `Bearer ${TOKEN}`],
      ['https://api.github.com', `Bearer ${COM_TOKEN}`],
    ]);

    const without = await loadRemotes(root, FILES, { mode: 'lock', api, fetch: both });
    expect(without.remotes.failed?.map((f) => [f.ref, f.failure])).toEqual([[ACT, 'not-found']]);

    const repos = REPOS();
    repos['octo/act']!.files[SHA_C]!['action.yml'] = 'name: not this one\n';
    const evil = fakeGitHub(repos);
    const served: FetchLike = (url, init) =>
      url.startsWith('https://ghes.example/') ? ghes.fetch(url, init) : evil.fetch(url, init);
    const wrong = await loadRemotes(root, FILES, { mode: 'lock', api, fallback, fetch: served });
    expect(wrong.remotes.failed?.map((f) => [f.ref, f.failure])).toEqual([[ACT, 'digest']]);
  });
});

describe('loadRemotes: the token (failure mode 7)', () => {
  it('goes only to the API, and into no message or log line', async () => {
    const gh = fakeGitHub(REPOS());
    const lines: string[] = [];
    const every: Call[] = [];
    const leaky: FetchLike = async (url, init) => {
      every.push({ url, headers: init.headers });
      if (url.includes('/octo/act/')) throw new Error(`refused ${init.headers.authorization}`);
      if (url.includes('/commits/')) return new Response('', { status: 503, statusText: `down ${TOKEN}` });
      return gh.fetch(url, init);
    };
    const root = checkout({
      [REMOTES_LOCK_FILE]: lockText({ [ACT]: entry(SHA_C, 'action', 'action.yml', ACTION_YML) }),
    });
    const load = await loadRemotes(root, FILES, host('fetch', leaky, { log: (l) => lines.push(l) }));
    const said = JSON.stringify([load, lines]);
    expect(said).not.toContain(TOKEN);
    expect(lines.length).toBeGreaterThan(0);
    expect(load.remotes.failed?.map((f) => [f.ref, f.failure])).toEqual([
      [ACT, 'unreachable'],
      [DEPLOY, 'server'],
    ]);
    expect(unique(authorizations(every))).toEqual([['https://api.github.com', `Bearer ${TOKEN}`]]);
  });

  it('a lockfile key cannot start a line of its own in a message or the log', async () => {
    const lines: string[] = [];
    const key = JSON.stringify('a/b@v1\n::error file=x::pwned\u001b[2J');
    const root = checkout({ [REMOTES_LOCK_FILE]: `version: 1\nremotes:\n  ${key}: { sha: x }\n` });
    const load = await loadRemotes(
      root,
      FILES,
      host('lock', fakeGitHub(REPOS()).fetch, { log: (l) => lines.push(l) }),
    );
    for (const text of [...load.lockErrors, ...lines]) {
      expect(text).toContain('a/b@v1\\u000a::error');
      expect(text.includes('\n') || text.includes('\u001b')).toBe(false);
    }
  });
});

describe('loadRemotes: caps (§ 2.8)', () => {
  it('reads 10 levels deep; the 11th is limited', async () => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 11; i++)
      files[`.github/workflows/w${i}.yml`] = chainLink(i < 11 ? i + 1 : undefined);
    const repos = { 'octo/chain': { refs: {}, files: { [SHA_A]: files } } };
    const load = await loadRemotes(
      checkout(),
      { '.github/workflows/ci.yml': `on: push\njobs:\n  c:\n    uses: ${link(1)}\n` },
      host('lock', fakeGitHub(repos).fetch),
    );
    expect(load.remotes.sources).toHaveLength(10);
    expect(load.remotes.limited).toEqual([link(11)]);
  });

  it('reads 200 units; the rest are limited', async () => {
    const actions: Record<string, string> = {};
    const steps: string[] = [];
    for (let i = 0; i < 201; i++) {
      actions[`a${String(i).padStart(3, '0')}/action.yml`] = ACTION_YML;
      steps.push(`      - uses: octo/many/a${String(i).padStart(3, '0')}@${SHA_A}`);
    }
    const repos = { 'octo/many': { refs: {}, files: { [SHA_A]: actions } } };
    const files = {
      '.github/workflows/ci.yml': `on: push\njobs:\n  b:\n    runs-on: x\n    steps:\n${steps.join('\n')}\n`,
    };
    const load = await loadRemotes(checkout(), files, host('lock', fakeGitHub(repos).fetch));
    expect(load.remotes.sources).toHaveLength(200);
    expect(load.remotes.limited).toEqual([`octo/many/a200@${SHA_A}`]);
  });

  it('refuses a file over 1 MB', async () => {
    const repos = REPOS();
    repos['octo/act']!.files[SHA_C]!['action.yml'] = `${ACTION_YML}#${'x'.repeat(1_000_000)}\n`;
    const files = {
      '.github/workflows/ci.yml': `on: push\njobs:\n  b:\n    runs-on: x\n    steps:\n      - uses: octo/act@${SHA_C}\n`,
    };
    const load = await loadRemotes(checkout(), files, host('lock', fakeGitHub(repos).fetch));
    expect(load.remotes.failed?.map((f) => [f.ref, f.failure])).toEqual([[`octo/act@${SHA_C}`, 'too-large']]);
  });
});

describe('updateRemotesLock', () => {
  it('locks the closure, with each file’s calls, and writes the same bytes again', async () => {
    const root = checkout();
    const gh = fakeGitHub(REPOS());
    const first = await updateRemotesLock(root, FILES, { api: API, fetch: gh.fetch });
    expect(first.text).toBe(
      lockText({
        [DEPLOY]: entry(SHA_A, 'workflow', '.github/workflows/deploy.yml', DEPLOY_YML),
        [BUILD_AT_A]: entry(SHA_A, 'workflow', '.github/workflows/build.yml', BUILD_YML),
        [ACT]: entry(SHA_C, 'action', 'action.yml', ACTION_YML),
      }).replace(
        `    digest: ${digestOf(DEPLOY_YML)}\n`,
        `    digest: ${digestOf(DEPLOY_YML)}\n    calls:\n      - ${ACT}\n      - ${BUILD_AT_A}\n`,
      ),
    );
    expect(readFileSync(join(root, REMOTES_LOCK_FILE), 'utf8')).toBe(first.text);
    expect(first).toMatchObject({
      written: true,
      added: [ACT, BUILD_AT_A, DEPLOY],
      removed: [],
      changed: [],
      issues: [],
    });

    const again = await updateRemotesLock(root, FILES, { api: API, fetch: fakeGitHub(REPOS()).fetch });
    expect(again).toMatchObject({ written: false, text: first.text, added: [], removed: [], changed: [] });

    // The lockfile it wrote reads back in lock mode with no ref resolved.
    const gh2 = fakeGitHub(REPOS());
    const load = await loadRemotes(root, FILES, host('lock', gh2.fetch));
    expect(pins(load)).toEqual([`${ACT} c lockfile`, `${BUILD_AT_A} a parent`, `${DEPLOY} a lockfile`]);
    expect(gh2.calls.some((c) => c.url.includes('/commits/'))).toBe(false);
  });

  it('moves a ref that moved, keeps an entry it cannot read with what it calls, and lists one it never could', async () => {
    const buildAtB = `octo/ship/.github/workflows/build.yml@${SHA_B}`;
    const root = checkout({
      [REMOTES_LOCK_FILE]: lockText({
        'Octo/Act@v1': entry(SHA_D, 'action', 'action.yml', `${ACTION_YML}# v2\n`),
        'gone/away@v1': entry(SHA_D, 'action', 'action.yml', ACTION_YML),
        [DEPLOY]: {
          ...entry(SHA_B, 'workflow', '.github/workflows/deploy.yml', DEPLOY_YML),
          calls: [buildAtB],
        },
        [buildAtB]: entry(SHA_B, 'workflow', '.github/workflows/build.yml', BUILD_YML),
      }),
    });
    const repos = REPOS();
    delete repos['octo/ship'];
    const files = { '.github/workflows/ci.yml': `${CI_YML}      - uses: nobody/there@v1\n` };
    const update = await updateRemotesLock(root, files, { api: API, fetch: fakeGitHub(repos).fetch });
    expect(update.changed).toEqual([{ ref: 'Octo/Act@v1', from: SHA_D, to: SHA_C }]);
    expect(update.removed).toEqual(['gone/away@v1']);
    expect(update.lock.remotes[DEPLOY]?.sha).toBe(SHA_B);
    // Nothing under the unreadable deploy.yml was read, so what it calls keeps its entry too.
    expect(update.lock.remotes[buildAtB]?.sha).toBe(SHA_B);
    expect(update.lock.unreadable).toEqual({ 'nobody/there@v1': 'not-found' });
    expect(update.failed.map((f) => f.ref)).toEqual(['nobody/there@v1', DEPLOY]);
  });

  it('lists a ref as unreadable only when no commit of it was read', async () => {
    // ci.yml's actions.lock pins octo/act to B, which octo/act lacks; deploy.yml's octo/act@v1 resolves to C.
    const root = checkout({
      '.github/workflows/actions.lock': actionsLock({ '.github/workflows/ci.yml': [ACT] }, { [ACT]: SHA_B }),
    });
    const update = await updateRemotesLock(root, FILES, { api: API, fetch: fakeGitHub(REPOS()).fetch });
    expect(update.failed.map((f) => [f.ref, f.failure])).toEqual([[ACT, 'not-found']]);
    expect(update.lock.remotes[ACT]?.sha).toBe(SHA_C);
    expect(update.lock.unreadable).toBeUndefined();
  });
});

describe('updateRemotesLock: links', () => {
  it('never writes through a symbolic link', async () => {
    for (const link of ['.github', '.github/simulci', REMOTES_LOCK_FILE]) {
      const root = checkout();
      const outside = checkout({ victim: 'keep me\n' });
      mkdirSync(dirname(join(root, link)), { recursive: true });
      symlinkSync(link === REMOTES_LOCK_FILE ? join(outside, 'victim') : outside, join(root, link));
      await expect(
        updateRemotesLock(root, FILES, { api: API, fetch: fakeGitHub(REPOS()).fetch }),
      ).rejects.toThrow(`${link} is a symbolic link: not writing ${REMOTES_LOCK_FILE}`);
      expect(readFileSync(join(outside, 'victim'), 'utf8')).toBe('keep me\n');
    }
  });
});

describe('readRemotesLockAt', () => {
  it('reads none, a lockfile, or why not', () => {
    expect(readRemotesLockAt(checkout())).toEqual({});
    expect(readRemotesLockAt(checkout({ [REMOTES_LOCK_FILE]: FULL_LOCK() })).lock?.remotes[ACT]?.sha).toBe(
      SHA_C,
    );
    expect(readRemotesLockAt(checkout({ [REMOTES_LOCK_FILE]: ': [' })).error).toMatch(/not valid YAML/);
    const dir = checkout();
    mkdirSync(join(dir, REMOTES_LOCK_FILE), { recursive: true });
    expect(readRemotesLockAt(dir).error).toMatch(/^\.github\/simulci\/remotes\.lock\.yml: EISDIR/);
  });
});

describe('githubAccess', () => {
  const gh = (token?: string) => (h: string) =>
    h === 'ghes.example' || h === 'github.com' ? token : undefined;
  const env = {
    GH_TOKEN: 'gh',
    GITHUB_TOKEN: 'actions',
    GH_ENTERPRISE_TOKEN: 'ghe',
    GITHUB_ENTERPRISE_TOKEN: 'ge',
  };
  const com = 'https://api.github.com';
  const ghes = 'https://ghes.example/api/v3';

  it('on github.com takes the option, then GH_TOKEN, then GITHUB_TOKEN, then the GitHub CLI', () => {
    expect(githubAccess(env, com, 'given', gh('cli'))).toEqual({
      apiUrl: com,
      token: 'given',
      tokenFrom: 'option',
    });
    expect(githubAccess(env, com, undefined, gh('cli'))).toEqual({
      apiUrl: com,
      token: 'gh',
      tokenFrom: 'GH_TOKEN',
    });
    expect(githubAccess({ GITHUB_TOKEN: 'actions' }, com, undefined, gh('cli'))).toMatchObject({
      tokenFrom: 'GITHUB_TOKEN',
    });
    expect(githubAccess({ GH_ENTERPRISE_TOKEN: 'ghe' }, com, undefined, gh('cli'))).toMatchObject({
      tokenFrom: 'gh',
    });
    expect(githubAccess({}, com, undefined, gh())).toEqual({ apiUrl: com });
    expect(githubAccess({ GH_TOKEN: 'gh' }, 'https://api.acme.ghe.com', undefined, gh())).toMatchObject({
      tokenFrom: 'GH_TOKEN',
    });
  });

  it('never sends a github.com token to another host: a GHES takes its own variables, or the runner’s pair', () => {
    expect(githubAccess(env, ghes, undefined, gh('cli'))).toMatchObject({
      token: 'ghe',
      tokenFrom: 'GH_ENTERPRISE_TOKEN',
    });
    expect(githubAccess({ GITHUB_ENTERPRISE_TOKEN: 'ge' }, ghes, undefined, gh())).toMatchObject({
      tokenFrom: 'GITHUB_ENTERPRISE_TOKEN',
    });
    expect(githubAccess({ GH_TOKEN: 'gh', GITHUB_TOKEN: 'actions' }, ghes, undefined, gh('cli'))).toEqual({
      apiUrl: ghes,
      token: 'cli',
      tokenFrom: 'gh',
    });
    expect(githubAccess({ GH_TOKEN: 'gh', GITHUB_TOKEN: 'actions' }, ghes, undefined, gh())).toEqual({
      apiUrl: ghes,
    });
    // A long run of slashes, then another character: linear, not a backtracking regex (CodeQL js/polynomial-redos).
    const slashes = `${ghes}${'/'.repeat(100_000)}x`;
    const started = performance.now();
    expect(
      githubAccess(
        { GITHUB_TOKEN: 'actions', GITHUB_API_URL: slashes },
        slashes.slice(0, -1),
        undefined,
        gh(),
      ),
    ).toEqual({
      apiUrl: slashes.slice(0, -1),
    });
    expect(performance.now() - started).toBeLessThan(1000);
    const runner = { GITHUB_TOKEN: 'actions', GITHUB_API_URL: `${ghes}/` };
    expect(githubAccess(runner, ghes, undefined, gh())).toMatchObject({
      token: 'actions',
      tokenFrom: 'GITHUB_TOKEN',
    });
  });

  it('falls back to github.com only from another host, with GITHUB_COM_TOKEN or none', () => {
    expect(githubComFallback({ GITHUB_COM_TOKEN: 'c' }, 'https://api.github.com')).toBeUndefined();
    expect(githubComFallback({ GITHUB_TOKEN: 'not this' }, 'https://ghes.example/api/v3')).toEqual({
      apiUrl: 'https://api.github.com',
    });
    expect(githubComFallback({ GITHUB_COM_TOKEN: 'c' }, 'https://ghes.example/api/v3')).toEqual({
      apiUrl: 'https://api.github.com',
      token: 'c',
    });
  });
});

/** Each request's origin and `authorization` header, for those that carry one. */
const authorizations = (calls: Call[]) =>
  calls.flatMap((c) => (c.headers.authorization ? [[new URL(c.url).origin, c.headers.authorization]] : []));

/** Pairs once each, in first-seen order. */
const unique = (pairs: string[][]) => [...new Map(pairs.map((p) => [p.join('\n'), p])).values()];

/** GitHub's `actions.lock`, as `gh actions-lock` writes it. */
function actionsLock(workflows: Record<string, string[]>, commits: Record<string, string>): string {
  const lines = ["version: 'v0.0.3'", 'workflows:'];
  for (const [path, listed] of Object.entries(workflows))
    lines.push(`  '${path}':${listed.length ? '' : ' []'}`, ...listed.map((p) => `    - '${p}'`));
  lines.push('dependencies:');
  for (const [key, sha] of Object.entries(commits))
    lines.push(`  '${key}':`, `    ref: '${key.split('@')[1]}'`, `    commit: 'sha1-${sha}'`);
  return `${lines.join('\n')}\n`;
}

const link = (i: number) => `octo/chain/.github/workflows/w${i}.yml@${SHA_A}`;

const chainLink = (next?: number) =>
  next === undefined ? BUILD_YML : `on: workflow_call\njobs:\n  c:\n    uses: ${link(next)}\n`;
