import { isCollection, isPair, isScalar, type ParsedNode } from 'yaml';
import { blockHeader, seqIndicators } from './cst';
import type { Lines } from './lines';
import { isFlow, type Collection, type ParsedPair, type Tree } from './tree';

/**
 * The lines an item of a collection owns. yaml cannot give these directly: a map key's indentation sits in the token
 * before it, a comment line deeper than the next key ends up in the map before it, and a block collection's range runs
 * on to its last item's end, over the comments, the blank lines and the next item's indentation that follow (`jobs.a`
 * ended inside `jobs.b`). So an item's span is computed in whole lines:
 *
 * - it starts at its own key or `-` (`own`), extended upward over the contiguous comment lines at exactly its column
 *   (except the document's first key: the comments above it are the file's header);
 * - it ends with the line that holds its content's end (`contentEnd`), its inline comment and break included, extended
 *   downward over the contiguous comment lines indented deeper than its column;
 * - an item that does not start its line (`name` in `- name: x`) starts at `own` itself.
 */
export interface ItemSpan {
  from: number;
  to: number;
  /** The key's offset (its anchor or tag, when it has one), or the `-`'s. */
  own: number;
  /** `own` does not start its line. */
  inline: boolean;
  /** `own`'s 0-based column. */
  column: number;
}

export function itemSpan(tree: Tree, parent: Collection, index: number): ItemSpan {
  const item = parent.items[index]!;
  if (isFlow(parent)) return flowItemSpan(tree, item);
  const { lines } = tree;
  const own = ownStart(parent, index);
  const line = lines.lineAt(own);
  const column = own - lines.start(line);
  const inline = !lines.startsLine(own);
  const lead = inline ? line : leadingComments(lines, line, column);
  // Comments that start the file above the document's first key are its header (a licence, a generated marker), not
  // the key's; after a blank line they are the key's again.
  const header = index === 0 && parent === tree.doc?.contents && startsFile(lines, lead);
  const first = header ? line : lead;
  const last = lines.lineAt(Math.max(contentEnd(tree, item) - 1, own));
  const to = lines.end(trailingComments(lines, last, column));
  return { from: inline ? own : lines.start(first), to, own, inline, column };
}

/** Whether nothing but a `---` or a directive comes before a line. */
function startsFile(lines: Lines, line: number): boolean {
  for (let l = 0; l < line; l++) if (!/^(?:---|%)/.test(lines.textOf(l))) return false;
  return true;
}

/** In a flow collection an item owns its own characters: `b` in `[a, b]`, `k: v` in `{k: v}`. */
function flowItemSpan(tree: Tree, item: ParsedPair | ParsedNode): ItemSpan {
  const from = isPair(item) ? item.key.range[0] : item.range[0];
  const to = contentEnd(tree, item);
  return { from, to, own: from, inline: !tree.lines.startsLine(from), column: tree.lines.column(from) };
}

/** Where item `index` of a block collection begins: its `-`, or its key (or the anchor or tag before the key). */
export function ownStart(parent: Collection, index: number): number {
  return ownOf(parent.items[index]!, () => seqIndicators(parent.srcToken)[index]);
}

/** Where each item of a collection begins, as `ownStart`; in a flow collection, at its first character. */
export function ownStarts(parent: Collection): number[] {
  const dashes = seqIndicators(parent.srcToken);
  return parent.items.map((item, i) => ownOf(item, () => dashes[i]));
}

/** What may come before a key on its own line: its anchor, its tag, a `?`. */
const PROPS = new Set(['anchor', 'tag', 'explicit-key-ind']);

function ownOf(item: ParsedPair | ParsedNode, dash: () => number | undefined): number {
  if (!isPair(item)) return dash() ?? item.range[0];
  const props = item.srcToken?.start.find((t) => PROPS.has(t.type));
  return props?.offset ?? item.key.range[0];
}

/**
 * Where an item's content ends: after the deepest last scalar, alias or flow collection in it, or after the last
 * non-empty line of a block scalar (every line under keep chomping, `|+`). An empty value (`push:`) ends where it
 * would start, on its key's line.
 */
export function contentEnd(tree: Tree, item: ParsedPair | ParsedNode | null): number {
  const leaf = lastLeaf(item);
  if (!leaf) return 0;
  if (isScalar(leaf) && leaf.srcToken?.type === 'block-scalar') return blockScalarEnd(tree.lines, leaf);
  return leaf.range[1];
}

/**
 * Whether an item ends with a block scalar that keeps its last line break (`|`, `|+`): at the end of a file, taking
 * that break away would change its value.
 */
export function endsInBlock(item: ParsedPair | ParsedNode | null): boolean {
  const leaf = lastLeaf(item);
  const header = isScalar(leaf) ? blockHeader(leaf.srcToken) : '';
  return header !== '' && !header.includes('-');
}

/**
 * Whether an item ends with a block scalar under keep chomping (`|+`): every blank line after it is part of its
 * value, so no edit may put a blank separator right after it, or leave one there.
 */
export function endsInKeep(item: ParsedPair | ParsedNode | null): boolean {
  const leaf = lastLeaf(item);
  return isScalar(leaf) && blockHeader(leaf.srcToken).includes('+');
}

function lastLeaf(item: ParsedPair | ParsedNode | null): ParsedNode | null {
  let node = isPair(item) ? (item.value ?? item.key) : item;
  while (isCollection(node) && !isFlow(node) && node.items.length > 0) {
    const last = node.items.at(-1)!;
    node = isPair(last) ? (last.value ?? last.key) : last;
  }
  return node;
}

