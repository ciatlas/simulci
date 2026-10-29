import { loadProject, memoryFileSystem } from '@ciatlas/core';
import { describe, expect, it } from 'vitest';
import { WorkflowDocument, type EditPlan, type Refusal, type TextEdit } from '@simulci/document';
import { applyEdits } from '@simulci/document/edits';
import { planOp } from '../src/ops/plan';
import type { Fp, WorkflowOp } from '../src/ops/types';
import { BOM, crlf, fixture } from './corpus';

const FILE = '.github/workflows/ci.yml';
const open = (text: string, generated?: string) =>
  WorkflowDocument.open(text, { path: FILE, kind: 'workflow', ...(generated ? { generated } : {}) });
const plan = (doc: WorkflowDocument, op: WorkflowOp, shared?: 'all') =>
  planOp(op, { doc: (p) => (p === FILE ? doc : undefined), ...(shared ? { shared } : {}) });

/** The fingerprint of a step as the author saw it. */
function fp(doc: WorkflowDocument, job: string, index: number): Fp {
  const { id, name, uses, runHead } = doc.jobs().find((j) => j.id === job)!.steps[index]!;
  return Object.fromEntries(Object.entries({ id, name, uses, runHead }).filter(([, v]) => v !== undefined));
}

type Make = (doc: WorkflowDocument) => WorkflowOp;

/** A commit an action's tag points at, as Pin to SHA writes it. */
const SHA = '49933ea5288caeca8642d1e84afbd3f7d6820020';

