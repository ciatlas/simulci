import { expandMatrix, loadProject, memoryFileSystem } from '@ciatlas/core';
import { describe, expect, it } from 'vitest';
import { WorkflowDocument, type EditPlan, type Refusal, type TextEdit } from '@simulci/document';
import { applyEdits } from '@simulci/document/edits';
import { planOp } from '../src/ops/plan';
import type { WorkflowOp } from '../src/ops/types';
import { BOM, crlf, fixture } from './corpus';

const FILE = '.github/workflows/ci.yml';
const open = (text: string) => WorkflowDocument.open(text, { path: FILE, kind: 'workflow' });
const plan = (doc: WorkflowDocument, op: WorkflowOp, shared?: 'all') =>
  planOp(op, { doc: (p) => (p === FILE ? doc : undefined), ...(shared ? { shared } : {}) });

function refused(result: EditPlan<Record<string, TextEdit[]>>): Refusal {
  if (result.ok) throw new Error(`expected a refusal, got ${JSON.stringify(result.value)}`);
  return result;
}

function applied(text: string, op: WorkflowOp): string {
  const result = plan(open(text), op);
  if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
  return applyEdits(text, result.value[FILE]!).text;
}

/** Trigger, matrix and strategy goldens, kept in `golden/ops/<name>.yml` and read by eye once. */
const cases: [name: string, fixture: string, op: WorkflowOp][] = [
  // triggers
  ['add-event-scalar', 'on-scalar.yml', { op: 'addEvent', file: FILE, event: 'pull_request' }],
  ['add-event-list', 'on-seq.yml', { op: 'addEvent', file: FILE, event: 'workflow_dispatch' }],
  ['add-event-map', 'starter.yml', { op: 'addEvent', file: FILE, event: 'release' }],
  ['remove-event-map', 'starter.yml', { op: 'removeEvent', file: FILE, event: 'pull_request' }],
  ['remove-event-list', 'on-flow.yml', { op: 'removeEvent', file: FILE, event: 'pull_request' }],
  ['remove-event-last', 'on-scalar.yml', { op: 'removeEvent', file: FILE, event: 'push' }],
  [
    'set-filter-scalar-on',
    'on-scalar.yml',
    { op: 'setFilter', file: FILE, event: 'push', filter: 'branches', patterns: ['main'] },
  ],
  [
    'set-filter-list-on-keeps-comment',
    'on-flow.yml',
    { op: 'setFilter', file: FILE, event: 'pull_request', filter: 'paths', patterns: ['src/**'] },
  ],
  [
    'set-filter-in-event-order',
    'starter.yml',
    { op: 'setFilter', file: FILE, event: 'push', filter: 'tags', patterns: ['v*'] },
  ],
  [
    'set-filter-patches-list',
    'starter.yml',
    { op: 'setFilter', file: FILE, event: 'push', filter: 'branches', patterns: ['main', 'release/**'] },
  ],
  [
    'set-filter-null-keeps-event',
    'events.yml',
    { op: 'setFilter', file: FILE, event: 'push', filter: 'branches', patterns: null },
  ],
  [
    'set-filter-under-null-event',
    'starter.yml',
    { op: 'setFilter', file: FILE, event: 'pull_request', filter: 'branches-ignore', patterns: ['!main'] },
  ],
  ['set-types', 'starter.yml', { op: 'setTypes', file: FILE, event: 'pull_request', types: ['opened'] }],
  [
    'set-types-null-event',
    'events.yml',
    { op: 'setTypes', file: FILE, event: 'pull_request', types: ['opened', 'reopened'] },
  ],
  [
    'switch-filter',
    'nightly.yml',
    { op: 'switchFilter', file: FILE, event: 'push', from: 'branches-ignore', to: 'branches' },
  ],
  [
    'set-schedule-patch',
    'nightly.yml',
    { op: 'setSchedule', file: FILE, crons: [{ cron: '0 5 * * 1' }, { cron: '30 5 * * *' }] },
  ],
  [
    'set-schedule-append',
    'nightly.yml',
    {
      op: 'setSchedule',
      file: FILE,
      crons: [
        { cron: '0 4 * * 1' },
        { cron: '30 5 * * *', timezone: 'Europe/Berlin' },
        { cron: '*/15 * * * *', timezone: 'UTC' },
      ],
    },
  ],
  ['set-schedule-fewer', 'nightly.yml', { op: 'setSchedule', file: FILE, crons: [{ cron: '0 4 * * 1' }] }],
  ['set-schedule-new', 'starter.yml', { op: 'setSchedule', file: FILE, crons: [{ cron: '0 4 * * 1' }] }],
  [
    'set-schedule-scalar-on',
    'on-scalar.yml',
    { op: 'setSchedule', file: FILE, crons: [{ cron: '0 4 * * 1', timezone: 'America/New_York' }] },
  ],
  ['set-schedule-remove', 'nightly.yml', { op: 'setSchedule', file: FILE, crons: [] }],
  [
    'set-dispatch-input-new',
    'starter.yml',
    {
      op: 'setDispatchInput',
      file: FILE,
      name: 'target',
      input: {
        description: 'Where to deploy',
        type: 'choice',
        options: ['staging', 'production'],
        default: 'staging',
      },
    },
  ],
  [
    'set-dispatch-input-patch',
    'starter.yml',
    {
      op: 'setDispatchInput',
      file: FILE,
      name: 'deploy',
      input: { description: 'Deploy now', required: true, type: 'boolean' },
    },
  ],
  [
    'remove-dispatch-input-last',
    'starter.yml',
    { op: 'setDispatchInput', file: FILE, name: 'deploy', input: null },
  ],
  [
    'set-dispatch-input-creates-event',
    'on-scalar.yml',
    { op: 'setDispatchInput', file: FILE, name: 'dry-run', input: { type: 'boolean', default: true } },
  ],
  // matrix and strategy
  [
    'set-matrix-dim-keeps-numbers',
    'starter.yml',
    { op: 'setMatrixDim', file: FILE, job: 'test', dim: 'node', values: ['22', '24', '26'] },
  ],
  [
    'set-matrix-dim-before-include',
    'families.yml',
    { op: 'setMatrixDim', file: FILE, job: 'build', dim: 'arch', values: ['x64', 'arm64'] },
  ],
  [
    'set-matrix-dim-keeps-strings',
    'nightly.yml',
    { op: 'setMatrixDim', file: FILE, job: 'test', dim: 'python', values: ['3.10', '3.12', '3.13'] },
  ],
  [
    'set-matrix-dim-creates-strategy',
    'on-scalar.yml',
    { op: 'setMatrixDim', file: FILE, job: 'a', dim: 'os', values: ['ubuntu-latest', 'macos-latest'] },
  ],
  [
    'remove-matrix-dim-last',
    'starter.yml',
    { op: 'setMatrixDim', file: FILE, job: 'test', dim: 'node', values: null },
  ],
  [
    'set-matrix-entry-append-flow',
    'nightly.yml',
    {
      op: 'setMatrixEntry',
      file: FILE,
      job: 'test',
      list: 'include',
      index: 'append',
      entry: { os: 'windows-latest', python: '3.13' },
    },
  ],
  [
    'set-matrix-entry-append-block',
    'families.yml',
    {
      op: 'setMatrixEntry',
      file: FILE,
      job: 'build',
      list: 'include',
      index: 'append',
      entry: { os: 'macos-latest', node: 26 },
    },
  ],
  [
    'set-matrix-entry-patch',
    'nightly.yml',
    {
      op: 'setMatrixEntry',
      file: FILE,
      job: 'test',
      list: 'include',
      index: 0,
      entry: { os: 'ubuntu-latest', python: '3.14' },
    },
  ],
  [
    'remove-matrix-entry-last',
    'nightly.yml',
    { op: 'setMatrixEntry', file: FILE, job: 'test', list: 'exclude', index: 0, entry: null },
  ],
  [
    'set-strategy-max-parallel',
    'starter.yml',
    { op: 'setStrategyField', file: FILE, job: 'test', field: 'max-parallel', value: '2' },
  ],
  [
    'set-strategy-fail-fast-new',
    'families.yml',
    { op: 'setStrategyField', file: FILE, job: 'build', field: 'fail-fast', value: 'false' },
  ],
  [
    'remove-strategy-fail-fast',
    'starter.yml',
    { op: 'setStrategyField', file: FILE, job: 'test', field: 'fail-fast', value: null },
  ],
];

