/** A key-value store over IndexedDB; a memory map where IndexedDB is missing (tests, some private windows). */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Version 1 of a database, `create` making its stores the first time; a refusal or a block rejects. */
export function openDatabase(dbName: string, create: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.addEventListener('upgradeneeded', () => create(request.result));
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () => reject(request.error ?? new Error('IndexedDB refused to open')));
    request.addEventListener('blocked', () => reject(new Error('IndexedDB is blocked by another tab')));
  });
}

export function openKeyValue(dbName: string, storeName: string): KeyValueStore {
  if (typeof indexedDB === 'undefined') return memoryStore();
  let opened: Promise<IDBDatabase> | undefined;
  const db = (): Promise<IDBDatabase> => {
    opened ??= openDatabase(dbName, (d) => d.createObjectStore(storeName));
    return opened;
  };
  /** A read is done when its request succeeds; a write only once its transaction has committed. */
  const run = async <T>(
    mode: IDBTransactionMode,
    op: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const tx = (await db()).transaction(storeName, mode);
    return new Promise<T>((resolve, reject) => {
      const request = op(tx.objectStore(storeName));
      const fail = (): void => reject(request.error ?? tx.error ?? new Error('IndexedDB request failed'));
      request.addEventListener('error', fail);
      if (mode === 'readonly') request.addEventListener('success', () => resolve(request.result));
      else {
        tx.addEventListener('complete', () => resolve(request.result));
        tx.addEventListener('abort', fail);
      }
    });
  };
  return {
    get: <T>(key: string) => run('readonly', (s) => s.get(key) as IDBRequest<T | undefined>),
    set: async (key, value) => {
      await run('readwrite', (s) => s.put(value, key));
    },
    delete: async (key) => {
      await run('readwrite', (s) => s.delete(key));
    },
  };
}

export function memoryStore(): KeyValueStore {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => Promise.resolve(map.get(key) as T | undefined),
    set: (key, value) => {
      map.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => {
      map.delete(key);
      return Promise.resolve();
    },
  };
}
