import {
  matchesRepo,
  modelFor,
  type RunPlan,
  type ScenarioInput,
  SHIPPED_MODELS,
  type StepPlan,
  simulate,
  usesRepo,
} from '@simulci/engine';
import { describe, expect, it, vi } from 'vitest';
import { anyMatcher, matcher } from '../src/models/changes';

const run = (yaml: string, scenario: ScenarioInput, assume: unknown[] = []): RunPlan =>
  simulate({ files: { '.github/workflows/ci.yml': yaml }, scenario, assume: assume as never });

const steps = (plan: RunPlan, job = 0): StepPlan[] => plan.workflows[0]!.jobs[job]!.legs[0]!.steps!;
const verdicts = (plan: RunPlan) =>
  Object.fromEntries(plan.workflows[0]!.jobs.map((j) => [j.jobId, j.runs.verdict]));
const codes = (plan: RunPlan) => plan.diagnostics.map((d) => d.code);
const value = (v: { known: boolean; value?: unknown }) => (v.known ? v.value : v);

describe('shipped models: registry', () => {
  it('matches an action by repository, sub-action and any ref, case-insensitively', () => {
    expect(usesRepo('Actions/Cache@v4')).toBe('actions/cache');
    expect(usesRepo('actions/cache/restore')).toBe('actions/cache/restore');
    expect(matchesRepo('actions/cache', 'actions/cache/restore@v4')).toBe(true);
    expect(matchesRepo('actions/cache', 'actions/cache-extra@v1')).toBe(false);
    expect(modelFor('actions/cache@v4')?.id).toBe('actions/cache');
    expect(modelFor('actions/cache/restore@v4')?.id).toBe('actions/cache');
    expect(modelFor('actions/cache/save@v4')).toBeUndefined();
    expect(modelFor('dorny/paths-filter@v3')?.id).toBe('dorny/paths-filter');
    expect(modelFor('tj-actions/changed-files@v46')?.id).toBe('tj-actions/changed-files');
    expect(modelFor('./.github/actions/x')).toBeUndefined();
    expect(SHIPPED_MODELS.map((m) => m.id)).toEqual([
      'actions/cache',
      'dorny/paths-filter',
      'tj-actions/changed-files',
    ]);
  });

  it('matches changed files the way the actions do: dot files, globstar, ordered negation', () => {
    // tj-actions/changed-files: micromatch over the list (positives minus negatives, negatives alone mean all but).
    const m = matcher(['src/**', '!src/**/*.md', '.github/**']);
    expect(m('src/a/b.ts')).toBe(true);
    expect(m('src/a/README.md')).toBe(false);
    expect(m('.github/workflows/ci.yml')).toBe(true);
    expect(m('docs/a.md')).toBe(false);
    expect(matcher([])('anything')).toBe(false);
    expect(matcher(['!src/**'])('src/a.ts')).toBe(false);
    expect(matcher(['!src/**'])('docs/a.md')).toBe(true);
    // dorny/paths-filter: each pattern alone, any wins; a negated pattern names everything else.
    const any = anyMatcher(['src/**', '!src/**/*.md']);
    expect(any('src/a.ts')).toBe(true);
    expect(any('src/README.md')).toBe(true);
    expect(any('docs/a.md')).toBe(true);
    expect(anyMatcher(['src/**'])('docs/a.md')).toBe(false);
    expect(anyMatcher(['!**/*.md'])('docs/a.md')).toBe(false);
  });
});

const cacheWorkflow = (extra = '') => `
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - id: cache
        uses: actions/cache@v4
        with:
          path: ~/.npm
          key: npm-lock${extra}
      - if: steps.cache.outputs.cache-hit != 'true'
        run: npm ci
`;

