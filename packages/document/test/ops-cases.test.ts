import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  caseFileText,
  WorkflowDocument,
  type CaseJson,
  type EditPlan,
  type Refusal,
  type TextEdit,
} from '@simulci/document';
import { applyEdits } from '@simulci/document/edits';
import { planOp } from '../src/ops/plan';
import type { WorkflowOp } from '../src/ops/types';
import { BOM, crlf, fixture } from './corpus';

const DIR = '.github/simulci/tests/';
const FILE = `${DIR}ci.test.yml`;
const open = (text: string, path = FILE) => WorkflowDocument.open(text, { path, kind: 'test' });
const context = (...docs: WorkflowDocument[]) => ({ doc: (p: string) => docs.find((d) => d.path === p) });

function refused(result: EditPlan<Record<string, TextEdit[]>>): Refusal {
  if (result.ok) throw new Error(`expected a refusal, got ${JSON.stringify(result.value)}`);
  return result;
}

const MAYBE: CaseJson = {
  name: 'a release',
  when: { event: 'release', action: 'published', tag: 'v1.2.0' },
  allowMaybe: true,
  then: { run: ['build', 'publish'], maybe: ['deploy'] },
  comments: ['deploy: maybe — vars.DEPLOY → pin: vars: {"DEPLOY":"true"}'],
};

const addCase = (testCase: CaseJson, workflow = 'ci.yml'): WorkflowOp => ({
  op: 'addCase',
  file: FILE,
  workflow,
  testCase,
});

function applied(text: string, op: WorkflowOp): string {
  const doc = open(text);
  const result = planOp(op, context(doc));
  if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
  return applyEdits(text, result.value[FILE]!).text;
}

/** `addCase` goldens, kept in `golden/ops/<name>.yml` and read by eye once. */
const cases: [name: string, fixture: string, op: WorkflowOp][] = [
  ['add-case-flow-when', 'ci.test.yml', addCase(MAYBE)],
  [
    'add-case-name-taken',
    'ci.test.yml',
    addCase({
      name: 'push to main',
      when: { event: 'push', branch: 'main' },
      then: { build: 'success' },
      comments: [],
    }),
  ],
  [
    'add-case-assume-block',
    'ci.test.yml',
    addCase({
      name: 'push with an assumption',
      when: { event: 'push', branch: 'main', assume: [{ job: 'build', result: 'failure' }] },
      then: { conclusion: 'failure' },
      comments: [],
    }),
  ],
  [
    'add-case-blank-separated',
    'cases.test.yml',
    addCase({
      name: 'a tag',
      when: { event: 'push', tag: 'v1', changed: ['src/a.ts', 'src/b.ts'] },
      then: { run: [] },
      comments: ['two lines\nof comment', ''],
    }),
  ],
];

describe('addCase goldens', () => {
  it.each(cases)('%s', async (name, file, op) => {
    const text = fixture(file);
    const out = applied(text, op);
    await expect(out).toMatchFileSnapshot(`golden/ops/${name}.yml`);
    // The case reads back as given, after the cases the file had.
    const before = parse(text) as { cases: unknown[] };
    const after = parse(out) as { cases: unknown[] };
    expect(after.cases.slice(0, -1)).toEqual(before.cases);
    expect(applied(`${BOM}${crlf(text)}`, op)).toBe(`${BOM}${crlf(out)}`);
  });

  it('the case as given: its keys in order, `allowMaybe` only when set, the comments above it', () => {
    const out = applied(fixture('ci.test.yml'), addCase(MAYBE));
    const last = (parse(out) as { cases: Record<string, unknown>[] }).cases.at(-1)!;
    expect(Object.keys(last)).toEqual(['name', 'when', 'allowMaybe', 'then']);
    expect(last).toEqual({ name: MAYBE.name, when: MAYBE.when, allowMaybe: true, then: MAYBE.then });
    expect(out).toContain(`  # ${MAYBE.comments[0]}\n  - name: a release\n`);
  });

  it('a file with no cases yet gets the list', () => {
    const out = applied('workflow: ci.yml\n', addCase({ ...MAYBE, comments: [] }));
    expect(out).toBe(
      'workflow: ci.yml\ncases:\n  - name: a release\n    when: { event: release, action: published, tag: v1.2.0 }\n    allowMaybe: true\n    then:\n      run: [build, publish]\n      maybe: [deploy]\n',
    );
  });
});