describe('trigger and matrix op goldens', () => {
  it.each(cases)('%s', async (name, file, op) => {
    const text = fixture(file);
    const out = applied(text, op);
    await expect(out).toMatchFileSnapshot(`golden/ops/${name}.yml`);
    expect(core(out).errors).toEqual([]);
    // The same op on the CRLF+BOM file gives the same text with CRLF and the mark.
    const variant = `${BOM}${crlf(text)}`;
    expect(applied(variant, op)).toBe(`${BOM}${crlf(out)}`);
  });
});

/** What core reads of a workflow: its parse errors, triggers, dispatch inputs and each job's matrix. */
function core(text: string) {
  const project = loadProject({ root: '.', fs: memoryFileSystem({ [FILE]: text }), validateSchema: false });
  const wf = project.workflows.get(FILE)!;
  return {
    errors: wf.parseErrors.map((e) => e.message),
    triggers: wf.triggers,
    inputs: Object.fromEntries(
      Object.entries(wf.dispatch?.inputs ?? {}).map(([name, i]) => [
        name,
        { type: i.type, required: i.required, default: i.default, options: i.options },
      ]),
    ),
    matrix: (job: string) => {
      const m = wf.jobs[job]?.matrix;
      return {
        dims: Object.fromEntries((m?.dims ?? []).map((d) => [d.name, d.values])),
        include: (m?.include ?? []).map((e) => e.values),
        exclude: (m?.exclude ?? []).map((e) => e.values),
        legs: m ? expandMatrix(m).combos.length : 0,
      };
    },
  };
}