/** Op goldens on the app's starter sample, kept in `golden/ops/<name>.yml` and read by eye once. */
const cases: [name: string, fixture: string, make: Make][] = [
  [
    'set-workflow-run-name',
    'starter.yml',
    () => ({ op: 'setWorkflowField', file: FILE, field: 'run-name', value: 'CI for ${{ github.ref }}' }),
  ],
  [
    'remove-workflow-name',
    'starter.yml',
    () => ({ op: 'setWorkflowField', file: FILE, field: 'name', value: null }),
  ],
  [
    'set-job-if-new-key',
    'starter.yml',
    () => ({
      op: 'setJobField',
      file: FILE,
      job: 'build',
      field: 'if',
      value: "github.ref == 'refs/heads/main'",
    }),
  ],
  [
    'set-job-if-bang',
    'starter.yml',
    () => ({ op: 'setJobField', file: FILE, job: 'build', field: 'if', value: '!cancelled()' }),
  ],
  [
    'set-job-if-bang-wrapped',
    'flush.yml',
    () => ({ op: 'setJobField', file: FILE, job: 'build', field: 'if', value: '!cancelled()' }),
  ],
  [
    'set-job-if-in-place',
    'starter.yml',
    () => ({
      op: 'setJobField',
      file: FILE,
      job: 'deploy',
      field: 'if',
      value: "github.event_name == 'push'",
    }),
  ],
  [
    'set-job-timeout-number',
    'starter.yml',
    () => ({ op: 'setJobField', file: FILE, job: 'deploy', field: 'timeout-minutes', value: '30' }),
  ],
  [
    'set-job-continue-boolean',
    'starter.yml',
    () => ({ op: 'setJobField', file: FILE, job: 'deploy', field: 'continue-on-error', value: 'true' }),
  ],
  [
    'set-job-runs-on-list',
    'starter.yml',
    () => ({
      op: 'setJobField',
      file: FILE,
      job: 'build',
      field: 'runs-on',
      value: ['self-hosted', 'linux'],
    }),
  ],
  [
    'remove-job-environment',
    'starter.yml',
    () => ({ op: 'setJobField', file: FILE, job: 'deploy', field: 'environment', value: null }),
  ],
  [
    'add-job-after',
    'starter.yml',
    () => ({
      op: 'addJob',
      file: FILE,
      id: 'lint',
      after: 'test',
      job: { needs: ['test'], steps: [{ uses: 'actions/checkout@v4' }, { run: 'npm run lint' }] },
    }),
  ],
  [
    'add-job-last-two-needs',
    'starter.yml',
    () => ({
      op: 'addJob',
      file: FILE,
      id: 'notify',
      job: { needs: ['deploy', 'preview'], if: 'always()', steps: [{ run: 'echo done\necho twice' }] },
    }),
  ],
  [
    'add-job-reusable',
    'starter.yml',
    () => ({
      op: 'addJob',
      file: FILE,
      id: 'call',
      job: { uses: './.github/workflows/release.yml', with: { tag: 'v1' } },
    }),
  ],
  [
    'add-job-no-jobs',
    'no-lists.yml',
    () => ({
      op: 'addJob',
      file: FILE,
      id: 'b',
      after: 'a',
      job: { 'runs-on': 'macos-latest', steps: [{ run: 'echo b' }] },
    }),
  ],
  ['remove-job-cascades-needs', 'starter.yml', () => ({ op: 'removeJob', file: FILE, job: 'build' })],
  ['remove-first-job', 'starter.yml', () => ({ op: 'removeJob', file: FILE, job: 'test' })],
  [
    'set-needs-scalar-to-list',
    'starter.yml',
    () => ({ op: 'setNeeds', file: FILE, job: 'preview', needs: ['build', 'test'] }),
  ],
  [
    'set-needs-flow-remove',
    'starter.yml',
    () => ({ op: 'setNeeds', file: FILE, job: 'deploy', needs: ['build'] }),
  ],
  [
    'set-needs-flow-append',
    'starter.yml',
    () => ({ op: 'setNeeds', file: FILE, job: 'deploy', needs: ['test', 'build', 'preview'] }),
  ],
  ['set-needs-none-to-one', 'starter.yml', () => ({ op: 'setNeeds', file: FILE, job: 'test', needs: [] })],
  ['set-needs-new', 'shapes.yml', () => ({ op: 'setNeeds', file: FILE, job: 'blocks', needs: ['expanded'] })],
  [
    'set-needs-empty-removes',
    'starter.yml',
    () => ({ op: 'setNeeds', file: FILE, job: 'preview', needs: [] }),
  ],
  [
    'set-output-new-map',
    'starter.yml',
    () => ({
      op: 'setOutput',
      file: FILE,
      job: 'build',
      name: 'changed',
      value: '${{ steps.detect.outputs.changed }}',
    }),
  ],
  [
    'set-binding-step-env',
    'starter.yml',
    (d) => ({
      op: 'setBinding',
      file: FILE,
      job: 'build',
      step: { index: 0, fp: fp(d, 'build', 0) },
      kind: 'env',
      name: 'CI',
      value: 'true',
    }),
  ],
  [
    'set-binding-step-with',
    'starter.yml',
    (d) => ({
      op: 'setBinding',
      file: FILE,
      job: 'test',
      step: { index: 1, fp: fp(d, 'test', 1) },
      kind: 'with',
      name: 'cache',
      value: 'npm',
    }),
  ],
  [
    'remove-binding-last',
    'starter.yml',
    (d) => ({
      op: 'setBinding',
      file: FILE,
      job: 'deploy',
      step: { index: 0, fp: fp(d, 'deploy', 0) },
      kind: 'env',
      name: 'TOKEN',
      value: null,
    }),
  ],
  [
    'set-binding-job-env',
    'starter.yml',
    () => ({ op: 'setBinding', file: FILE, job: 'deploy', kind: 'env', name: 'STAGE', value: 'prod' }),
  ],
  [
    'add-step-multi-line-run',
    'starter.yml',
    () => ({
      op: 'addStep',
      file: FILE,
      job: 'build',
      index: 1,
      step: { name: 'Install', run: 'npm ci\nnpm run prepare' },
    }),
  ],
  [
    'add-step-first',
    'starter.yml',
    () => ({ op: 'addStep', file: FILE, job: 'preview', index: 0, step: { uses: 'actions/checkout@v4' } }),
  ],
  [
    'remove-step-read-elsewhere',
    'starter.yml',
    (d) => ({ op: 'removeStep', file: FILE, job: 'build', index: 1, fp: fp(d, 'build', 1) }),
  ],
  [
    'move-step-down',
    'starter.yml',
    (d) => ({ op: 'moveStep', file: FILE, job: 'test', from: 0, to: 3, fp: fp(d, 'test', 0) }),
  ],
  [
    'move-step-up',
    'starter.yml',
    (d) => ({ op: 'moveStep', file: FILE, job: 'build', from: 2, to: 0, fp: fp(d, 'build', 2) }),
  ],
  [
    'set-step-name-new',
    'starter.yml',
    (d) => ({
      op: 'setStepField',
      file: FILE,
      job: 'test',
      index: 2,
      fp: fp(d, 'test', 2),
      field: 'name',
      value: 'Install',
    }),
  ],
  [
    'set-step-if-in-place',
    'starter.yml',
    (d) => ({
      op: 'setStepField',
      file: FILE,
      job: 'build',
      index: 2,
      fp: fp(d, 'build', 2),
      field: 'if',
      value: 'always()',
    }),
  ],
  [
    'set-step-run-block',
    'starter.yml',
    (d) => ({
      op: 'setStepField',
      file: FILE,
      job: 'build',
      index: 1,
      fp: fp(d, 'build', 1),
      field: 'run',
      value: 'echo "changed=true" >> "$GITHUB_OUTPUT"\n',
    }),
  ],
  [
    'set-step-four-spaces',
    'indent4.yml',
    (d) => ({
      op: 'setStepField',
      file: FILE,
      job: 'build',
      index: 1,
      fp: fp(d, 'build', 1),
      field: 'shell',
      value: 'bash',
    }),
  ],
  [
    'pin-step-uses',
    'starter.yml',
    (d) => ({
      op: 'pinStepUses',
      file: FILE,
      job: 'test',
      index: 1,
      fp: fp(d, 'test', 1),
      sha: SHA,
      tag: 'v4',
    }),
  ],
  [
    'pin-step-uses-comment',
    'comments.yml',
    (d) => ({
      op: 'pinStepUses',
      file: FILE,
      job: 'build',
      index: 1,
      fp: fp(d, 'build', 1),
      sha: SHA,
      tag: 'v4',
    }),
  ],
  ['dealias-op', 'shared.yml', () => ({ op: 'dealias', file: FILE, path: ['jobs', 'test', 'runs-on'] })],
  ['dealias-anchor-op', 'shared.yml', () => ({ op: 'dealiasAnchor', file: FILE, anchor: 'checkout' })],
];

