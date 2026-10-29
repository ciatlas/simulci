import { isCollection, isScalar, isSeq, type ParsedNode } from 'yaml';
import type { AliasUse, AnchorDef } from './anchors';
import type { WorkflowDocument } from './document';
import type { TextEdit } from './edits';
import { editable, isRefusal } from './guard';
import * as refusals from './refusal';
import { opensBlock } from './fragment';
import { inlineScalar, type Scalar } from './scalar';
import type { Refusal } from './refusal';
import { blockHeader } from './cst';
import { spaceBefore } from './set';
import { contentEnd, ownStart } from './spans';
import { isFlow, locate, type Hop } from './tree';
import type { YamlPath } from './types';
import type { Draft } from './verify';

/**
 * Replaces the alias at a path with a copy of the text of the node it names, re-indented to its new place, so that
 * it can be edited on its own. The value does not change (`toJS` is the same). Anchors inside the copy are left out,
 * and an alias inside it must still name what it named.
 */
export function dealiasDraft(doc: WorkflowDocument, path: YamlPath): Draft | Refusal {
  const bad = editable(doc);
  if (bad) return bad;
  const at = locate(doc.tree, path);
  const use = at ? doc.anchors.aliases.find((a) => a.node === at.node) : undefined;
  if (!at) return refusals.notFound(doc.path, path);
  if (!use)
    return refusals.unsupported(
      doc.path,
      path,
      `${refusals.describe(path)} is not an alias`,
      doc.lineOf(path),
    );
  if (at.alias!.at < path.length)
    return refusals.aliasRefusal(doc.path, path.slice(0, at.alias!.at), at.alias!.node.source, undefined);
  const edits = copyInto(doc, use);
  return isRefusal(edits)
    ? edits
    : { edits, expect: (js) => js, label: `Copied \`&${use.name}\` into ${refusals.describe(path)}` };
}

/**
 * Copies an anchor's node into every alias that names it, and removes the anchor: each use can then change on its
 * own, and the value does not change. The fix of `shared-anchor` ("Change only here") and of `anchor`.
 */
export function dealiasAnchorDraft(doc: WorkflowDocument, name: string, line?: number): Draft | Refusal {
  const bad = editable(doc);
  if (bad) return bad;
  const defs = doc.anchors.definitions(name);
  const def = line === undefined ? defs[0] : defs.find((d) => d.line === line);
  if (!def) return refusals.notFound(doc.path, [`&${name}`]);
  // A name defined twice needs the definition's line: which one is meant cannot be guessed.
  if (line === undefined && defs.length > 1)
    return refusals.unsupported(
      doc.path,
      defs[1]!.path,
      `\`&${name}\` is defined more than once (lines ${defs.map((d) => d.line).join(', ')})`,
      defs[1]!.line,
    );
  const edits: TextEdit[] = [anchorRemoval(doc, def)];
  for (const use of def.aliases) {
    const copy = copyInto(doc, use);
    if (isRefusal(copy)) return copy;
    edits.push(...copy);
  }
  const n = def.aliases.length;
  return { edits, expect: (js) => js, label: `Copied \`&${name}\` into its ${n} use${n === 1 ? '' : 's'}` };
}

