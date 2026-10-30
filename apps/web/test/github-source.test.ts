import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installLeaveGuard } from '../src/app/leave';
import { createSaver } from '../src/app/saver';
import { installEditPrefetch } from '../src/edit/load';
import type { RepoRead } from '../src/github/github';
import { createSources } from '../src/input/sources';
import { memoryStore } from '../src/lib/idb';
import { applyCommands, githubNote, patchName, patchPreamble, repoAt } from '../src/lib/repo-words';
import { defaultBranchOf, defaultScenario, scenarioFor } from '../src/scenario/defaults';
import { sourceStore, toStored } from '../src/state/persist';
import { reloadPlan, settledReload } from '../src/state/reload';
import { downloadPatch } from '../src/state/changes';
import { keepsSnapshot, repoKey, snapshotOf, snapshotStore } from '../src/state/snapshot';
import { createSnapshotKeeper } from '../src/state/snapshot-keeper';
import { createSessionStore, type GitHubSource, type PlanState, type SessionStore } from '../src/state/store';
import type { Outline } from '../src/worker/protocol';

/**
 * A GitHub repository as a source (M4 synthesis § 5.5, § 5.7): every place where a new kind of source could lose its
 * edits across a reload (failure mode 14: the source store, the crash snapshot and its keeper, the leave guard, the edit
 * prefetch), its Fetch again, its patch, and what the session sends the engine for it.
 */

const CI = '.github/workflows/ci.yml';
const RELEASE = '.github/workflows/release.yml';
const SNAP = '.github/simulci/tests/__snapshots__/ci.test.snap.json';
const SHA = '3f2a9c1'.padEnd(40, 'a');
const MOVED = '9b1e2c3'.padEnd(40, 'b');
const FILES = { [CI]: 'on: push\n', [RELEASE]: 'on: release\n' };

const repo = (over: Partial<GitHubSource> = {}): GitHubSource => ({
  kind: 'github',
  host: 'github.com',
  owner: 'octo',
  repo: 'ship',
  ref: 'main',
  sha: SHA,
  defaultBranch: 'main',
  private: false,
  readAt: 1,
  ...over,
});

const type = (store: SessionStore, path: string, insert: string, at = 0): void => {
  expect(store.getState().typed(path, [{ from: at, to: at, insert }]).ok).toBe(true);
};

/** A page as boot makes it, over one key-value store: the store, its sources, the crash snapshot's keeper. */
function page(kv = memoryStore(), read?: Partial<{ readRepository: unknown; fetchAgain: unknown }>) {
  const store = createSessionStore();
  const persist = sourceStore(kv);
  const snapshots = snapshotStore(kv);
  const keeper = createSnapshotKeeper({ store, snapshots, now: () => Date.UTC(2026, 9, 30, 14, 5) });
  const sources = createSources({
    store,
    persist,
    load: () => Promise.resolve({ reloadPlan, settledReload, downloadPatch }),
    github: () => Promise.resolve(read as never),
  });
  return { store, persist, snapshots, keeper, sources, kv };
}