describe('op goldens', () => {
  it.each(cases)('%s', async (name, file, make) => {
    const text = fixture(file);
    const doc = open(text);
    const result = plan(doc, make(doc));
    if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
    const out = applyEdits(text, result.value[FILE]!).text;
    await expect(out).toMatchFileSnapshot(`golden/ops/${name}.yml`);
    expect(core(out).errors).toEqual([]);
    // The same op on the CRLF+BOM file gives the same text with CRLF and the mark.
    const variant = open(`${BOM}${crlf(text)}`);
    const again = plan(variant, make(variant));
    expect(again.ok && applyEdits(variant.text, again.value[FILE]!).text).toBe(`${BOM}${crlf(out)}`);
  });
});

/** What core reads: parse errors, and each job's needs and steps. */
function core(text: string) {
  const project = loadProject({ root: '.', fs: memoryFileSystem({ [FILE]: text }), validateSchema: false });
  const wf = project.workflows.get(FILE);
  const jobs = Object.fromEntries(
    Object.entries(wf?.jobs ?? {}).map(([id, job]) => [
      id,
      { needs: job.needs.map((n) => n.id), steps: job.steps.length },
    ]),
  );
  return { errors: (wf?.parseErrors ?? []).map((e) => e.message), jobs };
}

describe('core reads what the op meant', () => {
  const doc = open(fixture('starter.yml'));
  const apply = (op: WorkflowOp) => {
    const result = plan(doc, op);
    if (!result.ok) throw new Error(result.message);
    return core(applyEdits(doc.text, result.value[FILE]!).text).jobs;
  };

  it('a removed job is gone from every needs', () => {
    expect(apply({ op: 'removeJob', file: FILE, job: 'build' })).toEqual({
      test: { needs: [], steps: 4 },
      deploy: { needs: ['test'], steps: 1 },
      preview: { needs: [], steps: 1 },
    });
  });

  it('an added job has its needs and steps', () => {
    expect(
      apply({
        op: 'addJob',
        file: FILE,
        id: 'lint',
        after: 'test',
        job: { needs: ['test'], steps: [{ run: 'a' }, { run: 'b' }] },
      })['lint'],
    ).toEqual({ needs: ['test'], steps: 2 });
  });

  it('needs are what was set, in order', () => {
    expect(
      apply({ op: 'setNeeds', file: FILE, job: 'preview', needs: ['test', 'build'] })['preview']!.needs,
    ).toEqual(['test', 'build']);
  });

  it('a step added, removed or moved changes the step count where it should', () => {
    expect(
      apply({ op: 'addStep', file: FILE, job: 'deploy', index: 1, step: { run: 'x' } })['deploy']!.steps,
    ).toBe(2);
    expect(
      apply({ op: 'removeStep', file: FILE, job: 'test', index: 3, fp: fp(doc, 'test', 3) })['test']!.steps,
    ).toBe(3);
  });
});

