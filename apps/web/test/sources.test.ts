import { describe, expect, it } from 'vitest';
import { createSources } from '../src/input/sources';
import { memoryStore } from '../src/lib/idb';
import { type SourceStore, type StoredSource, sourceStore } from '../src/state/persist';
import { createSessionStore } from '../src/state/store';

/** A tree as `{ name: text | bytes | subtree }`. */
type Tree = { [name: string]: string | Uint8Array<ArrayBuffer> | Tree };

const isFile = (v: Tree[string]): v is string | Uint8Array<ArrayBuffer> =>
  typeof v === 'string' || v instanceof Uint8Array;

/** A File as a walk reads it: its size and its bytes. Text is written as UTF-8; bytes are taken as they are. */
const fileOf = (content: string | Uint8Array<ArrayBuffer>) => {
  const blob = new Blob([content]);
  return { size: blob.size, arrayBuffer: () => blob.arrayBuffer() };
};

interface FolderOptions {
  /** The browser's answer to whether the folder may be read without a click. */
  permission?: () => Promise<PermissionState>;
  /** Waited for before the walk lists the folder; a rejection is a folder that no longer reads. */
  walk?: () => Promise<void>;
}

/** A folder handle as Chromium gives it, permission included. */
function folder(name: string, tree: Tree, options: FolderOptions = {}): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    name,
    queryPermission: options.permission ?? (() => Promise.resolve('granted')),
    requestPermission: () => Promise.resolve('denied'),
    async *entries() {
      await options.walk?.();
      for (const [n, v] of Object.entries(tree))
        yield [
          n,
          isFile(v) ? { kind: 'file', name: n, getFile: () => Promise.resolve(fileOf(v)) } : folder(n, v),
        ];
    },
  } as unknown as FileSystemDirectoryHandle;
}

const dropOf = (...items: unknown[]) => ({ items }) as unknown as DataTransfer;
const folderItem = (handle: FileSystemDirectoryHandle) => ({
  kind: 'file',
  getAsFileSystemHandle: () => Promise.resolve(handle),
  webkitGetAsEntry: () => null,
  getAsFile: () => null,
});
const fileItem = (name: string, text: string | Uint8Array<ArrayBuffer>) => ({
  kind: 'file',
  webkitGetAsEntry: () => null,
  getAsFile: () => ({ name, ...fileOf(text) }),
});

/** A promise settled from outside. */
function later<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const workflows = (files: Tree): Tree => ({ '.github': { workflows: files } });
const BIG = 'x'.repeat(2.5 * 1024 * 1024);
const BIG_LEFT_OUT = 'left out .github/workflows/big.yml (2.5 MB); a file may be at most 2 MB';

const CI = '.github/workflows/ci.yml';
const LATIN1_PATH = '.github/workflows/latin1.yml';
const utf8 = (text: string): number[] => Array.from(new TextEncoder().encode(text));
const withBom = (text: string) => new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(text)]);
/** A workflow saved as Latin-1: its é is no UTF-8. */
const LATIN1 = new Uint8Array([...utf8('name: caf'), 0xe9, ...utf8('\non: push\n')]);
const BOM_CRLF_META = { bom: true, eol: 'crlf', utf8: true };
const LATIN1_META = { bom: false, eol: 'lf', utf8: false };

function setup(
  persistOf: (kv: ReturnType<typeof memoryStore>) => SourceStore = sourceStore,
  load?: Parameters<typeof createSources>[0]['load'],
) {
  const store = createSessionStore();
  const kv = memoryStore();
  const sources = createSources({ store, persist: persistOf(kv), ...(load && { load }) });
  const notices = () => store.getState().notices.map((n) => n.text);
  return { store, kv, sources, notices };
}

