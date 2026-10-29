import { isSeq } from 'yaml';
import { walkTokens } from '../cst';
import type { WorkflowDocument } from '../document';
import { isRefusal } from '../guard';
import { insertDraft } from '../insert';
import { renameKeyDraft } from '../primitives';
import { removeDraft } from '../remove';
import * as refusals from '../refusal';
import type { Refusal } from '../refusal';
import { setDraft } from '../set';
import { itemSpan } from '../spans';
import { isFlow, locate } from '../tree';
import type { Json, YamlPath } from '../types';
import type { Draft } from '../verify';
import { keyIn } from './bindings';
import { chain, type Step } from './chain';
import { checkId } from './ids';
import { ORDER, orderFor } from './order';
import { quoted } from './restyle';
import type { DispatchInput, FilterKey, WorkflowOp } from './types';

type Op<K extends WorkflowOp['op']> = Extract<WorkflowOp, { op: K }>;

const ON: YamlPath = ['on'];

/**
 * The events `on:` names, whatever its shape (`on: push`, `on: [push, pull_request]`, a map of events); none for a
 * missing or empty `on:`. Undefined when it is something else (a number, a list holding a map).
 */
export function eventsOf(doc: WorkflowDocument): string[] | undefined {
  const on = doc.get(ON)?.value ?? null;
  if (on === null) return [];
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.every((e) => typeof e === 'string') ? on : undefined;
  return typeof on === 'object' ? Object.keys(on) : undefined;
}

const notEvents = (doc: WorkflowDocument): Refusal =>
  refusals.unsupported(doc.path, ON, '`on` is not a list of events', doc.lineOf(ON));

/**
 * An event added, the `on:` shape kept: `on: push` becomes a list (`on: [push, pull_request]`), a list gets one item
 * more, a map gets `event:` with no value. A file with no events gets `on: <event>`.
 */
export function addEvent(doc: WorkflowDocument, op: Op<'addEvent'>, shared?: 'all'): Draft | Refusal {
  const events = eventsOf(doc);
  if (!events) return notEvents(doc);
  const options = shared ? { shared } : {};
  const label = `Added the ${op.event} trigger`;
  if (events.includes(op.event)) return { edits: [], label };
  const on = doc.get(ON);
  const draft =
    on === undefined || on.kind === 'null'
      ? setDraft(doc, ON, op.event, { order: ORDER.workflow, ...options })
      : on.kind === 'scalar'
        ? setDraft(doc, ON, [...events, op.event], options)
        : on.kind === 'seq'
          ? insertDraft(doc, ON, events.length, op.event, options)
          : setDraft(doc, [...ON, op.event], null, options);
  return isRefusal(draft) ? draft : { ...draft, label, select: ON };
}

/**
 * An event taken out of `on:`, the shape kept: never a list back to a scalar. The last one leaves `on:` with no
 * value.
 */
export function removeEvent(doc: WorkflowDocument, op: Op<'removeEvent'>, shared?: 'all'): Draft | Refusal {
  const events = eventsOf(doc);
  if (!events) return notEvents(doc);
  const label = `Removed the ${op.event} trigger`;
  const on = doc.get(ON);
  if (!events.includes(op.event)) return { edits: [], label };
  if (on?.kind === 'scalar') return labelled(setDraft(doc, ON, null, shared ? { shared } : {}), label);
  // Every item naming it, from the last, so the indexes of the ones above stay.
  const steps: Step[] =
    on?.kind === 'seq'
      ? events
          .flatMap((e, i) => (e === op.event ? [i] : []))
          .toReversed()
          .map((i) => removing([...ON, i], shared))
      : [removing([...ON, op.event], shared)];
  return chain(doc, label, steps);
}

const removing =
  (path: YamlPath, shared?: 'all'): Step =>
  (d) =>
    removeDraft(d, path, 'null', shared ? { shared } : {});

/** A draft under the op's label; a refusal as it is. */
export const labelled = (draft: Draft | Refusal, label: string): Draft | Refusal =>
  isRefusal(draft) ? draft : { ...draft, label };

/** The filter a filter cannot go with: GitHub takes `branches` or `branches-ignore` on one event, not both. */
const EXCLUSIVE: Record<FilterKey, FilterKey> = {
  branches: 'branches-ignore',
  'branches-ignore': 'branches',
  tags: 'tags-ignore',
  'tags-ignore': 'tags',
  paths: 'paths-ignore',
  'paths-ignore': 'paths',
};

/**
 * One filter of an event set, the event's other keys kept. A scalar or list `on:` becomes a map first, once. A
 * filter next to its exclusive twin (`branches` with `branches-ignore`) is refused, with the switch as the fix.
 * `null` removes the filter and leaves the event (`push:`).
 */
