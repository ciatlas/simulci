import {
  isAlias,
  isCollection,
  isMap,
  isScalar,
  isSeq,
  type ParsedNode,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml';
import type { WorkflowDocument } from './document';
import type { TextEdit } from './edits';
import { flowInsert, flowText, holdsExpression, simpleFlow } from './flow';
import {
  opensBlock,
  renderItem,
  renderPair,
  renderValue,
  type RenderContext,
  type Rendered,
} from './fragment';
import { editable, equivalents, isRefusal, orphanedIn, reach } from './guard';
import { setIn } from './json';
import * as refusals from './refusal';
import type { Refusal } from './refusal';
import { bodyRange, headerEnd, writeScalar, type Scalar, type ScalarSite } from './scalar';
import { after, contentEnd, endsInKeep, itemColumn, itemSpan, ownStart, removalSpan } from './spans';
import { blankSeparated } from './style';
import { isFlow, keyOf, locate, toJson, walkNodes, type Collection, type Hop, type Located } from './tree';
import type { Json, YamlPath } from './types';
import { difference, type Draft } from './verify';

/** The canonical key order of the map at a path (§ 3.5), or none. */
export type OrderOf = (mapPath: YamlPath) => readonly string[] | undefined;

/** How a property field's text becomes a value: a `number` or `boolean` field reads `30` or `true` as one. */
export type ScalarKind = 'string' | 'number' | 'boolean' | 'expression' | 'auto';

export interface SetOptions {
  /** The order a new key is placed by: the key order of its map, or a function of the map's path for deep creation. */
  order?: readonly string[] | OrderOf;
  as?: ScalarKind;
  shared?: 'all';
}

/**
 * Sets the value at a path. A scalar is written in place (§ 2.7); a short flow list is spliced inside its brackets
 * and a block list of scalars item by item; another collection is written anew after its key, the one place comments
 * inside a value can go. A missing key is added where the map's key order puts it, creating its parents.
 */
export function setDraft(
  doc: WorkflowDocument,
  path: YamlPath,
  value: Json,
  options: SetOptions = {},
): Draft | Refusal {
  const bad = editable(doc);
  if (bad) return bad;
  if (path.length === 0)
    return refusals.unsupported(doc.path, path, 'the whole file cannot be replaced by an edit');
  const json = coerce(value, options.as);
  const found = locate(doc.tree, path);
  if (!found || found.hops.length < path.length) return addDraft(doc, path, json, options);
  const at = reach(doc, path, options);
  if (isRefusal(at)) return at;
  const draft = setExisting(doc, at, path, json);
  if (isRefusal(draft)) return draft;
  return {
    ...draft,
    expect: (js) => equivalents(doc, path).reduce((j, p) => setIn(j, p, json), js),
    select: path,
  };
}

function coerce(value: Json, as: ScalarKind | undefined): Json {
  if (typeof value !== 'string') return value;
  if (as === 'number' && /^-?\d+(?:\.\d+)?$/.test(value.trim())) return Number(value);
  if (as === 'boolean' && (value === 'true' || value === 'false')) return value === 'true';
  return value;
}

const label = (path: YamlPath) => `Set ${refusals.describe(path)}`;
const isEmpty = (node: ParsedNode): boolean => isScalar(node) && node.range[0] === node.range[1];
const isScalarValue = (v: Json): v is Scalar => v === null || typeof v !== 'object';

/**
 * The rendering context of a document: its style, and where the keys of a list's map items go after the `-` (as in
 * the sequence's own first item, else as in the file's first such item: `-   uses:` in a four-space file).
 */
export function renderContext(doc: WorkflowDocument, seq?: Collection, at?: number): RenderContext {
  const ctx: RenderContext = { style: doc.style };
  const limit = at === undefined ? undefined : doc.tree.lines.commentAfter(at);
  if (limit !== undefined) ctx.blockLimit = limit;
  const offset = (seq && keyOffset(doc, seq)) ?? fileKeyOffset(doc);
  if (offset !== undefined) ctx.itemKeyOffset = offset;
  return ctx;
}

/** The columns from a block sequence's first `-` to its item's first key on that line. */
function keyOffset(doc: WorkflowDocument, seq: ParsedNode): number | undefined {
  const first = isSeq(seq) && !isFlow(seq) ? seq.items[0] : undefined;
  if (!isMap(first) || isFlow(first) || first.items.length === 0) return undefined;
  const dash = ownStart(seq as YAMLSeq.Parsed, 0);
  const key = ownStart(first, 0);
  return doc.tree.lines.lineAt(dash) === doc.tree.lines.lineAt(key) ? key - dash : undefined;
}

const fileOffsets = new WeakMap<WorkflowDocument, number | undefined>();

function fileKeyOffset(doc: WorkflowDocument): number | undefined {
  if (fileOffsets.has(doc)) return fileOffsets.get(doc);
  let offset: number | undefined;
  walkNodes(doc.tree.doc?.contents ?? null, (node) => {
    offset ??= keyOffset(doc, node);
  });
  fileOffsets.set(doc, offset);
  return offset;
}

function setExisting(doc: WorkflowDocument, at: Located, path: YamlPath, value: Json): Draft | Refusal {
  const hop = at.hops.at(-1)!;
  const node = at.node;
  if (difference(toJson(doc.tree, node), value, '') === undefined) return { edits: [], label: label(path) };
  if (isScalarValue(value) && !isCollection(node) && !isAlias(node))
    return scalarDraft(doc, hop, node, value, path);
  return collectionRefusal(doc, hop, node, path) ?? collectionDraft(doc, hop, node, path, value);
}

/** A collection, or a value in place of one: a list of scalars patched item by item, else written anew. */
function collectionDraft(
  doc: WorkflowDocument,
  hop: Hop,
  node: ParsedNode | null,
  path: YamlPath,
  value: Json,
): Draft | Refusal {
  const patched =
    isSeq(node) && Array.isArray(value) && value.length > 0 ? patchList(doc, node, path, value) : undefined;
  return patched ?? replaceValue(doc, hop, node, path, value);
}

/**
 * Why a collection cannot be written where the node is: it would take with it an anchor that aliases use elsewhere,
 * or it would go inside a flow collection.
 */
function collectionRefusal(
  doc: WorkflowDocument,
  hop: Hop,
  node: ParsedNode | null,
  path: YamlPath,
): Refusal | undefined {
  const orphan = node
    ? orphanedIn(doc, { from: node.range[0], to: contentEnd(doc.tree, node) }, path)
    : undefined;
  if (orphan || !isFlow(hop.parent)) return orphan;
  const line = doc.tree.lines.lineAt(hop.parent.range[0]) + 1;
  return (
    simpleFlow(doc, hop.parent, path.slice(0, -1)) ??
    refusals.flowShape(doc.path, path, line, 'and cannot hold a collection')
  );
}

function scalarDraft(
  doc: WorkflowDocument,
  hop: Hop,
  node: ParsedNode | null,
  value: Scalar,
  path: YamlPath,
): Draft | Refusal {
  if (!node || writtenAnew(doc, hop, node, value)) return replaceValue(doc, hop, node, path, value);
  if (isFlow(hop.parent)) {
    const flat = simpleFlow(doc, hop.parent, path.slice(0, -1));
    if (flat) return flat;
  }
  const edits = writeScalar(siteOf(doc, hop, node), value);
  if (!edits)
    return refusals.unsupported(doc.path, path, `${refusals.describe(path)} cannot hold this value`);
  return { edits, label: label(path) };
}

/**
 * An empty value (`name:`) has no token to write over: the value goes after the `:` or the `-`. One on the line below
 * its key goes with that line when it becomes empty or a block.
 */
function writtenAnew(doc: WorkflowDocument, hop: Hop, node: ParsedNode, value: Scalar): boolean {
  const lines = value === null || (typeof value === 'string' && value.includes('\n'));
  return isEmpty(node) || (lines && belowKey(doc, hop, node));
}

export function siteOf(doc: WorkflowDocument, hop: Hop, node: ParsedNode): ScalarSite {
  const flow = isFlow(hop.parent);
  const column = flow ? 0 : doc.tree.lines.column(ownStart(hop.parent, hop.index));
  return {
    node,
    lines: doc.tree.lines,
    style: doc.style,
    place: flow ? 'flow' : hop.pair ? 'value' : 'item',
    column,
    bodyColumn: column + doc.style.indent,
  };
}

/**
 * A list of scalars patched item by item, so each kept item keeps its quotes and comments: undefined when an item on
 * either side is a collection, which `replaceValue` writes anew. A block list keeps the items whose values stay
 * (their longest common run), so a comment stays with its value.
 */
function patchList(
  doc: WorkflowDocument,
  seq: YAMLSeq.Parsed,
  path: YamlPath,
  value: Json[],
): Draft | Refusal | undefined {
  const skip = unpatched(doc, seq, path, value);
  if (skip !== false) return skip;
  const edits = isFlow(seq)
    ? flowPatch(doc, seq, path, value as Scalar[])
    : blockPatch(doc, seq, path, value as Scalar[]);
  if (isRefusal(edits)) return edits;
  const all = edits.toSorted((a, b) => a.from - b.from || a.to - b.to);
  // A kept item rewritten as a block may end where the cut tail begins: then the list is written anew.
  if (all.some((e, i) => i > 0 && e.from < all[i - 1]!.to)) return undefined;
  return { edits: all, label: label(path) };
}

/**
 * Why a list is not patched: undefined when it is written anew (an item on either side is a collection; a new item
 * holding an expression turns a flow list into a block one, G5; a list ending a file with no final break grows or
 * shrinks, so its last item's break is written once), a refusal, or false when it is patched.
 */
function unpatched(
  doc: WorkflowDocument,
  seq: YAMLSeq.Parsed,
  path: YamlPath,
  value: Json[],
): Refusal | undefined | false {
  if (!value.every(isScalarValue) || !seq.items.every((item) => isScalar(item))) return undefined;
  const flat = isFlow(seq) ? simpleFlow(doc, seq, path) : undefined;
  if (flat) return flat;
  if (isFlow(seq) && value.some(holdsExpression)) return undefined;
  return atFileEnd(doc, contentEnd(doc.tree, seq)) && value.length !== seq.items.length ? undefined : false;
}

function flowPatch(
  doc: WorkflowDocument,
  seq: YAMLSeq.Parsed,
  path: YamlPath,
  value: Scalar[],
): TextEdit[] | Refusal {
  const kept = keptItems(doc, seq, path, value);
  if (isRefusal(kept)) return kept;
  const tail = flowTail(doc, seq, value);
  return isRefusal(tail) ? tail : [...kept, ...tail];
}

/**
 * The gaps between the items both lists keep (in order, the longest such run): in each, the old items left are
 * written over by the new ones in turn, then the rest of the old ones removed or the rest of the new ones inserted.
 * An inserted value that a removed item held takes that item's lines, so a reordered item keeps its comments.
 */
function blockPatch(
  doc: WorkflowDocument,
  seq: YAMLSeq.Parsed,
  path: YamlPath,
  value: Scalar[],
): TextEdit[] | Refusal {
  const old = seq.items.map((item) => toJson(doc.tree, item) as Scalar);
  const gaps = gapsBetween(old, value);
  const pool = removedLines(doc, seq, old, gaps);
  const edits: TextEdit[] = [];
  for (const gap of gaps) {
    const paired = Math.min(gap.olds.length, gap.news.length);
    for (let k = 0; k < paired; k++) {
      const i = gap.olds[k]!;
      const write = scalarDraft(
        doc,
        { parent: seq, index: i, node: seq.items[i]! },
        seq.items[i]!,
        value[gap.news[k]!]!,
        [...path, i],
      );
      if (isRefusal(write)) return write;
      edits.push(...write.edits);
    }
    const removed = gap.olds.slice(paired);
    if (removed.length > 0)
      edits.push({
        from: removalSpan(doc.tree, seq, removed[0]!).from,
        to: removalSpan(doc.tree, seq, removed.at(-1)!).to,
        insert: '',
      });
    const added = gap.news.slice(paired).map((j) => value[j]!);
    const insert = added.length > 0 ? insertItems(doc, seq, path, gap.before, added, pool) : [];
    if (isRefusal(insert)) return insert;
    edits.push(...insert);
  }
  return edits;
}

interface Gap {
  olds: number[];
  news: number[];
  /** The kept old item the gap ends before; none for the last gap. */
  before?: number;
}

/** The gaps around a longest common subsequence of two lists of scalars. */
export function gapsBetween(a: readonly Scalar[], b: readonly Scalar[]): Gap[] {
  const common = commonAfter(a, b);
  const gaps: Gap[] = [];
  let gap: Gap = { olds: [], news: [] };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const step = stepAt(common, a, b, i, j);
    if (step === 'keep') {
      gaps.push({ ...gap, before: i++ });
      gap = { olds: [], news: [] };
      j++;
    } else if (step === 'new') gap.news.push(j++);
    else gap.olds.push(i++);
  }
  gaps.push(gap);
  return gaps.filter((g) => g.olds.length > 0 || g.news.length > 0);
}