describe('a GitHub source across a reload (failure mode 14)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is stored as read, with its fields and snapshots, and comes back without a request', async () => {
    const source = repo();
    const stored = toStored(source, FILES, undefined, undefined, { [SNAP]: '{}' });
    expect(stored).toEqual({
      kind: 'github',
      source,
      buffers: [
        { path: CI, text: FILES[CI] },
        { path: RELEASE, text: FILES[RELEASE] },
      ],
      readonly: { [SNAP]: '{}' },
    });
    const kv = memoryStore();
    await sourceStore(kv).save(source, FILES, undefined, undefined, { [SNAP]: '{}' });
    const fetchAgain = vi.fn();
    const after = page(kv, { readRepository: vi.fn(), fetchAgain });
    await after.sources.restore();
    const s = after.store.getState();
    expect(s.source).toEqual(source);
    expect(s.files.byPath).toEqual(FILES);
    expect(s.files.readonly).toEqual({ [SNAP]: '{}' });
    expect(fetchAgain).not.toHaveBeenCalled();
  });

  it('refuses a stored repository whose fields are not all there', async () => {
    const kv = memoryStore();
    await kv.set('current', { kind: 'github', source: { ...repo(), sha: 7 }, buffers: [] });
    expect(await sourceStore(kv).load()).toBeUndefined();
    await kv.set('current', { kind: 'github', source: repo(), buffers: [] });
    expect(await sourceStore(kv).load()).toMatchObject({ kind: 'github' });
  });

  it('keeps the edits in the crash snapshot keyed by the repository, and brings them back over the stored files', async () => {
    const kv = memoryStore();
    const before = page(kv);
    before.store.getState().setFiles(FILES, repo());
    await before.persist.save(repo(), FILES);
    await vi.advanceTimersByTimeAsync(0);
    type(before.store, CI, '# mine\n');
    expect(before.keeper.pending()).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    const kept = (await before.snapshots.find(repo()))!;
    expect(kept.source).toEqual({ kind: 'github', name: 'github.com/octo/ship' });
    expect(kept.files[CI]?.text).toBe(`# mine\n${FILES[CI]}`);

    // The tab reloads: the stored files as read, then the edits over them.
    const after = page(kv);
    await after.sources.restore();
    await vi.advanceTimersByTimeAsync(0);
    expect(after.store.getState().files.byPath[CI]).toBe(`# mine\n${FILES[CI]}`);
    expect(after.store.getState().files.base[CI]).toBe(FILES[CI]);
    expect(after.store.getState().edit.past.map((t) => t.origin)).toEqual(['restore']);
  });

  it('belongs to its repository at any commit or ref, in any letter case, and to no folder of the same name', async () => {
    const snapshots = snapshotStore(memoryStore());
    const store = createSessionStore();
    store.getState().setFiles(FILES, repo());
    type(store, CI, '# a\n');
    await snapshots.save(snapshotOf(store.getState(), 1)!, repo());
    expect(await snapshots.find(repo({ sha: MOVED, ref: 'v2' }))).toBeDefined();
    expect(await snapshots.find(repo({ owner: 'Octo', repo: 'Ship' }))).toBeDefined();
    expect(await snapshots.find(repo({ repo: 'boat' }))).toBeUndefined();
    expect(await snapshots.find({ kind: 'folder', name: 'github.com/octo/ship', readAt: 0 })).toBeUndefined();
    expect(repoKey(repo({ owner: 'Octo' }))).toBe('github.com/octo/ship');
    expect(keepsSnapshot(repo())).toBe(true);
  });

  it('turns the edits of a file GitHub changed since into a conflict, and brings back the others', async () => {
    const kv = memoryStore();
    const before = page(kv);
    before.store.getState().setFiles(FILES, repo());
    await vi.advanceTimersByTimeAsync(0);
    type(before.store, CI, '# ci\n');
    type(before.store, RELEASE, '# release\n');
    await vi.advanceTimersByTimeAsync(500);

    // The repository is opened again at a commit where ci.yml moved.
    const after = page(kv);
    after.store.getState().setFiles({ ...FILES, [CI]: 'on: [push]\n' }, repo({ sha: MOVED }));
    await vi.advanceTimersByTimeAsync(0);
    const s = after.store.getState();
    expect(s.files.byPath[RELEASE]).toBe(`# release\n${FILES[RELEASE]}`);
    expect(s.edit.restore?.conflicts).toEqual([{ path: CI, text: `# ci\n${FILES[CI]}`, reason: 'changed' }]);
  });

  it('asks before the page is left with unsaved edits', () => {
    const store = createSessionStore();
    const listeners = new Set<unknown>();
    const win = {
      addEventListener: (_: string, l: unknown) => listeners.add(l),
      removeEventListener: (_: string, l: unknown) => listeners.delete(l),
    };
    installLeaveGuard({ store, pending: () => false, flush: () => undefined, win });
    store.getState().setFiles(FILES, repo());
    expect(listeners.size).toBe(0);
    type(store, CI, '# a\n');
    expect(listeners.size).toBe(1);
    store.getState().undo();
    expect(listeners.size).toBe(0);
  });

  it('fetches the edit runtime on idle once its plan shows', () => {
    const store = createSessionStore();
    const load = vi.fn(() => Promise.resolve());
    const idle: (() => void)[] = [];
    installEditPrefetch(store, { load, idle: (run) => idle.push(run) });
    store.getState().setFiles(FILES, repo());
    const { version, epoch } = store.getState().files;
    store.getState().planReceived({ for: { files: version, epoch, project: 1 } } as PlanState);
    idle[0]!();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('says once, at the first edit, that its edits leave as a patch', () => {
    const store = createSessionStore();
    const saver = createSaver({ store, load: () => Promise.reject(new Error('unused')) });
    store.getState().setFiles(FILES, repo());
    type(store, CI, '# a\n');
    type(store, CI, '# b\n');
    expect(store.getState().notices.map((n) => n.text)).toEqual([
      'Read from octo/ship at 3f2a9c1. Download a patch and apply it in your checkout.',
    ]);
    saver.dispose();
  });
});

