import { isScalar, isSeq, type YAMLSeq } from 'yaml';
import type { WorkflowDocument } from './document';
import type { TextEdit } from './edits';
import { flowInsert, flowText, holdsExpression, simpleFlow } from './flow';
import { commentLines, renderItem } from './fragment';
import { editable, equivalents, isRefusal, reach } from './guard';
import { insertIn, moveIn } from './json';
import * as refusals from './refusal';
import type { Refusal } from './refusal';
import { appendLines, renderContext, setDraft, type SetOptions } from './set';
import {
  absorbed,
  after,
  blockBodyColumn,
  deepComment,
  endsInKeep,
  itemColumn,
  itemSpan,
  removalSpan,
} from './spans';
import { blankSeparated } from './style';
import { isFlow, locate, toJson, type Located } from './tree';
import type { Json, YamlPath } from './types';
import type { Draft } from './verify';

export interface InsertOptions extends SetOptions {
  /** Comment lines written above the new item, at its column. */
  commentBefore?: readonly string[];
}

/**
 * Inserts an item into a sequence at `index` (its length appends): before the item there, with a blank line after
 * it in a blank-separated sequence; inside the brackets of a short flow list. A missing or empty list is created.
 */
export function insertDraft(
  doc: WorkflowDocument,
  seqPath: YamlPath,
  index: number,
  value: Json,
  options: InsertOptions = {},
): Draft | Refusal {
  const bad = editable(doc);
  if (bad) return bad;
  const draft = intoList(doc, seqPath, index, value, options);
  if (isRefusal(draft)) return draft;
  return {
    ...draft,
    expect: (js: unknown) => equivalents(doc, seqPath).reduce((j, p) => insertIn(j, p, index, value), js),
    label: `Added to ${refusals.describe(seqPath)}`,
    select: [...seqPath, index],
  };
}

/** The edits of an insertion into the list at a path, which a missing or empty list is created for. */
function intoList(
  doc: WorkflowDocument,
  seqPath: YamlPath,
  index: number,
  value: Json,
  options: InsertOptions,
): Draft | Refusal {
  const found = locate(doc.tree, seqPath);
  const missing = !found || emptyAt(found, seqPath);
  // A comment goes above an item of a block list; a list created or one in brackets has no line for it.
  if ((options.commentBefore?.length ?? 0) > 0 && (missing || isFlow(found.node)))
    return refusals.unsupported(doc.path, seqPath, `a comment cannot go into ${refusals.describe(seqPath)}`);
  if (!missing) return intoItems(doc, seqPath, index, value, options);
  return index === 0
    ? setDraft(doc, seqPath, [value], options)
    : refusals.outOfRange(doc.path, [...seqPath, index], 0);
}

/** An empty value or `[]`, written anew as the list holding the item, as a missing list is. */
function emptyAt(at: Located, path: YamlPath): boolean {
  if (at.hops.length !== path.length) return false;
  return (
    (isScalar(at.node) && at.node.value === null) ||
    (isSeq(at.node) && isFlow(at.node) && at.node.items.length === 0)
  );
}

function intoItems(
  doc: WorkflowDocument,
  seqPath: YamlPath,
  index: number,
  value: Json,
  options: InsertOptions,
): Draft | Refusal {
  const seq = reachList(doc, seqPath, options);
  if (isRefusal(seq)) return seq;
  if (!Number.isInteger(index) || index < 0 || index > seq.items.length)
    return refusals.outOfRange(doc.path, [...seqPath, index], seq.items.length);
  // An item holding an expression turns a flow list into a block one (G5): the list is written anew.
  if (isFlow(seq) && holdsExpression(value))
    return setDraft(doc, seqPath, (toJson(doc.tree, seq) as Json[]).toSpliced(index, 0, value), options);
  const edit = isFlow(seq)
    ? flowItem(doc, seq, seqPath, index, value)
    : blockItem(doc, seq, seqPath, index, value, options);
  return isRefusal(edit) ? edit : { edits: [edit], label: '' };
}

