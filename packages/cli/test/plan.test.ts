import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { renderMermaid, renderText, simulate } from '@simulci/engine';
import { renderUsage } from 'citty';
import { describe, expect, it } from 'vitest';
import { readWorkflowFiles } from '@simulci/node';
import { FlagError } from '../src/args';
import { planArgs, planCommand, planOutput, render, scenarioFromArgs } from '../src/plan';

const root = join(import.meta.dirname, '../../..');
const lab = join(root, 'fixtures/routes-lab/repo');
const tsx = join(root, 'node_modules/.bin/tsx');
const cli = join(root, 'packages/cli/src/index.ts');

describe('scenarioFromArgs', () => {
  it('maps flags and key=value lists onto the scenario, typing dispatch inputs', () => {
    expect(
      scenarioFromArgs({
        dir: '.',
        event: 'workflow_dispatch',
        branch: 'main',
        changed: ['a.md', 'b.ts,c.ts'],
        input: ['dry=true', 'count=3', 'name=x'],
        var: 'DEPLOY=true',
        secret: ['NPM_TOKEN', 'OTHER'],
        actor: 'octocat',
        fork: true,
        format: 'text',
        detail: 'steps',
      }),
    ).toEqual({
      event: 'workflow_dispatch',
      branch: 'main',
      changed: ['a.md', 'b.ts', 'c.ts'],
      inputs: { dry: true, count: 3, name: 'x' },
      vars: { DEPLOY: 'true' },
      secrets: ['NPM_TOKEN', 'OTHER'],
      actor: { login: 'octocat', fork: true },
    });
    expect(
      scenarioFromArgs({ dir: '.', event: 'push', format: 'text', detail: 'steps', fork: false }),
    ).toEqual({ event: 'push' });
  });
});

describe('planArgs', () => {
  it('keeps every value of a repeated flag, and splits only the lists on commas', () => {
    const a = planArgs([
      '--changed',
      'a.md',
      '--changed=b.ts,c.ts',
      '--input',
      'dry=true',
      '--input',
      'count=3',
      '--var',
      'A=1',
      '--var',
      'B=2',
      '--secret',
      'NPM_TOKEN',
      '--secret',
      'OTHER',
      '--assume',
      'build=failure',
      '--assume',
      '{ uses: actions/cache, as: miss }',
      '--branch',
      'main',
      '--fork',
    ]);
    expect(a.assume).toEqual(['build=failure', '{ uses: actions/cache, as: miss }']);
    expect(scenarioFromArgs(a)).toEqual({
      event: 'push',
      branch: 'main',
      changed: ['a.md', 'b.ts', 'c.ts'],
      inputs: { dry: true, count: 3 },
      vars: { A: '1', B: '2' },
      secrets: ['NPM_TOKEN', 'OTHER'],
      actor: { fork: true },
    });
    expect(planArgs(['--secret', 'ONE'])).toMatchObject({
      dir: '.',
      event: 'push',
      secret: ['ONE'],
      format: 'text',
      detail: 'steps',
    });
  });

  it('reads a bare --as-test as jobs, without taking the next flag as its value', () => {
    expect(planArgs(['--as-test', '--event', 'pull_request'])).toMatchObject({
      asTest: 'jobs',
      event: 'pull_request',
    });
    expect(planArgs(['--event', 'pull_request', '--as-test']).asTest).toBe('jobs');
    expect(planArgs(['--as-test', '--no-fork'])).toMatchObject({ asTest: 'jobs', fork: false });
    expect(planArgs(['--as-test', 'steps']).asTest).toBe('steps');
    expect(planArgs(['--asTest=steps']).asTest).toBe('steps');
    expect(planArgs(['--message', '--as-test', '--as-test', '--workflow', 'ci.yml'])).toMatchObject({
      message: '--as-test',
      asTest: 'jobs',
      workflow: 'ci.yml',
    });
    expect(planArgs([]).asTest).toBeUndefined();
    expect(planArgs(['--no-as-test']).asTest).toBeUndefined();
  });

  it('refuses a --format, --detail or --as-test it does not take', () => {
    expect(planArgs(['--format', 'mermaid', '--detail', 'legs'])).toMatchObject({
      format: 'mermaid',
      detail: 'legs',
    });
    expect(() => planArgs(['--format', 'jsno'])).toThrow(
      new FlagError("--format takes text, json or mermaid, not 'jsno'"),
    );
    expect(() => planArgs(['--detail', 'jobs'])).toThrow(
      new FlagError("--detail takes steps or legs, not 'jobs'"),
    );
    expect(() => planArgs(['--as-test', 'bogus'])).toThrow(
      new FlagError("--as-test takes jobs or steps, not 'bogus'"),
    );
    expect(() => planArgs(['--as-test='])).toThrow(new FlagError("--as-test takes jobs or steps, not ''"));
  });

  it('shows its flags in kebab case, and reads their camelCase forms too', async () => {
    const help = await renderUsage(planCommand);
    expect(help).toContain('--assume-file=');
    expect(help).toContain('--as-test=');
    expect(help).not.toMatch(/--[a-z]+[A-Z]/);
    expect(planArgs(['--assume-file', 'a.yml', '--as-test', 'steps'])).toMatchObject({
      assumeFile: 'a.yml',
      asTest: 'steps',
    });
    expect(planArgs(['--assumeFile', 'a.yml', '--asTest', '--fork'])).toMatchObject({
      assumeFile: 'a.yml',
      asTest: 'jobs',
      fork: true,
    });
  });
});

