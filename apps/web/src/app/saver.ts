import type { Choices, DirectoryLike, DiskConflict } from '../input/save';
import { githubNote } from '../lib/repo-words';
import { dirtyPaths, type SessionState, type SessionStore, type Settling } from '../state/store';
import { type Dialogs, loadDialogs } from './dialogs-load';
import { targetsOf } from './save-targets';

/**
 * Save (synthesis § 5.3): the top bar's Save, Mod+S and the replace prompt's Save run it, in the click or the key, since
 * write access is asked for first and the browser grants it only within the gesture. The run that checks and writes
 * the files (`app/save-run.ts`) is in the dialogs chunk, fetched right after that question; the saver keeps one save
 * at a time and the conflicts dialog's question. Only a folder opened with a handle saves: a paste, a sample, a copy
 * of a folder or a GitHub repository (read-only to GitHub, M4 § 5.7) downloads (§ 5.5), and the first edit of a copy or
 * of a repository says so once.
 */
export interface Saver {
  /**
   * Saves every unsaved file to the folder; a save of these files under way is the one returned. True once every edit
   * is in the folder (none settled by keeping the folder's version). Call it in the gesture, before anything is awaited.
   */
  save(): Promise<boolean>;
  /** Shows the conflicts of a save or a reload; the choices, one per file, or `undefined` when the author cancelled. */
  settle(mode: Settling['mode'], folder: string, conflicts: DiskConflict[]): Promise<Choices | undefined>;
  /** The conflicts dialog's answer; one for an older question than `seq` is no answer. */
  answer(choices: Choices | undefined, seq?: number): void;
  dispose(): void;
}

/** What a save's run works with: the store, the folder it writes to, and the files' epoch it is for. */
export interface SaveContext {
  store: SessionStore;
  now: () => number;
  settle: Saver['settle'];
  root: DirectoryLike;
  folder: string;
  epoch: number;
}

/** Whether the files can be saved where they came from: a folder opened with a handle. */
export const canSave = (s: Pick<SessionState, 'source'>): boolean =>
  s.source.kind === 'folder' && s.source.handle !== undefined;

/** The note the first edit of a folder's copy gets (§ 5.5). */
export const COPY_NOTE = 'This folder was opened as a copy; Open folder (Chromium) saves in place.';

interface PermissionHandle {
  requestPermission?(d: { mode: 'readwrite' }): Promise<PermissionState>;
}

/** Asks for write access; a handle that cannot be asked is taken as allowed, and its writes say otherwise. */
const requestWrite = (handle: PermissionHandle): Promise<boolean> =>
  handle.requestPermission
    ? handle.requestPermission({ mode: 'readwrite' }).then(
        (state) => state === 'granted',
        () => false,
      )
    : Promise.resolve(true);

/** The save under way, and the files it is for: a save of other files is another save. */
interface Running {
  epoch: number;
  done: Promise<boolean>;
}

export function createSaver({
  store,
  now = Date.now,
  load = loadDialogs,
}: {
  store: SessionStore;
  now?: () => number;
  load?: () => Promise<Pick<Dialogs, 'runSave'>>;
}): Saver {
  let running: Running | undefined;
  /** The last save started: a save of new files waits until it has stopped, so two saves never write at once. */
  let last: Promise<unknown> = Promise.resolve();
  let open: ((choices: Choices | undefined) => void) | undefined;
  let seq = 0;
  let noted = false;

  const answer = (choices: Choices | undefined, asked = seq): void => {
    if (asked !== seq) return;
    const resolve = open;
    open = undefined;
    store.getState().setSettling(undefined);
    resolve?.(choices);
  };

  const settle: Saver['settle'] = (mode, folder, conflicts) => {
    open?.(undefined);
    store.getState().setSettling({ seq: ++seq, mode, folder, conflicts });
    return new Promise((resolve) => {
      open = resolve;
    });
  };

  /** A run that could not be fetched writes nothing, and the status line says so. */
  const unfetched = (folder: string): boolean => {
    const sentence = `Saving to ${folder} stopped: the page could not fetch the save; nothing was written`;
    store.getState().setSaving({ status: 'done', folder, at: now(), files: [], sentence, open: false });
    return false;
  };

  const save = (): Promise<boolean> => {
    const s = store.getState();
    if (s.source.kind !== 'folder' || !s.source.handle) return Promise.resolve(false);
    const epoch = s.files.epoch;
    if (running?.epoch === epoch) return running.done;
    const { targets, removed } = targetsOf(s.files);
    const root = s.source.handle as unknown as DirectoryLike & PermissionHandle;
    const context: SaveContext = { store, now, settle, root, folder: s.source.name, epoch };
    // First, while the gesture's activation lasts; a save that writes nothing asks for nothing. Then the run, from
    // the dialogs chunk, which nothing before the question may wait for.
    const asked = targets.length > 0 ? requestWrite(root) : Promise.resolve(true);
    const code = load();
    const run = (): Promise<boolean> =>
      code.then(
        (c) => c.runSave(context, asked),
        () => unfetched(context.folder),
      );
    // Nothing to write: the report at once, behind no other save.
    if (targets.length === 0 && removed.length === 0) return run();
    s.setSaving({ status: 'running', folder: context.folder });
    // A save of the files before stops at its next write (`alive`); this one writes once it has.
    const done: Promise<boolean> = last.then(run).finally(() => {
      if (running?.done === done) running = undefined;
    });
    running = { epoch, done };
    last = done.catch(() => undefined);
    return done;
  };

  const unsubscribe = store.subscribe((s, prev) => {
    // New files: the conflicts asked about are not theirs.
    if (s.files.epoch !== prev.files.epoch && open) answer(undefined);
    const note = !noted && s.files.version !== prev.files.version ? editNote(s) : undefined;
    if (note) {
      noted = true;
      s.notify(note);
    }
  });

  return { save, settle, answer, dispose: unsubscribe };
}

/** What the first edit of a source that cannot be saved in place says: a folder's copy, or a GitHub repository. */
function editNote(s: SessionState): string | undefined {
  if (dirtyPaths(s.files).length === 0) return undefined;
  if (s.source.kind === 'github') return githubNote(s.source);
  return s.source.kind === 'folder' && !s.source.handle ? COPY_NOTE : undefined;
}
