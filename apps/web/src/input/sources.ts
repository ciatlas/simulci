import { type Dialogs, loadDialogs } from '../app/dialogs-load';
import { downloadText } from '../lib/download';
import { fileLabel } from '../lib/file-label';
import type { SourceStore, StoredSource } from '../state/persist';
import type { ReloadPlan } from '../state/reload';
import { type BaseDiff, dirtyPaths, type SessionStore, type Settling, type Source } from '../state/store';
import { type Dropped, filesFromDrop } from './drop';
import { filterFiles, isProjectFile, snapshotFiles } from './filter';
import { canPickFolder, canReadFolder, pickFolder, readFolder, requestFolder } from './folder';
import { leftOut, overLimit, type Skipped, type Walked } from './limits';
import { checkPaste, type PasteCheck } from './paste';
import { filesFromList } from './picker';
import { asWritten, type FileMeta } from './read';
import { sampleByName } from './samples';
import type { Choices, DiskConflict } from './save';

/**
 * Every way files come in ends in `setFiles` after the filter and the limits, and in the source store so a reload
 * finds them again. Failures are the `source` error of the store; a cancelled picker is nothing; files a walk left
 * out for their size are a notice. Files with unsaved edits are never replaced unasked (synthesis § 5.7): opening a
 * folder or a sample, choosing or dropping files, a paste over an edited buffer and Forget first ask the author, who
 * can save them to the folder, download them (each, or as one patch), let them go, or keep them. Reload replaces
 * nothing: it merges the folder into the files one by one (`state/reload.ts`). The tests' snapshots a walk read go
 * apart, read-only (`files.readonly`); Reload reads them again.
 */
export interface Sources {
  canPickFolder: boolean;
  openFolder(): Promise<void>;
  chooseFiles(list: ArrayLike<File>): Promise<void>;
  drop(transfer: DataTransfer): Promise<void>;
  paste(path: string, text: string): Pasted;
  removeBuffer(path: string): void;
  useSample(name: string): void;
  /**
   * Reads an opened folder again and takes in what changed on disk, file by file, as one undoable entry; the files
   * both sides changed are the author's to settle. Says so when nothing changed.
   */
  reload(): Promise<void>;
  /** Asks for the stored folder again; must run in a click. */
  reopen(): Promise<void>;
  forget(): Promise<void>;
  /** What the last visit left in IndexedDB, unless the author has chosen a source by the time it is read. */
  restore(): Promise<void>;
}

/**
 * What the author answered the replace prompt: save the edited files to the folder first, or download them, each or
 * as one patch; let them go; or keep them.
 */
export type ReplaceChoice = 'save' | 'download' | 'patch' | 'discard' | 'cancel';

/** A paste the files took, once the replace prompt (if it asked) is answered: `done` is false when it was cancelled. */
export type Pasted = { ok: true; path: string; done: Promise<boolean> } | Extract<PasteCheck, { ok: false }>;

export interface SourcesOptions {
  store: SessionStore;
  persist: SourceStore;
  /**
   * Asks before files with unsaved edits are replaced, naming what would replace them and the files it would drop;
   * absent, nothing asks.
   */
  ask?: (what: string, paths: readonly string[]) => Promise<ReplaceChoice>;
  /** Hands files to the browser to save; one call per file, or one for the patch. */
  download?: (name: string, text: string) => void;
  /** Saves the edits to the folder (`app/saver.ts`), for the prompt's Save: true once nothing is unsaved. */
  save?: () => Promise<boolean>;
  /** Asks the author to settle the files both the folder and the page changed; `undefined` when they cancelled. */
  settle?: (
    mode: Settling['mode'],
    folder: string,
    conflicts: DiskConflict[],
  ) => Promise<Choices | undefined>;
  /** Fetches the dialogs chunk, which makes the patch and merges a reload (`app/dialogs-load.ts`). */
  load?: () => Promise<Pick<Dialogs, 'downloadPatch' | 'reloadPlan' | 'settledReload'>>;
}

const downloadFile = (name: string, text: string): void =>
  downloadText(name, text, name.endsWith('.patch') ? 'text/x-diff' : 'application/yaml');

