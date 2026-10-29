import { isScalar, isSeq, type ParsedNode, type Scalar } from 'yaml';
import type { WorkflowDocument } from '../document';
import type { TextEdit } from '../edits';
import { equivalents, isRefusal } from '../guard';
import { setIn } from '../json';
import { renameKeyDraft, replaceAtDraft } from '../primitives';
import * as refusals from '../refusal';
import type { Refusal } from '../refusal';
import { inlineScalar, tokenQuote } from '../scalar';
import { setDraft } from '../set';
import { isFlow, locate, walkNodes } from '../tree';
import type { Span, YamlPath } from '../types';
import type { Draft } from '../verify';
import { jobMissing } from './fields';
import { checkId, sameId } from './ids';
import { orderFor } from './order';
import { checkStep } from './steps';
import type { OpContext, Reference, WorkflowOp } from './types';

type Op<K extends WorkflowOp['op']> = Extract<WorkflowOp, { op: K }>;

/** A place a rename writes the new id over: the span holding the old one, as written there, and what goes in. */
interface Site {
  span: Span;
  text: string;
  insert: string;
}

/**
 * A job renamed: its key (quotes kept), every `needs` entry naming it, and every reference the worker found
 * (`ctx.refs`), each written through `replaceAt` with the text the worker saw there, so a reference that moved is
 * refused `stale`. A key anchored for aliases (`&b build:` with `needs: *b`) only renames with them ("Change all").
 */
// TODO(C10): warn `tests-name` with the cases of the open test files that name the old id; OpContext lists no test
// files yet.
export function renameJob(
  doc: WorkflowDocument,
  op: Op<'renameJob'>,
  shared?: 'all',
  ctx?: OpContext,
): Draft | Refusal {
  const missing = jobMissing(doc, op.job);
  if (missing) return missing;
  const label = `Renamed job ${op.job} to ${op.to}`;
  if (op.to === op.job) return { edits: [], label };
  const others = doc.jobs().flatMap((j) => (j.id === op.job ? [] : [j.id]));
  const bad = checkId(doc, 'job', op.to, others, (to) => ({ ...op, to }));
  if (bad) return bad;
  const key = renameKeyDraft(doc, ['jobs', op.job], op.to, shared ? { shared } : {});
  // Aliases of an anchor on the key read its text: renaming changes them all, or the needs they are would dangle.
  if (isRefusal(key))
    return key.reason === 'shared-anchor'
      ? { ...key, fixes: key.fixes.filter((f) => f.kind === 'shared-all') }
      : key;
  const token = locate(doc.tree, ['jobs', op.job])!.hops.at(-1)!.pair!.key.range;
  const found = foundSites(doc, ctx?.refs ?? [], op.job, op.to, { from: token[0], to: token[1] });
  if (isRefusal(found)) return found;
  const sites = merge(needsSites(doc, op.job, op.to), found);
  const draft = renameDraft(doc, key, sites, op.to, shared);
  if (isRefusal(draft)) return draft;
  return {
    ...draft,
    label,
    select: ['jobs', op.to],
    renames: [{ kind: 'job', file: doc.path, job: op.job, from: op.job, to: op.to }],
  };
}

/**
 * A step's id renamed: its `id:` value (written, in the step order, when the step has none) and every reference the
 * worker found in its job (`steps.<id>…`), each through `replaceAt` with its expected text.
 */
export function renameStepId(
  doc: WorkflowDocument,
  op: Op<'renameStepId'>,
  shared?: 'all',
  ctx?: OpContext,
): Draft | Refusal {
  const moved = checkStep(doc, op.job, op.index, op.fp);
  if (moved) return moved;
  const step = ['jobs', op.job, 'steps', op.index];
  const steps = doc.jobs().find((j) => j.id === op.job)!.steps;
  const old = steps[op.index]!.id;
  const label = `Renamed the id of ${refusals.describe(step)} to ${op.to}`;
  if (old === op.to) return { edits: [], label };
  const taken = steps.flatMap((s, i) => (i === op.index || s.id === undefined ? [] : [s.id]));
  const bad = checkId(doc, 'step', op.to, taken, (to) => ({ ...op, to }));
  if (bad) return bad;
  const id = setDraft(doc, [...step, 'id'], op.to, { order: orderFor, ...(shared ? { shared } : {}) });
  if (isRefusal(id) || old === undefined) return isRefusal(id) ? id : { ...id, label, select: step };
  const range = locate(doc.tree, [...step, 'id'])!.node!.range;
  const found = foundSites(doc, ctx?.refs ?? [], old, op.to, { from: range[0], to: range[1] });
  if (isRefusal(found)) return found;
  const draft = renameDraft(doc, id, found, op.to, shared);
  if (isRefusal(draft)) return draft;
  return {
    ...draft,
    label,
    select: step,
    renames: [{ kind: 'step', file: doc.path, job: op.job, from: old, to: op.to }],
  };
}

/**
 * The worker's references in this file as sites, each checked against the text there (`stale` when it is not the
 * old id as the worker saw it). The declaration's own (inside `skip`, the key or `id:` token) is written apart.
 */
