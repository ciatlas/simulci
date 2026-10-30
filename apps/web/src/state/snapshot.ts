import { regionEdit } from '@simulci/document/edits';
import type { FileMeta } from '../input/read';
import { type KeyValueStore, openKeyValue } from '../lib/idb';
import { stampOf, type TxFile } from './history';
import { DB_NAME, STORE_NAME } from './persist';
import { dirtyPaths, type GitHubSource, type RestoreConflict, type SessionState, type Source } from './store';

/**
 * The crash snapshot (synthesis § 5.6): a folder's unsaved edits survive a closed tab, a crash or a reload. Its files
 * stay on disk, so the source store keeps only its handle (or, for a copy, the buffers as read); the edits are kept
 * apart, under `edits` in the same IndexedDB store: per dirty file the fingerprint of the text it was edited from and
 * the text now. One snapshot per folder, the eight folders edited last: a folder waiting for Reopen, or one the
 * author left for another, keeps its edits while another is edited. Pasted and edited-sample buffers need none:
 * they carry their edits themselves (`state/buffers.ts`). A GitHub repository's edits are kept the same way, keyed
 * `github:<host>/<owner>/<repo>` whatever the commit: a ref that moved since leaves the files GitHub changed as conflicts.
 *
 * When a folder's files come in, from the last visit, after Reopen, or picked again, the snapshot that belongs to it
 * comes back: every file whose text is still the one it was edited from, as one undoable `restore` entry; every
 * other as a conflict the author settles, Restore mine or Keep disk. Until a conflict is settled its kept text stays
 * in the snapshot beside whatever the author types meanwhile (`withConflicts`).
 */

export interface EditsSnapshot {
  v: 1;
  /** A folder's name, or a repository's `<host>/<owner>/<repo>`, lower-case (`repoKey`). */
  source: { kind: 'folder' | 'copy' | 'github'; name: string; handle?: FileSystemDirectoryHandle };
  /** Per dirty file that was read: the stamp of the text it was edited from, its text now, what reading found. */
  files: Record<string, { base: string; text: string; meta: FileMeta }>;
  /** Files created since they were read, by path. */
  created: Record<string, string>;
  /**
   * Files removed since they were read, by path: the stamp of the text removed. Without it a removal came back as the
   * file, unedited, and a GitHub source's patch lost it (absent in snapshots written before).
   */
  removed?: Record<string, string>;
  at: number;
}

const EDITS_KEY = 'edits';

/** How many folders' edits are kept: the ones edited last. */
export const MAX_SNAPSHOTS = 8;

export interface SnapshotStore {
  /** The snapshot taken of this source, if one is kept. */
  find(source: Source): Promise<EditsSnapshot | undefined>;
  /** Keeps this snapshot as its source's, the newest first; past `MAX_SNAPSHOTS` the oldest goes. */
  save(snapshot: EditsSnapshot, source: Source): Promise<void>;
  /** Lets this source's snapshot go. */
  drop(source: Source): Promise<void>;
}

/**
 * The snapshots under one key, read and written one operation at a time, so two saves never interleave their read
 * and their write.
 */
export function snapshotStore(kv: KeyValueStore = openKeyValue(DB_NAME, STORE_NAME)): SnapshotStore {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(op: () => Promise<T>): Promise<T> => {
    const next = queue.then(op, op);
    queue = next.catch(() => undefined);
    return next;
  };
  const read = async (): Promise<EditsSnapshot[]> => {
    try {
      const stored = await kv.get<unknown>(EDITS_KEY);
      return Array.isArray(stored) ? stored.filter(isSnapshot) : [];
    } catch {
      return [];
    }
  };
  const write = async (list: EditsSnapshot[]): Promise<void> => {
    try {
      if (list.length > 0) await kv.set(EDITS_KEY, list);
      else await kv.delete(EDITS_KEY);
    } catch {
      // A refused write (private window, quota): the edits are still on the page.
    }
  };
  const indexOf = async (list: EditsSnapshot[], source: Source): Promise<number> => {
    for (const [i, snapshot] of list.entries()) if (await belongs(snapshot, source)) return i;
    return -1;
  };
  return {
    find: (source) =>
      serial(async () => {
        const list = await read();
        return list[await indexOf(list, source)];
      }),
    save: (snapshot, source) =>
      serial(async () => {
        const list = await read();
        const i = await indexOf(list, source);
        if (i >= 0) list.splice(i, 1);
        await write([snapshot, ...list].slice(0, MAX_SNAPSHOTS));
      }),
    drop: (source) =>
      serial(async () => {
        const list = await read();
        const i = await indexOf(list, source);
        if (i < 0) return;
        list.splice(i, 1);
        await write(list);
      }),
  };
}

