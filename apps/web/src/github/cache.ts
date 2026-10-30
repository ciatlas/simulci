import { openDatabase } from '../lib/idb';

/**
 * The content cache of a GitHub source (M4 synthesis § 2.6): git objects by SHA, so a ref that has not moved reads
 * nothing but its commit, and an object never goes stale. It lives in an IndexedDB of its own, `simulci-cache` (not a
 * version of `simulci-web`, which holds the author's source), with two stores: `blobs` (trees and files, here) and
 * `remotes` (the remote workflows and actions a plan reads, WR's). It holds at most 20 MB, the oldest written going
 * first, and only what was read anonymously from a repository seen `private: false`: the browser keeps no private
 * file a later visitor of the profile could read. A memory map stands in where IndexedDB is missing.
 */

const CACHE_DB = 'simulci-cache';
const BLOBS = 'blobs';
const REMOTES = 'remotes';
const BY_AGE = 'at';

/** The most the cache holds, in bytes. */
const MAX_CACHE_BYTES = 20 * 1024 * 1024;

export interface GitHubCache {
  get(key: string): Promise<Uint8Array | undefined>;
  /** Keeps the bytes, unless the repository they came from was not seen public. Never throws. */
  set(key: string, bytes: Uint8Array, seenPublic: boolean): Promise<void>;
}

/** A git object's key: its host, what it is, its SHA (lower-case). */
export const objectKey = (host: string, kind: 'blob' | 'tree' | 'tree-r', sha: string): string =>
  `${host.toLowerCase()}/${kind}/${sha.toLowerCase()}`;

interface Entry {
  bytes: Uint8Array;
  size: number;
  at: number;
}

/** The cache in memory, oldest written first out past `max` bytes. */
export function memoryCache(max = MAX_CACHE_BYTES): GitHubCache {
  const entries = new Map<string, Uint8Array>();
  let size = 0;
  const drop = (key: string): void => {
    size -= entries.get(key)?.byteLength ?? 0;
    entries.delete(key);
  };
  return {
    get: (key) => Promise.resolve(entries.get(key)?.slice()),
    set: (key, bytes, seenPublic) => {
      if (!seenPublic || bytes.byteLength > max) return Promise.resolve();
      drop(key);
      entries.set(key, bytes.slice());
      size += bytes.byteLength;
      for (const oldest of entries.keys()) {
        if (size <= max) break;
        drop(oldest);
      }
      return Promise.resolve();
    },
  };
}

/** The cache in IndexedDB; a read or a write that fails is a miss, or not kept. */
export function openGitHubCache(max = MAX_CACHE_BYTES): GitHubCache {
  if (typeof indexedDB === 'undefined') return memoryCache(max);
  let opened: Promise<IDBDatabase> | undefined;
  const db = (): Promise<IDBDatabase> => {
    opened ??= openDatabase(CACHE_DB, (d) => {
      d.createObjectStore(BLOBS).createIndex(BY_AGE, BY_AGE);
      d.createObjectStore(REMOTES).createIndex(BY_AGE, BY_AGE);
    });
    return opened;
  };
  /** What the store holds, in bytes: counted once, then kept up to date by every write and eviction. */
  let total: Promise<number> | undefined;
  /** Writes one at a time, so a count and an eviction never cross. */
  let queue: Promise<unknown> = Promise.resolve();

  const get = async (key: string): Promise<Uint8Array | undefined> => {
    try {
      const tx = (await db()).transaction(BLOBS, 'readonly');
      const entry = await done<Entry | undefined>(tx.objectStore(BLOBS).get(key));
      return entry?.bytes instanceof Uint8Array ? entry.bytes : undefined;
    } catch {
      return undefined;
    }
  };

  const write = async (key: string, bytes: Uint8Array): Promise<void> => {
    const d = await db();
    total ??= sizeOf(d);
    let held = await total;
    const tx = d.transaction(BLOBS, 'readwrite');
    const store = tx.objectStore(BLOBS);
    const before = await done<Entry | undefined>(store.get(key));
    store.put({ bytes, size: bytes.byteLength, at: Date.now() } satisfies Entry, key);
    held += bytes.byteLength - (before?.size ?? 0);
    held = await evict(store, held, max);
    await committed(tx);
    total = Promise.resolve(held);
  };

  return {
    get,
    set: (key, bytes, seenPublic) => {
      if (!seenPublic || bytes.byteLength > max) return Promise.resolve();
      const next = queue.then(() => write(key, bytes));
      queue = next.catch(() => {
        // Not kept: the next read asks GitHub again. The count is taken anew.
        total = undefined;
      });
      return queue.then(() => undefined);
    },
  };
}

/** The oldest entries deleted until the store holds `max` bytes at most; what it holds then. */
async function evict(store: IDBObjectStore, held: number, max: number): Promise<number> {
  if (held <= max) return held;
  const cursor = store.index(BY_AGE).openCursor();
  return new Promise((resolve, reject) => {
    cursor.addEventListener('error', () => reject(cursor.error));
    cursor.addEventListener('success', () => {
      const c = cursor.result;
      if (!c || held <= max) return resolve(held);
      held -= (c.value as Entry).size;
      c.delete();
      c.continue();
    });
  });
}

/** The bytes the store holds, counted over its entries. */
async function sizeOf(d: IDBDatabase): Promise<number> {
  const cursor = d.transaction(BLOBS, 'readonly').objectStore(BLOBS).openCursor();
  return new Promise((resolve, reject) => {
    let size = 0;
    cursor.addEventListener('error', () => reject(cursor.error));
    cursor.addEventListener('success', () => {
      const c = cursor.result;
      if (!c) return resolve(size);
      size += (c.value as Entry).size;
      c.continue();
    });
  });
}

const done = <T>(request: IDBRequest): Promise<T> =>
  new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result as T));
    request.addEventListener('error', () => reject(request.error));
  });

const committed = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.addEventListener('complete', () => resolve());
    tx.addEventListener('abort', () => reject(tx.error ?? new Error('IndexedDB write aborted')));
    tx.addEventListener('error', () => reject(tx.error));
  });
