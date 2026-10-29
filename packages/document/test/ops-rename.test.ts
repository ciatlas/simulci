import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadProject, memoryFileSystem } from '@ciatlas/core';
import { describe, expect, it } from 'vitest';
import {
  WorkflowDocument,
  type EditPlan,
  type Reference,
  type Refusal,
  type TextEdit,
} from '@simulci/document';
import { applyEdits } from '@simulci/document/edits';
import { planOp } from '../src/ops/plan';
import { fingerprint } from '../src/ops/steps';
import type { WorkflowOp } from '../src/ops/types';
import { BOM, crlf, fixture, ROOT } from './corpus';
import { jobReferences, stepReferences } from './refs';

const FILE = '.github/workflows/ci.yml';
const open = (text: string) => WorkflowDocument.open(text, { path: FILE, kind: 'workflow' });
const plan = (doc: WorkflowDocument, op: WorkflowOp, refs: readonly Reference[], shared?: 'all') =>
  planOp(op, { doc: (p) => (p === FILE ? doc : undefined), refs, ...(shared ? { shared } : {}) });

function refused(result: EditPlan<Record<string, TextEdit[]>>): Refusal {
  if (result.ok) throw new Error(`expected a refusal, got ${JSON.stringify(result.value)}`);
  return result;
}

/** An op and the references the worker would find for it, read from the document it is planned on. */
type Make = (doc: WorkflowDocument) => [WorkflowOp, Reference[]];

function renamed(text: string, make: Make): string {
  const doc = open(text);
  const result = plan(doc, ...make(doc));
  if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
  return applyEdits(text, result.value[FILE]!).text;
}

const renameJob = (job: string, to: string): WorkflowOp => ({ op: 'renameJob', file: FILE, job, to });

/** Rename goldens, kept in `golden/ops/<name>.yml` and read by eye once. */
const cases: [name: string, fixture: string, make: Make][] = [
  ['rename-job', 'starter.yml', (d) => [renameJob('build', 'compile'), jobReferences(d, 'build')]],
  [
    'rename-step-id',
    'starter.yml',
    (d) => [
      {
        op: 'renameStepId',
        file: FILE,
        job: 'build',
        index: 1,
        fp: fingerprint(d, 'build', 1)!,
        to: 'changes',
      },
      stepReferences(d, 'build', 1),
    ],
  ],
  [
    'rename-step-id-new',
    'starter.yml',
    (d) => [
      {
        op: 'renameStepId',
        file: FILE,
        job: 'build',
        index: 0,
        fp: fingerprint(d, 'build', 0)!,
        to: 'checkout',
      },
      [],
    ],
  ],
];

describe('rename goldens', () => {
  it.each(cases)('%s', async (name, file, make) => {
    const text = fixture(file);
    const out = renamed(text, make);
    await expect(out).toMatchFileSnapshot(`golden/ops/${name}.yml`);
    expect(renamed(`${BOM}${crlf(text)}`, make)).toBe(`${BOM}${crlf(out)}`);
  });
});

