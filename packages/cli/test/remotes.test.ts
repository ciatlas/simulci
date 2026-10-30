import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FetchLike } from '@ciatlas/core';
import { REMOTES_LOCK_FILE } from '@simulci/engine';
import { renderUsage } from 'citty';
import { describe, expect, it } from 'vitest';
import { FlagError, printable } from '../src/args';
import { planArgs, planCommand, planOutput } from '../src/plan';
import { type RemotesCommandIo, runRemotesCheck, runRemotesUpdate } from '../src/remotes';
import { runTestCommand, testArgs, testCommand } from '../src/test';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const TOKEN = 'ghp_cliSECRET0123456789abcdef';
const GH = 'gho_fromGhCLI0123456789abcdef';

const DEPLOY = 'octo/ship/.github/workflows/deploy.yml@v1';
const ACT = 'octo/act@v1';

const DEPLOY_YML = `on:
  workflow_call:
    outputs:
      shipped: { value: '\${{ jobs.ship.outputs.done }}' }
jobs:
  ship:
    runs-on: ubuntu-latest
    outputs: { done: yes }
    steps:
      - run: ./ship
`;
const ACTION_YML = 'name: act\nruns:\n  using: node20\n  main: index.js\n';

/** One job calls the remote workflow and one reads its output; another step runs the remote action. */
const CI_YML = `on: push
jobs:
  call:
    uses: ${DEPLOY}
  after:
    needs: call
    if: needs.call.outputs.shipped == 'yes'
    runs-on: ubuntu-latest
    steps:
      - uses: ${ACT}
`;

/** `after` runs only when the call's output is read: a plan that could not read the remote has it as maybe. */
const TESTS = `workflow: ci.yml
cases:
  - name: the remote decides
    when: { event: push }
    then: { run: [call, after] }
`;

/** What the fake API serves: `owner/repo@ref` → commit, `owner/repo/path@sha` → file. */
const SERVED: Record<string, string> = {
  'octo/ship@v1': A,
  'octo/act@v1': C,
  [`octo/ship/.github/workflows/deploy.yml@${A}`]: DEPLOY_YML,
  [`octo/ship/.github/workflows/deploy.yml@${B}`]: DEPLOY_YML.replace("'yes'", "'no'"),
  [`octo/act/action.yml@${C}`]: ACTION_YML,
};

interface Call {
  url: string;
  authorization?: string;
}

/**
 * GitHub's REST API at api.github.com for `served`: commits (as the SHA accept answers) and raw contents. Every request
 * is recorded with its authorization header; each answer may wait `delay()` ms, to shuffle the order they come back in.
 */
function fakeGitHub(served: Record<string, string> = SERVED, delay?: () => number) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, ...(init.headers.authorization ? { authorization: init.headers.authorization } : {}) });
    if (delay) await new Promise((done) => setTimeout(done, delay()));
    const u = new URL(url);
    const m = /^\/repos\/([^/]+)\/([^/]+)\/(commits|contents)\/(.+)$/.exec(u.pathname);
    const key =
      m &&
      (m[3] === 'commits'
        ? `${m[1]}/${m[2]}@${decodeURIComponent(m[4]!)}`
        : `${m[1]}/${m[2]}/${decodeURIComponent(m[4]!)}@${u.searchParams.get('ref')}`);
    const text = u.origin === 'https://api.github.com' && key ? served[key] : undefined;
    return text === undefined ? new Response('', { status: 404 }) : new Response(text);
  };
  return { fetch, calls };
}

function checkout(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'simulci-cli-remotes-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const project = (extra: Record<string, string> = {}) =>
  checkout({ '.github/workflows/ci.yml': CI_YML, '.github/simulci/tests/ci.test.yml': TESTS, ...extra });

type Io = RemotesCommandIo & { out: string[]; err: string[]; calls: Call[] };

/** A command's io over the fake API; `GH_TOKEN` set unless the env says otherwise, and no `gh` to ask. */
function io(env: Record<string, string> = { GH_TOKEN: TOKEN }, github = fakeGitHub()): Io {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    calls: github.calls,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    env,
    fetch: github.fetch,
    gh: () => undefined,
    secrets: [],
  };
}

