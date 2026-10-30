import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Annotation } from '@simulci/engine';
import { describe, expect, it } from 'vitest';
import { type Ports, run, withoutCommands } from '../src/main';
import { printable } from '../src/remotes';

const SHA = 'a'.repeat(40);
const TOKEN = 'ghs_actionTOKEN0123456789';
const COM_TOKEN = 'ghp_comTOKEN9876543210';
const DEPLOY = `octo/ship/.github/workflows/deploy.yml@${SHA}`;
const PRIVATE = `corp/private/.github/workflows/x.yml@${SHA}`;

/** A remote workflow whose names try to write workflow commands, Markdown, HTML and terminal sequences. */
const DEPLOY_YML = [
  'name: "Deploy ](https://evil.example) <img src=x> \\e[31mred \\u202Eevil"',
  'on: workflow_call',
  'jobs:',
  '  ship:',
  `    if: "vars.SHIP == 'true' || vars.X == '\\e[1m \`\`\`\`\`\` ## injected'"`,
  '    runs-on: ubuntu-latest',
  '    steps: [{ run: ./ship }]',
  '',
].join('\n');

const callerOf = (ref: string) =>
  [
    'on: push',
    'jobs:',
    '  call:',
    `    uses: ${ref}`,
    '  build:',
    '    runs-on: x',
    '    steps: [{ run: t }]',
    '',
  ].join('\n');

const SHIPS = `
workflow: ci.yml
given: { event: push, branch: main }
cases:
  - { name: ships, when: {}, then: { run: [call/ship] } }
`;

interface Call {
  url: string;
  authorization: string | undefined;
}

/** A GitHub API at `apiUrl` serving raw contents at a commit; anything else is a 404 unless `answer` says otherwise. */
function fakeGitHub(
  files: Record<string, string>,
  apiUrl = 'https://api.github.com',
  answer?: (u: URL) => Response | undefined,
) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: { headers: Record<string, string> }) => {
    const headers = Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ url, authorization: headers.authorization });
    const u = new URL(url);
    const special = answer?.(u);
    if (special) return special;
    const base = new URL(apiUrl);
    if (u.origin !== base.origin) return new Response('', { status: 404 });
    const m = /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/.exec(
      u.pathname.slice(base.pathname.replace(/\/$/, '').length),
    );
    const text = m && files[`${m[1]}/${m[2]}/${decodeURIComponent(m[3]!)}@${u.searchParams.get('ref')}`];
    return text === undefined || text === null ? new Response('', { status: 404 }) : new Response(text);
  };
  return { fetch, calls };
}

function checkout(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'simulci-action-remotes-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

interface Fake extends Ports {
  outputs: Record<string, string | number>;
  annotations: Annotation[];
  summaries: string[];
  logs: string[];
  warnings: string[];
  failures: string[];
}

function fake(
  workspace: string,
  inputs: Record<string, string>,
  env: Record<string, string>,
  fetch: Ports['fetch'],
): Fake {
  const f: Fake = {
    outputs: {},
    annotations: [],
    summaries: [],
    logs: [],
    warnings: [],
    failures: [],
    workspace,
    env,
    ...(fetch ? { fetch } : {}),
    input: (name) => (inputs[name] ?? '').trim(),
    setOutput: (name, value) => {
      f.outputs[name] = value;
    },
    annotate: (a) => f.annotations.push(a),
    summary: async (md) => {
      f.summaries.push(md);
    },
    log: (t) => f.logs.push(t),
    warn: (m) => f.warnings.push(m),
    fail: (m) => f.failures.push(m),
  };
  return f;
}

const REMOTE = { [`octo/ship/.github/workflows/deploy.yml@${SHA}`]: DEPLOY_YML };
const RUNNER = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'octo/app' };
const PLAN = { mode: 'plan', scenario: '{ event: push, branch: main }', token: TOKEN };