describe("renaming flowpact's resolve job (E2's numbers)", () => {
  const text = readFileSync(join(ROOT, 'packages/engine/test/fixtures/flowpact-release.yml'), 'utf8');
  const path = '.github/workflows/release.yml';
  const doc = WorkflowDocument.open(text, { path, kind: 'workflow' });
  const refs = jobReferences(doc, 'resolve');
  const op: WorkflowOp = { op: 'renameJob', file: path, job: 'resolve', to: 'tag-resolve' };
  const result = planOp(op, { doc: (p) => (p === path ? doc : undefined), refs });

  it('finds what referencesOf finds: 53 references, 1 key, 10 needs, 42 reads', () => {
    expect(refs).toHaveLength(53);
    const roles = (role: Reference['role']) => refs.filter((r) => r.role === role).length;
    expect([roles('key'), roles('needs'), roles('read')]).toEqual([1, 10, 42]);
  });

  it('renames each of them and nothing else: 52 lines change, and undo gives the bytes back', () => {
    if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
    expect(result.label).toBe('Renamed job resolve to tag-resolve');
    expect(result.renames).toEqual([
      { kind: 'job', file: path, job: 'resolve', from: 'resolve', to: 'tag-resolve' },
    ]);
    expect(result.select).toEqual({ file: path, path: ['jobs', 'tag-resolve'] });
    const edits = result.value[path]!;
    expect(edits).toHaveLength(53);
    const { text: out, inverse } = applyEdits(text, edits);
    const before = text.split('\n');
    expect(out.split('\n').filter((line, i) => line !== before[i])).toHaveLength(52);
    expect(out).not.toMatch(/needs\.resolve\b|needs: resolve\b|\[resolve,|^ {2}resolve:/m);
    expect(applyEdits(out, inverse).text).toBe(text);
  });

  it('core reads the renamed job, every need resolves and every read names it', () => {
    if (!result.ok) throw new Error(result.message);
    const out = applyEdits(text, result.value[path]!).text;
    const project = loadProject({ root: '.', fs: memoryFileSystem({ [path]: out }), validateSchema: false });
    const wf = project.workflows.get(path)!;
    expect(wf.parseErrors).toEqual([]);
    expect(Object.keys(wf.jobs)).toContain('tag-resolve');
    expect(Object.keys(wf.jobs)).not.toContain('resolve');
    expect(Object.values(wf.jobs).flatMap((j) => j.needs.filter((n) => !wf.jobs[n.id]))).toEqual([]);
    expect(out.match(/needs\.tag-resolve\b/g)).toHaveLength(42);
  });
});

describe('the references a rename writes', () => {
  /** E2's shapes: a quoted key, needs as a scalar, a flow list and a block list, reads in every scalar style. */
  const shapes = [
    'on:',
    '  workflow_call:',
    '    outputs:',
    '      out:',
    '        value: ${{ jobs.build.outputs.v }}',
    'jobs:',
    '  "build":',
    '    runs-on: ubuntu-latest',
    '    outputs:',
    '      v: ${{ steps.meta.outputs.v }}',
    '    steps:',
    "      - id: 'meta'",
    '        run: echo "v=1" >> "$GITHUB_OUTPUT"',
    "      - if: steps.meta.outcome == 'success'",
    '        run: echo ${{ steps.meta.outputs.v }} steps.meta.outputs.v',
    '  build-x:',
    '    needs: build',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: echo',
    '  deploy:',
    "    needs: ['build', build-x]",
    '    runs-on: ubuntu-latest',
    '    env:',
    '      A: "tab\\there ${{ needs.build.outputs.v }}"',
    "      B: 'it''s ${{ needs[''build''].outputs.v }} ${{ needs.build-x.result }}'",
    '      C: >-',
    '        folded',
    '        ${{ needs.Build.outputs.v }}',
    '      D: |',
    '        literal ${{ needs.build.result }} needs.build.result',
    '      F: "${{ needs.\\x62uild.result }}"',
    '    steps:',
    '      - run: echo',
    '  last:',
    '    needs:',
    '      - deploy',
    '      - "build"',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: echo',
    '',
  ].join('\n');

  it('keeps every quote and leaves alone what names another id, an escape and a script', () => {
    const out = renamed(shapes, (d) => [renameJob('build', 'compile'), jobReferences(d, 'build')]).split(
      '\n',
    );
    expect(out.filter((line, i) => line !== shapes.split('\n')[i])).toEqual([
      '        value: ${{ jobs.compile.outputs.v }}',
      '  "compile":',
      '    needs: compile',
      "    needs: ['compile', build-x]",
      '      A: "tab\\there ${{ needs.compile.outputs.v }}"',
      "      B: 'it''s ${{ needs[''compile''].outputs.v }} ${{ needs.build-x.result }}'",
      '        ${{ needs.compile.outputs.v }}',
      '        literal ${{ needs.compile.result }} needs.build.result',
      '      - "compile"',
    ]);
  });

  it('a step id: its value and its reads in its own job', () => {
    const doc = open(shapes);
    const op: WorkflowOp = {
      op: 'renameStepId',
      file: FILE,
      job: 'build',
      index: 0,
      fp: fingerprint(doc, 'build', 0)!,
      to: 'facts',
    };
    const result = plan(doc, op, stepReferences(doc, 'build', 0));
    if (!result.ok) throw new Error(result.message);
    const out = applyEdits(shapes, result.value[FILE]!).text.split('\n');
    expect(out.filter((line, i) => line !== shapes.split('\n')[i])).toEqual([
      '      v: ${{ steps.facts.outputs.v }}',
      "      - id: 'facts'",
      "      - if: steps.facts.outcome == 'success'",
      '        run: echo ${{ steps.facts.outputs.v }} steps.meta.outputs.v',
    ]);
    expect(result.renames).toEqual([{ kind: 'step', file: FILE, job: 'build', from: 'meta', to: 'facts' }]);
  });

  it('a job renamed only in case, and to an id YAML would read as another type', () => {
    const doc = open(fixture('starter.yml'));
    const result = plan(doc, renameJob('test', 'Test'), jobReferences(doc, 'test'));
    expect(result.ok && applyEdits(doc.text, result.value[FILE]!).text).toContain('  Test:\n');
    const typed = renamed(fixture('starter.yml'), (d) => [
      renameJob('preview', 'true'),
      jobReferences(d, 'preview'),
    ]);
    expect(typed).toContain("  'true':\n");
  });
});

describe('refusals of the renames', () => {
  const doc = open(fixture('starter.yml'));

  it('stale: a reference that is not the text the worker saw', () => {
    const refs = jobReferences(doc, 'build');
    const moved = open(`# a line above\n${doc.text}`);
    expect(refused(plan(moved, renameJob('build', 'compile'), refs))).toEqual({
      ok: false,
      reason: 'stale',
      file: FILE,
      message: `ci.yml changed at line ${refs[0]!.line} while the edit was prepared; try again.`,
      line: refs[0]!.line,
      fixes: [],
    });
  });

  it('duplicate-id and invalid-id: a free id as the fix', () => {
    expect(refused(plan(doc, renameJob('build', 'Deploy'), []))).toMatchObject({
      reason: 'duplicate-id',
      message: 'A job `deploy` already exists; ids ignore case.',
      fixes: [{ kind: 'ops', label: 'Use Deploy-2', ops: [renameJob('build', 'Deploy-2')], retry: false }],
    });
    expect(refused(plan(doc, renameJob('build', 'build it'), []))).toMatchObject({ reason: 'invalid-id' });
    const fp = fingerprint(doc, 'build', 0)!;
    expect(
      refused(plan(doc, { op: 'renameStepId', file: FILE, job: 'build', index: 0, fp, to: 'detect' }, [])),
    ).toMatchObject({ reason: 'duplicate-id', message: 'A step `detect` already exists; ids ignore case.' });
  });

  it('moved and not-found: the step or the job is not the one the author picked', () => {
    const fp = fingerprint(doc, 'build', 0)!;
    expect(
      refused(plan(doc, { op: 'renameStepId', file: FILE, job: 'build', index: 1, fp, to: 'x' }, [])).reason,
    ).toBe('moved');
    expect(refused(plan(doc, renameJob('ghost', 'x'), [])).reason).toBe('not-found');
  });

  it('shared-anchor: a key that aliases repeat renames only with them', () => {
    const anchored = open(
      'on: push\njobs:\n  &b build:\n    runs-on: x\n    steps: [{run: a}]\n  test:\n    needs: *b\n    runs-on: x\n    steps: [{run: b}]\n',
    );
    const refusal = refused(plan(anchored, renameJob('build', 'compile'), []));
    expect(refusal).toMatchObject({ reason: 'shared-anchor', fixes: [{ kind: 'shared-all' }] });
    const all = plan(anchored, renameJob('build', 'compile'), [], 'all');
    if (!all.ok) throw new Error(all.message);
    expect(all.documents[FILE]!.value()).toMatchObject({ jobs: { compile: {}, test: { needs: 'compile' } } });
  });
});