const text = (lines: string[]) => lines.join('');
const digestOf = (body: string) => `sha256-${createHash('sha256').update(body).digest('base64')}`;
const lockOf = (dir: string) => readFileSync(join(dir, REMOTES_LOCK_FILE), 'utf8');

/** A checkout with its lockfile written by `simulci remotes update` over the fake API. */
async function locked(extra: Record<string, string> = {}): Promise<string> {
  const dir = project(extra);
  expect(await runRemotesUpdate({ dir }, io())).toBe(0);
  return dir;
}

const plan = async (dir: string, flags: string[], with_: Io = io()) => {
  const out = await planOutput(planArgs(['--dir', dir, ...flags]), with_);
  return { ...out, err: text(with_.err), calls: with_.calls };
};

/** Every request, and everything printed, without the token. */
function expectNoToken(...ios: Io[]): void {
  for (const x of ios) expect(text([...x.out, ...x.err])).not.toContain(TOKEN);
}

describe('simulci remotes update', () => {
  it('pins every remote the checkout reaches, with the token only in the authorization header', async () => {
    const dir = project();
    const first = io();
    expect(await runRemotesUpdate({ dir }, first)).toBe(0);
    expect(text(first.out)).toBe(
      `${REMOTES_LOCK_FILE}: 2 added, 0 changed, 0 removed\n  + ${ACT} → ccccccc\n  + ${DEPLOY} → aaaaaaa\n`,
    );
    expect(lockOf(dir)).toBe(`# Generated by simulci. Run \`simulci remotes update\` to update it.
# The commit each remote workflow and action this repository uses resolved to, and a digest of the file read there.
version: 1
remotes:
  octo/act@v1:
    sha: ${C}
    kind: action
    file: action.yml
    digest: ${digestOf(ACTION_YML)}
  ${DEPLOY}:
    sha: ${A}
    kind: workflow
    file: .github/workflows/deploy.yml
    digest: ${digestOf(DEPLOY_YML)}
`);
    expect(first.calls.length).toBeGreaterThan(0);
    for (const call of first.calls) {
      expect(new URL(call.url).origin).toBe('https://api.github.com');
      expect(call.authorization).toBe(`Bearer ${TOKEN}`);
    }
    expect(first.secrets).toEqual([TOKEN]);
    expectNoToken(first);
  });

  it('writes the same bytes again, whatever order the answers come in', async () => {
    const one = project();
    const two = project();
    expect(
      await runRemotesUpdate(
        { dir: one },
        io(
          undefined,
          fakeGitHub(SERVED, () => 0),
        ),
      ),
    ).toBe(0);
    let n = 0;
    const late = () => [9, 0, 5, 1, 7, 3][n++ % 6]!;
    expect(await runRemotesUpdate({ dir: two }, io(undefined, fakeGitHub(SERVED, late)))).toBe(0);
    expect(lockOf(two)).toBe(lockOf(one));
    const again = io();
    expect(await runRemotesUpdate({ dir: one }, again)).toBe(0);
    expect(text(again.out)).toBe(`${REMOTES_LOCK_FILE}: up to date\n`);
    expect(lockOf(one)).toBe(lockOf(two));
  });

  it('prints what moved, and exits 1 keeping the entry of a remote it could not read', async () => {
    const dir = await locked();
    const moved = io(undefined, fakeGitHub({ ...SERVED, 'octo/ship@v1': B }));
    expect(await runRemotesUpdate({ dir }, moved)).toBe(0);
    expect(text(moved.out)).toBe(
      `${REMOTES_LOCK_FILE}: 0 added, 1 changed, 0 removed\n  ~ ${DEPLOY} aaaaaaa → bbbbbbb\n`,
    );
    const { 'octo/act@v1': _, ...withoutAct } = SERVED;
    const down = io({}, fakeGitHub({ ...withoutAct, 'octo/ship@v1': B }));
    const before = lockOf(dir);
    expect(await runRemotesUpdate({ dir }, down)).toBe(1);
    expect(text(down.err)).toContain(`remotes: ${ACT}: `);
    expect(text(down.err)).toContain('github.com was read anonymously; a remote not read keeps its entry');
    expect(lockOf(dir)).toBe(before);
  });

  it('exits 2 without workflows, or with an --api-url that is not one', async () => {
    const empty = io();
    expect(await runRemotesUpdate({ dir: checkout({}) }, empty)).toBe(2);
    expect(text(empty.err)).toMatch(/^no workflows under /);
    await expect(runRemotesUpdate({ dir: project(), apiUrl: 'ftp://x' }, io())).rejects.toThrow(
      new FlagError("--api-url takes an http or https URL, not 'ftp://x'"),
    );
  });
});