function flowItem(
  doc: WorkflowDocument,
  seq: YAMLSeq.Parsed,
  path: YamlPath,
  index: number,
  value: Json,
): TextEdit | Refusal {
  const flat = simpleFlow(doc, seq, path);
  if (flat) return flat;
  const text = value === null || typeof value !== 'object' ? flowText(doc, value) : undefined;
  if (text === undefined)
    return refusals.flowShape(
      doc.path,
      path,
      doc.tree.lines.lineAt(seq.range[0]) + 1,
      'and cannot hold this value',
    );
  return flowInsert(doc, seq, index, text);
}

function blockItem(
  doc: WorkflowDocument,
  seq: YAMLSeq.Parsed,
  path: YamlPath,
  index: number,
  value: Json,
  options: InsertOptions,
): TextEdit | Refusal {
  const column = itemColumn(doc.tree, seq);
  const at = index === seq.items.length ? after(doc.tree, seq, index - 1).at : undefined;
  const item = renderItem(value, column, [...path, index], renderContext(doc, seq, at));
  if (!item) return refusals.unsupported(doc.path, path, 'the new item cannot be written');
  const lines = [...commentLines(options.commentBefore ?? [], column), ...item];
  const blank = blankSeparated(doc.tree, seq) ?? false;
  if (index === seq.items.length) return appendLines(doc, after(doc.tree, seq, index - 1), lines, blank);
  const span = itemSpan(doc.tree, seq, index);
  if (span.inline)
    return refusals.unsupported(doc.path, path, `${refusals.describe(path)} starts on its parent's line`);
  const eol = doc.style.eol;
  return { from: span.from, to: span.from, insert: `${lines.join(eol)}${eol}${blank ? eol : ''}` };
}

/** Moves item `from` of a block sequence to index `to` (its index once moved): one removal and one insertion. */
export function moveDraft(
  doc: WorkflowDocument,
  seqPath: YamlPath,
  from: number,
  to: number,
  options: { shared?: 'all' } = {},
): Draft | Refusal {
  const bad = editable(doc);
  if (bad) return bad;
  const seq = reachList(doc, seqPath, options);
  if (isRefusal(seq)) return seq;
  const length = seq.items.length;
  for (const i of [from, to])
    if (!Number.isInteger(i) || i < 0 || i >= length)
      return refusals.outOfRange(doc.path, [...seqPath, i], length);
  if (isFlow(seq))
    return refusals.flowShape(
      doc.path,
      seqPath,
      doc.tree.lines.lineAt(seq.range[0]) + 1,
      'and its items cannot be moved',
    );
  const expect = (js: unknown) => equivalents(doc, seqPath).reduce((j, p) => moveIn(j, p, from, to), js);
  const draft = { label: `Moved ${refusals.describe([...seqPath, from])}`, expect, select: [...seqPath, to] };
  if (from === to) return { ...draft, edits: [] };
  const order = anchorOrder(doc, seq, seqPath, from, to);
  if (order) return order;
  return moveRefusal(doc, seq, seqPath, from, to) ?? { ...draft, edits: moveEdits(doc, seq, from, to) };
}

/**
 * Why an item cannot be moved: it or the item it would go before starts on the parent's line (`- - a`), or a
 * comment indented as deep as a block scalar's lines would end up below that scalar, which would take it in.
 */
function moveRefusal(
  doc: WorkflowDocument,
  seq: YAMLSeq.Parsed,
  path: YamlPath,
  from: number,
  to: number,
): Refusal | undefined {
  if (itemSpan(doc.tree, seq, from).inline || itemSpan(doc.tree, seq, to).inline)
    return refusals.unsupported(doc.path, path, `${refusals.describe(path)} starts on its parent's line`);
  const left = absorbed(doc.tree, seq, from, removalSpan(doc.tree, seq, from).to);
  const column = to > from ? blockBodyColumn(doc.tree, seq.items[from]!) : undefined;
  const landed =
    column === undefined ? undefined : deepComment(doc.tree, after(doc.tree, seq, to).at, column);
  const comment = left ?? landed;
  if (comment === undefined) return undefined;
  return refusals.unsupported(
    doc.path,
    path,
    `moving it would put the comment on line ${comment} inside a block scalar`,
    comment,
  );
}