describe('core reads what the trigger and matrix ops meant', () => {
  it('events added and removed, the shape kept', () => {
    const scalar = fixture('on-scalar.yml');
    expect(core(applied(scalar, { op: 'addEvent', file: FILE, event: 'pull_request' })).triggers).toEqual([
      'push',
      'pull_request',
    ]);
    const starter = fixture('starter.yml');
    expect(core(applied(starter, { op: 'removeEvent', file: FILE, event: 'pull_request' })).triggers).toEqual(
      ['push', 'workflow_dispatch'],
    );
    expect(
      core(
        applied(scalar, {
          op: 'setFilter',
          file: FILE,
          event: 'push',
          filter: 'branches',
          patterns: ['main'],
        }),
      ).triggers,
    ).toEqual(['push']);
  });

  it('a schedule and a dispatch input', () => {
    const out = applied(fixture('on-scalar.yml'), {
      op: 'setSchedule',
      file: FILE,
      crons: [{ cron: '*/15 * * * *' }],
    });
    expect(core(out).triggers).toEqual(['push', 'schedule']);
    const inputs = applied(fixture('starter.yml'), {
      op: 'setDispatchInput',
      file: FILE,
      name: 'target',
      input: { type: 'choice', options: ['staging', 'production'], default: 'staging', required: true },
    });
    expect(core(inputs).inputs).toEqual({
      deploy: { type: 'boolean', required: false, default: false, options: undefined },
      target: { type: 'choice', required: true, default: 'staging', options: ['staging', 'production'] },
    });
  });

  it('matrix dimensions keep their types, and the legs follow', () => {
    const nightly = fixture('nightly.yml');
    expect(core(nightly).matrix('test').legs).toBe(4);
    const python = applied(nightly, {
      op: 'setMatrixDim',
      file: FILE,
      job: 'test',
      dim: 'python',
      values: ['3.10', '3.12', '3.13'],
    });
    expect(core(python).matrix('test').dims).toEqual({
      os: ['ubuntu-latest', 'windows-latest'],
      python: ['3.10', '3.12', '3.13'],
    });
    expect(core(python).matrix('test').legs).toBe(5);
    const node = applied(fixture('starter.yml'), {
      op: 'setMatrixDim',
      file: FILE,
      job: 'test',
      dim: 'node',
      values: ['22', '24', '26'],
    });
    expect(core(node).matrix('test').dims).toEqual({ node: [22, 24, 26] });
    const arch = applied(fixture('families.yml'), {
      op: 'setMatrixDim',
      file: FILE,
      job: 'build',
      dim: 'arch',
      values: ['x64', 'arm64'],
    });
    expect(Object.keys(core(arch).matrix('build').dims)).toEqual(['os', 'node', 'arch']);
    expect(core(arch).matrix('build').include).toEqual([{ os: 'ubuntu-latest', node: 26 }]);
  });

  it('include and exclude entries', () => {
    const nightly = fixture('nightly.yml');
    const added = applied(nightly, {
      op: 'setMatrixEntry',
      file: FILE,
      job: 'test',
      list: 'include',
      index: 'append',
      entry: { os: 'windows-latest', python: '3.13' },
    });
    expect(core(added).matrix('test').include).toEqual([
      { os: 'ubuntu-latest', python: '3.13', experimental: true },
      { os: 'windows-latest', python: '3.13' },
    ]);
    const removed = applied(nightly, {
      op: 'setMatrixEntry',
      file: FILE,
      job: 'test',
      list: 'exclude',
      index: 0,
      entry: null,
    });
    expect(core(removed).matrix('test').exclude).toEqual([]);
    expect(core(removed).matrix('test').legs).toBe(5);
  });
});