describe('Fetch again', () => {
  const read = (files: Record<string, string>, sha = MOVED): RepoRead => ({
    source: repo({ sha, readAt: 2 }),
    walked: { files, meta: {}, skipped: [] },
    requests: 3,
  });

  it('says the ref has not moved, and changes nothing', async () => {
    const fetchAgain = vi.fn(() => Promise.resolve({ moved: false, requests: 1 }));
    const { store, sources } = page(memoryStore(), { fetchAgain });
    store.getState().setFiles(FILES, repo());
    await sources.reload();
    expect(fetchAgain).toHaveBeenCalledWith(repo());
    expect(store.getState().source).toEqual(repo());
    expect(store.getState().notices.map((n) => n.text)).toEqual(['octo/ship: up to date (3f2a9c1)']);
  });

  it('takes in what GitHub changed, keeps the edits of the files it did not, and moves the source and what is stored', async () => {
    const changed = { [CI]: 'on: [push]\n', [RELEASE]: FILES[RELEASE] };
    const fetchAgain = vi.fn(() => Promise.resolve({ moved: true, ...read(changed) }));
    const { store, sources, persist } = page(memoryStore(), { fetchAgain });
    store.getState().setFiles(FILES, repo());
    type(store, RELEASE, '# mine\n');
    await sources.reload();
    const s = store.getState();
    expect(s.files.byPath).toEqual({ [CI]: 'on: [push]\n', [RELEASE]: `# mine\n${FILES[RELEASE]}` });
    expect(s.files.base[CI]).toBe('on: [push]\n');
    expect(s.source).toMatchObject({ sha: MOVED, ref: 'main' });
    expect(s.edit.past.at(-1)?.label).toBe('Fetched octo/ship again');
    expect(s.notices.at(-1)?.text).toBe('octo/ship: now at 9b1e2c3');
    expect(await persist.load()).toMatchObject({
      kind: 'github',
      source: { sha: MOVED },
      buffers: [
        { path: CI, text: 'on: [push]\n' },
        { path: RELEASE, text: FILES[RELEASE] },
      ],
    });
  });

  it('asks about a file both sides changed, and moves nothing when the author cancels', async () => {
    const fetchAgain = vi.fn(() =>
      Promise.resolve({ moved: true, ...read({ ...FILES, [CI]: 'on: [push]\n' }) }),
    );
    const store = createSessionStore();
    const settle = vi.fn(() => Promise.resolve(undefined));
    const sources = createSources({
      store,
      persist: sourceStore(memoryStore()),
      settle,
      load: () => Promise.resolve({ reloadPlan, settledReload, downloadPatch }),
      github: () => Promise.resolve({ fetchAgain } as never),
    });
    store.getState().setFiles(FILES, repo());
    type(store, CI, '# mine\n');
    await sources.reload();
    expect(settle).toHaveBeenCalledWith('fetch', 'octo/ship', [expect.objectContaining({ path: CI })]);
    expect(store.getState().source.kind === 'github' && store.getState().source).toMatchObject({ sha: SHA });
    expect(store.getState().files.byPath[CI]).toBe(`# mine\n${FILES[CI]}`);
  });

  it('says why it failed, and keeps the files', async () => {
    const fetchAgain = vi.fn(() =>
      Promise.reject(
        new Error(
          'GitHub allows 60 requests an hour without signing in; this browser has used them. They reset at 14:05.',
        ),
      ),
    );
    const { store, sources } = page(memoryStore(), { fetchAgain });
    store.getState().setFiles(FILES, repo());
    await sources.reload();
    expect(store.getState().error).toMatchObject({
      kind: 'source',
      message: expect.stringMatching(/^GitHub allows 60/),
    });
    expect(store.getState().files.byPath).toEqual(FILES);
  });
});

