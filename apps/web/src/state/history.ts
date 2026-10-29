import { applyEdits, regionEdit, type TextEdit, touched } from '@simulci/document/edits';
import { fileLabel } from '../lib/file-label';
import { fnv1a } from '../lib/hash';
import type { Renames } from './renames';

/**
 * The page's one edit history (synthesis § 6), a pure reducer over the texts. Every change the author makes to a
 * file, whoever makes it (the YAML pane, an op, a revert, a restore, a disk take), is a transaction of per-file edits
 * with their inverses; the store commits what a step returns in the same `set()` as the texts, so the two never
 * disagree. Typing is grouped: each key changes the text at once, and the open group keeps the text from before its
 * first key, so when it closes it is one region edit. A transaction applies to every file or to none, and undo and
 * redo first check that every file still holds the text the entry left: an undo never writes the wrong bytes.
 */

export type Origin = 'pane' | 'op' | 'field' | 'revert' | 'disk' | 'restore' | 'convert';

/** The selection an entry was made under, as the URL spells it. */
export interface SelectionRef {
  focus?: string;
  sel?: string;
}

/**
 * What a transaction did to one file. `before` and `after` fingerprint its text on either side (`stampOf`); a created
 * file had none before and a removed one has none after, which `ABSENT` stands for.
 */
export interface FileChange {
  path: string;
  edits: TextEdit[];
  inverse: TextEdit[];
  before: string;
  after: string;
  created?: true;
  removed?: true;
}

export interface Transaction {
  id: number;
  /** For the undo and redo buttons: "Typed in ci.yml", "Added job lint". */
  label: string;
  origin: Origin;
  at: number;
  /** One per file; several for a multi-file transaction. */
  files: FileChange[];
  selection: { before: SelectionRef; after?: SelectionRef };
  /** The ids a rename changed: undo maps the page's ids back, redo forth again (C11). */
  renames?: Renames;
}

/**
 * Typing not yet closed into a transaction: the texts from before its first key and after its last, and where its
 * last key ended. It closes into the edit between those two texts, never into whatever a file holds by then, so a
 * change that reached a file outside the history is never folded into an entry: the hash guard stops its undo.
 */
export interface OpenGroup {
  key: string;
  label: string;
  origin: Origin;
  before: Record<string, string>;
  now: Record<string, string>;
  selection: SelectionRef;
  /** When its last edit came. */
  last: number;
  /** The offset its last edit ended at, in the text after it: the next key continues there or closes the group. */
  end?: number;
}

export interface History {
  past: Transaction[];
  future: Transaction[];
  group?: OpenGroup;
  /** What changed the texts last: the session's cadence reads it (§ 7.1). */
  lastOrigin?: Origin | 'undo' | 'redo';
  /** The id the next transaction takes; ids never repeat within a page. */
  next: number;
}

export const emptyHistory = (next = 1): History => ({ past: [], future: [], next });

/** The texts the history works over: the store's `files.byPath`. */
export type Texts = Readonly<Record<string, string>>;

/** What a step asks the store to commit: the new text of each changed file, `null` for a file removed. */
export type TextChanges = Record<string, string | null>;

export interface Step {
  history: History;
  changes: TextChanges;
  /** Per changed file, the edits that make its new text, in the offsets of the text before: what a view maps. */
  edits: Record<string, readonly TextEdit[]>;
}

/**
 * Why nothing was applied. `stale`: a file's text is not the one the edits were planned against; `exists` or
 * `missing`: a file to create is there, or a file to edit is not; `range`: an edit is not a range of the text;
 * `desync`: undo or redo found a file the history did not leave as it is (the store then clears the history).
 */
export interface Refusal {
  refused: 'stale' | 'exists' | 'missing' | 'range' | 'desync';
  path: string;
}

/** The fingerprint of an absent file. */
const ABSENT = '-';

/** A text's fingerprint for the hash guards: its length and its FNV-1a. */
export const stampOf = (text: string): string => `${text.length}:${fnv1a(text)}`;

/** Typing that pauses this long closes its group. */
export const PAUSE_MS = 300;
/** The caps of § 6: the oldest entries go first. */
export const MAX_ENTRIES = 500;
/** 16 MB of stored edit text, counted in UTF-16 code units. */
export const MAX_UNITS = 8 * 1024 * 1024;