describe('route tests among the files', () => {
  const TEST = '.github/simulci/tests/ci.test.yml';
  const tree = (tests: Tree): Tree => ({
    '.github': { workflows: { 'ci.yml': 'on: push\n' }, simulci: { tests }, 'dependabot.yml': 'x' },
  });

  it('takes a folder’s route tests in beside its workflows, but not their snapshots, and not tests alone', async () => {
    const { store, sources } = setup();
    const tests = { 'ci.test.yml': 'workflow: ci.yml\n', __snapshots__: { 'old.test.yml': 'x' } };
    await sources.drop(dropOf(folderItem(folder('repo', tree(tests)))));
    expect(Object.keys(store.getState().files.byPath).sort()).toEqual([TEST, CI]);

    await sources.drop(dropOf(folderItem(folder('tests', { '.github': { simulci: { tests } } }))));
    expect(store.getState().error?.message).toMatch(/^no workflow files in the folder tests/);
    expect(Object.keys(store.getState().files.byPath).sort()).toEqual([TEST, CI]);
  });

  it('reads the tests’ snapshots apart and read-only, again on Reload, and keeps them with a stored copy', async () => {
    const { store, kv, sources, notices } = setup();
    const SNAP = '.github/simulci/tests/__snapshots__/ci.test.snap.json';
    const snapshots: Tree = { 'ci.test.snap.json': '{"schemaVersion":1,"cases":{}}\n' };
    const tests = { 'ci.test.yml': 'workflow: ci.yml\n', __snapshots__: snapshots };
    await sources.drop(dropOf(folderItem(folder('repo', tree(tests)))));
    const files = store.getState().files;
    expect(Object.keys(files.byPath).sort()).toEqual([TEST, CI]);
    expect(files.readonly).toEqual({ [SNAP]: '{"schemaVersion":1,"cases":{}}\n' });
    expect(Object.keys(files.meta).sort()).toEqual([TEST, CI]);

    snapshots['ci.test.snap.json'] = '{"schemaVersion":1,"cases":{"a":1}}\n';
    await sources.reload();
    expect(store.getState().files.readonly).toEqual({ [SNAP]: '{"schemaVersion":1,"cases":{"a":1}}\n' });
    expect(store.getState().files.version).toBe(files.version);
    expect(notices()).toEqual(['repo: only snapshots changed']);
    delete snapshots['ci.test.snap.json'];
    await sources.reload();
    expect(store.getState().files.readonly).toBeUndefined();

    // A chosen folder is a copy with no handle: the stored copy keeps its snapshots for the next visit.
    const entry = (path: string, text: string) => ({
      name: path,
      webkitRelativePath: `repo/${path}`,
      ...fileOf(text),
    });
    await sources.chooseFiles([
      entry(CI, 'on: push\n'),
      entry(TEST, 'workflow: ci.yml\n'),
      entry(SNAP, '{}\n'),
    ] as unknown as File[]);
    expect(await kv.get('current')).toMatchObject({ kind: 'copy', readonly: { [SNAP]: '{}\n' } });
    const next = setup(() => sourceStore(kv));
    await next.sources.restore();
    expect(next.store.getState().files.readonly).toEqual({ [SNAP]: '{}\n' });
  });

  it('keeps a route test added among pasted buffers through the next paste and the next visit, unsaved (P1)', async () => {
    const { store, kv, sources } = setup();
    const first = sources.paste(CI, 'on: push\n');
    expect(first.ok && (await first.done)).toBe(true);
    const files = [
      { path: TEST, edits: [{ from: 0, to: 0, insert: 'workflow: ci.yml\n' }], create: true as const },
    ];
    expect(store.getState().transact({ label: 'Added', origin: 'op', files }).ok).toBe(true);
    const pasted = sources.paste('.github/workflows/b.yml', 'on: pull_request\n');
    expect(pasted.ok && (await pasted.done)).toBe(true);
    const now = store.getState().files;
    expect(now.byPath[TEST]).toBe('workflow: ci.yml\n');
    expect(now.base).not.toHaveProperty(TEST);
    // Written through to the buffers on the next visit, still a file the folder never had.
    const next = setup(() => sourceStore(kv));
    await next.sources.restore();
    expect(next.store.getState().files.byPath[TEST]).toBe('workflow: ci.yml\n');
    expect(next.store.getState().files.base).not.toHaveProperty(TEST);
  });
});