describe('shipped models: actions/cache', () => {
  it('leaves cache-hit one of true, false or empty, so the install step may run, and lists the model', () => {
    const plan = run(cacheWorkflow(), { event: 'push' });
    const [cache, install] = steps(plan);
    expect(cache!.outputs).toEqual({
      'cache-hit': {
        known: false,
        unknowns: [`${cache!.id}.outputs.cache-hit`],
        oneOf: ['true', 'false', ''],
      },
      'cache-primary-key': { known: true, value: 'npm-lock', by: 'model:actions/cache' },
      'cache-matched-key': { known: false, unknowns: [`${cache!.id}.outputs.cache-matched-key`] },
    });
    expect(cache!.outcome).toEqual({ known: true, value: 'success' });
    expect(install!.runs.verdict).toBe('maybe');
    expect(plan.models).toEqual([{ id: 'actions/cache', version: '1' }]);
    expect(plan.mocks).toEqual([
      {
        ref: 'model:actions/cache',
        layer: 'shipped',
        at: cache!.id,
        provides: ['outputs.cache-hit', 'outputs.cache-primary-key', 'outputs.cache-matched-key'],
      },
    ]);
    expect(plan.unknowns.map((u) => u.id)).toContain(`${cache!.id}.outputs.cache-hit`);
    expect(codes(plan)).toEqual([]);
  });

  it('models: [] switches the shipped models off', () => {
    const plan = simulate({
      files: { '.github/workflows/ci.yml': cacheWorkflow() },
      scenario: { event: 'push' },
      models: [],
    });
    expect(plan.models).toEqual([]);
    expect(steps(plan)[0]!.outputs).toEqual({});
    expect(steps(plan)[1]!.runs.verdict).toBe('maybe');
  });

  it('as: hit skips the install step; as: partial and as: miss run it', () => {
    for (const [as, expected] of [
      ['hit', 'no'],
      ['partial', 'yes'],
      ['miss', 'yes'],
    ] as const) {
      const plan = run(cacheWorkflow(), { event: 'push' }, [{ uses: 'actions/cache', as }]);
      const [cache, install] = steps(plan);
      expect(install!.runs.verdict, as).toBe(expected);
      expect(cache!.outcome, as).toEqual({ known: true, value: 'success' });
      expect(plan.mocks[0], as).toMatchObject({
        ref: 'assume[0]',
        provides: ['outcome', 'outputs.cache-hit'],
      });
      expect(codes(plan), as).toEqual([]);
    }
  });

  it('as: miss with fail-on-cache-miss fails the step and the job', () => {
    const plan = run(cacheWorkflow('\n          fail-on-cache-miss: true'), { event: 'push' }, [
      { step: 'build.cache', as: 'miss' },
    ]);
    expect(steps(plan)[0]!.outcome).toEqual({ known: true, value: 'failure' });
    expect(value(plan.workflows[0]!.jobs[0]!.result)).toBe('failure');
    // Unpinned, fail-on-cache-miss ties the outcome to the hit.
    const open = run(cacheWorkflow('\n          fail-on-cache-miss: true'), { event: 'push' });
    expect(steps(open)[0]!.outcome).toEqual({
      known: false,
      unknowns: [`${steps(open)[0]!.id}.outputs.cache-hit`],
      oneOf: ['success', 'failure'],
    });
  });

  it("an entry's own fields win over its preset, and a partial pin composes with the model", () => {
    const plan = run(cacheWorkflow(), { event: 'push' }, [
      { uses: 'actions/cache', as: 'hit', outputs: { 'cache-matched-key': 'npm-lock' } },
    ]);
    const cache = steps(plan)[0]!;
    expect(value(cache.outputs['cache-hit']!)).toBe('true');
    expect(cache.outputs['cache-matched-key']).toEqual({ known: true, value: 'npm-lock', by: 'assume[0]' });
    expect(cache.outputs['cache-primary-key']).toEqual({
      known: true,
      value: 'npm-lock',
      by: 'model:actions/cache',
    });
  });

  it('reports an unknown preset (SC105) once, and a preset on a unit without a model', () => {
    const plan = run(cacheWorkflow(), { event: 'push' }, [{ uses: 'actions/cache', as: 'bogus' }]);
    expect(codes(plan)).toEqual(['SC105']);
    expect(plan.diagnostics[0]!.message).toContain(
      "as 'bogus' names no preset of actions/cache (presets: hit, partial, miss)",
    );
    const script = run(cacheWorkflow(), { event: 'push' }, [{ step: 'build.#2', as: 'hit' }]);
    expect(codes(script)).toEqual(['SC105']);
    expect(script.diagnostics[0]!.message).toContain('a unit without a model');
  });

  it('validates author outputs against the model interface (SC101)', () => {
    const plan = run(cacheWorkflow(), { event: 'push' }, [{ uses: 'actions/cache', outputs: { nope: '1' } }]);
    expect(codes(plan)).toEqual(['SC101']);
    expect(plan.diagnostics[0]!.message).toContain('actions/cache (model) does not declare');
  });
});

