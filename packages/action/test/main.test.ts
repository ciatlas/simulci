import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Annotation } from '@simulci/engine';
import { describe, expect, it } from 'vitest';
import { type Ports, run } from '../src/main';

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
const passing = `
workflow: ci.yml
given: { event: push, branch: main }
cases:
  - { name: main, when: {}, then: { run: [build], skip: [deploy] } }
`;
const failing = `
workflow: ci.yml
given: { event: push, branch: main }
cases:
  - { name: main, when: {}, then: { run: [build], conclusion: success } }
  - name: wrong
    when: { vars: { DEPLOY: 'true' } }
    then:
      skip: [deploy]
`;

function checkout(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'simulci-action-'));
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
  failures: string[];
}

function fake(workspace: string, inputs: Record<string, string>): Fake {
  const f: Fake = {
    outputs: {},
    annotations: [],
    summaries: [],
    logs: [],
    failures: [],
    workspace,
    env: {},
    input: (name) => (inputs[name] ?? '').trim(),
    setOutput: (name, value) => {
      f.outputs[name] = value;
    },
    annotate: (a) => f.annotations.push(a),
    summary: async (md) => {
      f.summaries.push(md);
    },
    log: (t) => f.logs.push(t),
    warn: (m) => f.failures.push(`warning: ${m}`),
    fail: (m) => f.failures.push(m),
  };
  return f;
}

describe('the action in test mode', () => {
  it('passes a checkout whose route tests pass, with outputs and a summary', async () => {
    const ws = checkout({ '.github/workflows/ci.yml': ci, '.github/simulci/tests/ci.test.yml': passing });
    const p = fake(ws, {});
    await run(p);
    expect(p.failures).toEqual([]);
    expect(p.outputs).toMatchObject({ passed: 1, failed: 0, invalid: 0, skipped: 0, 'exit-code': 0 });
    expect(p.annotations).toEqual([]);
    expect(p.summaries[0]).toContain('## simulci test: 1 passed · 0 failed · 0 invalid · 0 skipped');
    expect(p.logs.join('')).toContain('  ✓ main\n');
  });

  it('fails the step on a failing case, annotates relative to the workspace, writes the JUnit file', async () => {
    const ws = checkout({
      'sub/.github/workflows/ci.yml': ci,
      'sub/.github/simulci/tests/ci.test.yml': failing,
    });
    const p = fake(ws, { 'working-directory': 'sub', junit: 'reports/simulci.xml', title: 'Route tests' });
    await run(p);
    expect(p.failures).toEqual(['simulci test: 1 failed, 0 invalid, 1 passed (exit 1)']);
    expect(p.outputs).toMatchObject({
      passed: 1,
      failed: 1,
      'exit-code': 1,
      junit: join(ws, 'reports/simulci.xml'),
    });
    expect(p.annotations.map((a) => [a.level, a.file, a.line])).toEqual([
      ['error', 'sub/.github/simulci/tests/ci.test.yml', 9],
      ['notice', 'sub/.github/workflows/ci.yml', 13],
    ]);
    expect(p.annotations[0]!.message).toMatch(/^skip\[0\]: expected deploy to skip; it runs\n/);
    expect(p.summaries[0]).toMatch(/^## Route tests: 1 passed · 1 failed/);
    expect(existsSync(join(ws, 'reports/simulci.xml'))).toBe(true);
  });

  it('honours annotations, summary, filter and assume, and refuses a report outside the workspace', async () => {
    const ws = checkout({ '.github/workflows/ci.yml': ci, '.github/simulci/tests/ci.test.yml': failing });
    const quiet = fake(ws, { annotations: 'false', summary: 'false', filter: 'main' });
    await run(quiet);
    expect(quiet.failures).toEqual([]);
    expect(quiet.annotations).toEqual([]);
    expect(quiet.summaries).toEqual([]);
    expect(quiet.outputs).toMatchObject({ passed: 1, skipped: 1 });
    const mocked = fake(ws, { assume: 'build.t=failure', filter: 'main' });
    await run(mocked);
    expect(mocked.outputs).toMatchObject({ failed: 1 });
    const mapping = fake(ws, {
      assume: '{ step: build.t,  outcome: failure }\n{ step: build.t, outputs: { x: 1 } }',
      filter: 'main',
    });
    await run(mapping);
    expect(mapping.failures).toEqual(['simulci test: 1 failed, 0 invalid, 0 passed (exit 1)']);
    const missing = fake(ws, { files: '.github/simulci/tests/nope.test.yml' });
    await run(missing);
    expect(missing.failures).toEqual(['T000 .github/simulci/tests/nope.test.yml: no such test file']);
    const escaped = fake(ws, { junit: '../outside.xml', filter: 'main' });
    await run(escaped);
    expect(escaped.failures).toEqual([
      '../outside.xml is outside the workspace; reports are written under it',
    ]);
  });

  it('stops early on a bad mode, a checkout without workflows, a misplaced test file or a bad mock', async () => {
    const ws = checkout({ '.github/workflows/ci.yml': ci, '.github/workflows/x.test.yml': passing });
    const mode = fake(ws, { mode: 'lint' });
    await run(mode);
    expect(mode.failures).toEqual(["mode must be test or plan, not 'lint'"]);
    expect(mode.outputs['exit-code']).toBe(2);
    const empty = fake(checkout({ 'README.md': '' }), {});
    await run(empty);
    expect(empty.failures).toEqual(['no workflows under ./.github/workflows']);
    const misplaced = fake(ws, { files: '.github/workflows/x.test.yml' });
    await run(misplaced);
    expect(misplaced.failures[0]).toMatch(
      /^T000 \.github\/workflows\/x\.test\.yml: a test file under \.github\/workflows/,
    );
    const mock = fake(ws, { assume: 'nonsense' });
    await run(mock);
    expect(mock.failures[0]).toMatch(/nonsense/);
  });
});

describe('the action in plan mode', () => {
  it('logs the plan, puts text and the graph in the summary, and counts the triggered workflows', async () => {
    const ws = checkout({ '.github/workflows/ci.yml': ci });
    const p = fake(ws, {
      mode: 'plan',
      scenario: '{ event: push, branch: main }',
      assume: 'build.t=failure',
    });
    await run(p);
    expect(p.failures).toEqual([]);
    expect(p.logs[0]).toContain('● .github/workflows/ci.yml');
    expect(p.summaries[0]).toMatch(/^## simulci plan: push:main\n\n```\n/);
    expect(p.summaries[0]).toContain('```mermaid\n');
    expect(p.outputs).toMatchObject({ triggered: 1, 'exit-code': 0 });
    const json = fake(ws, {
      mode: 'plan',
      scenario: '{ event: push, branch: main }',
      format: 'json',
      summary: 'false',
    });
    await run(json);
    expect(JSON.parse(json.logs[0]!).schemaVersion).toBe(1);
  });

  it('needs a scenario and rejects a bad one', async () => {
    const ws = checkout({ '.github/workflows/ci.yml': ci });
    const none = fake(ws, { mode: 'plan' });
    await run(none);
    expect(none.failures[0]).toMatch(/^scenario is required in plan mode/);
    const bad = fake(ws, { mode: 'plan', scenario: '{ event: push, branch: main, tag: v1 }' });
    await run(bad);
    expect(bad.failures[0]).toMatch(/^scenario: /);
  });
});
