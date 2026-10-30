import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderUsage } from 'citty';
import { describe, expect, it } from 'vitest';
import { FlagError } from '../src/args';
import { planOutput } from '../src/plan';
import { snapshotPath } from '@simulci/node';
import { runTestCommand, type TestIo, testArgs, testCommand } from '../src/test';

const root = join(import.meta.dirname, '../../..');

/** `simulci test --dir <dir>`, run from source outside CI. */
const simulci = (dir: string, flags: string[], env: Record<string, string> = {}) =>
  spawnSync(
    join(root, 'node_modules/.bin/tsx'),
    ['--conditions=source', join(root, 'packages/cli/src/index.ts'), 'test', '--dir', dir, ...flags],
    { encoding: 'utf8', env: { ...process.env, CI: '', GITHUB_ACTIONS: '', SIMULCI_DEBUG: '', ...env } },
  );

const ci = `
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - id: t
        run: npm test
  deploy:
    needs: build
    if: vars.DEPLOY == 'true'
    runs-on: ubuntu-latest
    steps: [{ run: ./deploy }]
`;

const tests = `
workflow: ci.yml
given: { event: push, branch: main }
cases:
  - name: main
    when: {}
    then: { run: [build], skip: [deploy] }
  - name: wrong
    when: { vars: { DEPLOY: 'true' } }
    then:
      skip: [deploy]
  - name: snap
    when: {}
    snapshot: true
`;

function checkout(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'simulci-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

function io(env: Record<string, string> = {}): TestIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    env,
    fetch: () => Promise.reject(new Error('no network')),
    gh: () => undefined,
  };
}

describe('simulci test', () => {
  it('runs the tests of a checkout, reports, writes a snapshot locally and fails on it under ci', async () => {
    const dir = checkout({ '.github/workflows/ci.yml': ci, '.github/simulci/tests/ci.test.yml': tests });
    const local = io();
    expect(await runTestCommand({ dir }, local)).toBe(1);
    const text = local.out.join('');
    expect(text).toContain(
      '.github/simulci/tests/ci.test.yml → ci.yml\n  ✓ main\n  ✗ wrong\n      skip[0]: expected deploy to skip; it runs\n',
    );
    expect(text).toContain('        at 11:14\n');
    expect(text).toContain('  ✓ snap\n      · snapshot written\n');
    expect(text).toContain('\n2 passed · 1 failed · 0 invalid · 0 skipped · exit 1\n');
    const snap = JSON.parse(
      readFileSync(join(dir, snapshotPath('.github/simulci/tests/ci.test.yml')), 'utf8'),
    ) as { cases: Record<string, unknown> };
    expect(Object.keys(snap.cases)).toEqual(['snap']);
    expect(snapshotPath('.github/simulci/tests/ci.test.yml')).toBe(
      '.github/simulci/tests/__snapshots__/ci.test.snap.json',
    );

    const again = io({ CI: 'true', GITHUB_ACTIONS: 'true' });
    expect(await runTestCommand({ dir, filter: 'snap' }, again)).toBe(0);
    expect(again.out.join('')).toContain('  ✓ snap\n');
    const fresh = checkout({ '.github/workflows/ci.yml': ci, '.github/simulci/tests/ci.test.yml': tests });
    const ciRun = io({ CI: 'true', GITHUB_ACTIONS: 'true' });
    expect(await runTestCommand({ dir: fresh, junit: join(fresh, 'out/junit.xml') }, ciRun)).toBe(1);
    const out = ciRun.out.join('');
    expect(out).toContain(
      "snapshot: no snapshot for 'snap' (CI=true never writes one; run simulci test -u and commit it)",
    );
    expect(out).toContain(
      '::error file=.github/simulci/tests/ci.test.yml,line=11,col=14,title=simulci%3A wrong::skip[0]: expected deploy to skip; it runs%0A',
    );
    expect(out).toContain('::notice file=.github/workflows/ci.yml,line=');
    const junit = readFileSync(join(fresh, 'out/junit.xml'), 'utf8');
    expect(junit).toContain('<testsuites name="simulci" tests="3" failures="2" errors="0" skipped="0">');
    expect(junit).toContain('<testcase classname=".github/simulci/tests/ci.test.yml" name="wrong" time="0">');
    expect(junit).toContain('<failure type="assertion" message="skip[0]: expected deploy to skip; it runs">');
  });

  it('refuses test files under .github/workflows, and applies --assume to every case', async () => {
    const misplaced = checkout({ '.github/workflows/ci.yml': ci, '.github/workflows/x.test.yml': tests });
    const bad = io();
    expect(
      await runTestCommand({ dir: misplaced, files: [join(misplaced, '.github/workflows/x.test.yml')] }, bad),
    ).toBe(2);
    expect(bad.err.join('')).toMatch(/^T000 .*would be run by GitHub/);
    const dir = checkout({
      '.github/workflows/ci.yml': ci,
      '.github/simulci/tests/ci.test.yml':
        'workflow: ci.yml\ncases:\n  - { name: x, when: { event: push, branch: main }, then: { conclusion: failure } }\n',
    });
    expect(await runTestCommand({ dir }, io())).toBe(1);
    expect(await runTestCommand({ dir, assume: 'build.t=failure' }, io())).toBe(0);
    const unread = io();
    expect(await runTestCommand({ dir, assumeFile: join(dir, 'nope.yml') }, unread)).toBe(2);
    expect(unread.err.join('')).toBe(`--assume-file ${join(dir, 'nope.yml')}: no such file\n`);
    const missing = io();
    expect(
      await runTestCommand({ dir, files: [join(dir, '.github/simulci/tests/nope.test.yml')] }, missing),
    ).toBe(2);
    expect(missing.err.join('')).toBe('T000 .github/simulci/tests/nope.test.yml: no such test file\n');
    const none = io();
    expect(await runTestCommand({ dir: checkout({ '.github/workflows/ci.yml': ci }) }, none)).toBe(2);
    expect(none.out.join('')).toContain('T000 no test files');
  });
});

