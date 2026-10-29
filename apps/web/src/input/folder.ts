import { filterFiles, isReadFile, mayHoldProjectFiles, snapshotFiles } from './filter';
import { LIMITS, readWithin, type Walked } from './limits';

/**
 * A folder through the File System Access API (Chromium): the handle is kept, so Reload re-walks the checkout and a
 * later visit can ask to reopen it. Only the directories that can hold project files or route tests are entered.
 */

export const canPickFolder = (): boolean => typeof window !== 'undefined' && 'showDirectoryPicker' in window;

export interface PickedFolder extends Walked {
  name: string;
  handle: FileSystemDirectoryHandle;
}

type Picker = (options: { id: string; mode: 'read' }) => Promise<FileSystemDirectoryHandle>;

/** Opens the picker; `undefined` when the author cancelled. Other failures throw a DOMException to show. */
export async function pickFolder(): Promise<PickedFolder | undefined> {
  const picker = (window as unknown as { showDirectoryPicker: Picker }).showDirectoryPicker;
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await picker({ id: 'simulci-repo', mode: 'read' });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return undefined;
    throw e;
  }
  return { name: handle.name, handle, ...(await readFolder(handle)) };
}

interface PermissionHandle {
  queryPermission?(d: { mode: 'read' }): Promise<PermissionState>;
  requestPermission?(d: { mode: 'read' }): Promise<PermissionState>;
}

/** Whether a stored handle can be read now, without asking. */
export async function canReadFolder(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const h = handle as unknown as PermissionHandle;
  if (!h.queryPermission) return false;
  try {
    return (await h.queryPermission({ mode: 'read' })) === 'granted';
  } catch {
    return false;
  }
}

/** Asks for read access again; must run in a click. */
export async function requestFolder(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const h = handle as unknown as PermissionHandle;
  if (!h.requestPermission) return false;
  try {
    return (await h.requestPermission({ mode: 'read' })) === 'granted';
  } catch {
    return false;
  }
}

/**
 * The project files, route tests and their snapshots under a handle, by repository-relative path, and the ones too big
 * to read.
 */
export async function readFolder(root: FileSystemDirectoryHandle): Promise<Walked> {
  const walked: Walked = { files: {}, meta: {}, skipped: [] };
  await walk(root, '', 0, walked);
  return {
    files: { ...filterFiles(walked.files), ...snapshotFiles(walked.files) },
    meta: walked.meta,
    skipped: walked.skipped,
  };
}

async function walk(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  depth: number,
  walked: Walked,
): Promise<void> {
  if (depth > LIMITS.depth) return;
  for await (const [name, handle] of entriesOf(dir)) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'directory') {
      if (mayHoldProjectFiles(path)) await walk(handle, path, depth + 1, walked);
    } else if (isReadFile(path)) await readWithin(await handle.getFile(), path, walked);
  }
}

/** `entries()` is in the spec and in Chromium; the TS lib may lag. */
function entriesOf(
  dir: FileSystemDirectoryHandle,
): AsyncIterable<[string, FileSystemDirectoryHandle | FileSystemFileHandle]> {
  return (
    dir as unknown as { entries(): AsyncIterable<[string, FileSystemDirectoryHandle | FileSystemFileHandle]> }
  ).entries();
}
