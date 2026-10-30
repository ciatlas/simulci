import { regionEdit } from '@simulci/document/edits';
import { asWritten } from '../input/read';
import { downloadText } from '../lib/download';
import { fileLabel } from '../lib/file-label';
import { type PatchFile, patchOf } from '../lib/patch';
import { patchName, patchPreamble } from '../lib/repo-words';
import { stampOf, type TxFile, type TxInput } from './history';
import { dirtyPaths, type SessionState, type Source } from './store';

/**
 * What the files changed since a point (synthesis § 5.2): the last save (`base`, what "unsaved" means) or the start
 * of the epoch (`opened`, "changes since open", which a save does not clear). The Changes dialog and the replace
 * prompt read them; a revert is an undoable transaction back to that point.
 */

export type Since = 'base' | 'opened';

type Files = Pick<SessionState['files'], 'byPath' | 'meta' | 'base' | 'opened'>;

/** The files whose text is not the one they had then: edited, created since, or removed since. */
export const changedPaths = (files: Files, since: Since): string[] =>
  dirtyPaths({ byPath: files.byPath, base: files[since] }).sort();

/** Each file's text then and now as a file holds them, its BOM put back: what a patch compares. */
export const patchFiles = (files: Files, paths: readonly string[], since: Since): PatchFile[] =>
  paths.map((path) => {
    const before = files[since][path];
    const after = files.byPath[path];
    const meta = files.meta[path];
    return {
      path,
      before: before === undefined ? undefined : asWritten(before, meta),
      after: after === undefined ? undefined : asWritten(after, meta),
    };
  });

/**
 * Hands the patch of the files' changes to the browser to save, one download whatever the count: named for the
 * source (`octo-ship-3f2a9c1.patch` for a GitHub repository, with a first line naming the commit; else
 * `simulci-changes.patch`).
 */
export function downloadPatch(
  files: Files,
  paths: readonly string[],
  since: Since,
  source: Source,
  download: (name: string, text: string) => void = (name, text) => downloadText(name, text, 'text/x-diff'),
): void {
  download(patchName(source), patchOf(patchFiles(files, paths, since), patchPreamble(source)));
}

/**
 * The transaction that puts a file back to its text then: one region edit, the removal of a file created since, or
 * the creation of one removed since. Nothing when it has that text.
 */
export function revertOf(files: Files, path: string, since: Since): TxInput | undefined {
  const then = files[since][path];
  const now = files.byPath[path];
  if (then === now) return undefined;
  let file: TxFile;
  if (now === undefined) file = { path, edits: [{ from: 0, to: 0, insert: then! }], create: true };
  else if (then === undefined) file = { path, edits: [], remove: true, expect: stampOf(now) };
  else file = { path, edits: [regionEdit(now, then)], expect: stampOf(now) };
  return { label: `Reverted ${fileLabel(path)}`, origin: 'revert', files: [file] };
}