describe('planOutput', () => {
  const io = {
    stderr: () => {},
    env: {},
    fetch: () => Promise.reject(new Error('no network')),
    gh: () => undefined,
  };
  const plan = (...flags: string[]) => planOutput(planArgs(['--dir', lab, '--remotes', 'off', ...flags]), io);

  it('exits 2 with a line saying what is wrong with the input', async () => {
    expect(await plan('--branch', 'a', '--tag', 'b')).toEqual({
      text: 'give one of ref, branch or tag\n',
      code: 2,
    });
    expect(await plan('--as-test', '--workflow', 'nope.yml')).toEqual({
      text: '--workflow nope.yml: no .github/workflows/nope.yml in the checkout\n',
      code: 2,
    });
    expect(await plan('--assume-file', 'nope.yml')).toEqual({
      text: '--assume-file nope.yml: no such file\n',
      code: 2,
    });
    expect((await plan('--assume-file', lab)).text).toMatch(/^--assume-file .*: EISDIR: [^\n]*\n$/);
    expect(await plan('--as-test', '--workflow', '.github/workflows/case-filter-paths.yml')).toMatchObject({
      text: expect.stringMatching(/^workflow: case-filter-paths.yml\n/) as string,
      code: 0,
    });
  });
});

describe('readWorkflowFiles', () => {
  it('reads the workflows and local actions of a checkout', () => {
    const files = readWorkflowFiles(lab);
    expect(Object.keys(files).filter((f) => f.startsWith('.github/workflows/')).length).toBeGreaterThan(20);
    expect(files['.github/actions/comp/action.yml']).toContain('composite');
  });
});

describe('render', () => {
  const plan = simulate({
    files: readWorkflowFiles(lab),
    scenario: { event: 'push', branch: 'main', changed: ['docs/x.md'] },
  });

  it('writes text with a mark per unit and the deciding clause', () => {
    const text = renderText(plan);
    expect(text).toMatch(/^push:main · \d+ of \d+ workflows triggered\n/);
    expect(text).toContain(
      '○ .github/workflows/case-filter-paths.yml — paths [src/**] ← ["docs/x.md"]: false',
    );
    expect(text).toContain('  ○ b — if: ');
    expect(render(plan, 'text')).toBe(text);
  });

  it('writes json and mermaid', () => {
    expect(JSON.parse(render(plan, 'json'))).toMatchObject({ schemaVersion: 1 });
    const mermaid = renderMermaid(plan);
    expect(mermaid).toMatch(/^flowchart LR\n/);
    expect(mermaid).toContain(':::no');
    expect(mermaid).toContain('classDef maybe');
  });
});

describe('simulci plan', () => {
  it('runs from source and prints the plan, with every value of a repeated flag', () => {
    const result = spawnSync(
      tsx,
      [
        '--conditions=source',
        cli,
        'plan',
        '--dir',
        lab,
        '--remotes',
        'off',
        '--event',
        'push',
        '--branch',
        'main',
        '--changed',
        'src/main.txt',
        '--changed',
        'docs/x.md',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('● .github/workflows/case-filter-paths.yml');
    const empty = spawnSync(tsx, ['--conditions=source', cli, 'plan', '--dir', join(root, 'packages')], {
      encoding: 'utf8',
    });
    expect(empty.status).toBe(2);
  });

  it('prints what is wrong with the input on stderr, and exits 2', () => {
    const plan = (...flags: string[]) => {
      const r = spawnSync(tsx, ['--conditions=source', cli, 'plan', '--dir', lab, ...flags], {
        encoding: 'utf8',
      });
      return [r.status, r.stdout, r.stderr];
    };
    expect(plan('--branch', 'a', '--tag', 'b')).toEqual([2, '', 'give one of ref, branch or tag\n']);
    expect(plan('--format', 'jsno')).toEqual([2, '', "--format takes text, json or mermaid, not 'jsno'\n"]);
  });
});