function isSnapshot(value: unknown): value is EditsSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.v === 1 &&
    isSnapshotSource(v.source) &&
    isRecordOf(v.files, isSnapshotFile) &&
    isRecordOf(v.created, (t) => typeof t === 'string') &&
    (v.removed === undefined || isRecordOf(v.removed, (t) => typeof t === 'string')) &&
    typeof v.at === 'number'
  );
}

function isSnapshotSource(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const source = value as Record<string, unknown>;
  return (
    (source.kind === 'folder' || source.kind === 'copy' || source.kind === 'github') &&
    typeof source.name === 'string'
  );
}

const isRecordOf = (value: unknown, each: (v: unknown) => boolean): boolean =>
  typeof value === 'object' && value !== null && Object.values(value).every(each);

function isSnapshotFile(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const f = value as Record<string, unknown>;
  return (
    typeof f.base === 'string' && typeof f.text === 'string' && typeof f.meta === 'object' && f.meta !== null
  );
}

/** Whether a source's edits are kept in a crash snapshot: a folder's, or a GitHub repository's. */
export const keepsSnapshot = (source: Source): source is Extract<Source, { kind: 'folder' | 'github' }> =>
  source.kind === 'folder' || source.kind === 'github';

/** A repository as its snapshot names it: one per repository, whichever commit or ref the edits were made over. */
export const repoKey = (source: Pick<GitHubSource, 'host' | 'owner' | 'repo'>): string =>
  `${source.host}/${source.owner}/${source.repo}`.toLowerCase();

/** The snapshot of the store's edits, or undefined when its source keeps none or nothing is unsaved. */
export function snapshotOf(s: Pick<SessionState, 'source' | 'files'>, at: number): EditsSnapshot | undefined {
  const { source, files } = s;
  if (!keepsSnapshot(source)) return undefined;
  const dirty = dirtyPaths(files);
  if (dirty.length === 0) return undefined;
  const snapshot: EditsSnapshot = {
    v: 1,
    source: snapshotSource(source),
    files: {},
    created: {},
    at,
  };
  for (const path of dirty) {
    const text = files.byPath[path];
    const base = files.base[path];
    if (text === undefined) {
      if (base !== undefined) (snapshot.removed ??= {})[path] = stampOf(base);
      continue;
    }
    if (base === undefined) snapshot.created[path] = text;
    else snapshot.files[path] = { base: stampOf(base), text, meta: files.meta[path]! };
  }
  return snapshot;
}

function snapshotSource(source: Extract<Source, { kind: 'folder' | 'github' }>): EditsSnapshot['source'] {
  if (source.kind === 'github') return { kind: 'github', name: repoKey(source) };
  return source.handle
    ? { kind: 'folder', name: source.name, handle: source.handle }
    : { kind: 'copy', name: source.name };
}

/**
 * Whether a snapshot was taken of this source: the same directory for a folder, the same name for a copy, the same
 * repository for a GitHub source.
 */
async function belongs(snapshot: EditsSnapshot, source: Source): Promise<boolean> {
  if (source.kind === 'github')
    return snapshot.source.kind === 'github' && snapshot.source.name === repoKey(source);
  return source.kind === 'folder' && snapshot.source.kind !== 'github' && belongsToFolder(snapshot, source);
}

