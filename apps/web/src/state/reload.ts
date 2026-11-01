import { isKeptFile, readOnlyFiles } from '../input/filter';
import type { Walked } from '../input/limits';
import { asWritten, type FileMeta, textMeta } from '../input/read';
import type { Choices, DiskConflict, DiskFile } from '../input/save';
import type { SessionState } from './store';

/**
 * Reload from disk, file by file (synthesis § 5.7): a file the folder still holds as it was read or last saved keeps
 * the author's text, edits and all; a file the folder changed takes the folder's text when the author has not edited
 * it; a file both changed is a conflict, settled with the choices of § 5.4. What is taken is one undoable `disk`
 * transaction, and the base of every file the folder changed moves to the folder's text, so the next save compares
 * with what the folder holds. The tests' snapshots are read-only: the folder's replace the page's, whatever they were.
 * Nothing reloads by itself.
 */

/** What a reload takes in, before the author settles its conflicts. */
export interface ReloadPlan {
  /** Per path the folder changed since it was read or last saved: its file now, or `null` when it is gone. */
  disk: Record<string, DiskFile | null>;
  /** The paths that take the folder's text: not edited here, or edited into the folder's very text. */
  take: string[];
  /** The paths both the folder and the author changed. */
  conflicts: DiskConflict[];
  /** Per path of `disk`, the author's text the plan was made over (`null`: none), so a take refuses a text moved since. */
  from: Record<string, string | null>;
  /** The snapshots the folder holds now, which replace the page's (`files.readonly`). */
  readonly: Record<string, string>;
}

type Files = Pick<SessionState['files'], 'byPath' | 'base' | 'meta'>;

/**
 * Compares the folder as read again with the files. The paths are the folder's files and the page's (project files
 * and route tests); a file the walk left out for its size is not taken for gone.
 */
export function reloadPlan(files: Files, read: Pick<Walked, 'files' | 'meta' | 'skipped'>): ReloadPlan {
  const plan: ReloadPlan = {
    disk: {},
    take: [],
    conflicts: [],
    from: {},
    readonly: readOnlyFiles(read.files),
  };
  const left = new Set(read.skipped.map((s) => s.path));
  const here = [...Object.keys(files.base), ...Object.keys(files.byPath)].filter(
    (p) => isKeptFile(p) && !left.has(p),
  );
  const there = Object.keys(read.files).filter(isKeptFile);
  for (const path of new Set([...there, ...here].sort())) {
    const text = read.files[path];
    const disk = text === undefined ? undefined : { text, meta: read.meta[path] ?? textMeta(text) };
    const base = files.base[path];
    if (unchanged(disk, base, files.meta[path])) continue;
    plan.disk[path] = disk ?? null;
    const mine = files.byPath[path];
    plan.from[path] = mine ?? null;
    if (mine === base || alike(mine, files.meta[path], disk)) plan.take.push(path);
    else plan.conflicts.push(conflictOf(path, mine, base, disk));
  }
  return plan;
}

/** A file both sides changed: gone from the folder, created on both sides, or changed on both. */
function conflictOf(
  path: string,
  mine: string | undefined,
  base: string | undefined,
  disk: DiskFile | undefined,
): DiskConflict {
  const reason = disk === undefined ? 'deleted-on-disk' : base === undefined ? 'exists' : 'changed-on-disk';
  const conflict: DiskConflict = { path, reason };
  if (mine !== undefined) conflict.mine = mine;
  if (base !== undefined) conflict.base = base;
  if (disk) conflict.disk = disk;
  return conflict;
}

/** Whether the author's text, written, is the folder's file: edited into the folder's very bytes. */
const alike = (mine: string | undefined, meta: FileMeta | undefined, disk: DiskFile | undefined): boolean =>
  mine !== undefined &&
  disk !== undefined &&
  disk.meta.utf8 &&
  asWritten(mine, meta) === asWritten(disk.text, disk.meta);

/**
 * Whether the folder still holds the file as it was read or last saved: its text as written, BOM in front, and its
 * encoding.
 */
function unchanged(
  disk: DiskFile | undefined,
  base: string | undefined,
  meta: FileMeta | undefined,
): boolean {
  if (disk === undefined || base === undefined) return disk === undefined && base === undefined;
  return asWritten(disk.text, disk.meta) === asWritten(base, meta) && disk.meta.utf8 === meta?.utf8;
}

/**
 * What the reload does once the author chose: `disk` takes the folder's text; `mine` keeps the author's text over the
 * folder's new base, so the next save writes it without asking; `skip` leaves the file as it was, base and all, so the
 * next save asks again. A conflict with no choice is skipped.
 */
export function settledReload(
  plan: ReloadPlan,
  choices: Choices,
): Pick<ReloadPlan, 'disk' | 'take' | 'from'> {
  const disk = { ...plan.disk };
  const take = [...plan.take];
  for (const { path } of plan.conflicts) {
    const choice = choices[path]?.choice;
    if (choice === 'disk') take.push(path);
    else if (choice !== 'mine') delete disk[path];
  }
  return { disk, take, from: plan.from };
}