describe('simulci remotes check', () => {
  it('passes a current lockfile, reading only the pinned files', async () => {
    const dir = await locked();
    const ok = io();
    expect(await runRemotesCheck({ dir }, ok)).toBe(0);
    expect(text(ok.out)).toBe(`${REMOTES_LOCK_FILE}: 2 remotes, up to date\n`);
    expect(ok.calls.map((c) => c.url).filter((u) => u.includes('/commits/'))).toEqual([]);
    const offline = io();
    expect(await runRemotesCheck({ dir, offline: true }, offline)).toBe(0);
    expect(text(offline.out)).toBe(
      `${REMOTES_LOCK_FILE}: 2 remotes, up to date (files not checked: offline)\n`,
    );
    expect(offline.calls).toEqual([]);
    expect(await runRemotesCheck({ dir }, io({ SIMULCI_OFFLINE: '1' }))).toBe(0);
  });

  it('fails a stale lockfile, at the line of its entry', async () => {
    const dir = await locked();
    writeFileSync(join(dir, '.github/workflows/ci.yml'), CI_YML.replace(ACT, 'octo/act@v2'));
    const stale = io();
    expect(await runRemotesCheck({ dir, offline: true }, stale)).toBe(1);
    expect(text(stale.out)).toBe(
      [
        `${REMOTES_LOCK_FILE}:5: octo/act@v1 is locked, but nothing uses it`,
        `${REMOTES_LOCK_FILE}: octo/act@v2 is used, but not locked`,
        'Run `simulci remotes update` to bring the lockfile up to date.',
        '',
      ].join('\n'),
    );
  });

  it('fails a file whose digest differs, and cannot tell (2) when one cannot be read', async () => {
    const dir = await locked();
    const tampered = io(
      undefined,
      fakeGitHub({ ...SERVED, [`octo/act/action.yml@${C}`]: `${ACTION_YML}#\n` }),
    );
    expect(await runRemotesCheck({ dir }, tampered)).toBe(1);
    expect(text(tampered.out)).toContain(`${REMOTES_LOCK_FILE}: ${ACT}: `);
    const { [`octo/act/action.yml@${C}`]: _, ...gone } = SERVED;
    const unread = io(undefined, fakeGitHub(gone));
    expect(await runRemotesCheck({ dir }, unread)).toBe(2);
    expect(text(unread.err)).toContain(`remotes: ${ACT}: `);
    expect(text(unread.err)).toContain('with the token from GH_TOKEN: the files above could not be checked');
    expectNoToken(tampered, unread);
  });

  it('wants a lockfile only for a checkout that uses remotes, and one that reads', async () => {
    const none = io();
    expect(await runRemotesCheck({ dir: project() }, none)).toBe(1);
    expect(text(none.out)).toBe(
      `no ${REMOTES_LOCK_FILE}: run \`simulci remotes update\` to pin the remotes this checkout uses\n`,
    );
    const local = io();
    const plain = checkout({
      '.github/workflows/ci.yml': 'on: push\njobs:\n  a: { runs-on: x, steps: [run: x] }\n',
    });
    expect(await runRemotesCheck({ dir: plain }, local)).toBe(0);
    expect(text(local.out)).toBe('no remotes, and no lockfile\n');
    const broken = io();
    expect(await runRemotesCheck({ dir: project({ [REMOTES_LOCK_FILE]: 'version: 2\n' }) }, broken)).toBe(1);
    expect(text(broken.out)).toMatch(
      /^\.github\/simulci\/remotes\.lock\.yml: .*\nRun `simulci remotes update`/,
    );
  });
});

