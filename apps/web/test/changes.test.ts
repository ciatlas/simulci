import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { rowsOf, diffOf } from '../src/app/DiffView';
import { PATCH_NAME } from '../src/lib/repo-words';
import { changedPaths, downloadPatch, patchFiles, revertOf, type Since } from '../src/state/changes';
import { createSessionStore, dirtyPaths, type SessionStore } from '../src/state/store';

const CI = '.github/workflows/ci.yml';
const RELEASE = '.github/workflows/release.yml';
const NEW = '.github/workflows/new.yml';

/** A folder of two files, the first read with a BOM and CRLF. */
function folder(): SessionStore {
  const store = createSessionStore();
  store
    .getState()
    .setFiles(
      { [CI]: 'name: CI\r\non: push\r\n', [RELEASE]: 'on: release\n' },
      { kind: 'folder', name: 'repo', readAt: 0 },
      { [CI]: { bom: true, eol: 'crlf', utf8: true } },
    );
  return store;
}

/** Edits a file through the history, as an op would. */
function rewrite(store: SessionStore, path: string, text: string | null): void {
  const now = store.getState().files.byPath[path];
  const ok = store.getState().transact({
    label: 'Op',
    origin: 'op',
    files: [
      now === undefined
        ? { path, edits: [{ from: 0, to: 0, insert: text ?? '' }], create: true }
        : text === null
          ? { path, edits: [], remove: true }
          : { path, edits: [{ from: 0, to: now.length, insert: text }] },
    ],
  }).ok;
  expect(ok).toBe(true);
}

function revert(store: SessionStore, path: string, since: Since = 'base'): void {
  const tx = revertOf(store.getState().files, path, since);
  expect(tx?.origin).toBe('revert');
  expect(store.getState().transact(tx!).ok).toBe(true);
}

describe('changedPaths', () => {
  it('lists edited, created and removed files against the last save or the open, sorted', () => {
    const store = folder();
    rewrite(store, RELEASE, null);
    rewrite(store, NEW, 'on: push\n');
    rewrite(store, CI, 'name: CI\r\non: [push]\r\n');
    const { files } = store.getState();
    expect(changedPaths(files, 'base')).toEqual([CI, NEW, RELEASE]);
    // A save (A7) moves the base and leaves the open texts: since open still lists the file.
    const saved = { ...files, base: { ...files.base, [CI]: files.byPath[CI]! } };
    expect(changedPaths(saved, 'base')).toEqual([NEW, RELEASE]);
    expect(changedPaths(saved, 'opened')).toEqual([CI, NEW, RELEASE]);
  });
});

describe('patchFiles and downloadPatch', () => {
  it('give each side as a file holds it, the BOM back on both, and one download for every file', () => {
    const store = folder();
    rewrite(store, CI, 'name: CI\r\non: [push]\r\n');
    rewrite(store, NEW, 'on: push\n');
    const { files } = store.getState();
    const paths = changedPaths(files, 'base');
    expect(patchFiles(files, paths, 'base')).toEqual([
      { path: CI, before: '﻿name: CI\r\non: push\r\n', after: '﻿name: CI\r\non: [push]\r\n' },
      { path: NEW, before: undefined, after: 'on: push\n' },
    ]);
    const downloads: [string, string][] = [];
    downloadPatch(files, paths, 'base', store.getState().source, (name, text) =>
      downloads.push([name, text]),
    );
    expect(downloads).toHaveLength(1);
    expect(downloads[0]![0]).toBe(PATCH_NAME);
    expect(downloads[0]![1]).toMatch(/^diff --git /);
    expect(downloads[0]![1]).toContain(' ﻿name: CI\r\n-on: push\r\n+on: [push]\r\n');
    expect(downloads[0]![1]).toContain(`--- /dev/null\n+++ b/${NEW}\n`);
  });

  it("names a GitHub repository's patch for it and its commit, and opens it with a line naming them", () => {
    const store = folder();
    rewrite(store, NEW, 'on: push\n');
    const source = {
      kind: 'github',
      host: 'github.com',
      owner: 'octo',
      repo: 'ship',
      ref: 'main',
      sha: '3f2a9c1d'.padEnd(40, '0'),
      defaultBranch: 'main',
      private: false,
      readAt: 0,
    } as const;
    const { files } = store.getState();
    const downloads: [string, string][] = [];
    downloadPatch(files, changedPaths(files, 'base'), 'base', source, (name, text) =>
      downloads.push([name, text]),
    );
    expect(downloads[0]![0]).toBe('octo-ship-3f2a9c1.patch');
    expect(downloads[0]![1]).toMatch(/^simulci: changes against octo\/ship@3f2a9c1 \(main\)\ndiff --git /);
  });
});