describe('the other-workflow refusal and its fix', () => {
  const doc = open(fixture('ci.test.yml'));
  const op = addCase(MAYBE, '.github/workflows/release.yml');

  it('refuses a case for another workflow, offering a file of its own', () => {
    const text = caseFileText(`${DIR}ci-2.test.yml`, 'release.yml', MAYBE, '\n');
    expect(refused(planOp(op, context(doc)))).toEqual({
      ok: false,
      reason: 'other-workflow',
      file: FILE,
      message: 'ci.test.yml tests ci.yml.',
      line: 1,
      at: ['workflow'],
      fixes: [
        {
          kind: 'ops',
          label: 'Create ci-2.test.yml',
          ops: [{ op: 'createFile', file: `${DIR}ci-2.test.yml`, text }],
          retry: false,
        },
      ],
    });
    expect(text).toBe(
      `workflow: release.yml\ncases:\n  # ${MAYBE.comments[0]}\n  - name: a release\n    when: { event: release, action: published, tag: v1.2.0 }\n    allowMaybe: true\n    then:\n      run: [build, publish]\n      maybe: [deploy]\n`,
    );
  });

  it('adds it to the next file that tests the workflow, or creates the first free name', () => {
    const release = open(
      'workflow: release.yml\ncases:\n  - name: x\n    when: { event: push }\n    then: {}\n',
      `${DIR}ci-2.test.yml`,
    );
    expect(refused(planOp(op, context(doc, release))).fixes).toEqual([
      {
        kind: 'ops',
        label: 'Add it to ci-2.test.yml',
        ops: [{ ...op, file: `${DIR}ci-2.test.yml` }],
        retry: false,
      },
    ]);
    const other = open('workflow: lint.yml\ncases: []\n', `${DIR}ci-2.test.yml`);
    expect(refused(planOp(op, context(doc, other))).fixes[0]).toMatchObject({
      label: 'Create ci-3.test.yml',
    });
  });

  it('the created file is one edit from the empty text; undo removes it, and it cannot be created twice', () => {
    const fix = refused(planOp(op, context(doc))).fixes[0]!;
    const create = fix.kind === 'ops' ? fix.ops[0]! : op;
    const result = planOp(create, context(doc));
    if (!result.ok) throw new Error(result.message);
    const path = `${DIR}ci-2.test.yml`;
    expect(result).toMatchObject({ label: 'Created ci-2.test.yml', created: [path] });
    expect(result.value).toEqual({
      [path]: [{ from: 0, to: 0, insert: create.op === 'createFile' ? create.text : '' }],
    });
    const { text, inverse } = applyEdits('', result.value[path]!);
    expect(result.documents[path]!.text).toBe(text);
    expect(result.documents[path]!.kind).toBe('test');
    expect(applyEdits(text, inverse).text).toBe('');
    // Now open, the file takes the case the next time.
    const created = result.documents[path]!;
    expect(refused(planOp(create, context(doc, created)))).toMatchObject({
      reason: 'stale',
      message: 'ci-2.test.yml exists already; try again.',
    });
    expect(planOp({ ...op, file: path }, context(doc, created)).ok).toBe(true);
  });

  it('a created file must parse, in one line ending', () => {
    const bad = planOp({ op: 'createFile', file: `${DIR}x.test.yml`, text: 'cases: [\n' }, context());
    expect(refused(bad).reason).toBe('internal');
    const mixed = planOp({ op: 'createFile', file: `${DIR}x.test.yml`, text: 'a: 1\r\nb: 2\n' }, context());
    expect(refused(mixed).reason).toBe('internal');
    const lf = planOp(
      { op: 'createFile', file: '.github/workflows/new.yml', text: 'on: push\r\n' },
      context(),
    );
    expect(lf.ok && lf.documents['.github/workflows/new.yml']!.kind).toBe('workflow');
  });
});

describe('refusals of addCase', () => {
  it('flow-shape: cases written in brackets', () => {
    expect(
      refused(planOp(addCase({ ...MAYBE, comments: [] }), context(open(fixture('flow.test.yml'))))),
    ).toMatchObject({ reason: 'flow-shape', line: 2 });
  });

  it('unsupported-shape: a test file that names no workflow', () => {
    expect(refused(planOp(addCase(MAYBE), context(open('cases: []\n'))))).toMatchObject({
      reason: 'unsupported-shape',
      message: 'ci.test.yml names no workflow (`workflow: ci.yml`); edit it in the YAML pane.',
    });
  });

  it('a generated test file is locked like any other', () => {
    const doc = WorkflowDocument.open('# DO NOT EDIT\nworkflow: ci.yml\ncases: []\n', {
      path: FILE,
      kind: 'test',
      generated: 'DO NOT EDIT',
    });
    expect(refused(planOp(addCase(MAYBE), context(doc))).reason).toBe('generated');
  });
});
