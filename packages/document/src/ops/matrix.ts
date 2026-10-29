import { isMap, isSeq } from 'yaml';
import type { WorkflowDocument } from '../document';
import { isRefusal } from '../guard';
import { insertDraft } from '../insert';
import { removeDraft } from '../remove';
import * as refusals from '../refusal';
import type { Refusal } from '../refusal';
import { setDraft, type OrderOf } from '../set';
import { isFlow, locate } from '../tree';
import type { Json, YamlPath } from '../types';
import type { Draft, Warning } from '../verify';
import { keyIn } from './bindings';
import { chain, type Step } from './chain';
import { jobMissing } from './fields';
import { checkId } from './ids';
import { orderFor } from './order';
import { inFlow, removeEmptied } from './restyle';
import { labelled } from './triggers';
import type { WorkflowOp } from './types';

type Op<K extends WorkflowOp['op']> = Extract<WorkflowOp, { op: K }>;

const strategyOf = (job: string): YamlPath => ['jobs', job, 'strategy'];
const matrixOf = (job: string): YamlPath => [...strategyOf(job), 'matrix'];

/** GitHub runs at most this many jobs from one matrix. */
const MAX_LEGS = 256;

/** Refuses a job that is not there, or whose matrix (or one of its lists) is an expression read at run time. */
function matrixRefusal(
  doc: WorkflowDocument,
  job: string,
  list?: 'include' | 'exclude',
): Refusal | undefined {
  const missing = jobMissing(doc, job);
  if (missing) return missing;
  for (const path of [matrixOf(job), ...(list ? [[...matrixOf(job), list]] : [])]) {
    const info = doc.get(path);
    if (info === undefined || info.kind === 'null') continue;
    if (info.kind === 'scalar' || (path.length === 5 && info.kind !== 'seq'))
      return refusals.unsupported(
        doc.path,
        path,
        `${refusals.describe(path)} is computed at run time`,
        doc.lineOf(path),
      );
  }
  return undefined;
}

/**
 * The key order of a job's matrix (§ 3.5): its dimensions as written, a new one last among them, then `include` and
 * `exclude`; elsewhere the canonical orders.
 */
function matrixOrder(doc: WorkflowDocument, job: string, dim?: string): OrderOf {
  const matrix = matrixOf(job);
  const keys = Object.keys(asMap(doc.get(matrix)?.value));
  const dims = keys.filter((k) => k !== 'include' && k !== 'exclude');
  const order = [...dims, ...(dim !== undefined && !dims.includes(dim) ? [dim] : []), 'include', 'exclude'];
  return (path) =>
    path.length === matrix.length && path.every((s, i) => s === matrix[i]) ? order : orderFor(path);
}

const asMap = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * A dimension of a job's matrix set: its list patched in place (each kept value keeps its line), or a new key before
 * `include` and `exclude`, `strategy:` and `matrix:` created in order when missing. Values keep their types (`3.10`
 * stays a string); a numeric string added to a dimension of numbers is a number. `null` or no values removes the
 * dimension, and the matrix and the strategy it leaves empty.
 */
export function setMatrixDim(doc: WorkflowDocument, op: Op<'setMatrixDim'>, shared?: 'all'): Draft | Refusal {
  const bad = matrixRefusal(doc, op.job);
  if (bad) return bad;
  const dim = keyIn(doc, matrixOf(op.job), op.dim);
  const path = [...matrixOf(op.job), dim];
  const label = `${op.values === null ? 'Removed' : 'Set'} ${op.job}'s matrix ${dim}`;
  const before = doc.get(path)?.value;
  const named = dimensionName(doc, op, before === undefined);
  if (named) return named;
  if (op.values === null || op.values.length === 0)
    return before === undefined
      ? { edits: [], label }
      : labelled(removeEmptied(doc, path, strategyOf(op.job).length, shared), label);
  const values = numbersKept(before, op.values);
  const draft = setDraft(doc, path, values, {
    order: matrixOrder(doc, op.job, dim),
    ...(shared ? { shared } : {}),
  });
  if (isRefusal(draft)) return draft;
  return { ...draft, label, select: ['jobs', op.job], warnings: legWarning(doc, op.job, dim, values) };
}

/** Refuses `include` and `exclude` as a dimension, and a new dimension whose name is not an id. */
function dimensionName(doc: WorkflowDocument, op: Op<'setMatrixDim'>, added: boolean): Refusal | undefined {
  if (/^(?:include|exclude)$/i.test(op.dim))
    return refusals.refuse(
      'invalid-id',
      doc.path,
      `\`${op.dim}\` lists whole legs, not the values of a dimension: name the dimension something else.`,
      { at: [...matrixOf(op.job), op.dim] },
    );
  return added ? checkId(doc, 'dimension', op.dim, [], (id) => ({ ...op, dim: id })) : undefined;
}

/** A dimension whose values are all numbers keeps numbers: `26` typed into `node: [22, 24]` is the number 26. */
function numbersKept(before: unknown, values: readonly Json[]): Json[] {
  const numbers = Array.isArray(before) && before.length > 0 && before.every((v) => typeof v === 'number');
  return values.map((v) =>
    numbers && typeof v === 'string' && /^-?\d+(?:\.\d+)?$/.test(v.trim()) ? Number(v) : v,
  );
}