/** When and under which selection a step happens: the store fills it in. */
export interface Context {
  at: number;
  selection: SelectionRef;
}

/** One file of a transaction: its edits, in the offsets of its text now. */
export interface TxFile {
  path: string;
  edits: readonly TextEdit[];
  /** `stampOf` the text the edits were planned against; a text that moved since refuses the transaction. */
  expect?: string;
  /** The file does not exist yet: the edits apply to an empty text. */
  create?: true;
  /** The file goes; its edits are ignored, the whole text is the removal. */
  remove?: true;
}

export interface TxInput {
  label: string;
  origin: Origin;
  files: readonly TxFile[];
  /** Where the selection should go once the plan of the new texts comes (C3). */
  selectionAfter?: SelectionRef;
  /** The ids a rename changes (C11). */
  renames?: Renames;
}

/**
 * A transaction over several files: every file is checked and computed first, so one refused file applies none.
 * Edits that change nothing leave no entry. An open group closes first, and the redo stack goes.
 */
export function transact(h: History, texts: Texts, input: TxInput, ctx: Context): Step | Refusal {
  const closed = close(h);
  const files: FileChange[] = [];
  const changes: TextChanges = {};
  const seen = new Set<string>();
  for (const file of input.files) {
    if (seen.has(file.path)) throw new Error(`${file.path} is twice in one transaction`);
    seen.add(file.path);
    const planned = planFile(texts, file);
    if (planned === undefined) continue;
    if ('refused' in planned) return planned;
    files.push(planned.change);
    changes[file.path] = planned.text;
  }
  if (files.length === 0) return { history: closed, changes: {}, edits: {} };
  const tx: Transaction = {
    id: closed.next,
    label: input.label,
    origin: input.origin,
    at: ctx.at,
    files,
    selection: { before: ctx.selection, ...(input.selectionAfter ? { after: input.selectionAfter } : {}) },
    ...(input.renames ? { renames: input.renames } : {}),
  };
  return {
    history: push({ ...closed, future: [], lastOrigin: input.origin, next: closed.next + 1 }, tx),
    changes,
    edits: Object.fromEntries(files.map((f) => [f.path, f.edits])),
  };
}

/** One file's change and its new text, a refusal, or nothing when the edits leave the text as it is. */
function planFile(
  texts: Texts,
  file: TxFile,
): { change: FileChange; text: string | null } | Refusal | undefined {
  const from = startOf(texts, file);
  if (typeof from !== 'string') return from;
  const edits = file.remove ? [{ from: 0, to: from.length, insert: '' }] : [...file.edits];
  const applied = tryApply(from, edits);
  if (applied === undefined) return { refused: 'range', path: file.path };
  if (applied.text === from && !file.create && !file.remove) return undefined;
  return { change: changeOf(file, edits, from, applied), text: file.remove ? null : applied.text };
}

function changeOf(
  file: TxFile,
  edits: TextEdit[],
  from: string,
  applied: { text: string; inverse: TextEdit[] },
) {
  const change: FileChange = {
    path: file.path,
    edits,
    inverse: applied.inverse,
    before: stampOf(from),
    after: stampOf(applied.text),
  };
  if (file.create) Object.assign(change, { created: true, before: ABSENT });
  if (file.remove) Object.assign(change, { removed: true, after: ABSENT });
  return change;
}

/** The text a file's edits apply to: its own, or an empty one for a file to create; else why there is none. */
function startOf(texts: Texts, file: TxFile): string | Refusal {
  const { path } = file;
  const current = textOf(texts, path);
  if (file.create && current !== undefined) return { refused: 'exists', path };
  if (!file.create && current === undefined) return { refused: 'missing', path };
  const from = current ?? '';
  return file.expect === undefined || stampOf(from) === file.expect ? from : { refused: 'stale', path };
}

const textOf = (texts: Texts, path: string): string | undefined =>
  Object.hasOwn(texts, path) ? texts[path] : undefined;

/** `applyEdits`, or undefined when the edits are not ranges of the text. */
function tryApply(text: string, edits: readonly TextEdit[]): ReturnType<typeof applyEdits> | undefined {
  try {
    return applyEdits(text, edits);
  } catch (e) {
    if (e instanceof RangeError) return undefined;
    throw e;
  }
}