function blockScalarEnd(lines: Lines, scalar: ParsedNode): number {
  const [start, end] = scalar.range;
  const header = lines.lineAt(start);
  let line = lines.lineAt(Math.max(end - 1, start));
  if (keepsTrailing(scalar)) return end;
  // Only lines of spaces are empty to a block scalar: a tab there is content.
  while (line > header && /^ *$/.test(lines.textOf(line))) line--;
  return lines.breakAt(line);
}

function keepsTrailing(scalar: ParsedNode): boolean {
  return blockHeader(scalar.srcToken).includes('+');
}

function leadingComments(lines: Lines, line: number, column: number): number {
  let first = line;
  while (first > 0 && isCommentAt(lines, first - 1, (indent) => indent === column)) first--;
  return first;
}

function trailingComments(lines: Lines, line: number, column: number): number {
  let last = line;
  while (last + 1 < lines.count && isCommentAt(lines, last + 1, (indent) => indent > column)) last++;
  return last;
}

function isCommentAt(lines: Lines, line: number, column: (indent: number) => boolean): boolean {
  const { kind, indent } = lines.kind(line);
  return kind === 'comment' && column(indent);
}

/** The column a block collection's items start at: its keys', or its dashes'. */
export function itemColumn(tree: Tree, parent: Collection): number {
  return tree.lines.column(ownStart(parent, 0));
}

/**
 * What removing item `index` of a block collection deletes: its span, and one blank separator so that a collection
 * written with blank lines between its items keeps them. An item after the first takes the blank lines above it; the
 * first takes those between it and the second; the only one takes those between it and its key. At the end of a file
 * with no final line break the line break before the span goes too, so the file still ends without one.
 */
export function removalSpan(tree: Tree, parent: Collection, index: number): { from: number; to: number } {
  const { lines, text } = tree;
  const span = itemSpan(tree, parent, index);
  let { from, to } = span;
  // The blank lines above are the separator unless they belong to the item before (a kept block scalar's).
  if (index > 0)
    from = Math.max(lines.start(blankAbove(lines, lines.lineAt(from))), itemSpan(tree, parent, index - 1).to);
  else if (parent.items.length > 1)
    to = lines.start(
      blankBelow(lines, lines.lineAt(Math.max(to - 1, from)) + 1, itemSpan(tree, parent, 1).from),
    );
  else from = lines.start(blankAbove(lines, lines.lineAt(from)));
  // After a kept block scalar the blank lines below go too, or they would join its value.
  if (index > 0 && endsInKeep(parent.items[index - 1]!) && index + 1 < parent.items.length)
    to = lines.start(
      blankBelow(lines, lines.lineAt(Math.max(to - 1, from)) + 1, itemSpan(tree, parent, index + 1).from),
    );
  const keepsBreak = index > 0 && endsInBlock(parent.items[index - 1]!);
  if (to === text.length && !text.endsWith('\n') && from > 0 && !keepsBreak)
    from -= text[from - 2] === '\r' ? 2 : 1;
  return { from, to };
}

/** The first of the blank lines right above a line (the line itself when there are none). */
function blankAbove(lines: Lines, line: number): number {
  let first = line;
  while (first > 0 && lines.kind(first - 1).kind === 'blank') first--;
  return first;
}

/** The line after the blank lines starting at `line`, stopping at offset `limit`. */
function blankBelow(lines: Lines, line: number, limit: number): number {
  let next = line;
  while (next < lines.count && lines.start(next) < limit && lines.kind(next).kind === 'blank') next++;
  return next;
}

/**
 * Where text inserted after an item goes: the end of its span. `lead` when the file ends there without a break;
 * `keep` when the item ends with a kept block scalar, after which no blank separator may go.
 */
export function after(
  tree: Tree,
  parent: Collection,
  index: number,
): { at: number; lead: boolean; keep: boolean } {
  const at = itemSpan(tree, parent, index).to;
  return {
    at,
    lead: at === tree.text.length && !tree.text.endsWith('\n'),
    keep: endsInKeep(parent.items[index]!),
  };
}

/**
 * The 1-based line of a comment that a removal would leave right below a block scalar, indented as deep as the
 * scalar's lines, where YAML would read it as part of the scalar; undefined when there is none.
 */
export function absorbed(
  tree: Tree,
  parent: Collection,
  index: number,
  removedTo: number,
): number | undefined {
  if (index === 0 || removedTo === tree.text.length) return undefined;
  const column = blockBodyColumn(tree, parent.items[index - 1]!);
  const deep = column === undefined ? undefined : deepComment(tree, removedTo, column);
  return deep;
}

/** The column of the body of the block scalar an item ends with, when it ends with one. */
export function blockBodyColumn(tree: Tree, item: ParsedPair | ParsedNode): number | undefined {
  const leaf = lastLeaf(item);
  if (!isScalar(leaf) || blockHeader(leaf.srcToken) === '') return undefined;
  const { lines } = tree;
  const body = lines.lineAt(leaf.range[0]) + 1;
  return body < lines.count ? lines.kind(body).indent : 0;
}

/** The 1-based line of the first comment from `offset` on, past blank lines, when it is at `column` or deeper. */
export function deepComment(tree: Tree, offset: number, column: number): number | undefined {
  const { lines } = tree;
  for (let line = lines.lineAt(offset); line < lines.count; line++) {
    const { kind, indent } = lines.kind(line);
    if (kind === 'blank') continue;
    return kind === 'comment' && indent >= column ? line + 1 : undefined;
  }
  return undefined;
}
