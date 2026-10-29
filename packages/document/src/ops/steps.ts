import type { WorkflowDocument } from '../document';
import { isRefusal } from '../guard';
import { insertDraft, moveDraft } from '../insert';
import { removeDraft } from '../remove';
import * as refusals from '../refusal';
import type { Refusal } from '../refusal';
import type { Draft, Warning } from '../verify';
import { danglingReads, fieldDraft, jobMissing, readOf, reads } from './fields';
import { checkId } from './ids';
import { stepBody } from './jobs';
import { ORDER } from './order';
import type { Fp, WorkflowOp } from './types';

type Op<K extends WorkflowOp['op']> = Extract<WorkflowOp, { op: K }>;

/**
 * Refuses a step op whose step is not the one the author picked (`moved`): its id, name, `uses` and first `run`
 * line, read from the document when the gesture started, are not those of the step now at that index.
 */
export function checkStep(doc: WorkflowDocument, job: string, index: number, fp: Fp): Refusal | undefined {
  const missing = jobMissing(doc, job);
  if (missing) return missing;
  const steps = doc.jobs().find((j) => j.id === job)?.steps ?? [];
  const step = steps[index];
  if (!step) return refusals.outOfRange(doc.path, ['jobs', job, 'steps', index], steps.length);
  const same =
    step.id === fp.id &&
    step.name === fp.name &&
    step.uses === fp.uses &&
    step.runHead === fp.runHead &&
    (fp.digest === undefined || fp.digest === digestOf(doc, job, index));
  return same ? undefined : refusals.moved(doc.path, ['jobs', job, 'steps', index]);
}

/** The fingerprint of the step at an index, to read when a gesture starts (§ 4.10); none for no step there. */
export function fingerprint(doc: WorkflowDocument, job: string, index: number): Fp | undefined {
  const step = doc.jobs().find((j) => j.id === job)?.steps[index];
  if (!step) return undefined;
  const fp: Fp = { digest: digestOf(doc, job, index) };
  for (const key of ['id', 'name', 'uses', 'runHead'] as const)
    if (step[key] !== undefined) fp[key] = step[key];
  return fp;
}