describe('testArgs', () => {
  it('keeps every --assume whole, and every test file named', () => {
    expect(
      testArgs([
        'a.test.yml',
        '--assume',
        'build.t=failure',
        '-t',
        'main',
        '--assume',
        '{ job: deploy, outcome: success }',
        'b.test.yml',
      ]),
    ).toMatchObject({
      dir: '.',
      files: ['a.test.yml', 'b.test.yml'],
      filter: 'main',
      assume: ['build.t=failure', '{ job: deploy, outcome: success }'],
    });
    expect(testArgs(['-u']).files).toBeUndefined();
  });

  it('refuses a --snapshot-detail it does not take, and reads the camelCase forms of its flags', async () => {
    expect(testArgs([]).snapshotDetail).toBe('steps');
    expect(testArgs(['--snapshot-detail', 'legs', '--assume-file', 'm.yml'])).toMatchObject({
      snapshotDetail: 'legs',
      assumeFile: 'm.yml',
    });
    expect(testArgs(['--snapshotDetail=legs', '--assumeFile', 'm.yml'])).toMatchObject({
      snapshotDetail: 'legs',
      assumeFile: 'm.yml',
    });
    expect(() => testArgs(['--snapshot-detail', 'jobs'])).toThrow(
      new FlagError("--snapshot-detail takes steps or legs, not 'jobs'"),
    );
    const help = await renderUsage(testCommand);
    expect(help).toContain('--snapshot-detail=');
    expect(help).toContain('--assume-file=');
    expect(help).not.toMatch(/--[a-z]+[A-Z]/);
  });

  it('applies every --assume from the command line', () => {
    const dir = checkout({
      '.github/workflows/ci.yml': `
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - { id: a, run: ./a }
      - { id: b, run: ./b }
      - { id: c, if: "steps.a.outputs.go == 'yes' && steps.b.outputs.go == 'yes'", run: ./c }
`,
      '.github/simulci/tests/ci.test.yml':
        'workflow: ci.yml\ncases:\n  - { name: c, when: { event: push }, then: { units: { build.c: { runs: yes } } } }\n',
    });
    const both = simulci(dir, ['--assume', 'build.a.outputs.go=yes', '--assume', 'build.b.outputs.go=yes']);
    expect(both.status, both.stdout + both.stderr).toBe(0);
    expect(simulci(dir, ['--assume', 'build.a.outputs.go=yes']).status).toBe(1);
  });

  it('exits 2 with one line for a value it does not take, or an error it does not expect', () => {
    const dir = checkout({
      '.github/workflows/ci.yml': ci,
      '.github/simulci/tests/ci.test.yml':
        'workflow: ci.yml\ncases:\n  - { name: x, when: { event: push, branch: main }, then: { run: [build] } }\n',
    });
    const bad = simulci(dir, ['--snapshot-detail', 'jobs']);
    expect([bad.status, bad.stdout, bad.stderr]).toEqual([
      2,
      '',
      "--snapshot-detail takes steps or legs, not 'jobs'\n",
    ]);
    // The JUnit report's directory would be under a file.
    const junit = join(dir, '.github/workflows/ci.yml/out/junit.xml');
    const crash = simulci(dir, ['--junit', junit]);
    expect([crash.status, crash.stderr]).toEqual([
      2,
      `ENOTDIR: not a directory, mkdir '${join(dir, '.github/workflows/ci.yml/out')}'\n`,
    ]);
    expect(crash.stdout).toContain('1 passed · 0 failed');
    const debug = simulci(dir, ['--junit', junit], { SIMULCI_DEBUG: '1' });
    expect(debug.stderr).toMatch(/^Error: ENOTDIR: [^\n]*\n {4}at /);
  });
});

describe('simulci plan --as-test', () => {
  it('prints a test case for the scenario, with the assumptions given', async () => {
    const dir = checkout({ '.github/workflows/ci.yml': ci });
    const out = await planOutput(
      {
        dir,
        event: 'push',
        branch: 'main',
        format: 'text',
        detail: 'steps',
        asTest: 'steps',
        assume: 'build.t=failure',
      },
      io(),
    );
    expect(out.code).toBe(0);
    expect(out.text).toBe(`workflow: ci.yml
cases:
  - name: push main with 1 assumption
    when:
      event: push
      branch: main
      assume:
        - step: build.t
          outcome: failure
    then:
      run:
        - build
      skip:
        - deploy
      conclusion: failure
      units:
        build.t:
          runs: yes
`);
    expect(
      (
        await planOutput(
          { dir, event: 'push', branch: 'main', format: 'text', detail: 'steps', assume: 'nonsense' },
          io(),
        )
      ).code,
    ).toBe(2);
  });
});
