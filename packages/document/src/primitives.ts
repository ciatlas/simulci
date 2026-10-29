import { isScalar } from 'yaml';
import { dealiasAnchorDraft, dealiasDraft } from './dealias';
import type { WorkflowDocument } from './document';
import type { TextEdit } from './edits';
import { editable, entryEquivalents, equivalents, isRefusal, reach } from './guard';
import { insertDraft, moveDraft, type InsertOptions } from './insert';
import { renameIn, setIn } from './json';
import * as refusals from './refusal';
import type { Refusal } from './refusal';
import { removeDraft } from './remove';
import { inlineScalar, tokenQuote } from './scalar';
import { setDraft, type SetOptions } from './set';
import { isFlow, keyOf, type Hop } from './tree';
import type { Eol, Json, Span, YamlPath } from './types';
import { verify, type Draft, type EditPlan } from './verify';

/** A draft checked (G6), or the refusal that came instead. */
export function finish(doc: WorkflowDocument, draft: Draft | Refusal): EditPlan<TextEdit[]> {
  return isRefusal(draft) ? draft : verify(doc, draft);
}

/** Sets the value at a path; see `setDraft`. */
export const set = (
  doc: WorkflowDocument,
  path: YamlPath,
  value: Json,
  options?: SetOptions,
): EditPlan<TextEdit[]> => finish(doc, setDraft(doc, path, value, options));

/** Removes the pair or item at a path; see `removeDraft`. */
export const remove = (
  doc: WorkflowDocument,
  path: YamlPath,
  emptied?: 'null' | 'remove',
  options?: { shared?: 'all' },
): EditPlan<TextEdit[]> => finish(doc, removeDraft(doc, path, emptied, options));

/** Inserts an item into a sequence; see `insertDraft`. */
export const insert = (
  doc: WorkflowDocument,
  seq: YamlPath,
  index: number,
  value: Json,
  options?: InsertOptions,
): EditPlan<TextEdit[]> => finish(doc, insertDraft(doc, seq, index, value, options));

/** Moves an item of a block sequence; see `moveDraft`. */
export const move = (
  doc: WorkflowDocument,
  seq: YamlPath,
  from: number,
  to: number,
  options?: { shared?: 'all' },
): EditPlan<TextEdit[]> => finish(doc, moveDraft(doc, seq, from, to, options));

export const renameKey = (
  doc: WorkflowDocument,
  path: YamlPath,
  key: string,
  options?: { shared?: 'all' },
): EditPlan<TextEdit[]> => finish(doc, renameKeyDraft(doc, path, key, options));

export const replaceAt = (
  doc: WorkflowDocument,
  span: Span,
  expected: string,
  insertText: string,
  options?: { shared?: 'all' },
): EditPlan<TextEdit[]> => finish(doc, replaceAtDraft(doc, span, expected, insertText, options));

export const dealias = (doc: WorkflowDocument, path: YamlPath): EditPlan<TextEdit[]> =>
  finish(doc, dealiasDraft(doc, path));

export const dealiasAnchor = (doc: WorkflowDocument, name: string, line?: number): EditPlan<TextEdit[]> =>
  finish(doc, dealiasAnchorDraft(doc, name, line));

export const convertEol = (doc: WorkflowDocument, eol: Eol): EditPlan<TextEdit[]> =>
  finish(doc, convertEolDraft(doc, eol));