describe('refusals of the trigger and matrix ops', () => {
  it('exclusive-filter: branches next to branches-ignore; the fix switches, and the op then goes through', () => {
    const doc = open(fixture('nightly.yml'));
    const op: WorkflowOp = {
      op: 'setFilter',
      file: FILE,
      event: 'push',
      filter: 'branches',
      patterns: ['main'],
    };
    const refusal = refused(plan(doc, op));
    expect(refusal).toEqual({
      ok: false,
      reason: 'exclusive-filter',
      file: FILE,
      message: 'push already uses `branches-ignore`; GitHub accepts one of the two.',
      line: 8,
      at: ['on', 'push', 'branches-ignore'],
      fixes: [
        {
          kind: 'ops',
          label: 'Switch to branches',
          ops: [{ op: 'switchFilter', file: FILE, event: 'push', from: 'branches-ignore', to: 'branches' }],
          retry: true,
        },
      ],
    });
    const fix = refusal.fixes[0]!;
    const switched = plan(doc, fix.kind === 'ops' ? fix.ops[0]! : op);
    if (!switched.ok) throw new Error(switched.message);
    const after = switched.documents[FILE]!;
    const retried = plan(after, op);
    if (!retried.ok) throw new Error(retried.message);
    expect(retried.documents[FILE]!.text).toContain('    branches: [main]\n  workflow_dispatch:');
    expect(retried.documents[FILE]!.text).not.toContain('branches-ignore');
  });

  it('flow-shape: a list `on:` with a comment inside cannot become a map', () => {
    const doc = open(
      'on: [\n  push, # main only\n  pull_request,\n]\njobs:\n  a:\n    runs-on: x\n    steps: [{run: a}]\n',
    );
    expect(
      refused(
        plan(doc, { op: 'setFilter', file: FILE, event: 'push', filter: 'branches', patterns: ['main'] }),
      ),
    ).toEqual({
      ok: false,
      reason: 'flow-shape',
      file: FILE,
      message: '`on` is written inline with a comment inside; edit it in the YAML pane.',
      line: 1,
      at: ['on'],
      fixes: [{ kind: 'reveal', label: 'Show line 1', line: 1 }],
    });
  });

  it('unsupported-shape: a block list `on:` with comments among its items', () => {
    const doc = open(
      'on: # triggers\n  - push # main\n  - pull_request\njobs:\n  a:\n    runs-on: x\n    steps: [{run: a}]\n',
    );
    expect(
      refused(
        plan(doc, { op: 'setFilter', file: FILE, event: 'push', filter: 'branches', patterns: ['main'] }),
      ),
    ).toMatchObject({
      reason: 'unsupported-shape',
      message: '`on` holds comments that writing it anew would lose; edit it in the YAML pane.',
      line: 2,
    });
    expect(
      refused(
        plan(open('on:\n  schedule: [\n    {cron: 0 4 * * 1}, # Mondays\n  ]\njobs: {}\n'), {
          op: 'setSchedule',
          file: FILE,
          crons: [{ cron: '0 5 * * 1' }],
        }),
      ),
    ).toMatchObject({
      reason: 'flow-shape',
      message: '`on.schedule` is written inline with a comment inside; edit it in the YAML pane.',
    });
    // The comment on the `on:` line is the line's: it stays, and the list is written as a map.
    const plain = open(
      'on: # triggers\n  - push\n  - pull_request\njobs:\n  a:\n    runs-on: x\n    steps: [{run: a}]\n',
    );
    const result = plan(plain, {
      op: 'setFilter',
      file: FILE,
      event: 'push',
      filter: 'branches',
      patterns: ['main'],
    });
    expect(result.ok && result.documents[FILE]!.text).toBe(
      'on: # triggers\n  push:\n    branches: [main]\n  pull_request:\njobs:\n  a:\n    runs-on: x\n    steps: [{run: a}]\n',
    );
  });

  it('not-found: a filter for an event the file does not name', () => {
    expect(
      refused(
        plan(open(fixture('on-scalar.yml')), {
          op: 'setFilter',
          file: FILE,
          event: 'pull_request',
          filter: 'branches',
          patterns: ['main'],
        }),
      ),
    ).toMatchObject({ reason: 'not-found', message: '`on.pull_request` is not in ci.yml any more.' });
  });

  it('unsupported-shape: a matrix, or its include, computed at run time', () => {
    const doc = open(
      'on: push\njobs:\n  a:\n    runs-on: x\n    strategy:\n      matrix: ${{ fromJSON(inputs.m) }}\n    steps: [{run: a}]\n  b:\n    runs-on: x\n    strategy:\n      matrix:\n        os: [x]\n        include: ${{ fromJSON(inputs.i) }}\n    steps: [{run: b}]\n',
    );
    expect(
      refused(plan(doc, { op: 'setMatrixDim', file: FILE, job: 'a', dim: 'os', values: ['x'] })),
    ).toEqual({
      ok: false,
      reason: 'unsupported-shape',
      file: FILE,
      message: "a's `strategy.matrix` is computed at run time; edit it in the YAML pane.",
      line: 6,
      at: ['jobs', 'a', 'strategy', 'matrix'],
      fixes: [{ kind: 'reveal', label: 'Show line 6', line: 6 }],
    });
    expect(
      refused(
        plan(doc, {
          op: 'setMatrixEntry',
          file: FILE,
          job: 'b',
          list: 'include',
          index: 'append',
          entry: { os: 'y' },
        }),
      ).message,
    ).toBe("b's `strategy.matrix.include` is computed at run time; edit it in the YAML pane.");
  });

  it('invalid-id: a new dimension or input whose name is no id, and include as a dimension', () => {
    const doc = open(fixture('starter.yml'));
    expect(
      refused(plan(doc, { op: 'setMatrixDim', file: FILE, job: 'test', dim: '2os', values: ['x'] })),
    ).toMatchObject({
      reason: 'invalid-id',
      message: 'Matrix keys start with a letter or `_`, then letters, digits, `-` or `_`: `2os` is not one.',
      fixes: [{ kind: 'ops', label: 'Use os', retry: false }],
    });
    expect(
      refused(plan(doc, { op: 'setMatrixDim', file: FILE, job: 'test', dim: 'include', values: ['x'] }))
        .message,
    ).toBe('`include` lists whole legs, not the values of a dimension: name the dimension something else.');
    expect(
      refused(plan(doc, { op: 'setDispatchInput', file: FILE, name: 'dry run', input: { type: 'boolean' } })),
    ).toMatchObject({ reason: 'invalid-id', fixes: [{ label: 'Use dry-run' }] });
  });

  it('alias: an event written as an alias gets its own copy first; the fix goes through', () => {
    const doc = open(
      'on:\n  push: &filters\n    branches: [main]\n  pull_request: *filters\njobs:\n  a:\n    runs-on: x\n    steps: [{run: a}]\n',
    );
    const op: WorkflowOp = {
      op: 'setFilter',
      file: FILE,
      event: 'pull_request',
      filter: 'paths',
      patterns: ['src/**'],
    };
    expect(refused(plan(doc, op))).toMatchObject({
      reason: 'alias',
      message: '`on.pull_request` is `*filters`, a reference to `&filters` on line 2.',
      fixes: [
        { kind: 'ops', ops: [{ op: 'dealias', file: FILE, path: ['on', 'pull_request'] }], retry: true },
        { kind: 'reveal', line: 2 },
      ],
    });
    expect(refused(plan(doc, { ...op, event: 'push' }))).toMatchObject({
      reason: 'shared-anchor',
      fixes: [{ label: 'Change only here' }, { kind: 'shared-all', label: 'Change all 2 uses' }],
    });
  });

  it('duplicate-id: switching to a filter the event already has', () => {
    const doc = open('on:\n  push:\n    branches: [a]\n    branches-ignore: [b]\njobs: {}\n');
    expect(
      refused(
        plan(doc, { op: 'switchFilter', file: FILE, event: 'push', from: 'branches-ignore', to: 'branches' }),
      ),
    ).toMatchObject({ reason: 'duplicate-id', message: '`on.push` already has `branches`.' });
  });

  it('out-of-range: an include entry that is not there', () => {
    expect(
      refused(
        plan(open(fixture('families.yml')), {
          op: 'setMatrixEntry',
          file: FILE,
          job: 'build',
          list: 'include',
          index: 3,
          entry: { os: 'x' },
        }),
      ),
    ).toMatchObject({ reason: 'out-of-range' });
  });
});

