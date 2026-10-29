import { isReadFile, mayHoldProjectFiles } from './filter';
import { LIMITS, readWithin, type Walked } from './limits';

/**
 * A drop of a folder or of workflow files. A dropped folder is walked through its handle where the browser gives one
 * (Chromium, so Reload works) and through the older entry API elsewhere; dropped `.yml` files become workflows by
 * their names. The items read only while the drop event lasts, so each one is taken before the first await.
 */

export interface Dropped extends Walked {
  /** The folder's name; for a drop of several items with a folder among them, a name for them all. */
  name?: string;
  /** How a message calls the drop: `the folder <name>` for one folder, else `the drop`. */
  where: string;
  /** Only for a drop of exactly one folder, so a reload re-reads everything it brought. */
  handle?: FileSystemDirectoryHandle;
}

type ItemWithHandle = DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> };

/** What an item holds, in every form the browser offers it. */
interface Taken {
  handle: Promise<FileSystemHandle | null>;
  entry: FileSystemEntry | null;
  file: File | null;
}

/** What an item brought: a folder (with its handle where there is one) or a loose workflow file. */
interface Part {
  name: string;
  folder: boolean;
  /** False for a loose file left out for its size: it names nothing and costs no folder its handle. */
  kept: boolean;
  handle?: FileSystemDirectoryHandle;
}

export async function filesFromDrop(transfer: DataTransfer): Promise<Dropped> {
  const taken = Array.from(transfer.items)
    .filter((item) => item.kind === 'file')
    .map(take);
  const walked: Walked = { files: {}, meta: {}, skipped: [] };
  const parts: Part[] = [];
  for (const t of taken) {
    const part = await readItem(t, walked);
    if (part) parts.push(part);
  }
  return { ...sourceOf(parts), ...walked };
}

/** Everything an item offers, asked for at once: after the drop event the items read as empty. */
function take(item: ItemWithHandle): Taken {
  return { handle: handleOf(item), entry: item.webkitGetAsEntry?.() ?? null, file: item.getAsFile() };
}

/** Starts `getAsFileSystemHandle` now; its answer comes later. */
async function handleOf(item: ItemWithHandle): Promise<FileSystemHandle | null> {
  if (!item.getAsFileSystemHandle) return null;
  try {
    return await item.getAsFileSystemHandle();
  } catch {
    return null;
  }
}

async function readItem(t: Taken, walked: Walked): Promise<Part | undefined> {
  const h = await t.handle;
  if (h?.kind === 'directory') {
    const dir = h as FileSystemDirectoryHandle;
    await walkHandle(dir, '', 0, walked);
    return { name: dir.name, folder: true, kept: true, handle: dir };
  }
  if (t.entry?.isDirectory) {
    await walkEntry(t.entry as FileSystemDirectoryEntry, '', 0, walked);
    return { name: t.entry.name, folder: true, kept: true };
  }
  if (!t.file || !/\.ya?ml$/i.test(t.file.name)) return undefined;
  const kept = await readWithin(t.file, `.github/workflows/${t.file.name}`, walked);
  return { name: t.file.name, folder: false, kept };
}

type Called = Pick<Dropped, 'name' | 'where' | 'handle'>;

/**
 * What the drop is called and whether it keeps a handle. Loose files alone have no name: they join the pasted buffers.
 * Messages say `the folder <name>` only for that folder dropped alone; a workflow file left out beside it makes it
 * `the drop`, so the notice does not place that file in the folder.
 */
function sourceOf(parts: Part[]): Called {
  const kept = parts.filter((p) => p.kept);
  const [first, second] = kept;
  if (!first || !kept.some((p) => p.folder)) return { where: 'the drop' };
  if (!second) {
    const one: Called = {
      name: first.name,
      where: parts.length === 1 ? `the folder ${first.name}` : 'the drop',
    };
    if (first.handle) one.handle = first.handle;
    return one;
  }
  const name =
    kept.length === 2 ? `${first.name} + ${second.name}` : `${first.name} + ${kept.length - 1} more`;
  return { name, where: 'the drop' };
}

async function walkHandle(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  depth: number,
  walked: Walked,
): Promise<void> {
  if (depth > LIMITS.depth) return;
  const entries = (
    dir as unknown as { entries(): AsyncIterable<[string, FileSystemDirectoryHandle | FileSystemFileHandle]> }
  ).entries();
  for await (const [entryName, h] of entries) {
    const path = prefix ? `${prefix}/${entryName}` : entryName;
    if (h.kind === 'directory') {
      if (mayHoldProjectFiles(path)) await walkHandle(h, path, depth + 1, walked);
    } else if (isReadFile(path)) await readWithin(await h.getFile(), path, walked);
  }
}

/** `readEntries` returns a batch at a time and an empty one at the end. */
function allEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const out: FileSystemEntry[] = [];
  return new Promise((resolve, reject) => {
    const next = (): void =>
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(out);
        else {
          out.push(...batch);
          next();
        }
      }, reject);
    next();
  });
}

const fileOf = (entry: FileSystemFileEntry): Promise<File> =>
  new Promise((resolve, reject) => entry.file(resolve, reject));

async function walkEntry(
  dir: FileSystemDirectoryEntry,
  prefix: string,
  depth: number,
  walked: Walked,
): Promise<void> {
  if (depth > LIMITS.depth) return;
  for (const entry of await allEntries(dir)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory) {
      if (mayHoldProjectFiles(path))
        await walkEntry(entry as FileSystemDirectoryEntry, path, depth + 1, walked);
    } else if (isReadFile(path)) await readWithin(await fileOf(entry as FileSystemFileEntry), path, walked);
  }
}