function refused(result: EditPlan<Record<string, TextEdit[]>>): Refusal {
  if (result.ok) throw new Error('expected a refusal');
  return result;
}

describe('refusals of the job and step ops', () => {
  const doc = open(fixture('starter.yml'));

  it('not-found: the file, the job, a need', () => {
    expect(refused(planOp({ op: 'removeJob', file: 'x.yml', job: 'a' }, { doc: () => undefined }))).toEqual({
      ok: false,
      reason: 'not-found',
      file: 'x.yml',
      message: 'x.yml is not open.',
      fixes: [],
    });
    expect(
      refused(plan(doc, { op: 'setJobField', file: FILE, job: 'nope', field: 'if', value: 'x' })),
    ).toMatchObject({ reason: 'not-found', message: 'nope is not in ci.yml any more.' });
    expect(refused(plan(doc, { op: 'setNeeds', file: FILE, job: 'deploy', needs: ['ghost'] }))).toMatchObject(
      { reason: 'not-found', message: 'ghost is not in ci.yml any more.' },
    );
    expect(
      refused(plan(doc, { op: 'setNeeds', file: FILE, job: 'deploy', needs: ['deploy'] })),
    ).toMatchObject({
      reason: 'cycle',
      message: 'deploy cannot need itself.',
    });
    expect(refused(plan(doc, { op: 'addJob', file: FILE, id: 'x', after: 'ghost', job: {} })).reason).toBe(
      'not-found',
    );
  });

  it('out-of-range and moved: the step is not the one the author picked', () => {
    expect(
      refused(plan(doc, { op: 'removeStep', file: FILE, job: 'deploy', index: 3, fp: {} })),
    ).toMatchObject({ reason: 'out-of-range' });
    expect(
      refused(plan(doc, { op: 'removeStep', file: FILE, job: 'test', index: 0, fp: { runHead: 'npm ci' } })),
    ).toEqual({
      ok: false,
      reason: 'moved',
      file: FILE,
      message: 'The selected step changed in the text; the graph will catch up in a moment.',
      at: ['jobs', 'test', 'steps', 0],
      fixes: [],
    });
    const fpOf = fp(doc, 'test', 0);
    expect(
      refused(plan(doc, { op: 'moveStep', file: FILE, job: 'test', from: 1, to: 0, fp: fpOf })).reason,
    ).toBe('moved');
    expect(
      refused(
        plan(doc, {
          op: 'setStepField',
          file: FILE,
          job: 'test',
          index: 1,
          fp: fpOf,
          field: 'name',
          value: 'x',
        }),
      ).reason,
    ).toBe('moved');
    expect(
      refused(
        plan(doc, {
          op: 'setBinding',
          file: FILE,
          job: 'test',
          step: { index: 1, fp: fpOf },
          kind: 'env',
          name: 'A',
          value: '1',
        }),
      ).reason,
    ).toBe('moved');
  });

  it('invalid-id and duplicate-id: a fix offers a free id', () => {
    expect(refused(plan(doc, { op: 'addJob', file: FILE, id: '2fast', job: {} }))).toEqual({
      ok: false,
      reason: 'invalid-id',
      file: FILE,
      message: 'Job ids start with a letter or `_`, then letters, digits, `-` or `_`: `2fast` is not one.',
      fixes: [
        {
          kind: 'ops',
          label: 'Use fast',
          ops: [{ op: 'addJob', file: FILE, id: 'fast', job: {} }],
          retry: false,
        },
      ],
    });
    expect(refused(plan(doc, { op: 'addJob', file: FILE, id: 'Build', job: {} }))).toMatchObject({
      reason: 'duplicate-id',
      message: 'A job `build` already exists; ids ignore case.',
      fixes: [
        {
          kind: 'ops',
          label: 'Use Build-2',
          ops: [{ op: 'addJob', file: FILE, id: 'Build-2', job: {} }],
          retry: false,
        },
      ],
    });
  });

  it('cycle: a need that already needs the job', () => {
    expect(refused(plan(doc, { op: 'setNeeds', file: FILE, job: 'test', needs: ['deploy'] }))).toEqual({
      ok: false,
      reason: 'cycle',
      file: FILE,
      message: 'deploy already needs test; test needing deploy would loop.',
      at: ['jobs', 'test', 'needs'],
      fixes: [],
    });
    expect(refused(plan(doc, { op: 'setNeeds', file: FILE, job: 'test', needs: ['preview'] })).message).toBe(
      'preview already needs test through build; test needing preview would loop.',
    );
  });

  it('unsupported-shape: needs computed at run time, steps in a reusable call, secrets on a step', () => {
    const dynamic = open(
      'on: push\njobs:\n  a:\n    needs: ${{ fromJSON(x) }}\n    runs-on: x\n    steps: [{run: a}]\n  b:\n    uses: ./x.yml\n',
    );
    expect(refused(plan(dynamic, { op: 'setNeeds', file: FILE, job: 'a', needs: ['b'] })).message).toBe(
      'The needs of a are not a list of job names; edit it in the YAML pane.',
    );
    expect(
      refused(plan(dynamic, { op: 'addStep', file: FILE, job: 'b', index: 0, step: { run: 'x' } })).reason,
    ).toBe('unsupported-shape');
    expect(
      refused(
        plan(doc, {
          op: 'setBinding',
          file: FILE,
          job: 'deploy',
          step: { index: 0, fp: fp(doc, 'deploy', 0) },
          kind: 'secrets',
          name: 'A',
          value: 'x',
        }),
      ).reason,
    ).toBe('unsupported-shape');
  });

  it('unsupported-shape: a pin of a script, of a local action, of a uses that does not end its line', () => {
    const pin = (d: WorkflowDocument, job: string, index: number) =>
      refused(
        plan(d, { op: 'pinStepUses', file: FILE, job, index, fp: fp(d, job, index), sha: SHA, tag: 'v4' }),
      );
    expect(pin(doc, 'test', 2).message).toBe(
      "test's step 3 has no remote action to pin; edit it in the YAML pane.",
    );
    const local = open(
      'on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - uses: ./.github/actions/setup\n',
    );
    expect(pin(local, 'a', 0).reason).toBe('unsupported-shape');
    const shapes = open(fixture('shapes.yml'));
    expect(pin(shapes, 'flow-steps', 0).message).toBe(
      "The `uses` of flow-steps's step 1 shares its line with other keys; edit it in the YAML pane.",
    );
    expect(
      refused(
        plan(doc, {
          op: 'pinStepUses',
          file: FILE,
          job: 'test',
          index: 0,
          fp: fp(doc, 'test', 0),
          sha: 'v4',
          tag: 'v4',
        }),
      ).reason,
    ).toBe('unsupported-shape');
  });

  it('the primitives’ refusals reach the author: alias, shared-anchor, anchor, generated, invalid YAML', () => {
    const shared = open(fixture('shared.yml'));
    expect(
      refused(plan(shared, { op: 'setJobField', file: FILE, job: 'test', field: 'runs-on', value: 'x' }))
        .reason,
    ).toBe('alias');
    expect(
      refused(plan(shared, { op: 'setJobField', file: FILE, job: 'build', field: 'name', value: 'B' }))
        .reason,
    ).toBe('shared-anchor');
    expect(
      plan(shared, { op: 'setJobField', file: FILE, job: 'build', field: 'name', value: 'B' }, 'all').ok,
    ).toBe(true);
    expect(refused(plan(shared, { op: 'removeJob', file: FILE, job: 'build' })).reason).toBe('anchor');
    expect(
      refused(
        plan(open('# DO NOT EDIT\non: push\njobs: {}\n', 'DO NOT EDIT'), {
          op: 'addJob',
          file: FILE,
          id: 'a',
          job: {},
        }),
      ).reason,
    ).toBe('generated');
    expect(
      refused(plan(open('on: [\n'), { op: 'setWorkflowField', file: FILE, field: 'name', value: 'x' }))
        .reason,
    ).toBe('invalid-yaml');
  });
});