/** FNV-1a of the step's value as JSON: two steps with the same id, name, `uses` and first line still differ. */
function digestOf(doc: WorkflowDocument, job: string, index: number): string {
  const text = JSON.stringify(doc.get(['jobs', job, 'steps', index])?.value ?? null);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** A step at an index of a job's steps, its keys in the step order; the job's `steps:` created when missing. */
export function addStep(doc: WorkflowDocument, op: Op<'addStep'>, shared?: 'all'): Draft | Refusal {
  const missing = jobMissing(doc, op.job);
  if (missing) return missing;
  if (doc.get(['jobs', op.job, 'uses']))
    return refusals.unsupported(
      doc.path,
      ['jobs', op.job],
      `the job ${op.job} calls a reusable workflow and runs no steps of its own`,
      doc.lineOf(['jobs', op.job]),
    );
  const taken = (doc.jobs().find((j) => j.id === op.job)?.steps ?? []).flatMap((s) =>
    s.id === undefined ? [] : [s.id],
  );
  const bad =
    op.step.id === undefined
      ? undefined
      : checkId(doc, 'step', op.step.id, taken, (id) => ({ ...op, step: { ...op.step, id } }));
  if (bad) return bad;
  const draft = insertDraft(doc, ['jobs', op.job, 'steps'], op.index, stepBody(doc, op.step), {
    order: ORDER.job,
    ...(shared ? { shared } : {}),
  });
  return isRefusal(draft) ? draft : { ...draft, label: `Added a step to ${op.job}` };
}

/** A step out with its lines; a step whose id is read elsewhere in its job gets a warning. */
export function removeStep(doc: WorkflowDocument, op: Op<'removeStep'>, shared?: 'all'): Draft | Refusal {
  const moved = checkStep(doc, op.job, op.index, op.fp);
  if (moved) return moved;
  const draft = removeDraft(doc, ['jobs', op.job, 'steps', op.index], 'null', shared ? { shared } : {});
  if (isRefusal(draft)) return draft;
  const id = op.fp.id;
  const spans =
    id === undefined
      ? []
      : reads(doc, readOf('steps', id), ['jobs', op.job, 'steps', op.index]).filter((s) =>
          inJob(doc, op.job, s.from),
        );
  const select = op.index > 0 ? ['jobs', op.job, 'steps', op.index - 1] : ['jobs', op.job];
  return {
    ...draft,
    label: `Removed ${refusals.describe(['jobs', op.job, 'steps', op.index])}`,
    warnings: danglingReads(doc, `steps.${id}`, spans),
    select,
  };
}

const inJob = (doc: WorkflowDocument, job: string, offset: number): boolean => {
  const span = doc.spanOf(['jobs', job]);
  return span !== undefined && offset >= span.from && offset < span.to;
};

/** A step moved within its job: one removal and one insertion. The selection follows it. */
export function moveStep(doc: WorkflowDocument, op: Op<'moveStep'>, shared?: 'all'): Draft | Refusal {
  const moved = checkStep(doc, op.job, op.from, op.fp);
  if (moved) return moved;
  const draft = moveDraft(doc, ['jobs', op.job, 'steps'], op.from, op.to, shared ? { shared } : {});
  return isRefusal(draft) ? draft : { ...draft, warnings: readsBefore(doc, op) };
}

/** Expressions that read a step's outputs from a step that the move puts before it (`steps.detect` above `detect`). */
function readsBefore(doc: WorkflowDocument, op: Op<'moveStep'>): Warning[] {
  const steps = doc.jobs().find((j) => j.id === op.job)?.steps ?? [];
  const order = steps.map((_, i) => i);
  order.splice(op.to, 0, ...order.splice(op.from, 1));
  const spans = steps.map((_, i) => doc.spanOf(['jobs', op.job, 'steps', i]));
  const stepAt = (offset: number) =>
    spans.findIndex((s) => s !== undefined && offset >= s.from && offset < s.to);
  return steps.flatMap((step, i) => {
    if (step.id === undefined) return [];
    const early = reads(doc, readOf('steps', step.id), ['jobs', op.job, 'steps', i]).filter((s) => {
      const reader = stepAt(s.from);
      return reader > i && order.indexOf(reader) < order.indexOf(i);
    });
    return danglingReads(doc, `steps.${step.id}`, early, ', now before that step runs');
  });
}

export function setStepField(doc: WorkflowDocument, op: Op<'setStepField'>, shared?: 'all'): Draft | Refusal {
  const moved = checkStep(doc, op.job, op.index, op.fp) ?? stepKind(doc, op);
  if (moved) return moved;
  const step = ['jobs', op.job, 'steps', op.index];
  const draft = fieldDraft(doc, [...step, op.field], op.value, shared);
  return isRefusal(draft) ? draft : { ...draft, select: step };
}

/**
 * A step's action pinned to a commit (synthesis § 4.8, Pin to SHA): its `uses:` written `<action>@<sha>` in place,
 * with `# <tag>` as the line's comment, which replaces a comment already there (the tag a pin wrote before). Refused
 * for a step without a remote action, and for a `uses:` that does not end its line (a flow map).
 */
export function pinStepUses(doc: WorkflowDocument, op: Op<'pinStepUses'>): Draft | Refusal {
  const moved = checkStep(doc, op.job, op.index, op.fp);
  if (moved) return moved;
  const step = ['jobs', op.job, 'steps', op.index];
  const path = [...step, 'uses'];
  const uses = doc.get(path)?.value;
  const at = typeof uses === 'string' && !uses.startsWith('./') ? uses.lastIndexOf('@') : -1;
  if (at <= 0 || !/^[0-9a-f]{40}$/.test(op.sha) || /[\r\n]/.test(op.tag))
    return refusals.unsupported(
      doc.path,
      path,
      `${refusals.describe(step)} has no remote action to pin`,
      doc.lineOf(path),
    );
  const draft = fieldDraft(doc, path, `${(uses as string).slice(0, at)}@${op.sha}`);
  if (isRefusal(draft) || draft.edits.length === 0) return draft;
  const [edit] = draft.edits;
  const lines = doc.tree.lines;
  const end = lines.breakAt(lines.lineAt(edit!.from));
  const rest = /^([ \t]*)(#.*)?$/.exec(doc.text.slice(edit!.to, end));
  if (draft.edits.length > 1 || edit!.insert.includes('\n') || !rest || edit!.to > end)
    return refusals.unsupported(
      doc.path,
      path,
      `the \`uses\` of ${refusals.describe(step)} shares its line with other keys`,
      doc.lineOf(path),
    );
  // A comment already there keeps its column.
  const gap = rest[2] === undefined ? ' ' : rest[1] || ' ';
  return {
    ...draft,
    edits: [{ from: edit!.from, to: end, insert: `${edit!.insert}${gap}# ${op.tag}` }],
    select: step,
  };
}

/** Fields only one kind of step takes: a script's `shell` and `working-directory`, an action's `uses`. */
const SCRIPT_FIELDS = new Set<string>(['run', 'shell', 'working-directory']);

/** Refuses a field the step's kind does not take (GitHub rejects `shell` on an action, `uses` with `run`). */
function stepKind(doc: WorkflowDocument, op: Op<'setStepField'>): Refusal | undefined {
  if (op.value === null) return undefined;
  const path = ['jobs', op.job, 'steps', op.index];
  const action = doc.get([...path, 'uses']) !== undefined;
  const script = doc.get([...path, 'run']) !== undefined;
  const wrong = SCRIPT_FIELDS.has(op.field) ? action : op.field === 'uses' && script;
  if (!wrong) return undefined;
  const kind = action ? 'uses an action' : 'runs a script';
  return refusals.unsupported(
    doc.path,
    [...path, op.field],
    `${refusals.describe(path)} ${kind}, which takes no \`${op.field}\``,
    doc.lineOf(path),
  );
}
