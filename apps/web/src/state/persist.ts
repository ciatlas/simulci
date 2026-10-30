import type { FileMeta } from '../input/read';
import { type KeyValueStore, openKeyValue } from '../lib/idb';
import type { BaseDiff, GitHubSource, Source } from './store';

/**
 * The source survives a reload in IndexedDB: paste buffers as they are (the crash snapshot), a folder as its handle
 * (which needs a click to re-grant), a sample by name. Files from a chosen folder (`webkitdirectory`) are a copy
 * with no handle, so they are stored as buffers too. Buffers keep the meta they were read with: their text no longer
 * shows a BOM or the bytes that were not UTF-8, and unlike a folder there is no disk to read them from again.
 * Pasted buffers keep the texts their edits were made to as well, so edits stay unsaved across a reload and
 * replacing them still asks (§ 5.7). A chosen folder's copy keeps its tests' snapshots too (`files.readonly`). A GitHub
 * repository is kept as read, with its source's fields, so it comes back without a request; like a folder's, its
 * edits are the crash snapshot's (`state/snapshot.ts`), which brings them back over it.
 */

export type StoredSource =
  | { kind: 'sample'; name: string }
  | {
      kind: 'paste';
      buffers: { path: string; text: string }[];
      meta?: Record<string, FileMeta>;
      /** An edited sample's buffers say which sample they are a copy of. */
      name?: string;
      /** The edited buffers' texts as pasted, `null` for one created since: `files.base` where it is not the text. */
      base?: BaseDiff;
    }
  | { kind: 'folder'; name: string; handle: FileSystemDirectoryHandle }
  | {
      kind: 'copy';
      name: string;
      buffers: { path: string; text: string }[];
      meta?: Record<string, FileMeta>;
      /** The route tests' snapshots, read-only beside the buffers. */
      readonly?: Record<string, string>;
    }
  | {
      kind: 'github';
      source: GitHubSource;
      /** The files as read at `source.sha`; the edits are the crash snapshot's. */
      buffers: { path: string; text: string }[];
      meta?: Record<string, FileMeta>;
      readonly?: Record<string, string>;
    };

export const DB_NAME = 'simulci-web';
export const STORE_NAME = 'source';
const CURRENT_KEY = 'current';

export interface SourceStore {
  load(): Promise<StoredSource | undefined>;
  save(
    source: Source,
    files: Record<string, string>,
    meta?: Record<string, FileMeta>,
    base?: Record<string, string>,
    readonly?: Record<string, string>,
  ): Promise<void>;
  clear(): Promise<void>;
}

export function sourceStore(kv: KeyValueStore = openKeyValue(DB_NAME, STORE_NAME)): SourceStore {
  return {
    load: async () => {
      try {
        const stored = await kv.get<StoredSource>(CURRENT_KEY);
        return isStoredSource(stored) ? withMeta(stored) : undefined;
      } catch {
        return undefined;
      }
    },
    save: async (source, files, meta, base, readonly) => {
      const stored = toStored(source, files, meta, base, readonly);
      try {
        if (stored) await kv.set(CURRENT_KEY, stored);
        else await kv.delete(CURRENT_KEY);
      } catch {
        // A refused write (private window, quota) only costs the author a reopen.
      }
    },
    clear: async () => {
      try {
        await kv.delete(CURRENT_KEY);
      } catch {
        // Nothing to clear then.
      }
    },
  };
}

export function toStored(
  source: Source,
  files: Record<string, string>,
  meta?: Record<string, FileMeta>,
  base?: Record<string, string>,
  readonly?: Record<string, string>,
): StoredSource | undefined {
  if (source.kind === 'sample') return { kind: 'sample', name: source.name };
  if (source.kind === 'paste') {
    const diff = base && baseDiff(files, base);
    return {
      kind: 'paste',
      buffers: source.buffers,
      ...(meta && { meta }),
      ...(source.name === undefined ? {} : { name: source.name }),
      ...(diff && { base: diff }),
    };
  }
  if (source.kind === 'folder' && source.handle)
    return { kind: 'folder', name: source.name, handle: source.handle };
  const buffers = Object.entries(files).map(([path, text]) => ({ path, text }));
  if (source.kind === 'folder')
    return { kind: 'copy', name: source.name, buffers, ...(meta && { meta }), ...(readonly && { readonly }) };
  if (source.kind === 'github')
    return { kind: 'github', source, buffers, ...(meta && { meta }), ...(readonly && { readonly }) };
  return undefined;
}