describe('the sources of a session, at their edges', () => {
  it('reports a drop with no workflow file in it and leaves the pasted buffers as they were', async () => {
    const { store, sources } = setup();
    sources.paste('', 'on: push');
    const version = store.getState().files.version;
    await sources.drop(dropOf(fileItem('README.md', '# hello')));
    expect(store.getState().error).toMatchObject({
      kind: 'source',
      message: expect.stringContaining('nothing in the drop is a workflow file'),
    });
    expect(store.getState().files.version).toBe(version);
  });

  it('stores a drop of several items as a copy, so the next visit gets all of it', async () => {
    const { store, kv, sources } = setup();
    const a = folder('repoA', workflows({ 'ci.yml': 'on: push' }));
    const b = folder('repoB', workflows({ 'release.yml': 'on: release' }));
    await sources.drop(dropOf(folderItem(a), folderItem(b), fileItem('hotfix.yml', 'on: push')));
    expect(store.getState().source).toEqual({
      kind: 'folder',
      name: 'repoA + 2 more',
      readAt: expect.any(Number),
    });
    expect(Object.keys(store.getState().files.byPath).sort()).toEqual([
      '.github/workflows/ci.yml',
      '.github/workflows/hotfix.yml',
      '.github/workflows/release.yml',
    ]);
    expect(await kv.get('current')).toMatchObject({ kind: 'copy', name: 'repoA + 2 more' });
    const next = setup(() => sourceStore(kv));
    await next.sources.restore();
    expect(next.store.getState().files.byPath).toEqual(store.getState().files.byPath);
  });

  it('stores a folder dropped beside a file it left out as the folder, not as a copy', async () => {
    const { store, kv, sources, notices } = setup();
    const repo = folder('repo', workflows({ 'ci.yml': 'on: push' }));
    await sources.drop(dropOf(folderItem(repo), fileItem('big.yml', BIG)));
    expect(store.getState().source).toEqual({
      kind: 'folder',
      name: 'repo',
      handle: repo,
      readAt: expect.any(Number),
    });
    expect(store.getState().files.byPath).toEqual({ '.github/workflows/ci.yml': 'on: push' });
    expect(notices()).toEqual([`the drop: ${BIG_LEFT_OUT}`]);
    expect(await kv.get('current')).toEqual({ kind: 'folder', name: 'repo', handle: repo });
  });

  it('forgets a stored folder that no longer reads, after saying so', async () => {
    const { store, kv, sources } = setup();
    const gone = () => Promise.reject(new DOMException('the folder could not be found', 'NotFoundError'));
    await kv.set('current', { kind: 'folder', name: 'repo', handle: folder('repo', {}, { walk: gone }) });
    await sources.restore();
    expect(store.getState().error).toMatchObject({
      kind: 'source',
      message: 'reading repo failed: the folder could not be found',
    });
    expect(await kv.get('current')).toBeUndefined();

    await kv.set('current', { kind: 'folder', name: 'docs', handle: folder('docs', { 'README.md': 'x' }) });
    await sources.restore();
    expect(store.getState().error).toMatchObject({
      message: expect.stringContaining('no workflow files in the folder docs'),
    });
    expect(await kv.get('current')).toBeUndefined();

    store.getState().clearError();
    await sources.restore();
    expect(store.getState().error).toBeUndefined();
  });

  it('leaves alone what the author chose while the last visit was still being restored', async () => {
    // The stored source arrives after a sample was picked.
    const loaded = later<void>();
    const slow = setup((kv) => {
      const persist = sourceStore(kv);
      const load = async () => {
        const stored = await persist.load();
        await loaded.promise;
        return stored;
      };
      return { ...persist, load };
    });
    await slow.kv.set('current', {
      kind: 'paste',
      buffers: [{ path: '.github/workflows/old.yml', text: 'on: push' }],
    });
    const restoring = slow.sources.restore();
    slow.sources.useSample('starter');
    loaded.resolve();
    await restoring;
    expect(slow.store.getState().source).toEqual({ kind: 'sample', name: 'starter' });

    // A granted folder still walking when the author pastes.
    const walking = later<void>();
    const release = later<void>();
    const walk = () => {
      walking.resolve();
      return release.promise;
    };
    const granted = setup();
    const repo = folder('repo', workflows({ 'ci.yml': 'on: push' }), { walk });
    await granted.kv.set('current', { kind: 'folder', name: 'repo', handle: repo });
    const reading = granted.sources.restore();
    await walking.promise;
    granted.sources.paste('', 'on: pull_request');
    release.resolve();
    await reading;
    expect(granted.store.getState().source).toMatchObject({ kind: 'paste' });
    expect(granted.store.getState().files.byPath).toEqual({
      '.github/workflows/pasted.yml': 'on: pull_request',
    });
    expect(await granted.kv.get('current')).toMatchObject({ kind: 'paste' });

    // A folder that needs a click, answered after the author picked a sample.
    const asking = later<void>();
    const answer = later<PermissionState>();
    const permission = () => {
      asking.resolve();
      return answer.promise;
    };
    const prompt = setup();
    await prompt.kv.set('current', {
      kind: 'folder',
      name: 'repo',
      handle: folder('repo', {}, { permission }),
    });
    const offering = prompt.sources.restore();
    await asking.promise;
    prompt.sources.useSample('starter');
    answer.resolve('prompt');
    await offering;
    expect(prompt.store.getState().source).toEqual({ kind: 'sample', name: 'starter' });
    expect(Object.keys(prompt.store.getState().files.byPath).length).toBeGreaterThan(0);
  });

  it('takes a stored kind named like an Object.prototype key as nothing stored', async () => {
    const stored = memoryStore();
    for (const kind of ['constructor', 'toString']) {
      await stored.set('current', { kind });
      expect(await sourceStore(stored).load()).toBeUndefined();
    }
    const odd = setup((kv) => ({
      ...sourceStore(kv),
      load: () => Promise.resolve({ kind: 'constructor' } as unknown as StoredSource),
    }));
    await odd.sources.restore();
    expect(odd.store.getState().error).toBeUndefined();
    expect(odd.store.getState().source).toEqual({ kind: 'none' });
  });

  it('tells the author which files it left out for their size, and takes the rest', async () => {
    const { store, sources, notices } = setup();
    const repo = folder('repo', workflows({ 'ci.yml': 'on: push', 'big.yml': BIG }));
    await sources.drop(dropOf(folderItem(repo)));
    expect(store.getState().error).toBeUndefined();
    expect(store.getState().files.byPath).toEqual({ '.github/workflows/ci.yml': 'on: push' });
    expect(notices()).toEqual([`the folder repo: ${BIG_LEFT_OUT}`]);
    await sources.reload();
    expect(notices().slice(1)).toEqual(['repo: no changes', `the folder repo: ${BIG_LEFT_OUT}`]);

    await sources.drop(dropOf(folderItem(folder('huge', workflows({ 'big.yml': BIG })))));
    expect(store.getState().error).toMatchObject({
      kind: 'source',
      message: `nothing in the folder huge fits: ${BIG_LEFT_OUT}`,
    });

    sources.paste('', 'on: push');
    await sources.drop(dropOf(fileItem('big.yml', BIG)));
    expect(store.getState().error).toMatchObject({ message: `nothing in the drop fits: ${BIG_LEFT_OUT}` });
    await sources.drop(dropOf(fileItem('a.yml', 'on: push'), fileItem('big.yml', BIG)));
    expect(Object.keys(store.getState().files.byPath).sort()).toEqual([
      '.github/workflows/a.yml',
      '.github/workflows/pasted.yml',
    ]);
    expect(notices().at(-1)).toBe(`the drop: ${BIG_LEFT_OUT}`);

    await sources.chooseFiles([
      { name: 'ci.yml', webkitRelativePath: 'other/.github/workflows/ci.yml', ...fileOf('on: push') },
      { name: 'big.yml', webkitRelativePath: 'other/.github/workflows/big.yml', ...fileOf(BIG) },
    ] as unknown as File[]);
    expect(store.getState().source).toMatchObject({ kind: 'folder', name: 'other' });
    expect(notices().at(-1)).toBe(`other: ${BIG_LEFT_OUT}`);
  });

  it('keeps what reading found of a copy through the next visit', async () => {
    const { store, kv, sources } = setup();
    await sources.chooseFiles([
      {
        name: 'ci.yml',
        webkitRelativePath: 'repo/.github/workflows/ci.yml',
        ...fileOf(withBom('on: push\r\n')),
      },
      { name: 'latin1.yml', webkitRelativePath: 'repo/.github/workflows/latin1.yml', ...fileOf(LATIN1) },
    ] as unknown as File[]);
    const meta = { [CI]: BOM_CRLF_META, [LATIN1_PATH]: LATIN1_META };
    expect(store.getState().files).toMatchObject({ byPath: { [CI]: 'on: push\r\n' }, meta });
    expect(await kv.get('current')).toMatchObject({ kind: 'copy', meta });
    const next = setup(() => sourceStore(kv));
    await next.sources.restore();
    expect(next.store.getState().files).toEqual({ ...store.getState().files, version: 1 });
  });

  it('keeps what a drop read of a loose file among the pasted buffers, until a paste replaces it', async () => {
    const { store, kv, sources } = setup();
    await sources.drop(dropOf(fileItem('ci.yml', withBom('on: push\r\n'))));
    sources.paste('', 'on: pull_request\n');
    expect(store.getState().files.meta).toEqual({
      [CI]: BOM_CRLF_META,
      '.github/workflows/pasted.yml': { bom: false, eol: 'lf', utf8: true },
    });
    const next = setup(() => sourceStore(kv));
    await next.sources.restore();
    expect(next.store.getState().files.meta).toEqual(store.getState().files.meta);

    sources.removeBuffer('.github/workflows/pasted.yml');
    expect(store.getState().files.meta).toEqual({ [CI]: BOM_CRLF_META });
    await sources.drop(dropOf(fileItem('latin1.yml', LATIN1)));
    expect(store.getState().files.meta).toEqual({ [CI]: BOM_CRLF_META, [LATIN1_PATH]: LATIN1_META });
    sources.paste(CI, 'on: push');
    expect(store.getState().files.meta).toEqual({
      [CI]: { bom: false, eol: 'none', utf8: true },
      [LATIN1_PATH]: LATIN1_META,
    });
  });

  it('takes a folder read again whose only change is a BOM as a change', async () => {
    const { store, sources, notices } = setup();
    const files = { 'ci.yml': withBom('on: push') as string | Uint8Array<ArrayBuffer> };
    await sources.drop(dropOf(folderItem(folder('repo', workflows(files)))));
    expect(store.getState().files.meta).toEqual({ [CI]: { bom: true, eol: 'none', utf8: true } });
    files['ci.yml'] = 'on: push';
    await sources.reload();
    expect(notices()).toEqual([]);
    // The text is the same, so the plan stands: only what reading found, and the base, move.
    expect(store.getState().files).toMatchObject({
      version: 1,
      byPath: { [CI]: 'on: push' },
      base: { [CI]: 'on: push' },
      meta: { [CI]: { bom: false, eol: 'none', utf8: true } },
    });
    await sources.reload();
    expect(notices()).toEqual(['repo: no changes']);
  });

  it('leaves the files as they are when the merge cannot be fetched, and says to reload again', async () => {
    const { store, sources } = setup(sourceStore, () => Promise.reject(new Error('offline')));
    const files = { 'ci.yml': 'on: push' };
    await sources.drop(dropOf(folderItem(folder('repo', workflows(files)))));
    files['ci.yml'] = 'on: [push, pull_request]';
    await sources.reload();
    expect(store.getState().files.byPath).toEqual({ [CI]: 'on: push' });
    expect(store.getState().error).toMatchObject({
      kind: 'source',
      message: 'reloading repo stopped: the page could not fetch the merge; reload again',
    });
  });

  it('reads a stored meta entry that is not one from the file’s text instead', async () => {
    const { store, kv, sources } = setup();
    await kv.set('current', {
      kind: 'copy',
      name: 'repo',
      buffers: [
        { path: CI, text: 'on: push\n' },
        { path: LATIN1_PATH, text: 'name: caf\uFFFD\non: push\n' },
      ],
      meta: { [CI]: { bom: 'yes', eol: 'lf', utf8: true }, [LATIN1_PATH]: LATIN1_META },
    });
    await sources.restore();
    expect(store.getState().files.meta).toEqual({
      [CI]: { bom: false, eol: 'lf', utf8: true },
      [LATIN1_PATH]: LATIN1_META,
    });
    await kv.set('current', { kind: 'paste', buffers: [{ path: CI, text: 'on: push' }], meta: 'odd' });
    const next = setup(() => sourceStore(kv));
    await next.sources.restore();
    expect(next.store.getState().files.meta).toEqual({ [CI]: { bom: false, eol: 'none', utf8: true } });
  });
});