describe('simulci plan with remotes', () => {
  it('reads nothing in lock mode without a lockfile, and nothing at all with --remotes off', async () => {
    const dir = project();
    const lock = await plan(dir, []);
    expect(lock.calls).toEqual([]);
    expect(lock.text).toContain(`    └ ${DEPLOY} (remote, not fetched)\n  ◐ after — if: `);
    expect(lock.text).toContain(`\nRemotes:\n  ${DEPLOY} (not fetched)\n`);
    const off = await plan(dir, ['--remotes', 'off']);
    expect(off.calls).toEqual([]);
    expect(off.text).toBe(lock.text);
  });

  it('reads the locked commits, never resolving a ref, and plans the remote', async () => {
    const dir = await locked();
    const read = await plan(dir, []);
    expect(read.code).toBe(0);
    expect(read.calls.map((c) => new URL(c.url).pathname).sort()).toEqual([
      '/repos/octo/act/contents/action.yml',
      '/repos/octo/ship/contents/.github/workflows/deploy.yml',
    ]);
    expect(read.text).toContain(
      `\nRemotes:\n  ${ACT} → ccccccc (lockfile)\n  ${DEPLOY} → aaaaaaa (lockfile)\n`,
    );
    expect(read.text).toContain(`${DEPLOY} (remote, aaaaaaa)`);
    expect(read.text).toContain('\n  ● after\n    ● octo/act@v1\n');
  });

  it('gives the same plan for the same inputs, whatever order the answers come in', async () => {
    const dir = await locked();
    let n = 0;
    const late = () => [7, 0, 3][n++ % 3]!;
    const one = await plan(
      dir,
      ['--format', 'json'],
      io(
        undefined,
        fakeGitHub(SERVED, () => 0),
      ),
    );
    const two = await plan(dir, ['--format', 'json'], io(undefined, fakeGitHub(SERVED, late)));
    expect(two.text).toBe(one.text);
    const fetched = await plan(project(), ['--format', 'json', '--remotes', 'fetch']);
    // Read live instead of from the lockfile, the same commits give the same remotes: only the pin differs.
    const remotesOf = (json: string) =>
      JSON.stringify(JSON.parse(json).remotes).replaceAll('"lockfile"', '"resolved"');
    expect(remotesOf(fetched.text)).toBe(remotesOf(one.text));
  });

  it('resolves unpinned refs live in fetch mode, and says when a remote cannot be read', async () => {
    const fetched = await plan(project(), ['--remotes', 'fetch']);
    expect(fetched.text).toContain(`  ${DEPLOY} → aaaaaaa (resolved)\n`);
    expect(fetched.calls.some((c) => c.url.endsWith('/repos/octo/ship/commits/v1'))).toBe(true);
    const dir = await locked();
    const { [`octo/act/action.yml@${C}`]: _, ...gone } = SERVED;
    const missing = await plan(dir, [], io(undefined, fakeGitHub(gone)));
    expect(missing.code).toBe(0);
    expect(missing.text).toContain(`  ${ACT} (not read: not-found)\n`);
    expect(missing.err).toContain(`remotes: ${ACT}: `);
    const offline = await plan(dir, ['--offline']);
    expect(offline.calls).toEqual([]);
    expect(offline.text).toContain(`  ${DEPLOY} (not read: unreachable)\n`);
  });

  it('refuses a mode, an API URL or a repository it does not take', async () => {
    expect(() => planArgs(['--remotes', 'live'])).toThrow(
      new FlagError("--remotes takes off, lock or fetch, not 'live'"),
    );
    const dir = project();
    await expect(plan(dir, ['--api-url', 'not a url'])).rejects.toThrow(
      new FlagError("--api-url takes an http or https URL, not 'not a url'"),
    );
    await expect(plan(dir, [], io({ GITHUB_API_URL: 'file:///x' }))).rejects.toThrow(
      new FlagError("GITHUB_API_URL takes an http or https URL, not 'file:///x'"),
    );
    await expect(plan(dir, ['--repository', 'nope'])).rejects.toThrow(
      new FlagError("--repository takes owner/name, not 'nope'"),
    );
    await expect(plan(dir, [], io({ GITHUB_REPOSITORY: 'a/b/c' }))).rejects.toThrow(
      new FlagError("GITHUB_REPOSITORY takes owner/name, not 'a/b/c'"),
    );
    expect((await plan(dir, ['--repository', 'me/app', '--remotes', 'off'])).code).toBe(0);
  });

  it('sends a token only to its own API, and never prints it', async () => {
    const dir = await locked();
    const ghes = io(
      { GH_TOKEN: TOKEN, GH_ENTERPRISE_TOKEN: 'ghe_ENTERPRISE0123456789', GITHUB_COM_TOKEN: GH },
      fakeGitHub({}),
    );
    const out = await plan(dir, ['--api-url', 'https://ghe.example/api/v3', '--github-com'], ghes);
    for (const call of ghes.calls) {
      const origin = new URL(call.url).origin;
      expect(call.authorization).toBe(
        origin === 'https://ghe.example' ? 'Bearer ghe_ENTERPRISE0123456789' : `Bearer ${GH}`,
      );
    }
    expect(ghes.calls.some((c) => c.url.startsWith('https://api.github.com/'))).toBe(true);
    expect(ghes.secrets).toEqual(['ghe_ENTERPRISE0123456789', GH]);
    expect(out.err).not.toContain('ghe_ENTERPRISE');
    expectNoToken(ghes);
    const fromGh = io({});
    fromGh.gh = () => GH;
    await plan(dir, [], fromGh);
    expect(fromGh.calls.every((c) => c.authorization === `Bearer ${GH}`)).toBe(true);
  });

  it('lists the new flags in kebab case', async () => {
    const help = await renderUsage(planCommand);
    for (const flag of ['--remotes=', '--offline', '--api-url=', '--repository=', '--github-com'])
      expect(help).toContain(flag);
  });
});