describe('opening a repository', () => {
  it('reads it before the replace prompt asks, so a failed read loses nothing', async () => {
    const readRepository = vi.fn(() =>
      Promise.reject(new Error('octo/boat is not a public repository on GitHub')),
    );
    const ask = vi.fn(() => Promise.resolve('discard' as const));
    const store = createSessionStore();
    const sources = createSources({
      store,
      persist: sourceStore(memoryStore()),
      ask,
      github: () => Promise.resolve({ readRepository } as never),
    });
    store.getState().setFiles(FILES, { kind: 'folder', name: 'repo', readAt: 0 });
    type(store, CI, '# mine\n');
    expect(await sources.openGitHub({ owner: 'octo', repo: 'boat' })).toEqual({
      ok: false,
      message: 'octo/boat is not a public repository on GitHub',
    });
    expect(ask).not.toHaveBeenCalled();
    expect(store.getState().files.byPath[CI]).toBe(`# mine\n${FILES[CI]}`);
  });

  it('opens what it read once the prompt lets the edits go, and says why files were refused', async () => {
    const opened: RepoRead = {
      source: repo(),
      walked: { files: { ...FILES, [SNAP]: '{}' }, meta: {}, skipped: [] },
      requests: 6,
      rate: '54 of 60 requests left this hour',
    };
    const readRepository = vi
      .fn()
      .mockResolvedValueOnce(opened)
      .mockResolvedValueOnce({
        ...opened,
        walked: { files: {}, meta: {}, skipped: [] },
      });
    const { store, sources, persist } = page(memoryStore(), { readRepository });
    expect(await sources.openGitHub({ owner: 'octo', repo: 'ship' })).toEqual({
      ok: true,
      requests: 6,
      rate: '54 of 60 requests left this hour',
    });
    expect(store.getState().source).toEqual(repo());
    expect(store.getState().files.readonly).toEqual({ [SNAP]: '{}' });
    expect(await persist.load()).toMatchObject({ kind: 'github', source: repo() });
    expect(await sources.openGitHub({ owner: 'octo', repo: 'ship' })).toEqual({
      ok: false,
      message: expect.stringMatching(/^no workflow files in octo\/ship at 3f2a9c1: looked for/),
      requests: 6,
    });
    expect(store.getState().error).toBeUndefined();
  });
});

describe('what the page says of a GitHub source', () => {
  it('names its patch, its first line and the commands that apply it', () => {
    const source = repo();
    expect(repoAt(source)).toBe('octo/ship @ main (3f2a9c1)');
    expect(patchName(source)).toBe('octo-ship-3f2a9c1.patch');
    expect(patchName({ kind: 'sample', name: 'starter' })).toBe('simulci-changes.patch');
    expect(patchPreamble(source)).toBe('simulci: changes against octo/ship@3f2a9c1 (main)');
    expect(patchPreamble({ kind: 'none' })).toBeUndefined();
    expect(applyCommands(source)).toBe(
      'git fetch origin && git switch -c simulci-edits 3f2a9c1 && git apply octo-ship-3f2a9c1.patch',
    );
    expect(githubNote(source)).toBe(
      'Read from octo/ship at 3f2a9c1. Download a patch and apply it in your checkout.',
    );
  });

  it('sends the engine its repository and default branch, unless the scenario names them', () => {
    const source = repo({ defaultBranch: 'trunk' });
    expect(scenarioFor({ event: 'push' }, source)).toEqual({
      event: 'push',
      repository: 'octo/ship',
      defaultBranch: 'trunk',
    });
    expect(scenarioFor({ event: 'push', repository: 'a/b', defaultBranch: 'dev' }, source)).toEqual({
      event: 'push',
      repository: 'a/b',
      defaultBranch: 'dev',
    });
    const plain = { event: 'push' };
    expect(scenarioFor(plain, { kind: 'sample', name: 'starter' })).toBe(plain);
  });

  it("defaults a push and a pull request's base to its default branch", () => {
    const outline = {
      workflows: [{ path: CI, events: [{ event: 'push' }], callable: false }],
    } as unknown as Outline;
    expect(defaultScenario(outline, defaultBranchOf(repo({ defaultBranch: 'trunk' }))).scenario).toEqual({
      event: 'push',
      branch: 'trunk',
    });
    expect(defaultScenario(outline, defaultBranchOf({ kind: 'none' })).scenario).toEqual({
      event: 'push',
      branch: 'main',
    });
  });
});