/**
 * A commit of a Properties field's focus session (synthesis § 4.4), applied at once as `transact` applies it, and
 * grouped with the session's earlier commits under `key` (`field:<file>:<path>`): the session is one entry when its
 * group closes, on blur or at any other edit. A commit under another key closes the open group first; one that changes
 * nothing leaves the history as it is. A file to create or remove is never grouped: that commit is a transaction.
 */
export function grouped(h: History, texts: Texts, key: string, input: TxInput, ctx: Context): Step | Refusal {
  if (input.files.some((f) => f.create || f.remove)) return transact(h, texts, input, ctx);
  const changes: Record<string, string> = {};
  const edits: Record<string, readonly TextEdit[]> = {};
  for (const file of input.files) {
    const planned = planFile(texts, file);
    if (planned === undefined) continue;
    if ('refused' in planned) return planned;
    changes[file.path] = planned.text!;
    edits[file.path] = planned.change.edits;
  }
  if (Object.keys(changes).length === 0) return { history: h, changes: {}, edits: {} };
  const joined = h.group?.key === key ? h.group : undefined;
  const before = { ...joined?.before };
  for (const path of Object.keys(changes)) before[path] ??= texts[path]!;
  const group: OpenGroup = {
    key,
    label: joined?.label ?? input.label,
    origin: input.origin,
    before,
    now: { ...joined?.now, ...changes },
    selection: joined?.selection ?? ctx.selection,
    last: ctx.at,
  };
  const open = joined ? h : close(h);
  return { history: { ...open, future: [], group, lastOrigin: input.origin }, changes, edits };
}

/** A typed edit that is not a key: a paste, a cut or a drop is an entry of its own. */
export type Alone = 'paste' | 'cut' | 'drop';

const ALONE_LABEL: Record<Alone, string> = { paste: 'Pasted into', cut: 'Cut from', drop: 'Dropped into' };

/**
 * A key typed in the pane, applied at once. It joins the open group when it continues it: the same file, within
 * `PAUSE_MS` of the last key, one edit touching the offset where the last one ended. Otherwise the group closes and a
 * new one opens. A line break joins its group and closes it; a paste, a cut or a drop is its own entry.
 */
export function typed(
  h: History,
  texts: Texts,
  path: string,
  edits: readonly TextEdit[],
  ctx: Context,
  alone?: Alone,
): Step | Refusal {
  const current = textOf(texts, path);
  if (current === undefined) return { refused: 'missing', path };
  const applied = tryApply(current, edits);
  if (applied === undefined) return { refused: 'range', path };
  if (applied.text === current) return { history: h, changes: {}, edits: {} };
  const key = `pane:${path}`;
  const end = touched(edits).at(-1)!.to;
  const joins = alone === undefined && continues(h.group, key, current, edits, ctx.at);
  const open = joins ? h : close(h);
  const group: OpenGroup =
    joins && h.group
      ? { ...h.group, now: { [path]: applied.text }, last: ctx.at, end }
      : {
          key,
          label: `${alone ? ALONE_LABEL[alone] : 'Typed in'} ${fileLabel(path)}`,
          origin: 'pane',
          before: { [path]: current },
          now: { [path]: applied.text },
          selection: ctx.selection,
          last: ctx.at,
          end,
        };
  const next: History = { ...open, future: [], group, lastOrigin: 'pane' };
  const after = alone !== undefined || breaksLine(edits) ? close(next) : next;
  return { history: after, changes: { [path]: applied.text }, edits: { [path]: edits } };
}

/**
 * Whether a key continues the open group: the same file, still holding the text the group's last key left, within
 * `PAUSE_MS` of it, one edit touching the offset where the last one ended.
 */
function continues(
  group: OpenGroup | undefined,
  key: string,
  current: string,
  edits: readonly TextEdit[],
  at: number,
): boolean {
  if (group?.key !== key || group.end === undefined || edits.length !== 1) return false;
  if (at - group.last >= PAUSE_MS || Object.values(group.now)[0] !== current) return false;
  const [edit] = edits;
  return edit!.from <= group.end && group.end <= edit!.to;
}

const breaksLine = (edits: readonly TextEdit[]): boolean => edits.some((e) => /[\r\n]/.test(e.insert));