const LOOKED_FOR = 'looked for .github/workflows/*.yml, .github/actions/**/action.yml and action.yml';

/**
 * What a way in brought: the files, what reading them found (none for strings), the files it left out, and for
 * buffers that keep their edits the texts those were made to.
 */
type Brought = Pick<Walked, 'files'> &
  Partial<Pick<Walked, 'meta' | 'skipped'>> & { base?: BaseDiff; readonly?: Record<string, string> };

export function createSources({
  store,
  persist,
  ask,
  download = downloadFile,
  save,
  settle,
  load = loadDialogs,
}: SourcesOptions): Sources {
  const actions = store.getState();

  /**
   * Whether the files may give way to `what`: at once when no edit would be lost, which keeps a picker in the click
   * that opened it; else once the author said so, having downloaded the edited files if they chose to. `kept` are the
   * edited paths that survive the replacement (a paste of another buffer keeps the others, whose texts carry their
   * edits).
   */
  const mayReplace = (what: string, kept: ReadonlySet<string> = new Set()): true | Promise<boolean> => {
    const lost = dirtyPaths(store.getState().files).filter((p) => !kept.has(p));
    if (lost.length === 0 || !ask) return true;
    return ask(what, lost).then((choice) => {
      // The files go only once every edit is in the folder: a save that stopped, met an edit typed meanwhile, or kept
      // the folder's version of a file (the author's text then lives only in the history the replacement clears)
      // keeps them all.
      if (choice === 'save') return save?.() ?? false;
      if (choice === 'download') downloadAll(lost);
      if (choice === 'patch') return downloadPatch(lost);
      return choice !== 'cancel';
    });
  };

  /**
   * One patch of the files' edits, made by the dialogs chunk: true once it is handed over; false, which keeps the
   * files, when the chunk could not be fetched.
   */
  const downloadPatch = (paths: readonly string[]): Promise<boolean> => {
    const { files } = store.getState();
    return load().then(
      (dialogs) => {
        dialogs.downloadPatch(files, paths, 'base', download);
        return true;
      },
      () => {
        actions.notify('The patch could not be made, so nothing was replaced: try again');
        return false;
      },
    );
  };

  const downloadAll = (paths: readonly string[]): void => {
    const { files } = store.getState();
    for (const path of paths) {
      const text = files.byPath[path];
      if (text !== undefined)
        download(path.slice(path.lastIndexOf('/') + 1), asWritten(text, files.meta[path]));
    }
  };

  /** `act` once the files may give way, at once when nothing would be lost; whether it did. */
  const thenReplace = (go: true | Promise<boolean>, act: () => void): Promise<boolean> => {
    if (go === true) {
      act();
      return Promise.resolve(true);
    }
    return go.then((yes) => {
      if (yes) act();
      return yes;
    });
  };

  /** The buffers' paths that a paste or a drop leaves standing, edits and all: the ones it does not overwrite. */
  const keptBuffers = (overwritten: ReadonlySet<string>): Set<string> =>
    new Set(
      buffersOf()
        .map((b) => b.path)
        .filter((p) => !overwritten.has(p)),
    );

  const fail = (message: string): void => actions.rejected({ kind: 'source', message });

  /** Why a source brought nothing: no project file at all, or only ones too big to read. */
  const nothingIn = (where: string, skipped: Skipped[], none: string): string =>
    skipped.length ? `nothing in ${where} fits: ${leftOut(skipped)}` : none;

  const tellLeftOut = (where: string, skipped: Skipped[]): void => {
    if (skipped.length) actions.notify(`${where}: ${leftOut(skipped)}`);
  };

  const accept = (
    { files, meta, skipped = [], base, readonly = snapshotFiles(files) }: Brought,
    source: Source,
    where: string,
  ): boolean => {
    // Route tests are kept beside the project, but a source of tests alone has nothing to simulate.
    const kept = filterFiles(files);
    if (!Object.keys(kept).some(isProjectFile)) {
      fail(nothingIn(where, skipped, `no workflow files in ${where}: ${LOOKED_FOR}`));
      return false;
    }
    const limit = overLimit({ ...kept, ...readonly });
    if (limit) {
      fail(`${where} is too big: ${limit}`);
      return false;
    }
    actions.setFiles(kept, source, meta, base, readonly);
    tellLeftOut(where, skipped);
    const now = store.getState().files;
    void persist.save(source, kept, now.meta, now.base, now.readonly);
    return true;
  };

  const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  const guarded = async (work: () => Promise<void>): Promise<void> => {
    try {
      await work();
    } catch (e) {
      fail(messageOf(e));
    }
  };

  const filesOf = (buffers: { path: string; text: string }[]): Record<string, string> => {
    const files: Record<string, string> = {};
    for (const b of buffers) files[b.path] = b.text;
    return filterFiles(files);
  };

  const buffersOf = (): { path: string; text: string }[] => {
    const s = store.getState();
    return s.source.kind === 'paste' ? s.source.buffers : [];
  };

  /** What the store holds about these buffers, so a paste or a removal keeps what a drop read of the others. */
  const metaOf = (buffers: { path: string }[]): Record<string, FileMeta> => {
    const { meta } = store.getState().files;
    const kept: Record<string, FileMeta> = {};
    for (const { path } of buffers) {
      const m = meta[path];
      if (m) kept[path] = m;
    }
    return kept;
  };

  /** The texts the edits of these buffers were made to, so a paste or a drop beside them leaves them unsaved. */
  const baseOf = (buffers: { path: string }[]): BaseDiff | undefined => {
    const { byPath, base } = store.getState().files;
    const diff: BaseDiff = {};
    for (const { path } of buffers) {
      const text = byPath[path];
      if (text !== undefined && base[path] !== text) diff[path] = base[path] ?? null;
    }
    return Object.keys(diff).length > 0 ? diff : undefined;
  };

  /** The pasted buffers as a source, still named for the sample they are an edited copy of, if they are. */
  const pasted = (buffers: { path: string; text: string }[]): Source => {
    const { source } = store.getState();
    return source.kind === 'paste' && source.name !== undefined
      ? { kind: 'paste', buffers, name: source.name }
      : { kind: 'paste', buffers };
  };

  /** `base` keeps the edits of the buffers already there unsaved; the others are new, as pasted or dropped. */
  const setBuffers = (
    buffers: { path: string; text: string }[],
    meta = metaOf(buffers),
    base = baseOf(buffers),
  ): boolean => {
    if (buffers.length === 0) {
      actions.forgetSource();
      void persist.clear();
      return true;
    }
    return accept({ files: filesOf(buffers), meta, base }, pasted(buffers), 'the pasted files');
  };

  /** Dropped files with no folder among them join the pasted buffers, replacing a buffer at the same path. */
  const dropLoose = ({ files, meta, skipped }: Dropped): void => {
    if (Object.keys(files).length === 0) {
      fail(nothingIn('the drop', skipped, `nothing in the drop is a workflow file: ${LOOKED_FOR}`));
      return;
    }
    const buffers = buffersOf().filter((b) => !(b.path in files));
    const read = { ...metaOf(buffers), ...meta };
    const base = baseOf(buffers);
    for (const [path, text] of Object.entries(files)) buffers.push({ path, text });
    if (setBuffers(buffers, read, base)) tellLeftOut('the drop', skipped);
  };

  /** A stored folder's files, after the permission the browser needs; `undefined` once the failure is reported. */
  const readAgain = async (source: Source, orElse: string): Promise<Walked | undefined> => {
    if (source.kind !== 'folder' || !source.handle) return undefined;
    if (!(await canReadFolder(source.handle)) && !(await requestFolder(source.handle))) {
      fail(`reading ${source.name} is not allowed any more; ${orElse}`);
      return undefined;
    }
    return readFolder(source.handle);
  };

  /**
   * A folder handle from the last visit: read now when the browser remembered the permission, else offered. One
   * that no longer reads is reported and forgotten, so the next visit does not fail on it again.
   */
  const restoreFolder = async (
    name: string,
    handle: FileSystemDirectoryHandle,
    untouched: () => boolean,
  ): Promise<void> => {
    const source: Source = { kind: 'folder', name, handle, readAt: 0 };
    const granted = await canReadFolder(handle);
    if (!untouched()) return;
    if (!granted) {
      // Not yet: the screen offers "Reopen <name>"; the scenario from the URL waits for the files.
      actions.awaitReopen(source);
      return;
    }
    let read: Walked;
    try {
      read = await readFolder(handle);
    } catch (e) {
      if (!untouched()) return;
      fail(`reading ${name} failed: ${messageOf(e)}`);
      await persist.clear();
      return;
    }
    if (!untouched()) return;
    if (!accept(read, { ...source, readAt: Date.now() }, `the folder ${name}`)) await persist.clear();
  };

  /**
   * The folder read again, merged into the files (`state/reload.ts`, in the dialogs chunk with the conflicts dialog):
   * the files both sides changed wait for the author's choices, and Cancel leaves everything as it was.
   */
  const merge = async (name: string, epoch: number, read: Walked): Promise<void> => {
    const where = `the folder ${name}`;
    const limit = overLimit(read.files);
    if (limit) return fail(`${where} is too big: ${limit}`);
    const code = await load().catch(() => undefined);
    if (!code) return fail(`reloading ${name} stopped: the page could not fetch the merge; reload again`);
    if (store.getState().files.epoch !== epoch) return;
    const plan = code.reloadPlan(store.getState().files, read);
    const before = store.getState().files.readonly;
    actions.setReadonly(epoch, plan.readonly);
    const snapshots = store.getState().files.readonly !== before;
    if (Object.keys(plan.disk).length === 0)
      actions.notify(`${name}: ${snapshots ? 'only snapshots changed' : 'no changes'}`);
    else if (!(await takeIn(name, epoch, plan, code))) return;
    tellLeftOut(where, read.skipped);
  };

  /**
   * The reload's plan taken in once the author chose for the files both sides changed (without anyone to ask, they
   * stay as they are); false when nothing was taken: cancelled, new files, a save meanwhile, or a text moved since.
   */
  const takeIn = async (
    name: string,
    epoch: number,
    plan: ReloadPlan,
    code: Pick<Dialogs, 'settledReload'>,
  ): Promise<boolean> => {
    const { base } = store.getState().files;
    const asking = plan.conflicts.length > 0 && settle;
    const choices = asking ? await settle('reload', name, plan.conflicts) : {};
    const now = store.getState().files;
    if (!choices || now.epoch !== epoch) return false;
    if (now.base !== base) {
      fail(`reloading ${name} stopped: the files were saved meanwhile`);
      return false;
    }
    const { disk, take, from } = code.settledReload(plan, choices);
    const outcome = actions.fromDisk(epoch, `Reloaded ${name}`, disk, take, from);
    if (outcome.ok || !outcome.refusal) return true;
    fail(`reloading ${name} stopped: ${fileLabel(outcome.refusal.path)} changed meanwhile`);
    return false;
  };

  /** What the last visit stored, set again; a kind this page does not know is nothing stored. */
  const restoreStored = async (stored: StoredSource, untouched: () => boolean): Promise<void> => {
    switch (stored.kind) {
      case 'sample': {
        const sample = sampleByName(stored.name);
        if (sample) actions.setFiles(sample.files, { kind: 'sample', name: stored.name });
        break;
      }
      case 'paste': {
        if (!stored.buffers.length) break;
        const source: Source = { kind: 'paste', buffers: stored.buffers };
        if (typeof stored.name === 'string') source.name = stored.name;
        actions.setFiles(filesOf(stored.buffers), source, stored.meta, stored.base);
        break;
      }
      case 'copy':
        actions.setFiles(
          filesOf(stored.buffers),
          { kind: 'folder', name: stored.name, readAt: 0 },
          stored.meta,
          undefined,
          stored.readonly,
        );
        break;
      case 'folder':
        await restoreFolder(stored.name, stored.handle, untouched);
        break;
    }
  };

  return {
    canPickFolder: canPickFolder(),

    openFolder: () =>
      guarded(async () => {
        const go = mayReplace('Opening another folder');
        if (go !== true && !(await go)) return;
        let picked: Awaited<ReturnType<typeof pickFolder>>;
        try {
          picked = await pickFolder();
        } catch (e) {
          // The picker opens only right after a click, and a save or the prompt may have taken longer.
          if (go === true || !(e instanceof DOMException) || e.name !== 'SecurityError') throw e;
          actions.notify(
            'Choose Open folder again: the browser opens its folder picker only right after a click.',
          );
          return;
        }
        if (!picked) return;
        accept(
          picked,
          { kind: 'folder', name: picked.name, handle: picked.handle, readAt: Date.now() },
          `the folder ${picked.name}`,
        );
      }),

    chooseFiles: (list) =>
      guarded(async () => {
        const picked = await filesFromList(list);
        const name = picked.name ?? 'the chosen files';
        if (!(await mayReplace(`Opening ${name}`))) return;
        accept(picked, { kind: 'folder', name, readAt: Date.now() }, name);
      }),

    drop: (transfer) =>
      guarded(async () => {
        const dropped = await filesFromDrop(transfer);
        if (dropped.name === undefined) {
          const overwritten = new Set(Object.keys(dropped.files));
          if (await mayReplace('Opening the dropped files', keptBuffers(overwritten))) dropLoose(dropped);
          return;
        }
        if (!(await mayReplace(`Opening ${dropped.where}`))) return;
        const source: Source = { kind: 'folder', name: dropped.name, readAt: Date.now() };
        if (dropped.handle) source.handle = dropped.handle;
        accept(dropped, source, dropped.where);
      }),

    paste: (path, text) => {
      const check = checkPaste(path, text);
      if (!check.ok) return check;
      const buffers = buffersOf().filter((b) => b.path !== check.path);
      const meta = metaOf(buffers);
      const base = baseOf(buffers);
      buffers.push({ path: check.path, text });
      const done = thenReplace(mayReplace(`Pasting ${check.path}`, keptBuffers(new Set([check.path]))), () =>
        setBuffers(buffers, meta, base),
      );
      return { ...check, done };
    },

    removeBuffer: (path) => setBuffers(buffersOf().filter((b) => b.path !== path)),

    useSample: (name) => {
      const sample = sampleByName(name);
      if (!sample) return fail(`no sample named ${name}`);
      void thenReplace(mayReplace(`Opening the ${name} sample`), () =>
        accept({ files: sample.files }, { kind: 'sample', name }, `the sample ${name}`),
      );
    },

    reload: () =>
      guarded(async () => {
        const s = store.getState();
        if (s.source.kind !== 'folder') return;
        const epoch = s.files.epoch;
        // A save that moves the base while the folder is read leaves the read behind the base: it is read again.
        for (let tries = 0; tries < 3; tries++) {
          const { base } = store.getState().files;
          const read = await readAgain(s.source, 'open it again');
          if (!read || store.getState().files.epoch !== epoch) return;
          if (store.getState().files.base === base) return merge(s.source.name, epoch, read);
        }
        fail(`reloading ${s.source.name} stopped: the files were saved while it read them; reload again`);
      }),

    reopen: () =>
      guarded(async () => {
        const s = store.getState();
        if (s.source.kind !== 'folder') return;
        const read = await readAgain(s.source, 'choose it again');
        if (read) accept(read, { ...s.source, readAt: Date.now() }, `the folder ${s.source.name}`);
      }),

    forget: async () => {
      const { source } = store.getState();
      if (!(await mayReplace(`Forgetting ${source.kind === 'folder' ? source.name : 'these files'}`))) return;
      actions.forgetSource();
      await persist.clear();
    },

    restore: () =>
      guarded(async () => {
        const at = store.getState().files.version;
        const untouched = (): boolean => {
          const s = store.getState();
          return s.source.kind === 'none' && s.files.version === at;
        };
        const stored = await persist.load();
        if (stored && untouched()) await restoreStored(stored, untouched);
      }),
  };
}