function moveEdits(doc: WorkflowDocument, seq: YAMLSeq.Parsed, from: number, to: number): TextEdit[] {
  const span = itemSpan(doc.tree, seq, from);
  const raw = doc.text.slice(span.from, span.to);
  const moved = { text: raw.endsWith('\n') ? raw : raw + doc.style.eol, keep: endsInKeep(seq.items[from]!) };
  const removal: TextEdit = { ...removalSpan(doc.tree, seq, from), insert: '' };
  const blank = blankSeparated(doc.tree, seq) ?? false;
  return to > from
    ? [removal, moveDown(doc, seq, to, moved, blank)]
    : [moveUp(doc, seq, to, moved, blank), removal];
}

interface Moved {
  text: string;
  /** It ends with a kept block scalar: no blank line may follow it, or the scalar would take it in. */
  keep: boolean;
}

/** The moved text after item `to`, a blank line before it in a blank-separated sequence. */
function moveDown(
  doc: WorkflowDocument,
  seq: YAMLSeq.Parsed,
  to: number,
  moved: Moved,
  blank: boolean,
): TextEdit {
  const eol = doc.style.eol;
  if (moved.keep && to + 1 < seq.items.length) {
    const next = itemSpan(doc.tree, seq, to + 1).from;
    return { from: next, to: next, insert: moved.text };
  }
  const end = after(doc.tree, seq, to);
  const sep = blank && !end.keep ? eol : '';
  const insert = end.lead ? `${eol}${sep}${moved.text.slice(0, -eol.length)}` : `${sep}${moved.text}`;
  return { from: end.at, to: end.at, insert };
}

/** The moved text before item `to`, a blank line after it in a blank-separated sequence. */
function moveUp(
  doc: WorkflowDocument,
  seq: YAMLSeq.Parsed,
  to: number,
  moved: Moved,
  blank: boolean,
): TextEdit {
  const start = itemSpan(doc.tree, seq, to).from;
  return { from: start, to: start, insert: `${moved.text}${blank && !moved.keep ? doc.style.eol : ''}` };
}

/** Refuses a move that would put an alias above its anchor, both in this sequence (`anchor`). */
function anchorOrder(
  doc: WorkflowDocument,
  seq: YAMLSeq.Parsed,
  path: YamlPath,
  from: number,
  to: number,
): Refusal | undefined {
  const spans = seq.items.map((_, i) => itemSpan(doc.tree, seq, i));
  const itemOf = (offset: number) => spans.findIndex((s) => offset >= s.from && offset < s.to);
  const order = spans.map((_, i) => i);
  order.splice(to, 0, ...order.splice(from, 1));
  const position = (item: number) => order.indexOf(item);
  for (const def of doc.anchors.anchors) {
    const home = itemOf(def.from);
    if (home === -1) continue;
    // With a name defined twice, a move can change which definition a later alias names.
    const redefined = doc.anchors.definitions(def.name).length > 1;
    const early = def.aliases.filter(
      (a) => itemOf(a.from) !== -1 && itemOf(a.from) !== home && position(itemOf(a.from)) < position(home),
    );
    if (early.length > 0 || (redefined && def.aliases.length > 0))
      return refusals.orphanedAnchor(
        doc.path,
        [...path, home],
        [{ name: def.name, line: def.line, redefined }],
        (early.length > 0 ? early : def.aliases).map((a) => a.line),
      );
  }
  return undefined;
}

/** The sequence at a path, or why an edit may not touch it. */
function reachList(
  doc: WorkflowDocument,
  path: YamlPath,
  options: { shared?: 'all' },
): YAMLSeq.Parsed | Refusal {
  const at = reach(doc, path, options);
  if (isRefusal(at)) return at;
  return isSeq(at.node)
    ? at.node
    : refusals.unsupported(doc.path, path, `${refusals.describe(path)} is not a list`, doc.lineOf(path));
}