const filterWorkflow = (filters: string) => `
on: pull_request
jobs:
  changes:
    runs-on: ubuntu-latest
    outputs:
      src: \${{ steps.filter.outputs.src }}
      docs: \${{ steps.filter.outputs.docs }}
    steps:
      - id: filter
        uses: dorny/paths-filter@v3
        with:
          filters: ${filters}
  test:
    needs: changes
    if: needs.changes.outputs.src == 'true'
    runs-on: ubuntu-latest
    steps: [{ run: npm test }]
  docs:
    needs: changes
    if: needs.changes.outputs.docs == 'true'
    runs-on: ubuntu-latest
    steps: [{ run: npm run docs }]
`;

const FILTERS = `|
            src:
              - 'src/**'
            docs:
              - added|modified: 'docs/**'`;

describe('shipped models: dorny/paths-filter', () => {
  it('decides each filter from the changed files, with statuses, and the changes list', () => {
    const plan = run(filterWorkflow(FILTERS), { event: 'pull_request', changed: ['src/a.ts', 'src/b.md'] });
    expect(verdicts(plan)).toEqual({ changes: 'yes', test: 'yes', docs: 'no' });
    const filter = steps(plan)[0]!;
    expect(value(filter.outputs.src!)).toBe('true');
    expect(value(filter.outputs.docs!)).toBe('false');
    expect(value(filter.outputs.changes!)).toBe('["src"]');
    expect(codes(plan)).toEqual([]);

    const removed = run(filterWorkflow(FILTERS), {
      event: 'pull_request',
      changed: [
        { path: 'docs/x.md', status: 'removed' },
        { path: 'docs/y.md', status: 'added' },
      ],
    });
    expect(verdicts(removed)).toEqual({ changes: 'yes', test: 'no', docs: 'yes' });
    const onlyRemoved = run(filterWorkflow(FILTERS), {
      event: 'pull_request',
      changed: [{ path: 'docs/x.md', status: 'removed' }],
    });
    expect(verdicts(onlyRemoved)).toEqual({ changes: 'yes', test: 'no', docs: 'no' });
  });

  it('prints no YAML warning: one would quote the filters, another repository’s text, on stderr', () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    try {
      const filters = "|\n            src: '**'\n            ::error::forged: !x y";
      run(filterWorkflow(filters), { event: 'pull_request', changed: ['src/a.ts'] });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('without changed files every filter is unknown, pinned by the scenario', () => {
    const plan = run(filterWorkflow(FILTERS), { event: 'pull_request' });
    expect(verdicts(plan)).toEqual({ changes: 'yes', test: 'maybe', docs: 'maybe' });
    expect(steps(plan)[0]!.outputs.src).toEqual({ known: false, unknowns: ['scenario.changed'] });
    const u = plan.unknowns.find((x) => x.id === 'scenario.changed')!;
    expect(u.kind).toBe('changed-files');
    expect(u.pin).toEqual({ layer: 'scenario', fragment: { changed: ['path/to/file'] }, at: ['when'] });
  });

  it('an unreadable filters value leaves the interface open and changes unknown', () => {
    const plan = run(
      filterWorkflow('${{ secrets.FILTERS }}'),
      { event: 'pull_request', changed: ['src/a.ts'] },
      [{ step: 'changes.filter', outputs: { src: 'true' } }],
    );
    const filter = steps(plan)[0]!;
    expect(filter.outputs.changes).toEqual({ known: false, unknowns: [`${filter.id}.outputs.changes`] });
    expect(value(filter.outputs.src!)).toBe('true');
    expect(codes(plan)).toEqual([]);
    expect(verdicts(plan)).toEqual({ changes: 'yes', test: 'yes', docs: 'maybe' });
  });
});

const changedFilesWorkflow = (with_ = '') => `
on: push
jobs:
  files:
    runs-on: ubuntu-latest
    steps:
      - id: changed
        uses: tj-actions/changed-files@v46${with_}
      - if: steps.changed.outputs.any_changed == 'true'
        run: echo "\${{ steps.changed.outputs.all_changed_files }}"
`;

const WITH = `
        with:
          files: |
            src/**
            !src/legacy/**
          separator: ','`;

describe('shipped models: tj-actions/changed-files', () => {
  it('lists and counts the selected files by status, joined by the separator', () => {
    const plan = run(changedFilesWorkflow(WITH), {
      event: 'push',
      changed: [
        'src/a.ts',
        'src/legacy/b.ts',
        { path: 'src/c.ts', status: 'removed' },
        { path: 'src/d.ts', status: 'added' },
        { path: 'src/e.ts', status: 'renamed', from: 'src/old.ts' },
        'README.md',
      ],
    });
    const [changed, echo] = steps(plan);
    const outputs = Object.fromEntries(Object.entries(changed!.outputs).map(([k, v]) => [k, value(v)]));
    expect(outputs).toMatchObject({
      all_changed_files: 'src/a.ts,src/d.ts,src/e.ts',
      all_modified_files: 'src/a.ts,src/c.ts,src/d.ts,src/e.ts',
      all_changed_and_modified_files: 'src/a.ts,src/c.ts,src/d.ts,src/e.ts',
      added_files: 'src/d.ts',
      modified_files: 'src/a.ts',
      deleted_files: 'src/c.ts',
      renamed_files: 'src/e.ts',
      all_changed_files_count: '3',
      deleted_files_count: '1',
      any_changed: 'true',
      any_modified: 'true',
      any_deleted: 'true',
    });
    expect(echo!.runs.verdict).toBe('yes');
    expect(echo!.with).toEqual({});
    expect(plan.models).toEqual([{ id: 'tj-actions/changed-files', version: '1' }]);
  });

  it('with no files pattern every changed file counts; nothing changed reads false', () => {
    const all = run(changedFilesWorkflow(), { event: 'push', changed: ['a.txt', 'b.txt'] });
    expect(value(steps(all)[0]!.outputs.all_changed_files!)).toBe('a.txt b.txt');
    const none = run(changedFilesWorkflow(WITH), { event: 'push', changed: ['README.md'] });
    expect(value(steps(none)[0]!.outputs.any_changed!)).toBe('false');
    expect(steps(none)[1]!.runs.verdict).toBe('no');
  });

  it('is unknown without changed files or with an unreadable pattern, and its interface stays open', () => {
    const plan = run(changedFilesWorkflow(WITH), { event: 'push' }, [
      { step: 'files.changed', outputs: { other_changed_files: 'x' } },
    ]);
    expect(steps(plan)[0]!.outputs.any_changed).toEqual({ known: false, unknowns: ['scenario.changed'] });
    expect(steps(plan)[1]!.runs.verdict).toBe('maybe');
    expect(codes(plan)).toEqual([]);
    const dynamic = run(changedFilesWorkflow('\n        with:\n          files: ${{ secrets.FILES }}'), {
      event: 'push',
      changed: ['src/a.ts'],
      secrets: ['FILES'],
    });
    const changed = steps(dynamic)[0]!;
    expect(changed.outputs.any_changed).toEqual({
      known: false,
      unknowns: [`${changed.id}.outputs.any_changed`],
    });
  });
});