/** Renames a map key in place: only the key token changes, its quotes kept when it needs or had them. */
export function renameKeyDraft(
  doc: WorkflowDocument,
  path: YamlPath,
  key: string,
  options: { shared?: 'all' } = {},
): Draft | Refusal {
  const bad = editable(doc);
  if (bad) return bad;
  const at = reach(doc, path, { ...options, aliasTarget: true, sharedAbove: true });
  if (isRefusal(at)) return at;
  const edits = keyEdits(doc, at.hops.at(-1), path, key);
  if (isRefusal(edits)) return edits;
  // Aliases of an anchor on the key read the key's text: they follow the rename, which only "Change all" allows.
  const def = doc.anchors.anchors.find(
    (d) => d.key && d.node === at.hops.at(-1)?.pair?.key && d.aliases.length > 0,
  );
  if (def && options.shared !== 'all') {
    const named = { name: def.name, line: def.line, redefined: doc.anchors.definitions(def.name).length > 1 };
    return refusals.sharedAnchor(
      doc.path,
      path,
      [named],
      def.aliases.map((a) => a.line),
      def.aliases.length + 1,
    );
  }
  const uses = (def?.aliases ?? []).flatMap((alias) => equivalents(doc, alias.path));
  return {
    edits,
    expect: (js) =>
      uses.reduce(
        (j, p) => setIn(j, p, key),
        entryEquivalents(doc, path).reduce((j, p) => renameIn(j, p, key), js),
      ),
    label: `Renamed ${refusals.describe(path)} to ${key}`,
    select: [...path.slice(0, -1), key],
  };
}

/** The key token rewritten: nothing when it is the key already, refused when a sibling has it. */
function keyEdits(
  doc: WorkflowDocument,
  hop: Hop | undefined,
  path: YamlPath,
  key: string,
): TextEdit[] | Refusal {
  if (!hop?.pair || !isScalar(hop.pair.key))
    return refusals.unsupported(doc.path, path, `${refusals.describe(path)} is not a key`);
  if (keyOf(hop.pair) === key) return [];
  if (hop.parent.items.some((pair) => pair !== hop.pair && keyOf(pair as never) === key))
    return refusals.duplicateId(doc.path, [...path.slice(0, -1), key], key);
  const token = hop.pair.key;
  const text = inlineScalar(
    key,
    isFlow(hop.parent) ? 'flowKey' : 'key',
    doc.style,
    tokenQuote(token.srcToken),
  );
  if (text === undefined)
    return refusals.unsupported(doc.path, path, `\`${key}\` cannot be written as a key`);
  return [{ from: token.range[0], to: token.range[1], insert: text }];
}

/** Replaces exactly `expected` at a span: a reference the worker found, refused as `stale` when the text moved on. */
export function replaceAtDraft(
  doc: WorkflowDocument,
  span: Span,
  expected: string,
  text: string,
  options: { shared?: 'all' } = {},
): Draft | Refusal {
  const bad = editable(doc);
  if (bad) return bad;
  const line = doc.tree.lines.lineAt(span.from) + 1;
  if (doc.text.slice(span.from, span.to) !== expected) return refusals.stale(doc.path, line);
  // Text known only as text: it may not touch an anchor or an alias, nor what aliases elsewhere repeat.
  const tokens = [...doc.anchors.anchors, ...doc.anchors.aliases];
  if (tokens.some((t) => t.from < span.to && span.from < t.to))
    return refusals.unsupported(
      doc.path,
      doc.pathAt(span.from),
      `line ${line} has an anchor or an alias there`,
    );
  const at = reach(doc, doc.pathAt(span.from), options);
  if (isRefusal(at)) return at;
  return { edits: [{ from: span.from, to: span.to, insert: text }], label: 'Replaced a reference' };
}

/** The whole file to one line ending, one splice per line break that changes; the value does not change. */
export function convertEolDraft(doc: WorkflowDocument, eol: Eol): Draft | Refusal {
  const bad = editable(doc, true);
  if (bad) return bad;
  const edits: TextEdit[] = [];
  for (let at = doc.text.indexOf('\n'); at !== -1; at = doc.text.indexOf('\n', at + 1)) {
    const crlf = doc.text[at - 1] === '\r';
    if (eol === '\n' && crlf) edits.push({ from: at - 1, to: at, insert: '' });
    if (eol === '\r\n' && !crlf) edits.push({ from: at, to: at, insert: '\r' });
  }
  return {
    edits,
    expect: (js) => js,
    label: `Converted line endings to ${eol === '\n' ? 'LF' : 'CRLF'}`,
    eol,
  };
}