/**
 * The open group as one transaction: per file, one region edit from the text before its first key to the text after
 * its last. A group that changed nothing leaves no entry.
 */
export function close(h: History): History {
  const g = h.group;
  if (!g) return h;
  const files: FileChange[] = [];
  for (const [path, before] of Object.entries(g.before)) {
    const after = g.now[path];
    if (after === undefined || after === before) continue;
    const edit = regionEdit(before, after);
    const inverse = {
      from: edit.from,
      to: edit.from + edit.insert.length,
      insert: before.slice(edit.from, edit.to),
    };
    files.push({ path, edits: [edit], inverse: [inverse], before: stampOf(before), after: stampOf(after) });
  }
  const rest: History = { ...h, group: undefined };
  if (files.length === 0) return rest;
  const tx: Transaction = {
    id: h.next,
    label: g.label,
    origin: g.origin,
    at: g.last,
    files,
    selection: { before: g.selection },
  };
  return push({ ...rest, next: h.next + 1 }, tx);
}

/** The history with `tx` on top, the oldest entries dropped past the caps. */
function push(h: History, tx: Transaction): History {
  const past = [...h.past, tx];
  let units = past.reduce((n, t) => n + unitsOf(t), 0);
  while (past.length > 1 && (past.length > MAX_ENTRIES || units > MAX_UNITS)) units -= unitsOf(past.shift()!);
  return { ...h, past };
}

const unitsOf = (tx: Transaction): number =>
  tx.files.reduce(
    (n, f) =>
      n +
      f.edits.reduce((m, e) => m + e.insert.length, 0) +
      f.inverse.reduce((m, e) => m + e.insert.length, 0),
    0,
  );

/**
 * Undoes the top entry, an open group closed first; undefined when there is nothing to undo. Every file of the entry
 * must still hold the text it left, or nothing is applied.
 */
export function undo(h: History, texts: Texts): Step | Refusal | undefined {
  const closed = close(h);
  const tx = closed.past.at(-1);
  if (!tx) return undefined;
  const desynced = tx.files.find((f) => !holds(texts, f.path, f.after));
  if (desynced) return { refused: 'desync', path: desynced.path };
  const changes: TextChanges = {};
  for (const f of tx.files)
    changes[f.path] = f.created ? null : applyEdits(texts[f.path] ?? '', f.inverse).text;
  return {
    history: {
      ...closed,
      past: closed.past.slice(0, -1),
      future: [...closed.future, tx],
      lastOrigin: 'undo',
    },
    changes,
    edits: Object.fromEntries(tx.files.map((f) => [f.path, f.inverse])),
  };
}

/** Redoes the entry undone last; undefined when there is none. Every file must hold the text the undo left. */
export function redo(h: History, texts: Texts): Step | Refusal | undefined {
  const tx = h.future.at(-1);
  if (!tx || h.group) return undefined;
  const desynced = tx.files.find((f) => !holds(texts, f.path, f.before));
  if (desynced) return { refused: 'desync', path: desynced.path };
  const changes: TextChanges = {};
  for (const f of tx.files)
    changes[f.path] = f.removed ? null : applyEdits(texts[f.path] ?? '', f.edits).text;
  return {
    history: { ...h, past: [...h.past, tx], future: h.future.slice(0, -1), lastOrigin: 'redo' },
    changes,
    edits: Object.fromEntries(tx.files.map((f) => [f.path, f.edits])),
  };
}

/** Whether a file is as a fingerprint says: absent for `ABSENT`, else a text with that stamp. */
function holds(texts: Texts, path: string, stamp: string): boolean {
  const text = textOf(texts, path);
  return stamp === ABSENT ? text === undefined : text !== undefined && stampOf(text) === stamp;
}

/** Whether the open group changed anything: a group typed back to its texts leaves no entry when it closes. */
const groupChanged = (g: OpenGroup): boolean =>
  Object.entries(g.before).some(([path, before]) => g.now[path] !== before);

/** What Undo would undo, by its label; undefined when nothing. */
export function undoLabel(h: History): string | undefined {
  if (h.group && groupChanged(h.group)) return h.group.label;
  return h.past.at(-1)?.label;
}

/** What Redo would redo, by its label; undefined when nothing. */
export const redoLabel = (h: History): string | undefined => (h.group ? undefined : h.future.at(-1)?.label);
