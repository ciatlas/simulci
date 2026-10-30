import { debounce, type Timers } from '../lib/debounce';
import { remotePoolKey, type SessionStore } from '../state/store';
import type { RemoteNeed, RemotePool } from '../worker/protocol';

/**
 * The page's half of the remotes loop (M4 synthesis § 5.3): what the newest load says the project needs is read from
 * GitHub, through the `github-*` chunk, once the author lets the page (`remotes.consent`), and handed to the store, whose
 * new pool the session loads again with; that load names the next level, until nothing is needed (the engine stops at
 * depth 10). Reads wait for 500 ms of quiet, so a burst of loads asks once, but the click that gives consent reads at
 * once. Each ref at its commit is read once for the page's life, whatever came of it: one in flight is never asked again,
 * and the loop cannot spin on a need the pool cannot meet.
 */

export type ReadRemotes = (needs: RemoteNeed[], signal: AbortSignal) => Promise<RemotePool>;

export interface RemoteReadsOptions {
  store: SessionStore;
  read: ReadRemotes;
  timers?: Timers;
  debounceMs?: number;
}

export function createRemoteReads({ store, read, timers, debounceMs = 500 }: RemoteReadsOptions): () => void {
  const actions = store.getState();
  /** The needs asked for, by ref and commit. */
  const asked = new Set<string>();
  const stop = new AbortController();
  let out = 0;

  const readNeeded = async (): Promise<void> => {
    const todo = toRead();
    if (!todo.length) return;
    out++;
    actions.remotesFetching();
    const got = await readOrNot(todo);
    out--;
    if (!stop.signal.aborted) actions.remotesRead(got, out === 0);
  };

  /** What the newest load needs and nobody asked for yet, marked asked; nothing without consent. */
  const toRead = (): RemoteNeed[] => {
    const { consent, needed } = store.getState().remotes;
    if (consent === 'none' || stop.signal.aborted) return [];
    const todo = needed.filter((n) => !asked.has(remotePoolKey(n.ref, n.pin?.sha)));
    for (const n of todo) asked.add(remotePoolKey(n.ref, n.pin?.sha));
    return todo;
  };

  /** The needs read, or each not read with why the reader failed (its chunk did not load). */
  const readOrNot = (todo: RemoteNeed[]): Promise<RemotePool> =>
    read(todo, stop.signal).catch((e: unknown) => ({
      sources: [],
      failed: todo.map((n) => notRead(n, e instanceof Error ? e.message : String(e))),
    }));

  const later = debounce(() => void readNeeded(), debounceMs, timers);
  const unsubscribe = store.subscribe((s, prev) => {
    if (s.remotes.consent !== 'none' && prev.remotes.consent === 'none') {
      later.cancel();
      void readNeeded();
    } else if (s.remotes.needed !== prev.remotes.needed && s.remotes.needed.length) later.call();
  });
  return () => {
    unsubscribe();
    later.cancel();
    stop.abort();
  };
}

/** A need the page could not even ask for (the chunk did not load): not read, at the commit it was for. */
const notRead = (need: RemoteNeed, message: string): RemotePool['failed'][number] => ({
  ref: need.ref,
  kind: need.kind,
  failure: 'unreachable',
  message,
  ...(need.pin ? { sha: need.pin.sha } : {}),
});