function foundSites(
  doc: WorkflowDocument,
  refs: readonly Reference[],
  old: string,
  to: string,
  skip: Span,
): Site[] | Refusal {
  const sites: Site[] = [];
  for (const ref of refs) {
    if (ref.file !== doc.path) continue;
    const span = { from: doc.offsetOf(ref.line, ref.column), to: doc.offsetOf(ref.endLine, ref.endColumn) };
    if (doc.text.slice(span.from, span.to) !== ref.text || !sameId(ref.text, old))
      return refusals.stale(doc.path, ref.line);
    if (span.from >= skip.from && span.to <= skip.to) continue;
    sites.push({ span, text: ref.text, insert: to });
  }
  return sites;
}

/**
 * Every `needs` entry naming a job, read from the text so none is missed: a scalar (`needs: build`) or an item of a
 * list, its quotes kept. A plain one is written as the scalar writer would (`'true'` for a job `true`).
 */
function needsSites(doc: WorkflowDocument, job: string, to: string): Site[] {
  return doc.jobs().flatMap(({ id }) => {
    const node = locate(doc.tree, ['jobs', id, 'needs'])?.node ?? null;
    const place = isSeq(node) ? (isFlow(node) ? 'flow' : 'item') : 'value';
    const entries = isSeq(node) ? node.items : [node];
    return entries.flatMap((entry) => needSite(doc, entry, job, to, place));
  });
}

function needSite(
  doc: WorkflowDocument,
  node: ParsedNode | null,
  job: string,
  to: string,
  place: 'flow' | 'item' | 'value',
): Site[] {
  if (!isScalar(node) || typeof node.value !== 'string' || !sameId(node.value, job)) return [];
  const quoted = tokenQuote(node.srcToken) !== 'plain' ? 1 : 0;
  const span = { from: node.range[0] + quoted, to: node.range[1] - quoted };
  // An entry spelled with escapes (`"b\x75ild"`) has no span to write over; the check then finds it unrenamed.
  if (doc.text.slice(span.from, span.to) !== node.value) return [];
  const insert = quoted ? to : (inlineScalar(to, place, doc.style) ?? to);
  return [{ span, text: node.value, insert }];
}

/** The sites by where they start, the first of two at one place kept. */
function merge(...lists: Site[][]): Site[] {
  const byStart = new Map<number, Site>();
  for (const site of lists.flat()) if (!byStart.has(site.span.from)) byStart.set(site.span.from, site);
  return [...byStart.values()].sort((a, b) => a.span.from - b.span.from);
}

/**
 * The declaration's draft with every site written through `replaceAt`, as one draft whose meaning is the
 * declaration's change after each site's scalar has the new id where the old one was.
 */
function renameDraft(
  doc: WorkflowDocument,
  declaration: Draft,
  sites: readonly Site[],
  to: string,
  shared?: 'all',
): Draft | Refusal {
  const edits: TextEdit[] = [...declaration.edits];
  for (const site of sites) {
    const draft = replaceAtDraft(doc, site.span, site.text, site.insert, shared ? { shared } : {});
    if (isRefusal(draft)) return draft;
    edits.push(...draft.edits);
  }
  const values = siteValues(doc, sites, to);
  const expect = (js: unknown) =>
    declaration.expect!(
      values.reduce((j, { paths, value }) => paths.reduce((k, p) => setIn(k, p, value), j), js),
    );
  return { edits: edits.sort((a, b) => a.from - b.from), expect, label: declaration.label };
}

/**
 * The value each scalar holding a site has after the rename, at every path it appears (an anchored scalar's aliases
 * too): its string with the new id at the occurrences of the old one the sites are, counted in the source and in
 * the value alike. Where the two counts differ (an escape spells the id), the value is left as it was, so the check
 * refuses the edit rather than guess.
 */
function siteValues(
  doc: WorkflowDocument,
  sites: readonly Site[],
  to: string,
): { paths: YamlPath[]; value: string }[] {
  const scalars: { node: Scalar.Parsed; path: YamlPath }[] = [];
  walkNodes(doc.tree.doc?.contents ?? null, (node, path, isKey) => {
    if (!isKey && isScalar(node) && typeof node.value === 'string') scalars.push({ node, path: [...path] });
  });
  return scalars.flatMap(({ node, path }) => {
    const [start, end] = node.range;
    const inside = sites.filter((s) => s.span.from >= start && s.span.to <= end);
    if (inside.length === 0) return [];
    const source = doc.text.slice(start, end);
    const old = String(node.value);
    const at: { from: number; length: number }[] = [];
    for (const site of inside) {
      const inSource = occurrences(source, site.text);
      const inValue = occurrences(old, site.text);
      const nth = inSource.indexOf(site.span.from - start);
      if (inSource.length !== inValue.length || nth === -1) return [];
      at.push({ from: inValue[nth]!, length: site.text.length });
    }
    // From the last, so the places before it stay where they were.
    const value = at
      .toSorted((a, b) => b.from - a.from)
      .reduce((v, { from, length }) => v.slice(0, from) + to + v.slice(from + length), old);
    return [{ paths: equivalents(doc, path), value }];
  });
}

/** Where a text occurs in a string, without overlaps. */
function occurrences(text: string, part: string): number[] {
  const out: number[] = [];
  for (let at = text.indexOf(part); at !== -1; at = text.indexOf(part, at + part.length)) out.push(at);
  return out;
}
