/**
 * The Tests tab's run in the worker (synthesis § 5.1): the route tests of a load, run as `simulci test` runs them,
 * against the load's read-only snapshots, with what the tab offers for each case.
 */
import { loadFiles, runTests, type Snapshot } from '@simulci/engine';
import { describe, expect, it } from 'vitest';
import { snapshotPath } from '../src/lib/snapshot-path';
import { handle, initialState } from '../src/worker/handle';
import type { TestedResponse } from '../src/worker/protocol';
import { NOT_WRITTEN, readOnlySnapshots } from '../src/worker/tests';

const files = {
  '.github/workflows/ci.yml': `on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps: [{ run: make }]
  deploy:
    needs: build
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps: [{ run: ./deploy }]
`,
};

const TEST = '.github/simulci/tests/ci.test.yml';
const tests = {
  [TEST]: `workflow: ci.yml
given: { event: push }
cases:
  - name: main deploys
    when: { branch: main, assume: [{ job: build, outcome: success }] }
    then: { run: [build, deploy] }
  - name: a branch deploys too
    when: { branch: main }
    then: { skip: [deploy] }
  - name: the plan of main
    when: { branch: main }
    snapshot: true
`,
};

/** The project loaded with these tests and snapshots, then run. */
function run(ci: boolean, readonly: Record<string, string> = {}, more: Record<string, string> = {}) {
  const loaded = handle(initialState(), {
    id: 1,
    type: 'load',
    files,
    tests: { ...tests, ...more },
    readonly,
  });
  if (loaded.response.type !== 'loaded') throw new Error(JSON.stringify(loaded.response));
  const r = handle(loaded.state, { id: 2, type: 'test', project: loaded.response.project, ci });
  if (r.response.type !== 'tested') throw new Error(JSON.stringify(r.response));
  return r.response;
}

const caseNamed = (r: TestedResponse, name: string) => r.files[0]!.cases.find((c) => c.name === name)!;

/** The snapshot `simulci test -u` writes for the test file, as its JSON text. */
function written(): string {
  let snapshot: Snapshot | undefined;
  runTests(loadFiles(files), [{ path: TEST, text: tests[TEST] }], {
    update: true,
    snapshots: { read: () => undefined, write: (_, s) => (snapshot = s) },
  });
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

describe('the route tests run in the worker', () => {
  it('reports what simulci test --ci reports, a missing snapshot failed with its headline', () => {
    const r = run(true);
    expect(r.summary).toEqual({ passed: 1, failed: 2, invalid: 0, skipped: 0 });
    expect(r.exitCode).toBe(1);
    expect(caseNamed(r, 'the plan of main').failures.map((f) => f.headline)).toEqual([
      "snapshot: no snapshot for 'the plan of main' (CI=true never writes one; run simulci test -u and commit it)",
    ]);
    // The same as the engine reports over the same inputs, the plans left out.
    const engine = runTests(loadFiles(files), [{ path: TEST, text: tests[TEST] }], {
      ci: true,
      snapshots: readOnlySnapshots({}),
    });
    expect(r.summary).toEqual(engine.summary);
    expect(r.files[0]!.cases.map((c) => [c.name, c.status])).toEqual(
      engine.files[0]!.cases.map((c) => [c.name, c.status]),
    );
    expect(JSON.stringify(r)).not.toContain('"plan"');
  });

  it('passes a snapshot the read-only files hold, and says it would not write a missing one off CI', () => {
    expect(caseNamed(run(true, { [snapshotPath(TEST)]: written() }), 'the plan of main').status).toBe(
      'passed',
    );
    const local = caseNamed(run(false), 'the plan of main');
    expect(local.status).toBe('passed');
    expect(local.notes).toEqual([NOT_WRITTEN]);
  });

  it('refuses only under CI, and honours it off CI', () => {
    const only = {
      '.github/simulci/tests/only.test.yml': `workflow: ci.yml
cases:
  - { name: one, when: { event: push, branch: main }, then: { run: [build] }, only: true }
  - { name: two, when: { event: push, branch: main }, then: { run: [build] } }
`,
    };
    const missing = {
      '.github/simulci/tests/release.test.yml':
        'workflow: release.yml\ncases: [{ name: r, when: { event: push }, then: { run: [x] } }]\n',
    };
    const release = run(true, {}, missing).files.find((f) => f.path.endsWith('release.test.yml'))!;
    expect(release.cases[0]).toMatchObject({ status: 'invalid', line: 2 });
    expect(release.cases[0]!.scenario).toBeUndefined();
    const ci = run(true, {}, only).files.find((f) => f.path.endsWith('only.test.yml'))!;
    expect(ci.status).toBe('invalid');
    expect(ci.failures[0]!.headline).toMatch(/^T104 /);
    const local = run(false, {}, only).files.find((f) => f.path.endsWith('only.test.yml'))!;
    expect(local.cases.map((c) => [c.name, c.status, c.reason])).toEqual([
      ['one', 'passed', undefined],
      ['two', 'skipped', 'only elsewhere'],
    ]);
  });

  it('gives each case its line, the workflow line that decided it, and its scenario and mocks', () => {
    const r = run(true);
    const deploys = caseNamed(r, 'main deploys');
    expect(deploys.line).toBe(4);
    expect(deploys.scenario).toEqual({ event: 'push', branch: 'main' });
    expect(deploys.assume).toEqual([{ job: 'build', outcome: 'success' }]);
    expect(deploys.deciding?.file).toBe('.github/workflows/ci.yml');
    const failed = caseNamed(r, 'a branch deploys too');
    expect(failed.status).toBe('failed');
    expect(failed.line).toBe(7);
    // deploy runs, decided by its if: line, which the failure points at.
    expect(failed.failures[0]!.workflowLoc).toMatchObject({ file: '.github/workflows/ci.yml', line: 10 });
    expect(failed.deciding).toEqual(failed.failures[0]!.workflowLoc);
    // A passing case points at the on: line that decided its workflow runs: the branches filter.
    expect(deploys.deciding).toMatchObject({ file: '.github/workflows/ci.yml', line: 3 });
  });

  it('fails the run with the path of a snapshot that is not JSON', () => {
    const loaded = handle(initialState(), {
      id: 1,
      type: 'load',
      files,
      tests,
      readonly: { [snapshotPath(TEST)]: '{' },
    });
    if (loaded.response.type !== 'loaded') throw new Error('not loaded');
    const r = handle(loaded.state, { id: 2, type: 'test', project: loaded.response.project, ci: true });
    expect(r.response).toMatchObject({ type: 'error', kind: 'engine' });
    expect(r.response.type === 'error' && r.response.message).toMatch(
      /__snapshots__\/ci\.test\.snap\.json is not JSON/,
    );
  });

  it('answers a test request for a project it no longer holds as stale', () => {
    const r = handle(initialState(), { id: 1, type: 'test', project: 7, ci: true });
    expect(r.response).toMatchObject({ type: 'error', kind: 'stale' });
  });
});
