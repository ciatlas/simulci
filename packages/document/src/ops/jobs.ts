import { isScalar } from 'yaml';
import type { WorkflowDocument } from '../document';
import { isRefusal } from '../guard';
import { removeDraft } from '../remove';
import * as refusals from '../refusal';
import type { Refusal } from '../refusal';
import { setDraft } from '../set';
import { locate } from '../tree';
import type { Json, YamlPath } from '../types';
import type { Draft } from '../verify';
import { chain } from './chain';
import { danglingReads, fieldDraft, ifValue, jobMissing, readOf, reads, runValue } from './fields';
import { checkId } from './ids';
import { canonical, needsRefusal, needsValue, removeNeed, timesNeeded } from './needs';
import { ORDER, orderFor } from './order';
import type { NewStep, WorkflowOp } from './types';

type Op<K extends WorkflowOp['op']> = Extract<WorkflowOp, { op: K }>;

export function setWorkflowField(
  doc: WorkflowDocument,
  op: Op<'setWorkflowField'>,
  shared?: 'all',
): Draft | Refusal {
  return fieldDraft(doc, [op.field], op.value, shared);
}

/** A job's field set or removed; a missing job is refused, not created. */
export function setJobField(doc: WorkflowDocument, op: Op<'setJobField'>, shared?: 'all'): Draft | Refusal {
  const missing = jobMissing(doc, op.job) ?? jobFieldKind(doc, op);
  if (missing) return missing;
  const draft = fieldDraft(doc, ['jobs', op.job, op.field], op.value, shared);
  return isRefusal(draft) ? draft : { ...draft, select: ['jobs', op.job] };
}

/** Fields only a job that runs steps takes: a reusable call (`uses`) takes none of them, nor they a `uses`. */
const STEPS_JOB_FIELDS = new Set<string>(['runs-on', 'timeout-minutes', 'environment', 'continue-on-error']);

/** Refuses a field the job's kind does not take (GitHub rejects `runs-on` on a reusable call, `uses` with steps). */
function jobFieldKind(doc: WorkflowDocument, op: Op<'setJobField'>): Refusal | undefined {
  if (op.value === null) return undefined;
  const job = ['jobs', op.job];
  const call = doc.get([...job, 'uses']) !== undefined;
  const steps = doc.get([...job, 'steps']) !== undefined || doc.get([...job, 'runs-on']) !== undefined;
  const wrong = op.field === 'uses' ? steps : call && STEPS_JOB_FIELDS.has(op.field);
  if (!wrong) return undefined;
  const kind = call ? 'calls a reusable workflow' : 'runs steps';
  return refusals.unsupported(
    doc.path,
    job,
    `the job ${op.job} ${kind}, which takes no \`${op.field}\``,
    doc.lineOf(job),
  );
}

/**
 * A new job after `after` (else last), its keys in the job order, blank-separated when the file separates jobs. A job
 * that runs steps gets a `runs-on`: the one given, else `after`'s, else the file's commonest, else `ubuntu-latest`.
 */
export function addJob(doc: WorkflowDocument, op: Op<'addJob'>): Draft | Refusal {
  const ids = doc.jobs().map((j) => j.id);
  const bad = checkId(doc, 'job', op.id, ids, (id) => ({ ...op, id })) ?? newJobRefusal(doc, op);
  if (bad) return bad;
  const at = op.after === undefined ? ids.length - 1 : ids.indexOf(op.after);
  const jobs = [...ids.slice(0, at + 1), op.id];
  const order = (path: YamlPath) => (path.length === 1 && path[0] === 'jobs' ? jobs : orderFor(path));
  const draft = setDraft(doc, ['jobs', op.id], jobBody(doc, op), { order });
  return isRefusal(draft) ? draft : { ...draft, label: `Added job ${op.id}`, select: ['jobs', op.id] };
}

/**
 * Why a new job cannot be written: `after` is no job, its needs are not jobs here (or itself), or its steps' ids are
 * not ids or repeat one another.
 */
