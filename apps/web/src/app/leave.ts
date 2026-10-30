import { keepsSnapshot } from '../state/snapshot';
import { dirtyPaths, type SessionStore } from '../state/store';

/**
 * Leaving the page asks first while a folder (or a copy of one) or a GitHub repository has unsaved edits, or while edited buffers are still
 * to be written (synthesis § 5.7): the crash snapshot keeps a folder's edits too, but a closed tab should not need it.
 * The listener is there only while it is needed, since a `beforeunload` listener keeps some browsers from keeping
 * the page in their back-forward cache. It also starts the writes that wait: one started in `pagehide` does not
 * finish before the page goes (Chromium), one started here does, while the browser asks.
 */
export function installLeaveGuard({
  store,
  pending,
  flush,
  win = window,
}: {
  store: SessionStore;
  /** A write of the edits to IndexedDB waits or runs. */
  pending: () => boolean;
  /** Starts the writes that wait. */
  flush: () => void;
  win?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}): () => void {
  const needed = (): boolean => {
    const s = store.getState();
    return (keepsSnapshot(s.source) && dirtyPaths(s.files).length > 0) || pending();
  };
  const onBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (!needed()) return;
    flush();
    event.preventDefault();
    // Older browsers ask only when the event carries a value.
    event.returnValue = '';
  };
  let installed = false;
  const sync = (): void => {
    const want = needed();
    if (want === installed) return;
    installed = want;
    if (want) win.addEventListener('beforeunload', onBeforeUnload);
    else win.removeEventListener('beforeunload', onBeforeUnload);
  };
  const unsubscribe = store.subscribe(sync);
  sync();
  return () => {
    unsubscribe();
    if (installed) win.removeEventListener('beforeunload', onBeforeUnload);
  };
}