describe('simulci test with remotes', () => {
  const run = async (dir: string, flags: string[], with_: Io = io()) => ({
    code: await runTestCommand(testArgs(['--dir', dir, ...flags]), with_),
    out: text(with_.out),
    err: text(with_.err),
    calls: with_.calls,
  });

  it('passes on the locked remotes, and plans the call as maybe with none', async () => {
    const dir = await locked();
    expect((await run(dir, ['--ci'])).code).toBe(0);
    const off = await run(dir, ['--ci', '--remotes', 'off']);
    expect(off.code).toBe(1);
    expect(off.calls).toEqual([]);
  });

  it('exits 2, never another verdict, when a locked file cannot be read or its digest differs', async () => {
    const dir = await locked();
    const { [`octo/ship/.github/workflows/deploy.yml@${A}`]: _, ...gone } = SERVED;
    const missing = await run(dir, ['--ci'], io(undefined, fakeGitHub(gone)));
    expect(missing.code).toBe(2);
    expect(missing.out).toBe('');
    expect(missing.err).toContain(`remotes: ${DEPLOY}: `);
    expect(missing.err).toContain(
      '1 remote could not be read, so the tests would not run as pinned. github.com was read with the token from GH_TOKEN: set GH_TOKEN to a token that can read them, or test without remotes (--remotes off).\n',
    );
    const tampered = await run(
      dir,
      ['--ci'],
      io(
        undefined,
        fakeGitHub({ ...SERVED, [`octo/ship/.github/workflows/deploy.yml@${A}`]: DEPLOY_YML + '#\n' }),
      ),
    );
    expect(tampered.code).toBe(2);
    expect(tampered.err).toContain(
      'Run `simulci remotes update`, or test without remotes (--remotes off).\n',
    );
    const offline = await run(dir, ['--offline']);
    expect([offline.code, offline.calls]).toEqual([2, []]);
    expect(offline.err).toContain('Try again once the API answers');
  });

  it('exits 2 on a lockfile it cannot use', async () => {
    const dir = project({ [REMOTES_LOCK_FILE]: 'remotes: [\n' });
    const broken = await run(dir, []);
    expect(broken.code).toBe(2);
    expect(broken.err).toContain(`remotes: not used: ${REMOTES_LOCK_FILE}: `);
    expect(broken.err).toContain('a lockfile could not be used, so the tests would not run as pinned.');
  });

  it('refuses fetch under --ci or CI=true before reading anything, and allows it locally', async () => {
    const dir = project();
    for (const [flags, env] of [
      [['--ci', '--remotes', 'fetch'], { GH_TOKEN: TOKEN }],
      [['--remotes', 'fetch'], { GH_TOKEN: TOKEN, CI: 'true' }],
    ] as const) {
      const refused = await run(dir, [...flags], io({ ...env }));
      expect(refused.code).toBe(2);
      expect(refused.calls).toEqual([]);
      expect(refused.err).toMatch(
        /^--remotes fetch reads the commit a tag or branch is at now, .*simulci remotes update/,
      );
    }
    expect((await run(dir, ['--remotes', 'fetch'])).code).toBe(0);
  });

  it('reads the remote flags', async () => {
    expect(() => testArgs(['--remotes', 'live'])).toThrow(
      new FlagError("--remotes takes off, lock or fetch, not 'live'"),
    );
    expect(
      testArgs(['--offline', '--api-url', 'https://x', '--repository', 'a/b', '--github-com']),
    ).toMatchObject({
      remotes: 'lock',
      offline: true,
      apiUrl: 'https://x',
      repository: 'a/b',
      githubCom: true,
    });
    const help = await renderUsage(testCommand);
    expect(help).toContain('--remotes=');
  });
});