async function belongsToFolder(
  snapshot: EditsSnapshot,
  source: Extract<Source, { kind: 'folder' }>,
): Promise<boolean> {
  if (snapshot.source.name !== source.name) return false;
  if (snapshot.source.kind === 'copy') return source.handle === undefined;
  const stored = snapshot.source.handle;
  if (!stored || !source.handle) return false;
  try {
    return await source.handle.isSameEntry(stored);
  } catch {
    return false;
  }
}

/** What a snapshot brings back to the files as they are: edits that apply cleanly, and the files to settle. */
export interface RestorePlan {
  files: TxFile[];
  conflicts: RestoreConflict[];
  /** Files removed before that changed since: they stay, and the author is told. */
  kept: string[];
}

/**
 * A file comes back when its text is still the one it was edited from (and its BOM as read): the disk did not
 * change, and nothing was typed since. A file created since comes back when its path is still free. A file removed
 * goes again when it is still the text removed; one that changed since stays (`kept`). Any other file is a conflict:
 * the disk, or the author, moved on.
 */
export function restorePlan(snapshot: EditsSnapshot, files: SessionState['files']): RestorePlan {
  const plan: RestorePlan = { files: [], conflicts: [], kept: [] };
  removals(snapshot, files, plan);
  for (const [path, f] of Object.entries(snapshot.files)) {
    const current = files.byPath[path];
    if (current === f.text) continue;
    if (cleanly(files, path, f))
      plan.files.push({ path, edits: [regionEdit(current!, f.text)], expect: stampOf(current!) });
    else plan.conflicts.push({ path, text: f.text, reason: current === undefined ? 'gone' : 'changed' });
  }
  for (const [path, text] of Object.entries(snapshot.created)) {
    const current = files.byPath[path];
    if (current === text) continue;
    if (current === undefined)
      plan.files.push({ path, edits: [{ from: 0, to: 0, insert: text }], create: true });
    else plan.conflicts.push({ path, text, reason: 'exists' });
  }
  return plan;
}

/** The snapshot's removals: each file still the text removed, untouched since, goes again; any other stays. */
function removals(snapshot: EditsSnapshot, files: SessionState['files'], plan: RestorePlan): void {
  for (const [path, stamp] of Object.entries(snapshot.removed ?? {})) {
    const current = files.byPath[path];
    if (current === undefined) continue;
    if (current === files.base[path] && stampOf(current) === stamp)
      plan.files.push({ path, edits: [], remove: true, expect: stamp });
    else plan.kept.push(path);
  }
}

/** Whether a file is still the text the snapshot's edits were made to, as read, BOM included, and untouched since. */
function cleanly(files: SessionState['files'], path: string, kept: EditsSnapshot['files'][string]): boolean {
  const current = files.byPath[path];
  const base = files.base[path];
  if (current === undefined || current !== base) return false;
  return stampOf(base) === kept.base && files.meta[path]?.bom === kept.meta.bom;
}

/** "14:02": when the snapshot was taken, as the notice says it. */
export const clockOf = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * The snapshot to write while restore conflicts wait: the edits on the page, and for each file still to be settled
 * the text the snapshot kept for it, so neither typing meanwhile nor the kept text is lost to a crash.
 */
export function withConflicts(
  current: EditsSnapshot | undefined,
  kept: EditsSnapshot,
  conflicts: readonly RestoreConflict[],
  at: number,
): EditsSnapshot | undefined {
  if (conflicts.length === 0) return current;
  const out: EditsSnapshot = current
    ? { ...current, files: { ...current.files }, created: { ...current.created } }
    : { v: 1, source: kept.source, files: {}, created: {}, at };
  for (const { path } of conflicts) {
    const file = kept.files[path];
    if (file) out.files[path] = file;
    else if (Object.hasOwn(kept.created, path)) out.created[path] = kept.created[path]!;
  }
  return out;
}