/** A warning when the dimensions' combinations, before `include` and `exclude`, pass GitHub's limit. */
function legWarning(doc: WorkflowDocument, job: string, dim: string, values: readonly Json[]): Warning[] {
  const matrix = { ...asMap(doc.get(matrixOf(job))?.value), [dim]: values };
  const legs = Object.entries(matrix)
    .filter(([key, v]) => key !== 'include' && key !== 'exclude' && Array.isArray(v))
    .reduce((n, [, v]) => n * (v as unknown[]).length, 1);
  return legs > MAX_LEGS
    ? [
        {
          code: 'matrix-limit',
          message: `${job}'s matrix makes ${legs} combinations; GitHub runs at most ${MAX_LEGS} jobs from one matrix.`,
        },
      ]
    : [];
}

/**
 * One `include` or `exclude` entry set: appended (a flow map when the list's entries are written so), patched key by
 * key in place, or removed with `null`, the list and the matrix it leaves empty going too.
 */
export function setMatrixEntry(
  doc: WorkflowDocument,
  op: Op<'setMatrixEntry'>,
  shared?: 'all',
): Draft | Refusal {
  const bad = matrixRefusal(doc, op.job, op.list);
  if (bad) return bad;
  const list = [...matrixOf(op.job), op.list];
  const length = (doc.get(list)?.value as unknown[] | undefined)?.length ?? 0;
  const label = entryLabel(op);
  const options = shared ? { shared } : {};
  if (op.entry === null) {
    if (op.index === 'append') return { edits: [], label };
    return labelled(removeEmptied(doc, [...list, op.index], strategyOf(op.job).length, shared), label);
  }
  const entry = op.entry;
  if (op.index === 'append') {
    const padded = flowEntries(doc, list);
    return chain(doc, label, [
      (d) => insertDraft(d, list, length, entry, { order: matrixOrder(doc, op.job), ...options }),
      (d) => (padded === undefined ? undefined : inFlow(d, [...list, length], padded)),
    ]);
  }
  const item = [...list, op.index];
  if (op.index < 0 || op.index >= length || !Number.isInteger(op.index))
    return refusals.outOfRange(doc.path, item, length);
  const keys = Object.keys(asMap(doc.get(item)?.value));
  const steps: Step[] = [
    ...Object.entries(entry).map(
      ([key, value]): Step =>
        (d) =>
          setDraft(d, [...item, key], value, options),
    ),
    ...keys
      .filter((key) => !Object.hasOwn(entry, key))
      .map(
        (key): Step =>
          (d) =>
            removeDraft(d, [...item, key], 'null', options),
      ),
  ];
  const draft = chain(doc, label, steps);
  return isRefusal(draft) ? draft : { ...draft, select: ['jobs', op.job] };
}

/**
 * Whether a matrix list writes its entries as flow maps (`- { os: linux }`), and then whether padded inside the
 * braces; undefined when most are block maps, or there are none.
 */
function flowEntries(doc: WorkflowDocument, list: YamlPath): boolean | undefined {
  const node = locate(doc.tree, list)?.node;
  const maps = isSeq(node) ? node.items.filter((item) => isMap(item)) : [];
  const flow = maps.filter((item) => isFlow(item));
  if (flow.length === 0 || flow.length * 2 < maps.length) return undefined;
  const padded = flow.filter((item) => doc.text[item.range[0] + 1] === ' ').length;
  return padded * 2 >= flow.length;
}

function entryLabel(op: Op<'setMatrixEntry'>): string {
  const matrix = `${op.job}'s matrix`;
  if (op.index === 'append') return `Added an ${op.list} entry to ${matrix}`;
  return `${op.entry === null ? 'Removed' : 'Set'} ${op.list} entry ${op.index + 1} of ${matrix}`;
}

/** How a strategy field's text is read: `max-parallel: 2` a number, `fail-fast: false` a boolean. */
const STRATEGY_KIND = { 'fail-fast': 'boolean', 'max-parallel': 'number' } as const;

/**
 * `fail-fast` or `max-parallel` set in the strategy order, `strategy:` created in the job order; `null` removes the
 * field, and a strategy it leaves empty.
 */
export function setStrategyField(
  doc: WorkflowDocument,
  op: Op<'setStrategyField'>,
  shared?: 'all',
): Draft | Refusal {
  const missing = jobMissing(doc, op.job);
  if (missing) return missing;
  const path = [...strategyOf(op.job), op.field];
  const label = `${op.value === null ? 'Removed' : 'Set'} ${op.job}'s ${op.field}`;
  if (op.value === null)
    return doc.get(path) === undefined
      ? { edits: [], label }
      : labelled(removeEmptied(doc, path, strategyOf(op.job).length, shared), label);
  const draft = setDraft(doc, path, op.value, {
    order: orderFor,
    as: STRATEGY_KIND[op.field],
    ...(shared ? { shared } : {}),
  });
  return isRefusal(draft) ? draft : { ...draft, label, select: ['jobs', op.job] };
}