function newJobRefusal(doc: WorkflowDocument, op: Op<'addJob'>): Refusal | undefined {
  const ids = doc.jobs().map((j) => j.id);
  if (op.after !== undefined && !ids.includes(op.after))
    return refusals.notFound(doc.path, ['jobs', op.after]);
  const needs = needsRefusal(doc, op.id, canonical(doc, op.job.needs ?? []));
  if (needs) return needs;
  const steps = op.job.steps ?? [];
  for (const [i, step] of steps.entries()) {
    const taken = steps.slice(0, i).flatMap((s) => (s.id === undefined ? [] : [s.id]));
    const retry = (id: string): WorkflowOp => ({
      ...op,
      job: { ...op.job, steps: steps.with(i, { ...step, id }) },
    });
    const bad = step.id === undefined ? undefined : checkId(doc, 'step', step.id, taken, retry);
    if (bad) return bad;
  }
  return undefined;
}

function jobBody(doc: WorkflowDocument, op: Op<'addJob'>): { [key: string]: Json } {
  const job = op.job;
  const needs = canonical(doc, job.needs ?? []);
  const fields: { [key: string]: Json | undefined } = {
    name: job.name,
    'runs-on': job.uses === undefined ? (job['runs-on'] ?? defaultRunsOn(doc, op.after)) : undefined,
    needs: needs.length > 0 ? needsValue(doc, needs) : undefined,
    if: job.if === undefined ? undefined : ifValue(doc, job.if),
    uses: job.uses,
    with: job.with,
    steps: job.steps?.map((step) => stepBody(doc, step)),
  };
  return ordered(fields, ORDER.job);
}

/** A new step's keys in the step order; a multi-line `run` ends with a line break, an `if:` is written as the file's. */
export function stepBody(doc: WorkflowDocument, step: NewStep): { [key: string]: Json } {
  const fields: { [key: string]: Json | undefined } = {
    ...step,
    if: step.if === undefined ? undefined : ifValue(doc, step.if),
    run: typeof step.run === 'string' ? runValue(step.run) : step.run,
  };
  return ordered(fields, ORDER.step);
}

function ordered(
  fields: { [key: string]: Json | undefined },
  order: readonly string[],
): { [key: string]: Json } {
  const out: { [key: string]: Json } = {};
  for (const key of [...order, ...Object.keys(fields)])
    if (fields[key] !== undefined && !(key in out)) out[key] = fields[key];
  return out;
}

/**
 * `after`'s scalar `runs-on`, else the file's commonest, else `ubuntu-latest`. An expression (`${{ matrix.os }}`)
 * reads what the new job does not have, and is not copied.
 */
function defaultRunsOn(doc: WorkflowDocument, after: string | undefined): Json {
  const scalarOf = (id: string) => {
    const node = locate(doc.tree, ['jobs', id, 'runs-on'])?.node;
    return isScalar(node) && typeof node.value === 'string' && !node.value.includes('${{')
      ? node.value
      : undefined;
  };
  const own = after === undefined ? undefined : scalarOf(after);
  if (own !== undefined) return own;
  const counts = new Map<string, number>();
  for (const { id } of doc.jobs()) {
    const runsOn = scalarOf(id);
    if (runsOn !== undefined) counts.set(runsOn, (counts.get(runsOn) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'ubuntu-latest';
}

/**
 * A job out with its lines, its leading comments and one separator, and out of every `needs` that names it. What
 * still reads it in an expression is a warning, not a refusal.
 */
export function removeJob(doc: WorkflowDocument, op: Op<'removeJob'>, shared?: 'all'): Draft | Refusal {
  const missing = jobMissing(doc, op.job);
  if (missing) return missing;
  const ids = doc.jobs().map((j) => j.id);
  const others = ids.filter((id) => id !== op.job);
  // Every entry naming the job goes, a need written twice included.
  const needSteps = others.flatMap((other) =>
    Array.from(
      { length: timesNeeded(doc, other, op.job) },
      () => (d: WorkflowDocument) => removeNeed(d, other, op.job, shared),
    ),
  );
  const draft = chain(doc, `Removed job ${op.job}`, [
    ...needSteps,
    (d) => removeDraft(d, ['jobs', op.job], 'null', shared ? { shared } : {}),
  ]);
  if (isRefusal(draft)) return draft;
  const spans = reads(doc, readOf('(?:needs|jobs)', op.job), ['jobs', op.job]);
  const previous = ids[ids.indexOf(op.job) - 1];
  return {
    ...draft,
    warnings: danglingReads(doc, op.job, spans),
    select: previous === undefined ? [] : ['jobs', previous],
  };
}