describe('warnings and labels of the trigger and matrix ops', () => {
  it('matrix-limit: more combinations than GitHub runs', () => {
    const result = plan(open(fixture('nightly.yml')), {
      op: 'setMatrixDim',
      file: FILE,
      job: 'test',
      dim: 'shard',
      values: Array.from({ length: 65 }, (_, i) => i + 1),
    });
    expect(result.ok && result.warnings).toEqual([
      {
        code: 'matrix-limit',
        message: "test's matrix makes 260 combinations; GitHub runs at most 256 jobs from one matrix.",
      },
    ]);
  });

  it('labels each op in the author’s words', () => {
    const doc = open(fixture('starter.yml'));
    const label = (op: WorkflowOp) => {
      const result = plan(doc, op);
      return result.ok ? result.label : result.reason;
    };
    expect(label({ op: 'addEvent', file: FILE, event: 'release' })).toBe('Added the release trigger');
    expect(label({ op: 'setFilter', file: FILE, event: 'push', filter: 'branches', patterns: null })).toBe(
      "Removed push's branches",
    );
    expect(label({ op: 'setSchedule', file: FILE, crons: [{ cron: '0 4 * * 1' }] })).toBe('Set the schedule');
    expect(
      label({
        op: 'setMatrixEntry',
        file: FILE,
        job: 'test',
        list: 'include',
        index: 'append',
        entry: { node: 26 },
      }),
    ).toBe("Added an include entry to test's matrix");
    expect(label({ op: 'setStrategyField', file: FILE, job: 'test', field: 'fail-fast', value: null })).toBe(
      "Removed test's fail-fast",
    );
  });
});