describe('revert', () => {
  it('puts a file back as one undoable entry; undo brings the edit back and redo the same bytes', () => {
    const store = folder();
    rewrite(store, CI, 'name: CI\r\non: [push, pull_request]\r\n');
    const edited = store.getState().files.byPath[CI];
    revert(store, CI);
    const s = () => store.getState();
    expect(s().files.byPath[CI]).toBe(s().files.base[CI]);
    expect(dirtyPaths(s().files)).toEqual([]);
    expect(s().edit.past.at(-1)).toMatchObject({ label: 'Reverted ci.yml', origin: 'revert' });
    expect(s().undo()).toBe(true);
    expect(s().files.byPath[CI]).toBe(edited);
    expect(s().redo()).toBe(true);
    expect(s().files.byPath[CI]).toBe('name: CI\r\non: push\r\n');
    expect(dirtyPaths(s().files)).toEqual([]);
  });

  it('removes a file created since, and brings back one removed since with what reading found', () => {
    const store = folder();
    rewrite(store, NEW, 'on: push\n');
    rewrite(store, CI, null);
    revert(store, NEW);
    revert(store, CI);
    const { files } = store.getState();
    expect(dirtyPaths(files)).toEqual([]);
    expect(files.byPath[CI]).toBe('name: CI\r\non: push\r\n');
    expect(files.meta[CI]).toEqual({ bom: true, eol: 'crlf', utf8: true });
    expect(store.getState().undo()).toBe(true);
    expect(store.getState().files.byPath[CI]).toBeUndefined();
  });

  it('gives nothing to do for a file as it was', () => {
    expect(revertOf(folder().getState().files, CI, 'base')).toBeUndefined();
  });

  it('after any edits: clean, then undo and redo give the same bytes each way', () => {
    const edit = fc.record({
      at: fc.nat(),
      cut: fc.nat({ max: 5 }),
      insert: fc.constantFrom('', 'x', '\r\n', 'jobs:\r\n'),
    });
    fc.assert(
      fc.property(fc.array(edit, { minLength: 1, maxLength: 8 }), (edits) => {
        const store = folder();
        const s = () => store.getState();
        for (const { at, cut, insert } of edits) {
          const text = s().files.byPath[CI]!;
          const from = at % (text.length + 1);
          s().transact({
            label: 'Op',
            origin: 'op',
            files: [{ path: CI, edits: [{ from, to: Math.min(text.length, from + cut), insert }] }],
          });
        }
        const edited = s().files.byPath[CI];
        if (edited === s().files.base[CI]) return;
        revert(store, CI);
        expect(s().files.byPath[CI]).toBe(s().files.base[CI]);
        s().undo();
        expect(s().files.byPath[CI]).toBe(edited);
        s().redo();
        expect(s().files.byPath[CI]).toBe(s().files.base[CI]);
      }),
    );
  });
});

describe('the drawn diff', () => {
  it('stops after its line cap and says how many lines it left out', () => {
    const before = Array.from({ length: 30 }, (_, i) => `${i}\n`).join('');
    const diff = diffOf(before, undefined);
    expect(diff).toMatchObject({ added: 0, removed: 30 });
    const { rows, hidden } = rowsOf(diff, 10);
    expect(rows.map((r) => r.text)).toEqual([
      '@@ -1,30 +0,0 @@',
      ...Array.from({ length: 10 }, (_, i) => `-${i}`),
    ]);
    expect(hidden).toBe(20);
  });

  it('says when a last line has no line break, and leaves CRLF off the drawn line', () => {
    const { rows } = rowsOf(diffOf('a\r\nb', 'a\r\nc'));
    expect(rows.map((r) => r.text)).toEqual([
      '@@ -1,2 +1,2 @@',
      ' a',
      '-b',
      '\\ No newline at end of file',
      '+c',
      '\\ No newline at end of file',
    ]);
  });
});