/** Where the texts are not their base, the base; nothing when every text is. */
function baseDiff(
  files: Readonly<Record<string, string>>,
  base: Readonly<Record<string, string>>,
): BaseDiff | undefined {
  const diff: BaseDiff = {};
  for (const [path, text] of Object.entries(files))
    if (base[path] !== text) diff[path] = Object.hasOwn(base, path) ? base[path]! : null;
  for (const [path, text] of Object.entries(base)) if (!Object.hasOwn(files, path)) diff[path] = text;
  return Object.keys(diff).length > 0 ? diff : undefined;
}

const STORED_SHAPES: Record<string, (v: Record<string, unknown>) => boolean> = {
  sample: (v) => typeof v.name === 'string',
  paste: (v) => Array.isArray(v.buffers),
  copy: (v) => typeof v.name === 'string' && Array.isArray(v.buffers),
  folder: (v) => typeof v.name === 'string' && typeof v.handle === 'object' && v.handle !== null,
  github: (v) => isGitHubSource(v.source) && Array.isArray(v.buffers),
};

const GITHUB_STRINGS = ['host', 'owner', 'repo', 'ref', 'sha', 'defaultBranch'] as const;

function isGitHubSource(value: unknown): value is GitHubSource {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.kind === 'github' &&
    GITHUB_STRINGS.every((k) => typeof v[k] === 'string') &&
    typeof v.private === 'boolean' &&
    typeof v.readAt === 'number' &&
    (v.pull === undefined || typeof v.pull === 'number')
  );
}

function isStoredSource(value: unknown): value is StoredSource {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const check =
    typeof v.kind === 'string' && Object.hasOwn(STORED_SHAPES, v.kind) ? STORED_SHAPES[v.kind] : undefined;
  return check !== undefined && check(v);
}

const EOLS: ReadonlySet<unknown> = new Set(['lf', 'crlf', 'mixed', 'none']);

function isFileMeta(value: unknown): value is FileMeta {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.bom === 'boolean' && typeof v.utf8 === 'boolean' && EOLS.has(v.eol);
}

/**
 * Buffers with the stored meta entries that are one; any other is left out, so the store reads it from the text. A
 * base that is not one is left out whole: the buffers then read as unedited, as they did before bases were kept.
 */
function withMeta(stored: StoredSource): StoredSource {
  if (stored.kind === 'sample' || stored.kind === 'folder') return stored;
  const meta = fileMetas(stored.meta);
  if (stored.kind === 'copy' || stored.kind === 'github') {
    const { readonly, ...rest } = stored;
    return isTexts(readonly) ? { ...rest, meta, readonly } : { ...rest, meta };
  }
  const { base, ...rest } = stored;
  return isBaseDiff(base) ? { ...rest, meta, base } : { ...rest, meta };
}

/** The stored meta entries that are one. */
function fileMetas(stored: Record<string, unknown> | undefined): Record<string, FileMeta> {
  const meta: Record<string, FileMeta> = {};
  for (const [path, m] of Object.entries(stored ?? {})) if (isFileMeta(m)) meta[path] = m;
  return meta;
}

const isTexts = (value: unknown): value is Record<string, string> =>
  typeof value === 'object' && value !== null && Object.values(value).every((v) => typeof v === 'string');

const isBaseDiff = (value: unknown): value is BaseDiff =>
  typeof value === 'object' &&
  value !== null &&
  Object.values(value).every((v) => typeof v === 'string' || v === null);
