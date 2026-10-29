import { isMap, isSeq } from 'yaml';
import { WorkflowDocument } from '../document';
import { applyEdits, type TextEdit } from '../edits';
import { isRefusal } from '../guard';
import { insertDraft } from '../insert';
import * as refusals from '../refusal';
import { fileName, type Fix, type Refusal } from '../refusal';
import { inlineScalar } from '../scalar';
import { eolOf, textStyle } from '../style';
import { isFlow, locate } from '../tree';
import type { Eol, FileKind, Json } from '../types';
import { verify, type Draft, type EditPlan } from '../verify';
import { chain } from './chain';
import { commentsBefore, inFlow } from './restyle';
import type { CaseJson, OpContext, WorkflowOp } from './types';

type Op<K extends WorkflowOp['op']> = Extract<WorkflowOp, { op: K }>;

/** A workflow as a test file's `workflow:` names it: `ci.yml` and `.github/workflows/ci.yml` are one. */
const shortName = (workflow: string): string => workflow.replace(/^\.github\/workflows\//, '');

/**
 * A case appended to a test file's `cases:`, in the file's style: its keys in the case order, `when:` on one line in
 * flow when the file writes its cases' `when` so and the case has no `assume` (as `fileFromPlan` does), its maybe
 * comments as its leading comment lines. A name the file already has gets ` (2)`. A file testing another workflow
 * is refused (`other-workflow`), with a new file, or the next one testing this workflow, as the fix.
 */
export function addCase(
  doc: WorkflowDocument,
  op: Op<'addCase'>,
  _shared?: 'all',
  ctx?: OpContext,
): Draft | Refusal {
  const workflow = doc.get(['workflow'])?.value;
  if (typeof workflow !== 'string')
    return refusals.refuse(
      'unsupported-shape',
      doc.path,
      `${fileName(doc.path)} names no workflow (\`workflow: ci.yml\`); edit it in the YAML pane.`,
      { at: ['workflow'], line: 1, fixes: [{ kind: 'reveal', label: 'Show line 1', line: 1 }] },
    );
  if (shortName(workflow) !== shortName(op.workflow)) return otherWorkflow(doc, op, workflow, ctx);
  return appendCase(doc, op.testCase);
}

/** The case's draft: inserted last, `when:` restyled, the comments put above it. */
function appendCase(doc: WorkflowDocument, testCase: CaseJson): Draft | Refusal {
  const cases = doc.get(['cases'])?.value;
  const names = Array.isArray(cases) ? cases.map((c) => (isObject(c) ? c.name : undefined)) : [];
  const index = Array.isArray(cases) ? cases.length : 0;
  const name = freeCaseName(testCase.name, names);
  const flow = whenInFlow(doc, testCase);
  const draft = chain(doc, `Added a case to ${fileName(doc.path)}`, [
    (d) => insertDraft(d, ['cases'], index, caseValue({ ...testCase, name })),
    (d) => (flow === undefined ? undefined : inFlow(d, ['cases', index, 'when'], flow)),
    (d) => commentsBefore(d, ['cases', index], testCase.comments),
  ]);
  return isRefusal(draft) ? draft : { ...draft, select: ['cases', index] };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A case name the file does not have yet: the name, else `name (2)`, `name (3)`. */
export function freeCaseName(name: string, taken: readonly unknown[]): string {
  if (!taken.includes(name)) return name;
  for (let n = 2; ; n++) if (!taken.includes(`${name} (${n})`)) return `${name} (${n})`;
}

/** The case as the file writes it: `name, when, allowMaybe, then`. */
function caseValue(testCase: CaseJson): { [key: string]: Json } {
  const value: { [key: string]: Json } = { name: testCase.name, when: testCase.when };
  if (testCase.allowMaybe) value.allowMaybe = true;
  value.then = testCase.then;
  return value;
}

/**
 * Whether the new case's `when:` goes in flow, and then padded inside its braces (`{ event: push }`); undefined for
 * block. Flow unless most of the file's cases write it in block, or the case has an `assume` (a list of maps); padded
 * as most flow ones are, else padded as yaml writes them.
 */
function whenInFlow(doc: WorkflowDocument, testCase: CaseJson): boolean | undefined {
  if (testCase.when.assume !== undefined) return undefined;
  const cases = locate(doc.tree, ['cases'])?.node;
  const whens = (isSeq(cases) ? cases.items : []).flatMap((_, i) => {
    const when = locate(doc.tree, ['cases', i, 'when'])?.node;
    return isMap(when) ? [when] : [];
  });
  const flow = whens.filter((when) => isFlow(when));
  if (flow.length * 2 < whens.length) return undefined;
  if (flow.length === 0) return true;
  return flow.filter((when) => doc.text[when.range[0] + 1] === ' ').length * 2 >= flow.length;
}

/**
 * The fix for a case whose test file tests another workflow: add it to the first `<base>-<n>.test.yml` beside it that
 * tests this one, or create the first that is not there (none past `<base>-99`).
 */
function otherWorkflow(
  doc: WorkflowDocument,
  op: Op<'addCase'>,
  workflow: string,
  ctx: OpContext | undefined,
): Refusal {
  const dir = op.file.slice(0, op.file.lastIndexOf('/') + 1);
  const base = fileName(op.file).replace(/\.test\.ya?ml$/, '');
  let fix: Fix | undefined;
  for (let n = 2; fix === undefined && n < 100; n++) {
    const path = `${dir}${base}-${n}.test.yml`;
    const other = ctx?.doc(path);
    const tests = other?.get(['workflow'])?.value;
    if (other === undefined) fix = createFix(doc, op, path);
    else if (typeof tests === 'string' && shortName(tests) === shortName(op.workflow))
      fix = { kind: 'ops', label: `Add it to ${fileName(path)}`, ops: [{ ...op, file: path }], retry: false };
  }
  return refusals.otherWorkflow(doc.path, workflow, doc.lineOf(['workflow']), fix ? [fix] : []);
}

function createFix(doc: WorkflowDocument, op: Op<'addCase'>, path: string): Fix {
  const text = caseFileText(path, shortName(op.workflow), op.testCase, doc.style.eol);
  return {
    kind: 'ops',
    label: `Create ${fileName(path)}`,
    ops: [{ op: 'createFile', file: path, text }],
    retry: false,
  };
}

/**
 * A new test file holding one case: `workflow:` and the case, written as `addCase` writes one into a file with no
 * cases yet.
 */
export function caseFileText(path: string, workflow: string, testCase: CaseJson, eol: Eol): string {
  const name = inlineScalar(workflow, 'value', textStyle('')) ?? workflow;
  const skeleton = WorkflowDocument.open(`workflow: ${name}${eol}`, { path, kind: 'test' });
  const draft = appendCase(skeleton, testCase);
  return isRefusal(draft) ? skeleton.text : applyEdits(skeleton.text, draft.edits).text;
}

/** What a path holds, by where it is: a test file, a workflow, an action, or another file. */
export function kindOf(path: string): FileKind {
  if (/\.test\.ya?ml$/.test(path)) return 'test';
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) return 'workflow';
  if (/(?:^|\/)action\.ya?ml$/.test(path)) return 'action';
  return 'other';
}

/**
 * A new file from its text (a test file `fileFromPlan` wrote): one edit against the empty text, its path in
 * `created`, so that undo removes the file rather than leave it empty. Refused when the path is open already (the
 * view thought it missing); the text must parse, as any edit's result must.
 */
export function createFile(op: Op<'createFile'>, ctx: OpContext): EditPlan<Record<string, TextEdit[]>> {
  if (ctx.doc(op.file)) return refusals.exists(op.file);
  const options = { path: op.file, kind: kindOf(op.file) };
  const empty = WorkflowDocument.open('', options);
  const value = WorkflowDocument.open(op.text, options).value();
  const plan = verify(empty, {
    edits: op.text === '' ? [] : [{ from: 0, to: 0, insert: op.text }],
    expect: () => value,
    label: `Created ${fileName(op.file)}`,
    eol: eolOf(op.text),
  });
  return plan.ok ? { ...plan, value: { [op.file]: plan.value }, created: [op.file] } : plan;
}
