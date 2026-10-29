import type { WorkflowDocument } from './document';
import type { TextEdit } from './edits';
import { flowRemove, simpleFlow } from './flow';
import { editable, entryEquivalents, isRefusal, orphanedIn, reach } from './guard';
import { deleteIn } from './json';
import * as refusals from './refusal';
import type { Refusal } from './refusal';
import { setDraft, spaceBefore } from './set';
import { absorbed, itemSpan, ownStart, removalSpan } from './spans';
import { isFlow, type Collection } from './tree';
import type { YamlPath } from './types';
import type { Draft } from './verify';

/**
 * Removes the pair or item at a path with the lines it owns (§ 2.5): its leading comments, its deeper trailing
 * comments and one blank separator. The last item of a collection leaves its key with no value (`emptied: 'null'`,
 * so removing an event's last filter keeps `push:`) or takes the key too (`'remove'`, for `needs`, `with`, `env`).
 */
export function removeDraft(
  doc: WorkflowDocument,
  path: YamlPath,
  emptied: 'null' | 'remove' = 'null',
  options: { shared?: 'all' } = {},
): Draft | Refusal {
  const bad = editable(doc);
  if (bad) return bad;
  if (path.length === 0)
    return refusals.unsupported(doc.path, path, 'the whole file cannot be removed by an edit');
  const at = reach(doc, path, { ...options, aliasTarget: true, sharedAbove: true });
  if (isRefusal(at)) return at;
  const hop = at.hops.at(-1)!;
  const orphan = orphanedIn(doc, itemSpan(doc.tree, hop.parent, hop.index), path);
  if (orphan) return orphan;
  const expect = (js: unknown) => entryEquivalents(doc, path).reduce((j, p) => deleteIn(j, p, emptied), js);
  const label = `Removed ${refusals.describe(path)}`;
  if (hop.parent.items.length === 1) {
    const emptiedDraft = emptyCollection(doc, path, emptied, options);
    return isRefusal(emptiedDraft) ? emptiedDraft : { ...emptiedDraft, expect, label };
  }
  const edit = isFlow(hop.parent)
    ? flowItem(doc, hop.parent, hop.index, path)
    : blockItem(doc, hop.parent, hop.index, path);
  return isRefusal(edit) ? edit : { edits: [edit], expect, label };
}

/** A collection's last item removed: its key stays with no value, or goes too. */
function emptyCollection(
  doc: WorkflowDocument,
  path: YamlPath,
  emptied: 'null' | 'remove',
  options: { shared?: 'all' },
): Draft | Refusal {
  const container = path.slice(0, -1);
  if (emptied === 'remove' && container.length > 0) return removeDraft(doc, container, 'null', options);
  if (container.length === 0) return refusals.unsupported(doc.path, path, 'the file would be left empty');
  if (typeof container.at(-1) === 'number')
    return refusals.unsupported(doc.path, path, `${refusals.describe(container)} would be left empty`);
  return setDraft(doc, container, null, options);
}

function flowItem(
  doc: WorkflowDocument,
  parent: Collection,
  index: number,
  path: YamlPath,
): TextEdit | Refusal {
  return simpleFlow(doc, parent, path.slice(0, -1)) ?? flowRemove(doc, parent, index);
}

/**
 * A block item's lines out. The first key of a compact item (`- name: x`) is removed up to the next key, which moves
 * up behind the `- `; with a comment between them, its own lines go and the item then starts on the line after its
 * `-`, the comment kept.
 */
function blockItem(
  doc: WorkflowDocument,
  parent: Collection,
  index: number,
  path: YamlPath,
): TextEdit | Refusal {
  const span = itemSpan(doc.tree, parent, index);
  if (!span.inline) {
    const removal = removalSpan(doc.tree, parent, index);
    const comment = absorbed(doc.tree, parent, index, removal.to);
    if (comment !== undefined)
      return refusals.unsupported(
        doc.path,
        path,
        `removing it would leave the comment on line ${comment} inside the block scalar above it`,
        comment,
      );
    return { ...removal, insert: '' };
  }
  const next = ownStart(parent, index + 1);
  if (doc.text.slice(span.to, next).trim() === '') return { from: span.own, to: next, insert: '' };
  return { from: spaceBefore(doc.text, span.own), to: span.to, insert: doc.style.eol };
}