describe('simulci remotes', () => {
  const root = join(import.meta.dirname, '../../..');
  const simulci = (...args: string[]) => {
    const r = spawnSync(
      join(root, 'node_modules/.bin/tsx'),
      ['--conditions=source', join(root, 'packages/cli/src/index.ts'), ...args],
      { encoding: 'utf8', env: { ...process.env, CI: '', SIMULCI_OFFLINE: '', GH_TOKEN: TOKEN } },
    );
    return [r.status, r.stdout, r.stderr];
  };

  it('runs from source: check offline, and a flag it does not take', () => {
    const plain = checkout({
      '.github/workflows/ci.yml': 'on: push\njobs:\n  a: { runs-on: x, steps: [run: x] }\n',
    });
    expect(simulci('remotes', 'check', '--dir', plain, '--offline')).toEqual([
      0,
      'no remotes, and no lockfile\n',
      '',
    ]);
    expect(simulci('remotes', 'check', '--dir', project(), '--offline')).toEqual([
      1,
      `no ${REMOTES_LOCK_FILE}: run \`simulci remotes update\` to pin the remotes this checkout uses\n`,
      '',
    ]);
    expect(simulci('plan', '--dir', plain, '--remotes', 'live')).toEqual([
      2,
      '',
      "--remotes takes off, lock or fetch, not 'live'\n",
    ]);
  });
});

describe('printable', () => {
  it('leaves out the tokens read and escapes control characters but newlines and tabs', () => {
    expect(printable(`a ${TOKEN}\tb\u001b[2J\r\n`, [TOKEN, 'short'])).toBe('a ***\tb\\u001b[2J\\u000d\n');
    expect(printable('ab', ['ab'])).toBe('ab');
  });
});