describe('warnings', () => {
  it('names the expressions that still read a removed job, and the callers of a reusable workflow', () => {
    const doc = open(
      "on: workflow_call\njobs:\n  a:\n    runs-on: x\n    steps: [{run: a}]\n  b:\n    needs: a\n    if: needs.a.result == 'success'\n    runs-on: x\n    steps: [{run: b}]\n",
    );
    const result = plan(doc, { op: 'removeJob', file: FILE, job: 'a' });
    expect(result.ok && result.warnings).toEqual([
      {
        code: 'dangling-ref',
        message: '1 expression still reads a (line 8).',
        at: [{ from: doc.text.indexOf('needs.a'), to: doc.text.indexOf('\n', doc.text.indexOf('needs.a')) }],
      },
      {
        code: 'callers',
        message: 'ci.yml is a reusable workflow: the workflows that call it may plan differently.',
      },
    ]);
  });

  it('labels each op in the author’s words, and selects what it touched', () => {
    const doc = open(fixture('starter.yml'));
    expect(plan(doc, { op: 'removeJob', file: FILE, job: 'build' })).toMatchObject({
      label: 'Removed job build',
      select: { file: FILE, path: ['jobs', 'test'] },
    });
    expect(
      plan(doc, { op: 'moveStep', file: FILE, job: 'test', from: 0, to: 3, fp: fp(doc, 'test', 0) }),
    ).toMatchObject({ label: "Moved test's step 1", select: { path: ['jobs', 'test', 'steps', 3] } });
    expect(plan(doc, { op: 'addJob', file: FILE, id: 'x', job: {} })).toMatchObject({
      label: 'Added job x',
      select: { path: ['jobs', 'x'] },
    });
    expect(plan(doc, { op: 'setNeeds', file: FILE, job: 'deploy', needs: ['build'] })).toMatchObject({
      label: 'Set what deploy needs',
    });
  });
});
