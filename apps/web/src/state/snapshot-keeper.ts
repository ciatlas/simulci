import { fileLabel } from '../lib/file-label';
import { type BehindOptions, behind } from './behind';
import {
  clockOf,
  type EditsSnapshot,
  keepsSnapshot,
  restorePlan,
  type SnapshotStore,
  snapshotOf,
  withConflicts,
} from './snapshot';
import { dirtyPaths, type SessionState, type SessionStore } from './store';

/**
 * Keeps the crash snapshot of a folder's or a GitHub repository's edits (`state/snapshot.ts`): written behind the edits (`state/behind.ts`),
 * at once after a save (the base moves, the version does not), and dropped once nothing is unsaved, or once the author
 * lets the edits go by replacing the folder (the replace
 * prompt asked first) or forgetting it. When a folder's files come in, the snapshot that belongs to them comes back
 * first: the writer waits while it loads, and while conflicts wait it writes their kept texts with the new edits.
 */
export interface SnapshotKeeper {
  /** A write waits or runs: leaving the page now could lose the last edits. */
  pending(): boolean;
  flush(): Promise<void>;
  dispose(): void;
}

export interface SnapshotKeeperOptions extends BehindOptions {
  store: SessionStore;
  snapshots: SnapshotStore;
  now?: () => number;
}

export function createSnapshotKeeper({
  store,
  snapshots,
  now = Date.now,
  ...options
}: SnapshotKeeperOptions): SnapshotKeeper {
  /** The restore under way, by the epoch it is for; a newer one makes an older one moot. */
  let restoring: number | undefined;
  /** The snapshot restored, while conflicts of it wait to be settled. */
  let kept: EditsSnapshot | undefined;

  const writer = behind(() => {
    const s = store.getState();
    if (!keepsSnapshot(s.source) || restoring !== undefined) return undefined;
    const conflicts = s.edit.restore?.conflicts ?? [];
    const at = now();
    const snapshot = kept ? withConflicts(snapshotOf(s, at), kept, conflicts, at) : snapshotOf(s, at);
    return snapshot ? snapshots.save(snapshot, s.source) : snapshots.drop(s.source);
  }, options);

  /** The snapshot's files that come back by themselves as one entry, the others for the author to settle. */
  const apply = (snapshot: EditsSnapshot): void => {
    const a = store.getState();
    const plan = restorePlan(snapshot, a.files);
    const n = plan.files.length;
    if (n > 0 && a.transact({ label: 'Restored unsaved edits', origin: 'restore', files: plan.files }).ok)
      a.notify(
        `Restored unsaved edits to ${n} ${n === 1 ? 'file' : 'files'} from ${clockOf(snapshot.at)} · undo starts here`,
      );
    if (plan.kept.length > 0)
      a.notify(
        `Not removed again, since each changed after it was removed: ${plan.kept.map(fileLabel).join(', ')}`,
      );
    if (plan.conflicts.length > 0) {
      kept = snapshot;
      a.offerRestore({ at: snapshot.at, conflicts: plan.conflicts });
    }
  };

  const restore = async (epoch: number, after: Promise<void>): Promise<void> => {
    restoring = epoch;
    try {
      await after;
      const snapshot = await snapshots.find(store.getState().source);
      if (snapshot && store.getState().files.epoch === epoch) apply(snapshot);
    } finally {
      if (restoring === epoch) {
        restoring = undefined;
        // Edits made while the restore loaded were not written: write them now. With none, nothing is written.
        if (dirtyPaths(store.getState().files).length > 0) writer.call();
      }
    }
  };

  /** New files: the old ones' snapshot goes if their edits were let go, and the new ones' comes back. */
  const onEpoch = (s: SessionState, prev: SessionState): void => {
    writer.cancel();
    restoring = undefined;
    kept = undefined;
    const gone = letGo(prev) ? writer.run(() => snapshots.drop(prev.source)) : Promise.resolve();
    if (keepsSnapshot(s.source) && Object.keys(s.files.byPath).length > 0) void restore(s.files.epoch, gone);
  };

  const unsubscribe = store.subscribe((s, prev) => {
    if (s.files.epoch !== prev.files.epoch) return onEpoch(s, prev);
    // A conflict settled: the snapshot keeps the others' texts only.
    const settled = prev.edit.restore !== undefined && s.edit.restore !== prev.edit.restore;
    if (prev.edit.restore !== undefined && s.edit.restore === undefined) kept = undefined;
    if (s.files.version !== prev.files.version || settled) writer.call();
    // A save moved the base: the saved files leave the snapshot now, and with nothing unsaved it goes.
    if (s.files.base !== prev.files.base) {
      writer.call();
      void writer.flush();
    }
  });

  return {
    pending: () => writer.pending(),
    flush: () => writer.flush(),
    dispose: () => {
      unsubscribe();
      writer.dispose();
    },
  };
}

/** Whether a new epoch let a folder's or a repository's unsaved edits go: the prompt asked first, and the author chose to. */
const letGo = (prev: SessionState): boolean =>
  keepsSnapshot(prev.source) && dirtyPaths(prev.files).length > 0;