describe('remotes in the action', () => {
  it('reads a pinned remote with the token, and moves an annotation inside it to the calling uses: line', async () => {
    const gh = fakeGitHub(REMOTE);
    const ws = checkout({
      'sub/.github/workflows/ci.yml': callerOf(DEPLOY),
      'sub/.github/simulci/tests/ci.test.yml': SHIPS,
    });
    const p = fake(ws, { 'working-directory': 'sub', token: TOKEN, junit: 'junit.xml' }, RUNNER, gh.fetch);
    await run(p);
    expect(gh.calls.map((c) => [c.url.split('?')[0], c.authorization])).toEqual([
      ['https://api.github.com/repos/octo/ship/contents/.github/workflows/deploy.yml', `Bearer ${TOKEN}`],
    ]);
    expect(p.failures).toEqual(['simulci test: 1 failed, 0 invalid, 0 passed (exit 1)']);
    expect(p.logs).toContain('remotes: lock, 1 read, 0 not read\n');
    // The `if:` that decided is on line 5 of deploy.yml; the annotation is on the ref the job calls it by.
    expect(p.annotations.map((a) => [a.level, a.file, a.line, a.col])).toEqual([
      ['error', 'sub/.github/simulci/tests/ci.test.yml', 5, expect.any(Number)],
      ['notice', 'sub/.github/workflows/ci.yml', 4, 11],
    ]);
    // The remote's `if:` holds an ESC, which XML 1.0 refuses: the report shows it escaped.
    const junit = readFileSync(join(ws, 'junit.xml'), 'utf8');
    expect(junit).toContain("vars.X == '\\u001b[1m");
    expect(junit).not.toContain(String.fromCharCode(0x1b));
  });

  it('escapes what a remote names in the log, the annotations and the job summary', async () => {
    const ws = checkout({ '.github/workflows/ci.yml': callerOf(DEPLOY) });
    const p = fake(ws, PLAN, RUNNER, fakeGitHub(REMOTE).fetch);
    await run(p);
    expect(p.failures).toEqual([]);
    const all = [...p.logs, ...p.summaries, ...p.warnings].join('\n');
    expect(printable(`a${String.fromCharCode(0xd800)}b${String.fromCharCode(0xfffe)}\r\t\n😀`)).toBe(
      'a\\ud800b\\ufffe\\u000d\t\n😀',
    );
    // The workflow's name is in the graph (an ESC is a space there), its `if:` in the text.
    expect(all).toContain('#lt;img src=x#gt;  [31mred \\u202eevil');
    expect(all).toContain("vars.X == '\\u001b[1m ``````");
    for (const c of [0x1b, 0x202e]) expect(all).not.toContain(String.fromCharCode(c));
    const summary = p.summaries[0]!;
    // Six backticks in an `if:`: the text block's fence is seven, so nothing the remote wrote leaves it.
    const fences = summary.split('\n').filter((l) => l.startsWith('```'));
    expect(fences).toEqual(['```````', '```````', '```mermaid', '```']);
    expect(summary).toMatch(/^## simulci plan: push:main\n\n```````\n/);
    expect(summary).not.toContain('<img');
    expect(summary).toContain('#lt;img src=x#gt;');
  });

  it('reads nothing on pull_request_target and workflow_run, and says why', async () => {
    for (const event of ['pull_request_target', 'workflow_run', 'issue_comment']) {
      const gh = fakeGitHub(REMOTE);
      const ws = checkout({
        '.github/workflows/ci.yml': callerOf(DEPLOY),
        '.github/simulci/tests/ci.test.yml': SHIPS,
      });
      const env = { ...RUNNER, GITHUB_EVENT_NAME: event };
      const test = fake(ws, { token: TOKEN }, env, gh.fetch);
      await run(test);
      const plan = fake(ws, PLAN, env, gh.fetch);
      await run(plan);
      expect(gh.calls).toEqual([]);
      for (const p of [test, plan]) {
        expect(p.warnings).toEqual([
          `remotes: off on ${event}: the run holds this repository's token while a pull request chose the workflows, so no remote workflow or action is read, and calls they lock show as not fetched. Run route tests on pull_request.`,
        ]);
        expect(p.logs.join('')).not.toContain('remotes: lock');
      }
      expect(plan.logs[0]).toContain(`${DEPLOY} (not fetched)`);
    }
    // Asked for off, nothing is said.
    const quiet = fake(
      checkout({ '.github/workflows/ci.yml': callerOf(DEPLOY) }),
      { ...PLAN, remotes: 'off' },
      { GITHUB_EVENT_NAME: 'workflow_run' },
      fakeGitHub(REMOTE).fetch,
    );
    await run(quiet);
    expect(quiet.warnings).toEqual([]);
  });

  it('names the repository a token cannot read, and exits 2 in test mode', async () => {
    const forbidden = (u: URL) =>
      u.pathname.startsWith('/repos/corp/') ? new Response('', { status: 403 }) : undefined;
    const ws = checkout({
      '.github/workflows/ci.yml': callerOf(PRIVATE),
      '.github/simulci/tests/ci.test.yml': SHIPS.replace('call/ship', 'build'),
    });
    const access = `${PRIVATE}: not read (access). GITHUB_TOKEN reads only this repository and public ones. Pass a token that can read corp/private as \`token\` (actions/create-github-app-token, or a fine-grained token).`;
    const test = fake(ws, { token: TOKEN }, RUNNER, fakeGitHub({}, undefined, forbidden).fetch);
    await run(test);
    expect(test.failures).toEqual([access, 'simulci test: 0 failed, 0 invalid, 1 passed (exit 2)']);
    expect(test.outputs).toMatchObject({ passed: 1, 'exit-code': 2 });
    const plan = fake(ws, PLAN, RUNNER, fakeGitHub({}, undefined, forbidden).fetch);
    await run(plan);
    expect(plan.failures).toEqual([]);
    expect(plan.warnings).toEqual([access]);
    // GitHub answers 404 for a private repository the token cannot see: the same advice, as a possibility.
    const hidden = fake(ws, PLAN, RUNNER, fakeGitHub({}).fetch);
    await run(hidden);
    expect(hidden.warnings).toEqual([
      `${PRIVATE}: not read (not-found): .github/workflows/x.yml not found at ${SHA.slice(0, 7)}. If corp/private is private: GITHUB_TOKEN reads only this repository and public ones. Pass a token that can read corp/private as \`token\` (actions/create-github-app-token, or a fine-grained token).`,
    ]);
  });

  it('annotates five unread remotes at most, and logs them all', async () => {
    const refs = Array.from({ length: 7 }, (_, i) => `corp/private/.github/workflows/x${i}.yml@${SHA}`);
    const caller = ['on: push', 'jobs:', ...refs.map((r, i) => `  j${i}: { uses: '${r}' }`), ''].join('\n');
    const forbidden = () => new Response('', { status: 403 });
    const p = fake(
      checkout({ '.github/workflows/ci.yml': caller }),
      PLAN,
      RUNNER,
      fakeGitHub({}, undefined, forbidden).fetch,
    );
    await run(p);
    expect(p.warnings).toHaveLength(5);
    expect(p.warnings[4]).toBe('3 more remotes not read or lockfiles not used: see the log');
    expect(p.logs[0]).toBe('remotes: lock, 0 read, 7 not read\n');
    expect(p.logs[1]!.trimEnd().split('\n')).toHaveLength(7);
  });

  it('never shows the token, whatever GitHub answers', async () => {
    const leaky = (u: URL) => {
      if (u.pathname.startsWith('/repos/corp/'))
        return new Response(`bad credentials: ${TOKEN}`, { status: 401, statusText: `Bad ${TOKEN}` });
      if (u.pathname.startsWith('/repos/octo/')) throw new Error(`socket closed while sending ${TOKEN}`);
      return undefined;
    };
    const caller = [
      'on: push',
      'jobs:',
      `  a: { uses: '${PRIVATE}' }`,
      `  b: { uses: '${DEPLOY}' }`,
      '',
    ].join('\n');
    const ws = checkout({
      '.github/workflows/ci.yml': caller,
      '.github/simulci/tests/ci.test.yml': SHIPS.replace('call/ship', 'b/ship'),
    });
    const shown: string[] = [];
    const runs: Record<string, string>[] = [
      { token: TOKEN, junit: 'junit.xml' },
      { ...PLAN, format: 'json' },
    ];
    for (const inputs of runs) {
      const p = fake(ws, inputs, RUNNER, fakeGitHub({}, undefined, leaky).fetch);
      await run(p);
      expect(p.failures.length + p.warnings.length).toBeGreaterThan(0);
      shown.push(JSON.stringify([p.logs, p.warnings, p.failures, p.annotations, p.summaries, p.outputs]));
    }
    shown.push(readFileSync(join(ws, 'junit.xml'), 'utf8'));
    expect(shown.join('\n')).toContain('the GitHub API rejected the token');
    expect(shown.join('\n')).not.toContain(TOKEN);
    expect(shown.join('\n')).not.toContain(TOKEN.slice(4));
  }, 20_000);

  it('sends each token only to its own API: the GHES token to the server, github-com-token to github.com', async () => {
    const ghesApi = 'https://ghes.example/api/v3';
    const both = (u: URL) =>
      u.host === 'api.github.com' && u.pathname.includes('/contents/') ? new Response(DEPLOY_YML) : undefined;
    const gh = fakeGitHub({}, ghesApi, both);
    const ws = checkout({ '.github/workflows/ci.yml': callerOf(DEPLOY) });
    const inputs = { ...PLAN, 'api-url': ghesApi, 'github-com-token': COM_TOKEN };
    const p = fake(ws, inputs, { ...RUNNER, GITHUB_API_URL: ghesApi }, gh.fetch);
    await run(p);
    expect(p.failures).toEqual([]);
    expect(gh.calls.length).toBeGreaterThan(1);
    for (const c of gh.calls)
      expect(c.authorization).toBe(
        new URL(c.url).host === 'api.github.com' ? `Bearer ${COM_TOKEN}` : `Bearer ${TOKEN}`,
      );
    expect(p.logs[0]).not.toContain('(not fetched)');
    // Without github-com-token, github.com is never asked.
    const alone = fakeGitHub({}, ghesApi, both);
    await run(fake(ws, { ...PLAN, 'api-url': ghesApi }, RUNNER, alone.fetch));
    expect(alone.calls.every((c) => new URL(c.url).host === 'ghes.example')).toBe(true);
  });

  it('reads with the token input only: never one from the environment, and never over http', async () => {
    const gh = fakeGitHub(REMOTE);
    const ws = checkout({ '.github/workflows/ci.yml': callerOf(DEPLOY) });
    const env = { ...RUNNER, GH_TOKEN: 'ghp_env', GITHUB_TOKEN: 'ghs_env', GH_ENTERPRISE_TOKEN: 'ghe_env' };
    const anonymous = fake(ws, { ...PLAN, token: '' }, env, gh.fetch);
    await run(anonymous);
    expect(anonymous.failures).toEqual([]);
    expect(gh.calls.map((c) => c.authorization)).toEqual([undefined]);
    const http = fake(ws, { ...PLAN, 'api-url': 'http://ghes.example/api/v3' }, RUNNER, gh.fetch);
    await run(http);
    expect(http.failures).toEqual([
      "api-url must be https:// when a token is set, not 'http://ghes.example/api/v3'",
    ]);
    expect(gh.calls).toHaveLength(1);
  });

  it('refuses fetch in test mode and an unknown mode', async () => {
    const ws = checkout({
      '.github/workflows/ci.yml': callerOf(DEPLOY),
      '.github/simulci/tests/ci.test.yml': SHIPS,
    });
    const live = fake(ws, { remotes: 'fetch' }, RUNNER, fakeGitHub(REMOTE).fetch);
    await run(live);
    expect(live.failures).toEqual([
      'remotes: fetch resolves refs live, so a test could pass today and fail when a tag moves; pin them with `simulci remotes update` and use lock',
    ]);
    expect(live.outputs['exit-code']).toBe(2);
    const odd = fake(ws, { remotes: 'always' }, RUNNER, undefined);
    await run(odd);
    expect(odd.failures).toEqual(["remotes must be off, lock or fetch, not 'always'"]);
  });

  it('gives the engine GITHUB_REPOSITORY, unless the scenario names a repository', async () => {
    // `secrets: inherit` to another owner passes only GITHUB_TOKEN (lab R6): the owner is the repository's.
    const inherit = `octo/ship/.github/workflows/inherit.yml@${SHA}`;
    const body = [
      'on: workflow_call',
      'jobs:',
      '  ship:',
      '    runs-on: x',
      '    env:',
      '      K: ${{ secrets.KEY }}',
      "    steps: [{ id: s, if: env.K != '', run: t }]",
      '',
    ].join('\n');
    const remote = { [inherit]: body };
    const ws = checkout({
      '.github/workflows/ci.yml': `on: push\njobs:\n  call:\n    secrets: inherit\n    uses: ${inherit}\n`,
      '.github/simulci/tests/ci.test.yml': [
        'workflow: ci.yml',
        'given: { event: push, branch: main, secrets: [KEY] }',
        'cases:',
        '  - { name: withheld, when: {}, then: { skip: [call/ship.s] } }',
        '',
      ].join('\n'),
    });
    const verdict = async (
      repository: string | undefined,
      scenario = '{ event: push, branch: main, secrets: [KEY] }',
    ) => {
      const env: Record<string, string> = repository ? { GITHUB_REPOSITORY: repository } : {};
      const p = fake(
        ws,
        { ...PLAN, scenario, format: 'json', summary: 'false' },
        env,
        fakeGitHub(remote).fetch,
      );
      await run(p);
      expect(p.failures).toEqual([]);
      const plan = JSON.parse(p.logs.find((l) => l.startsWith('{'))!);
      return plan.workflows[0].jobs[0].legs[0].call.jobs[0].legs[0].steps[0].runs.verdict;
    };
    expect(await verdict('other/app')).toBe('no');
    expect(await verdict('octo/app')).toBe('maybe');
    expect(
      await verdict('other/app', '{ event: push, branch: main, secrets: [KEY], repository: octo/app }'),
    ).toBe('maybe');
    const test = async (repository: string) => {
      const p = fake(ws, { token: TOKEN }, { GITHUB_REPOSITORY: repository }, fakeGitHub(remote).fetch);
      await run(p);
      return p.outputs;
    };
    expect(await test('other/app')).toMatchObject({ passed: 1, 'exit-code': 0 });
    expect(await test('octo/app')).toMatchObject({ failed: 1, 'exit-code': 1 });
  });

  it('logs between stop-commands and a one-time token, so a remote line is never a workflow command', () => {
    const text = 'plan\n  ::error::injected\n##[add-mask]x\n';
    expect(withoutCommands(text, 'f00d')).toBe(
      '::stop-commands::f00d\nplan\n  ::error::injected\n##[add-mask]x\n::f00d::',
    );
  });
});