/** `key: &name value` → `key: value`; `key: &name` before a line break or a comment → `key:`. */
function anchorRemoval(doc: WorkflowDocument, def: AnchorDef): TextEdit {
  const { lines, text } = doc.tree;
  const after = text.slice(def.to);
  const space = /^[ \t]*/.exec(after)![0];
  const rest = after.slice(space.length);
  const own = lines.lineAt(def.from);
  // `&x` alone on its line goes with the line; on an empty node in a flow collection (`[&x, y]`) the node stays `null`.
  if (lines.startsLine(def.from) && /^(?:\r?\n|$)/.test(rest))
    return { from: lines.start(own), to: lines.end(own), insert: '' };
  if (def.node.range[0] === def.node.range[1] && /^[,\]}]/.test(rest))
    return { from: def.from, to: def.to, insert: 'null' };
  if (rest === '' || /^(?:\r?\n|#)/.test(rest))
    return { from: spaceBefore(text, def.from), to: def.to, insert: '' };
  return { from: def.from, to: def.to + space.length, insert: '' };
}

/** The splices that put a copy of the anchored node where the alias is. */
function copyInto(doc: WorkflowDocument, use: AliasUse): TextEdit[] | Refusal {
  const def = use.target;
  if (!def) return refusals.danglingAlias(doc.path, use);
  const hop = locate(doc.tree, use.path)?.hops.at(-1);
  if (!hop) return refusals.notFound(doc.path, use.path);
  const why = cannotCopy(doc, def, use, hop);
  if (why) return refusals.unsupported(doc.path, use.path, why, use.line);
  const node = def.node;
  const oneLine = isScalar(node)
    ? node.srcToken?.type !== 'block-scalar'
    : isCollection(node) && isFlow(node);
  if (oneLine) return inlineCopy(doc, def, use, isFlow(hop.parent));
  if (isFlow(hop.parent))
    return refusals.flowShape(doc.path, use.path, use.line, `and cannot hold a copy of \`&${def.name}\``);
  return linesCopy(doc, def, use, hop);
}

/** Why a copy of the anchored node cannot go where the alias is, if it cannot. */
function cannotCopy(doc: WorkflowDocument, def: AnchorDef, use: AliasUse, hop: Hop): string | undefined {
  const moved = changedAliases(doc, def, use);
  if (moved) return `the copy would hold \`*${moved}\`, which would then name another anchor`;
  if (def.node.tag !== undefined) return `\`&${def.name}\` has a YAML tag (\`${def.node.tag}\`)`;
  const block = isCollection(def.node) && !isFlow(def.node);
  if (block && isSeq(def.node) && !hop.pair) return `a list cannot be copied into a list item`;
  return undefined;
}

/** An alias inside the copied node whose name the copy's place would resolve to another definition. */
function changedAliases(doc: WorkflowDocument, def: AnchorDef, use: AliasUse): string | undefined {
  const [start] = def.node.range;
  const end = contentEnd(doc.tree, def.node);
  for (const inner of doc.anchors.aliases) {
    if (inner.from < start || inner.from >= end) continue;
    const before = doc.anchors.anchors.findLast((d) => d.name === inner.name && d.from < use.from);
    if (before !== inner.target) return inner.name;
  }
  return undefined;
}

/** A one-line node (a scalar, a short flow collection) copied over the alias token. */
function inlineCopy(
  doc: WorkflowDocument,
  def: AnchorDef,
  use: AliasUse,
  flow: boolean,
): TextEdit[] | Refusal {
  const { lines } = doc.tree;
  const [start] = def.node.range;
  const end = contentEnd(doc.tree, def.node);
  if (lines.lineAt(start) !== lines.lineAt(Math.max(end - 1, start)))
    return refusals.unsupported(doc.path, use.path, `\`&${def.name}\` spans lines`, def.line);
  const text = isScalar(def.node) && flow ? flowScalar(doc, def.node) : withoutAnchors(doc, start, end);
  if (text === undefined)
    return refusals.unsupported(doc.path, use.path, `\`&${def.name}\` cannot be written here`, use.line);
  // An empty copy takes the space before the alias with it, so no trailing space is left.
  return [{ from: text === '' ? spaceBefore(doc.text, use.from) : use.from, to: use.to, insert: text }];
}

/** A scalar written again for a flow collection, where `,`, `[` and `]` mean something. */
function flowScalar(doc: WorkflowDocument, node: ParsedNode): string | undefined {
  const value = (node as { value: unknown }).value;
  return inlineScalar(value === undefined ? null : (value as Scalar), 'flow', doc.style);
}

/**
 * A block node (a block collection, a block scalar) copied as lines, shifted by the difference between the columns
 * of the anchor's owner and of the alias's (the key or `-` they belong to), so the copy keeps the original's shape.
 */
function linesCopy(doc: WorkflowDocument, def: AnchorDef, use: AliasUse, hop: Hop): TextEdit[] | Refusal {
  const { lines } = doc.tree;
  const owner = locate(doc.tree, def.path)?.hops.at(-1);
  if (!owner || isFlow(owner.parent))
    return refusals.unsupported(
      doc.path,
      use.path,
      `\`&${def.name}\` is not in a block collection`,
      def.line,
    );
  const shift =
    lines.column(ownStart(hop.parent, hop.index)) - lines.column(ownStart(owner.parent, owner.index));
  const copy = blockLines(doc, def.node, shift);
  if (!copy)
    return refusals.unsupported(
      doc.path,
      use.path,
      `the copy of \`&${def.name}\` cannot be re-indented here`,
      use.line,
    );
  return placeCopy(
    doc,
    use,
    copy,
    !hop.pair && copy.header === undefined && copy.firstColumn === lines.column(use.from),
  );
}

/**
 * A copy's lines after the alias's line. A compact one (a map copied into `- *x` at the map's own column) puts its
 * first line where the alias was; otherwise the alias goes, or a block scalar's header takes its place.
 */
function placeCopy(doc: WorkflowDocument, use: AliasUse, copy: BlockCopy, compact: boolean): TextEdit[] {
  const below = linesBelow(doc, use, copy, compact);
  if (below.alone) return [below.edit(copy.lines)];
  if (compact) {
    const [first, ...rest] = copy.lines;
    const edits: TextEdit[] = [{ from: use.from, to: use.to, insert: first!.trimStart() }];
    return rest.length > 0 ? [...edits, below.edit(rest)] : edits;
  }
  const head = copy.header === undefined ? '' : ` ${copy.header}`;
  return [{ from: spaceBefore(doc.text, use.from), to: use.to, insert: head }, below.edit(copy.lines)];
}

/**
 * Where a copy's lines go: after the alias's line, or in place of it when the alias is alone on the line after its
 * key, so no blank line is left.
 */
function linesBelow(
  doc: WorkflowDocument,
  use: AliasUse,
  copy: BlockCopy,
  compact: boolean,
): { alone: boolean; edit: (rest: readonly string[]) => TextEdit } {
  const { lines } = doc.tree;
  const eol = doc.style.eol;
  const line = lines.lineAt(use.from);
  const alone = !compact && aloneOnLine(doc, use, copy);
  const atEnd = lines.end(line) === doc.text.length && !doc.text.endsWith('\n');
  // A block scalar that keeps its last line break needs one after it, even at the end of a file that has none.
  const close = !atEnd || opensBlock([copy.header ?? '', ...copy.lines]) ? eol : '';
  const [at, to] = alone ? [lines.start(line), lines.end(line)] : [lines.end(line), lines.end(line)];
  const lead = atEnd && !alone ? eol : '';
  return { alone, edit: (rest) => ({ from: at, to, insert: lead + rest.join(eol) + close }) };
}

/** Whether an alias with no block header to write is all its line holds. */
function aloneOnLine(doc: WorkflowDocument, use: AliasUse, copy: BlockCopy): boolean {
  const line = doc.tree.lines.lineAt(use.from);
  return copy.header === undefined && doc.tree.lines.textOf(line).trim() === doc.text.slice(use.from, use.to);
}

interface BlockCopy {
  /** A block scalar's header, which goes where the alias was; its lines follow. */
  header?: string;
  lines: string[];
  firstColumn: number;
}

/** A block node's lines, each shifted by `shift` columns; undefined when a line would lose content. */
function blockLines(doc: WorkflowDocument, node: ParsedNode, shift: number): BlockCopy | undefined {
  return isScalar(node) && node.srcToken?.type === 'block-scalar'
    ? scalarLines(doc, node, shift)
    : collectionLines(doc, node, shift);
}

/** A block scalar's header and body lines; the body keeps its kept blank lines. */
function scalarLines(doc: WorkflowDocument, node: ParsedNode, shift: number): BlockCopy | undefined {
  const { lines } = doc.tree;
  const from = lines.end(lines.lineAt(node.range[0]));
  const shifted = withoutAnchors(doc, from, node.range[1])
    .split(/\r?\n/)
    .map((line) => shiftLine(line, shift));
  if (shifted.some((line) => line === undefined)) return undefined;
  const out = shifted as string[];
  if (out.at(-1) === '') out.pop();
  return { header: blockHeader(node.srcToken), lines: out, firstColumn: lines.column(from) + shift };
}

/** A block collection's lines; its first line starts at its first key or dash, mid-line, and gets its indentation. */
function collectionLines(doc: WorkflowDocument, node: ParsedNode, shift: number): BlockCopy | undefined {
  const { lines } = doc.tree;
  const from = node.range[0];
  const to = lines.breakAt(lines.lineAt(contentEnd(doc.tree, node) - 1));
  const firstColumn = lines.column(from) + shift;
  const [first, ...rest] = withoutAnchors(doc, from, to).split(/\r?\n/);
  const shifted = rest.map((line) => shiftLine(line, shift));
  if (shifted.some((line) => line === undefined)) return undefined;
  return { lines: [`${' '.repeat(firstColumn)}${first}`, ...(shifted as string[])], firstColumn };
}

function shiftLine(line: string, shift: number): string | undefined {
  if (line === '') return '';
  if (shift >= 0) return ' '.repeat(shift) + line;
  const spaces = /^ */.exec(line)![0].length;
  if (spaces >= -shift) return line.slice(-shift);
  // Fewer spaces than the shift on a line of spaces: an empty line either way.
  return line.trim() === '' && !line.includes('\t') ? '' : undefined;
}

/** The text of a range without the anchors defined in it, each taken out as `dealiasAnchor` takes one out. */
function withoutAnchors(doc: WorkflowDocument, from: number, to: number): string {
  let text = '';
  let at = from;
  for (const def of doc.anchors.anchors) {
    if (def.from < from || def.from >= to) continue;
    const cut = anchorRemoval(doc, def);
    text += doc.text.slice(at, Math.max(at, cut.from));
    at = Math.min(cut.to, to);
  }
  return text + doc.text.slice(at, to);
}