export function setFilter(doc: WorkflowDocument, op: Op<'setFilter'>, shared?: 'all'): Draft | Refusal {
  const label = `${op.patterns === null ? 'Removed' : 'Set'} ${op.event}'s ${op.filter}`;
  if (op.patterns !== null) {
    const twin = EXCLUSIVE[op.filter];
    if (doc.get([...ON, op.event, twin]) !== undefined)
      return refusals.exclusiveFilter(
        doc.path,
        op.event,
        twin,
        op.filter,
        doc.lineOf([...ON, op.event, twin]),
      );
  }
  return eventKey(doc, op.event, op.filter, op.patterns, label, shared);
}

/** An event's activity types set, or removed with `null`; as `setFilter`. */
export function setTypes(doc: WorkflowDocument, op: Op<'setTypes'>, shared?: 'all'): Draft | Refusal {
  const label = `${op.types === null ? 'Removed' : 'Set'} ${op.event}'s types`;
  return eventKey(doc, op.event, 'types', op.types, label, shared);
}

/** A key under an event the file names: set in the event order, the `on:` map made first; or removed. */
function eventKey(
  doc: WorkflowDocument,
  event: string,
  key: string,
  values: string[] | null,
  label: string,
  shared?: 'all',
): Draft | Refusal {
  const path = [...ON, event, key];
  const options = shared ? { shared } : {};
  if (values === null)
    return doc.get(path) === undefined
      ? { edits: [], label }
      : labelled(removeDraft(doc, path, 'null', options), label);
  const events = eventsOf(doc);
  if (!events) return notEvents(doc);
  if (!events.includes(event)) return refusals.notFound(doc.path, [...ON, event]);
  const draft = chain(doc, label, [
    (d) => asMap(d, shared),
    (d) => setDraft(d, path, [...values], { order: orderFor, ...options }),
  ]);
  return isRefusal(draft) ? draft : { ...draft, select: [...ON, event] };
}

/**
 * A scalar or list `on:` written as the map of its events, each with no value (`on:\n  push:\n  pull_request:`), so
 * that an event can take a filter; the `on:` line's comment stays. Nothing to do for a map, or no `on:`. A list with a
 * comment inside is refused: rewriting it would lose the comment.
 */
export function asMap(doc: WorkflowDocument, shared?: 'all'): Draft | Refusal | undefined {
  const on = doc.get(ON);
  if (on === undefined || (on.kind !== 'scalar' && on.kind !== 'seq')) return undefined;
  const events = eventsOf(doc);
  if (!events) return notEvents(doc);
  const comment = commentInside(doc, ON);
  if (comment) return comment;
  const map = Object.fromEntries(events.map((event) => [event, null]));
  return setDraft(doc, ON, map, shared ? { shared } : {});
}

/**
 * Refuses a list holding a comment, which writing it anew would lose: inside the brackets of a flow list (one after
 * the `]` is the line's, and stays), or among or after the items of a block one.
 */
function commentInside(doc: WorkflowDocument, path: YamlPath): Refusal | undefined {
  const node = locate(doc.tree, path)?.node;
  if (!isSeq(node) || node.items.length === 0) return undefined;
  const flow = isFlow(node);
  const end = flow ? node.range[1] : itemSpan(doc.tree, node, node.items.length - 1).to;
  let comment = false;
  walkTokens(node.srcToken ? [node.srcToken] : [], (t) => {
    comment ||= t.type === 'comment' && t.offset >= node.range[0] && t.offset < end;
  });
  if (!comment) return undefined;
  const line = doc.tree.lines.lineAt(node.range[0]) + 1;
  const what = refusals.describe(path);
  return flow
    ? refusals.flowShape(doc.path, path, line, 'with a comment inside')
    : refusals.unsupported(doc.path, path, `${what} holds comments that writing it anew would lose`, line);
}

/** Renames one filter of an event to its twin (`branches-ignore` to `branches`), its patterns kept. */
export function switchFilter(doc: WorkflowDocument, op: Op<'switchFilter'>, shared?: 'all'): Draft | Refusal {
  const draft = renameKeyDraft(doc, [...ON, op.event, op.from], op.to, shared ? { shared } : {});
  return isRefusal(draft)
    ? draft
    : { ...draft, label: `Switched ${op.event} to ${op.to}`, select: [...ON, op.event] };
}

const SCHEDULE: YamlPath = [...ON, 'schedule'];

type Cron = Op<'setSchedule'>['crons'][number];

