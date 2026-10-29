import { isReadFile, normalizePath } from './filter';
import { readWithin, type Walked } from './limits';

/**
 * A folder through `<input type="file" webkitdirectory>`: every browser has it, the files are a copy (no handle, no
 * reload) and the first path segment is the folder's own name. Only the files the page keeps and the
 * tests' snapshots (filter.ts) are read.
 */

export interface PickedFiles extends Walked {
  /** The folder's name, from the first path segment. */
  name?: string;
}

export async function filesFromList(list: ArrayLike<File>): Promise<PickedFiles> {
  const walked: Walked = { files: {}, meta: {}, skipped: [] };
  let name: string | undefined;
  for (const file of Array.from(list)) {
    const relative = normalizePath(file.webkitRelativePath || file.name);
    const slash = relative.indexOf('/');
    if (slash === -1) {
      // A loose file, as a multiple-file input or a drop gives them: taken as a workflow by its name.
      if (/\.ya?ml$/i.test(relative)) await readWithin(file, `.github/workflows/${relative}`, walked);
      continue;
    }
    name ??= relative.slice(0, slash);
    const path = relative.slice(slash + 1);
    if (isReadFile(path)) await readWithin(file, path, walked);
  }
  return name === undefined ? walked : { name, ...walked };
}