/** The length of the longest common subsequence of `a` from `i` on and `b` from `j` on, for every `i` and `j`. */
function commonAfter(a: readonly Scalar[], b: readonly Scalar[]): number[][] {
  const common = Array.from({ length: a.length + 1 }, () => Array.from({ length: b.length + 1 }, () => 0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      common[i]![j] = Object.is(a[i], b[j])
        ? common[i + 1]![j + 1]! + 1
        : Math.max(common[i + 1]![j]!, common[i]![j + 1]!);
  return common;
}

/** Whether the walk keeps `a[i]` as `b[j]`, takes `b[j]` as new, or `a[i]` as gone. */
function stepAt(
  common: number[][],
  a: readonly Scalar[],
  b: readonly Scalar[],
  i: number,
  j: number,
): 'keep' | 'new' | 'old' {
  if (i < a.length && j < b.length && Object.is(a[i], b[j])) return 'keep';
  if (j === b.length) return 'old';
  return i === a.length || common[i]![j + 1]! >= common[i + 1]![j]! ? 'new' : 'old';
}

const valueKey = (v: Scalar): string => `${typeof v}:${String(v)}`;

/** The lines of each removed item, by its value, for an insertion of the same value to take. */
function removedLines(
  doc: WorkflowDocument,
  seq: YAMLSeq.Parsed,
  old: Scalar[],
  gaps: Gap[],
): Map<string, string[][]> {
  const pool = new Map<string, string[][]>();
  const eol = doc.style.eol;
  for (const gap of gaps)
    for (const i of gap.olds.slice(Math.min(gap.olds.length, gap.news.length))) {
      const span = itemSpan(doc.tree, seq, i);
      const raw = doc.text.slice(span.from, span.to);
      if (span.inline || !raw.endsWith(eol) || endsInKeep(seq.items[i]!)) continue;
      const key = valueKey(old[i]!);
      pool.set(key, [...(pool.get(key) ?? []), raw.slice(0, -eol.length).split(eol)]);
    }
  return pool;
}

/** New items before the kept item `before`, or after the last item. */
function insertItems(
  doc: WorkflowDocument,
  seq: YAMLSeq.Parsed,
  path: YamlPath,
  before: number | undefined,
  values: Scalar[],
  pool: Map<string, string[][]>,
): TextEdit[] | Refusal {
  const old = seq.items.length;
  const end = after(doc.tree, seq, old - 1);
  const column = itemColumn(doc.tree, seq);
  const lines: string[] = [];
  for (const [k, item] of values.entries()) {
    const reused = pool.get(valueKey(item))?.shift();
    const rendered =
      reused ??
      renderItem(
        item,
        column,
        [...path, old + k],
        renderContext(doc, seq, before === undefined ? end.at : undefined),
      );
    if (!rendered) return refusals.unsupported(doc.path, path, 'a list item cannot be written');
    lines.push(...rendered);
  }
  const blank = blankSeparated(doc.tree, seq) ?? false;
  if (before === undefined) return [appendLines(doc, end, lines, blank)];
  const span = itemSpan(doc.tree, seq, before);
  if (span.inline)
    return refusals.unsupported(doc.path, path, `${refusals.describe(path)} starts on its parent's line`);
  const eol = doc.style.eol;
  const text = lines.join(eol) + eol + (blank ? eol : '');
  return [{ from: span.from, to: span.from, insert: text }];
}

/** The items both lists have, each written in place. */
function keptItems(
  doc: WorkflowDocument,
  seq: YAMLSeq.Parsed,
  path: YamlPath,
  value: Scalar[],
): TextEdit[] | Refusal {
  const edits: TextEdit[] = [];
  for (let i = 0; i < Math.min(seq.items.length, value.length); i++) {
    const hop: Hop = { parent: seq, index: i, node: seq.items[i]! };
    const write = scalarDraft(doc, hop, seq.items[i]!, value[i]!, [...path, i]);
    if (isRefusal(write)) return write;
    edits.push(...write.edits);
  }
  return edits;
}

/** The items past the kept ones: removed, or appended. */
function flowTail(doc: WorkflowDocument, seq: YAMLSeq.Parsed, value: Scalar[]): TextEdit[] | Refusal {
  const old = seq.items.length;
  // The items from `value.length` on, with the separator before the first of them.
  if (value.length < old)
    return [
      {
        from: contentEnd(doc.tree, seq.items[value.length - 1]!),
        to: contentEnd(doc.tree, seq.items.at(-1)!),
        insert: '',
      },
    ];
  const texts = value.slice(old).map((v) => flowText(doc, v));
  if (texts.some((t) => t === undefined))
    return refusals.unsupported(doc.path, [], 'a list item cannot be written');
  return texts.length === 0 ? [] : [flowInsert(doc, seq, old, texts.join(', '))];
}

/** Lines appended after an item: a blank line first in a blank-separated collection. */
export function appendLines(
  doc: WorkflowDocument,
  at: { at: number; lead: boolean; keep?: boolean },
  lines: readonly string[],
  blank: boolean,
): TextEdit {
  const eol = doc.style.eol;
  const sep = blank && !at.keep ? eol : '';
  const text = lines.join(eol);
  // At the end of a file with no final break, a block scalar that keeps its break still ends with one.
  const close = opensBlock(lines) ? eol : '';
  return { from: at.at, to: at.at, insert: at.lead ? `${eol}${sep}${text}${close}` : `${sep}${text}${eol}` };
}

/** A value written anew in place of the old one: after its key, or as the whole sequence item. */
function replaceValue(
  doc: WorkflowDocument,
  hop: Hop,
  node: ParsedNode | null,
  path: YamlPath,
  value: Json,
): Draft | Refusal {
  const end = node ? contentEnd(doc.tree, node) : ownStart(hop.parent, hop.index);
  const ctx = renderContext(
    doc,
    isSeq(node) ? node : undefined,
    doc.tree.lines.end(doc.tree.lines.lineAt(end)),
  );
  const column = doc.tree.lines.column(ownStart(hop.parent, hop.index));
  const cannot = () =>
    refusals.unsupported(doc.path, path, `${refusals.describe(path)} cannot hold this value`);
  if (!hop.pair) {
    const lines = renderItem(value, column, path, ctx);
    return lines ? { edits: [itemEdit(doc, hop, node!, lines)], label: label(path) } : cannot();
  }
  // `a:` then `&s` alone on the next line: the value's lines would take the anchor with them.
  if (doc.tree.lines.lineAt(valueHeadAt(hop)) > doc.tree.lines.lineAt(ownStart(hop.parent, hop.index)))
    return refusals.unsupported(
      doc.path,
      path,
      `the anchor or tag of ${refusals.describe(path)} is on a line of its own`,
    );
  const rendered = renderValue(value, column, path, 'value', ctx);
  return rendered ? { edits: pairValueEdits(doc, hop, node, rendered), label: label(path) } : cannot();
}

/**
 * A sequence item's text replaced from its `-` to the end of its content's line. The comment of an item on one line
 * (`- main # default`, `- # to do`) stays on the first line written.
 */
function itemEdit(doc: WorkflowDocument, hop: Hop, node: ParsedNode, lines: readonly string[]): TextEdit {
  const { lines: table } = doc.tree;
  const own = ownStart(hop.parent, hop.index);
  const last = table.lineAt(Math.max(contentEnd(doc.tree, node) - 1, own));
  const end = table.end(last);
  const atEnd = end === doc.text.length && !doc.text.endsWith('\n');
  const comment =
    last === table.lineAt(own) ? inlineComment(doc, Math.max(contentEnd(doc.tree, node), own + 1), last) : '';
  const [first = '', ...rest] = lines;
  const text = [first.trimStart() + comment, ...rest].join(doc.style.eol);
  return { from: own, to: end, insert: atEnd && !opensBlock(lines) ? text : text + doc.style.eol };
}

/** The comment after `from` on a line, with the space before it (` # default`), or ''. */
function inlineComment(doc: WorkflowDocument, from: number, line: number): string {
  const rest = doc.text.slice(spaceBefore(doc.text, from), doc.tree.lines.breakAt(line));
  return /^[ \t]+#/.test(rest) ? rest.trimEnd() : '';
}

/**
 * A pair's value replaced, its key line kept (the key's text, an anchor, an inline comment): the head goes after the
 * `:`, the lines after the key's line, in place of the old value's.
 */
function pairValueEdits(
  doc: WorkflowDocument,
  hop: Hop,
  node: ParsedNode | null,
  rendered: Rendered,
): TextEdit[] {
  if (node === null || isEmpty(node) || (isCollection(node) && !isFlow(node)) || belowKey(doc, hop, node))
    return valueLinesEdits(doc, hop, node, rendered);
  if (node.srcToken?.type === 'block-scalar') return blockValueEdits(doc, node, rendered);
  return inlineValueEdits(doc, node, rendered);
}

/** Whether a pair's value starts on a line below its key's (`if:` with the condition on the next line). */
const belowKey = (doc: WorkflowDocument, hop: Hop, node: ParsedNode): boolean =>
  hop.pair !== undefined &&
  doc.tree.lines.lineAt(node.range[0]) > doc.tree.lines.lineAt(ownStart(hop.parent, hop.index));

const atFileEnd = (doc: WorkflowDocument, offset: number): boolean =>
  offset === doc.text.length && !doc.text.endsWith('\n');

/** Rendered lines as text: after a line break when `lead`, ending with one unless `atEnd`. */
function restText(doc: WorkflowDocument, rendered: Rendered, lead: boolean, atEnd: boolean): string {
  if (rendered.rest.length === 0) return '';
  const eol = doc.style.eol;
  const text = rendered.rest.join(eol);
  const close = !atEnd || opensBlock([rendered.head, ...rendered.rest]) ? eol : '';
  return (lead ? eol : '') + text + close;
}

const headText = (rendered: Rendered): string => (rendered.head === '' ? '' : ` ${rendered.head}`);

/**
 * A value with nothing on the key's line (a block collection, an empty value, a value on the line below): the head
 * goes after the `:`, the lines in place of the value's.
 */
function valueLinesEdits(
  doc: WorkflowDocument,
  hop: Hop,
  node: ParsedNode | null,
  rendered: Rendered,
): TextEdit[] {
  const { lines } = doc.tree;
  const from = lines.end(lines.lineAt(hop.pair!.key.range[0]));
  const to = node && !isEmpty(node) ? valueEnd(doc, node) : from;
  const at = valueHeadAt(hop);
  // Nothing written below the key at the end of a file with no final break: the key's line keeps none either.
  const start =
    rendered.rest.length === 0 && atFileEnd(doc, to) && to > from
      ? lines.breakAt(lines.lineAt(from - 1))
      : from;
  const edits: TextEdit[] = [
    { from: at, to: at, insert: headText(rendered) },
    { from: start, to, insert: restText(doc, rendered, atFileEnd(doc, from), atFileEnd(doc, to)) },
  ];
  return edits.filter((e) => e.insert !== '' || e.from !== e.to);
}

/** The end of a value's last line; a block collection's runs over the deeper comments its last item owns. */
function valueEnd(doc: WorkflowDocument, node: ParsedNode): number {
  const { lines } = doc.tree;
  const end = lines.end(lines.lineAt(contentEnd(doc.tree, node) - 1));
  if (!isCollection(node) || isFlow(node) || node.items.length === 0) return end;
  return Math.max(end, itemSpan(doc.tree, node, node.items.length - 1).to);
}

/** A block scalar's header and body replaced: the head where the header was, the lines in place of the body. */
function blockValueEdits(doc: WorkflowDocument, node: ParsedNode, rendered: Rendered): TextEdit[] {
  const { lines } = doc.tree;
  const body = bodyRange(lines, node);
  // The header's comment stays: only the header goes (`args: | # sorted` → `args: [a, b] # sorted`).
  const header = Math.min(headerEnd(node), lines.breakAt(lines.lineAt(node.range[0])), body.from);
  return [
    {
      from: spaceBefore(doc.text, node.range[0]),
      to: header,
      insert: headText(rendered),
    },
    { from: body.from, to: body.to, insert: restText(doc, rendered, body.lead, atFileEnd(doc, body.to)) },
  ];
}

/** A one-line value replaced by the head; the lines go after the line the old value ended on. */
function inlineValueEdits(doc: WorkflowDocument, node: ParsedNode, rendered: Rendered): TextEdit[] {
  const { lines } = doc.tree;
  const [start, end] = node.range;
  const line = lines.end(lines.lineAt(Math.max(end - 1, start)));
  // `"5"# minutes`: the comment needs a space before it once the token is gone.
  const touching = doc.text[end] === '#' ? ' ' : '';
  const edits: TextEdit[] = [
    { from: spaceBefore(doc.text, start), to: end, insert: headText(rendered) + touching },
  ];
  const lead = atFileEnd(doc, line);
  if (rendered.rest.length > 0)
    edits.push({ from: line, to: line, insert: restText(doc, rendered, lead, lead) });
  return edits;
}

/** Where a pair's value would start on its key's line: after the `:`, or after an anchor or tag that follows it. */
function valueHeadAt(hop: Hop): number {
  const sep = hop.pair?.srcToken?.sep ?? [];
  const last = sep.findLast((t) => t.type === 'map-value-ind' || t.type === 'anchor' || t.type === 'tag');
  return last ? last.offset + last.source.length : hop.pair!.key.range[1];
}

/** The offset where the spaces and tabs right before `at` begin. */
export function spaceBefore(text: string, at: number): number {
  let from = at;
  while (from > 0 && (text[from - 1] === ' ' || text[from - 1] === '\t')) from--;
  return from;
}

/** A key that is not there: added to its map, the map created first when it is missing. */
function addDraft(doc: WorkflowDocument, path: YamlPath, value: Json, options: SetOptions): Draft | Refusal {
  const mapPath = path.slice(0, -1);
  const key = path.at(-1)!;
  const parent = locate(doc.tree, mapPath);
  if (typeof key === 'number' || (parent && parent.hops.length < mapPath.length)) {
    const at = reach(doc, path, options);
    return isRefusal(at) ? at : refusals.notFound(doc.path, path);
  }
  // Each map created on the way is placed by its own parent's order: a function of the path reaches every level.
  if (!parent) {
    const deep = setDraft(doc, mapPath, { [key]: value }, options);
    const expect = (js: unknown) => equivalents(doc, path).reduce((j, p) => setIn(j, p, value), js);
    return isRefusal(deep) ? deep : { ...deep, expect, select: path };
  }
  const at = reach(doc, mapPath, options);
  if (isRefusal(at)) return at;
  const expect = (js: unknown) => equivalents(doc, path).reduce((j, p) => setIn(j, p, value), js);
  const draft = addKey(doc, at, mapPath, key, value, orderAt(options.order, mapPath));
  return isRefusal(draft) ? draft : { ...draft, expect, select: path };
}

function orderAt(order: SetOptions['order'], mapPath: YamlPath): readonly string[] | undefined {
  return typeof order === 'function' ? order(mapPath) : order;
}

function addKey(
  doc: WorkflowDocument,
  at: Located,
  mapPath: YamlPath,
  key: string,
  value: Json,
  order: readonly string[] | undefined,
): Draft | Refusal {
  const node = at.node;
  const hop = at.hops.at(-1);
  // An empty value (`jobs:`, `jobs: {}`) is written anew as the map holding the key, outside a flow collection: one
  // inside (`{with: {}}`) takes the key in its braces, and an empty value there cannot become a map.
  const flow = hop !== undefined && isFlow(hop.parent);
  if (emptyValue(node) && hop && !flow) return replaceValue(doc, hop, node, mapPath, { [key]: value });
  if (!isMap(node) && flow)
    return refusals.flowShape(
      doc.path,
      mapPath,
      doc.tree.lines.lineAt(hop.parent.range[0]) + 1,
      'and cannot hold a map',
    );
  if (!isMap(node))
    return refusals.unsupported(
      doc.path,
      mapPath,
      `${refusals.describe(mapPath)} is not a map`,
      doc.lineOf(mapPath),
    );
  return isFlow(node)
    ? flowAddKey(doc, node, mapPath, key, value)
    : blockAddKey(doc, node, mapPath, key, value, order);
}

const emptyValue = (node: ParsedNode | null): boolean =>
  node === null || (isScalar(node) && node.value === null) || (isMap(node) && node.items.length === 0);

function blockAddKey(
  doc: WorkflowDocument,
  map: YAMLMap.Parsed,
  mapPath: YamlPath,
  key: string,
  value: Json,
  order: readonly string[] | undefined,
): Draft | Refusal {
  const path = [...mapPath, key];
  const column = map.items.length > 0 ? itemColumn(doc.tree, map) : 0;
  const lines = renderPair(
    key,
    value,
    column,
    path,
    renderContext(doc, undefined, after(doc.tree, map, map.items.length - 1).at),
  );
  if (!lines)
    return refusals.unsupported(doc.path, path, `${refusals.describe(path)} cannot hold this value`);
  return {
    edits: [placeKey(doc, map, key, lines, column, order)],
    label: `Added ${refusals.describe(path)}`,
  };
}

function flowAddKey(
  doc: WorkflowDocument,
  map: YAMLMap.Parsed,
  mapPath: YamlPath,
  key: string,
  value: Json,
): Draft | Refusal {
  const flat = simpleFlow(doc, map, mapPath);
  if (flat) return flat;
  const text = isScalarValue(value) ? flowText(doc, value, key) : undefined;
  if (text === undefined)
    return refusals.flowShape(
      doc.path,
      mapPath,
      doc.tree.lines.lineAt(map.range[0]) + 1,
      'and cannot hold this value',
    );
  return {
    edits: [flowInsert(doc, map, map.items.length, text)],
    label: `Added ${refusals.describe([...mapPath, key])}`,
  };
}

/**
 * A new key's text where the map's order puts it (§ 3.5): after the present key ranked highest below it; with none,
 * before the first key ranked above it; else last. Keys outside the order never anchor a placement.
 */
function placeKey(
  doc: WorkflowDocument,
  map: YAMLMap.Parsed,
  key: string,
  lines: readonly string[],
  column: number,
  order: readonly string[] | undefined,
): TextEdit {
  const keys = map.items.map((pair) => keyOf(pair) ?? '');
  const { anchor = keys.length - 1, before } = placement(keys, key, order);
  const blank = blankSeparated(doc.tree, map) ?? false;
  if (before === undefined) return appendLines(doc, after(doc.tree, map, anchor), lines, blank);
  const span = itemSpan(doc.tree, map, before);
  const eol = doc.style.eol;
  if (span.inline)
    return {
      from: span.own,
      to: span.own,
      insert: `${lines.join(eol).slice(column)}${eol}${' '.repeat(column)}`,
    };
  return { from: span.from, to: span.from, insert: `${lines.join(eol)}${eol}${blank ? eol : ''}` };
}

export function placement(
  keys: readonly string[],
  key: string,
  order: readonly string[] | undefined,
): { anchor?: number; before?: number } {
  const rank = (k: string) => order?.indexOf(k) ?? -1;
  const mine = rank(key);
  if (keys.length === 0) return {};
  if (mine < 0) return { anchor: keys.length - 1 };
  const ranks = keys.map(rank);
  const below = ranks.filter((r) => r >= 0 && r < mine);
  if (below.length > 0) return { anchor: ranks.indexOf(Math.max(...below)) };
  const before = ranks.findIndex((r) => r > mine);
  return before === -1 ? { anchor: keys.length - 1 } : { before };
}