const cronItem = (cron: Cron): { [key: string]: Json } =>
  cron.timezone === undefined ? { cron: cron.cron } : { cron: cron.cron, timezone: cron.timezone };

/**
 * The schedule set: its items patched in place (`cron`, then `timezone` when given), the ones left over removed,
 * new ones appended; a new cron is always quoted, as it holds `*`. No crons removes the schedule.
 */
export function setSchedule(doc: WorkflowDocument, op: Op<'setSchedule'>, shared?: 'all'): Draft | Refusal {
  const label = op.crons.length === 0 ? 'Removed the schedule' : 'Set the schedule';
  const options = shared ? { shared } : {};
  if (op.crons.length === 0)
    return doc.get(SCHEDULE) === undefined
      ? { edits: [], label }
      : labelled(removeDraft(doc, SCHEDULE, 'null', options), label);
  const node = locate(doc.tree, SCHEDULE)?.node;
  const quotes = op.crons.map((_, i) => (d: WorkflowDocument) => quoted(d, [...SCHEDULE, i, 'cron']));
  if (!isSeq(node) || isFlow(node))
    return chain(doc, label, [
      (d) => commentInside(d, SCHEDULE),
      (d) => asMap(d, shared),
      (d) => setDraft(d, SCHEDULE, op.crons.map(cronItem), { order: orderFor, ...options }),
      ...quotes,
    ]);
  const old = node.items.length;
  const patches = op.crons.slice(0, old).flatMap((cron, i) => patchCron(doc, i, cron, shared));
  const removals = Array.from({ length: Math.max(old - op.crons.length, 0) }, (_, k) =>
    removing([...SCHEDULE, old - 1 - k], shared),
  );
  const additions = op.crons
    .slice(old)
    .flatMap((cron, k): Step[] => [
      (d) => insertDraft(d, SCHEDULE, old + k, cronItem(cron), options),
      quotes[old + k]!,
    ]);
  return chain(doc, label, [...patches, ...removals, ...additions]);
}

/** An existing schedule item given a cron and a timezone, or its timezone taken out. */
function patchCron(doc: WorkflowDocument, index: number, cron: Cron, shared?: 'all'): Step[] {
  const item = [...SCHEDULE, index];
  const options = { order: ORDER.schedule, ...(shared ? { shared } : {}) };
  const timezone: Step =
    cron.timezone === undefined
      ? (d) =>
          d.get([...item, 'timezone']) === undefined ? undefined : removing([...item, 'timezone'], shared)(d)
      : (d) => setDraft(d, [...item, 'timezone'], cron.timezone!, options);
  return [(d) => setDraft(d, [...item, 'cron'], cron.cron, options), timezone];
}

const INPUTS: YamlPath = [...ON, 'workflow_dispatch', 'inputs'];

/**
 * A `workflow_dispatch` input set, its keys in the order `description, required, default, type, options`: an input
 * there is patched key by key (the keys it no longer has removed); a new one is written whole, the event and its
 * `inputs:` created when missing. `null` removes the input, and `inputs:` with its last one.
 */
export function setDispatchInput(
  doc: WorkflowDocument,
  op: Op<'setDispatchInput'>,
  shared?: 'all',
): Draft | Refusal {
  const name = keyIn(doc, INPUTS, op.name);
  const path = [...INPUTS, name];
  const label = `${op.input === null ? 'Removed' : 'Set'} the input ${name}`;
  const options = { order: orderFor, ...(shared ? { shared } : {}) };
  const exists = doc.get(path) !== undefined;
  if (op.input === null)
    return exists
      ? labelled(removeDraft(doc, path, 'remove', shared ? { shared } : {}), label)
      : { edits: [], label };
  if (!exists) {
    const bad = checkId(doc, 'input', op.name, [], (id) => ({ ...op, name: id }));
    if (bad) return bad;
    return chain(doc, label, [
      (d) => asMap(d, shared),
      (d) => setDraft(d, path, inputBody(op.input!), options),
    ]);
  }
  const body = inputBody(op.input);
  const steps = ORDER.input.map((key): Step => {
    const at = [...path, key];
    if (body[key] !== undefined) return (d) => setDraft(d, at, body[key]!, options);
    return (d) =>
      d.get(at) === undefined ? undefined : removeDraft(d, at, 'null', shared ? { shared } : {});
  });
  const draft = chain(doc, label, steps);
  return isRefusal(draft) ? draft : { ...draft, select: path };
}

function inputBody(input: DispatchInput): { [key: string]: Json } {
  const out: { [key: string]: Json } = {};
  for (const key of ORDER.input) if (input[key] !== undefined) out[key] = input[key];
  return out;
}
