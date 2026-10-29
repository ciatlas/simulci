import { describe, expect, it } from 'vitest';
import { createSaver } from '../src/app/saver';
import { readFolder } from '../src/input/folder';
import { textMeta } from '../src/input/read';
import type { Choices, DiskConflict } from '../src/input/save';
import { createSources } from '../src/input/sources';
import { memoryStore } from '../src/lib/idb';
import { sourceStore } from '../src/state/persist';
import { reloadPlan, settledReload } from '../src/state/reload';
import { createSessionStore, dirtyPaths, type SessionStore } from '../src/state/store';
import { fakeFolder, withBom } from './fake-folder';

/**
 * Reload from disk (synthesis § 5.7, § 9.4 row 13): per file, the folder's change against the base and the author's
 * against the base decide. Unchanged on disk keeps the author's text; changed and clean takes the disk; changed and
 * edited is a conflict. What is taken is one undoable `disk` entry.
 */

const W = '.github/workflows';
const meta = textMeta('a\n');

/** The files as `setFiles` leaves them, then texts typed over some. */
function filesOf(base: Record<string, string>, here: Record<string, string | null> = {}) {
  const byPath = { ...base };
  for (const [path, text] of Object.entries(here))
    if (text === null) delete byPath[path];
    else byPath[path] = text;
  const metas = Object.fromEntries(Object.keys({ ...base, ...byPath }).map((p) => [p, meta]));
  return { byPath, base, meta: metas };
}

const read = (files: Record<string, string>, skipped: string[] = []) => ({
  files,
  meta: Object.fromEntries(Object.keys(files).map((p) => [p, textMeta(files[p]!)])),
  skipped: skipped.map((path) => ({ path, bytes: 3 * 1024 * 1024 })),
});

describe('the three-way reload', () => {
  it('decides each file by what the folder and the author changed since it was read', () => {
    const base = {
      [`${W}/same-clean.yml`]: 'a\n',
      [`${W}/same-edited.yml`]: 'a\n',
      [`${W}/changed-clean.yml`]: 'a\n',
      [`${W}/changed-edited.yml`]: 'a\n',
      [`${W}/changed-alike.yml`]: 'a\n',
      [`${W}/gone-clean.yml`]: 'a\n',
      [`${W}/gone-edited.yml`]: 'a\n',
      [`${W}/big.yml`]: 'a\n',
    };
    const files = filesOf(base, {
      [`${W}/same-edited.yml`]: 'mine\n',
      [`${W}/changed-edited.yml`]: 'mine\n',
      [`${W}/changed-alike.yml`]: 'both\n',
      [`${W}/gone-edited.yml`]: 'mine\n',
      [`${W}/created-here.yml`]: 'new here\n',
      [`${W}/created-both.yml`]: 'new here\n',
    });
    const disk = read(
      {
        [`${W}/same-clean.yml`]: 'a\n',
        [`${W}/same-edited.yml`]: 'a\n',
        [`${W}/changed-clean.yml`]: 'theirs\n',
        [`${W}/changed-edited.yml`]: 'theirs\n',
        [`${W}/changed-alike.yml`]: 'both\n',
        [`${W}/created-both.yml`]: 'new there\n',
        [`${W}/new-there.yml`]: 'theirs\n',
      },
      [`${W}/big.yml`],
    );
    const plan = reloadPlan(files, disk);
    const d = (text: string) => ({ text, meta: textMeta(text) });
    expect(plan.disk).toEqual({
      [`${W}/changed-alike.yml`]: d('both\n'),
      [`${W}/changed-clean.yml`]: d('theirs\n'),
      [`${W}/changed-edited.yml`]: d('theirs\n'),
      [`${W}/created-both.yml`]: d('new there\n'),
      [`${W}/gone-clean.yml`]: null,
      [`${W}/gone-edited.yml`]: null,
      [`${W}/new-there.yml`]: d('theirs\n'),
    });
    expect(plan.take).toEqual([
      `${W}/changed-alike.yml`,
      `${W}/changed-clean.yml`,
      `${W}/gone-clean.yml`,
      `${W}/new-there.yml`,
    ]);
    expect(plan.conflicts).toEqual([
      {
        path: `${W}/changed-edited.yml`,
        reason: 'changed-on-disk',
        mine: 'mine\n',
        base: 'a\n',
        disk: d('theirs\n'),
      },
      { path: `${W}/created-both.yml`, reason: 'exists', mine: 'new here\n', disk: d('new there\n') },
      { path: `${W}/gone-edited.yml`, reason: 'deleted-on-disk', mine: 'mine\n', base: 'a\n' },
    ]);
  });

  it('compares the route tests too: one created here stays, one gone from the folder is gone, one changed is taken', () => {
    const T = '.github/simulci/tests';
    const base = { [`${W}/ci.yml`]: 'a\n', [`${T}/ci.test.yml`]: 'a\n', [`${T}/gone.test.yml`]: 'a\n' };
    const files = filesOf(base, { [`${T}/nested/new.test.yml`]: 'new here\n' });
    const disk = read({ [`${W}/ci.yml`]: 'a\n', [`${T}/ci.test.yml`]: 'b\n' });
    const plan = reloadPlan(files, disk);
    expect(plan.disk).toEqual({
      [`${T}/ci.test.yml`]: { text: 'b\n', meta: textMeta('b\n') },
      [`${T}/gone.test.yml`]: null,
    });
    expect(plan.take).toEqual([`${T}/ci.test.yml`, `${T}/gone.test.yml`]);
    expect(plan.conflicts).toEqual([]);
  });

  it('takes a BOM added on disk as a change of a clean file', () => {
    const files = filesOf({ [`${W}/ci.yml`]: 'a\n' });
    const plan = reloadPlan(files, {
      files: { [`${W}/ci.yml`]: 'a\n' },
      meta: { [`${W}/ci.yml`]: { ...meta, bom: true } },
      skipped: [],
    });
    expect(plan.take).toEqual([`${W}/ci.yml`]);
  });

  it('keeps, takes or skips each conflict as the author chose', () => {
    const conflict = (path: string): DiskConflict => ({
      path,
      reason: 'changed-on-disk',
      base: 'a\n',
      mine: 'm\n',
      disk: { text: 'd\n', meta },
    });
    const plan = {
      disk: {
        a: { text: 'd\n', meta },
        b: { text: 'd\n', meta },
        c: { text: 'd\n', meta },
        t: { text: 'd\n', meta },
      },
      take: ['t'],
      conflicts: [conflict('a'), conflict('b'), conflict('c')],
      from: { a: 'm\n', b: 'm\n', c: 'm\n', t: 'a\n' },
      readonly: {},
    };
    const stamp = '';
    const choices: Choices = {
      a: { choice: 'disk', stamp },
      b: { choice: 'mine', stamp },
      c: { choice: 'skip', stamp },
    };
    expect(settledReload(plan, choices)).toEqual({
      disk: { a: { text: 'd\n', meta }, b: { text: 'd\n', meta }, t: { text: 'd\n', meta } },
      take: ['t', 'a'],
      from: { a: 'm\n', b: 'm\n', c: 'm\n', t: 'a\n' },
    });
  });
});

const CI = `${W}/ci.yml`;
const DEPLOY = `${W}/deploy.yml`;
const LINT = `${W}/lint.yml`;

/** A folder opened from a fake handle, with sources whose conflicts the test answers. */
async function opened(tree: Record<string, string | Uint8Array<ArrayBuffer>>) {
  const fake = fakeFolder(tree);
  const store = createSessionStore();
  const saver = createSaver({ store, now: () => 0 });
  const sources = createSources({
    store,
    persist: sourceStore(memoryStore()),
    save: () => saver.save(),
    settle: (mode, folder, conflicts) => saver.settle(mode, folder, conflicts),
  });
  const walked = await readFolder(fake.handle);
  store
    .getState()
    .setFiles(walked.files, { kind: 'folder', name: 'repo', handle: fake.handle, readAt: 0 }, walked.meta);
  return { fake, store, sources, saver, s: () => store.getState() };
}

const edit = (store: SessionStore, path: string, insert = '# mine\n'): void => {
  expect(
    store
      .getState()
      .transact({ label: 'Op', origin: 'op', files: [{ path, edits: [{ from: 0, to: 0, insert }] }] }).ok,
  ).toBe(true);
};

const asked = (store: SessionStore) =>
  new Promise<DiskConflict[]>((resolve) => {
    const stop = store.subscribe((s) => {
      if (!s.settling) return;
      stop();
      resolve(s.settling.conflicts);
    });
  });

describe('Reload from disk', () => {
  it('takes in what changed on disk as one undoable entry, and keeps the edits of files the disk did not change', async () => {
    const { fake, sources, store, s } = await opened({ [CI]: 'a\n', [DEPLOY]: 'b\n' });
    edit(store, CI);
    const epoch = s().files.epoch;
    fake.set(DEPLOY, 'theirs\n');
    fake.set(LINT, 'new\n');
    await sources.reload();
    expect(s().files.epoch).toBe(epoch);
    expect(s().files.byPath).toEqual({ [CI]: '# mine\na\n', [DEPLOY]: 'theirs\n', [LINT]: 'new\n' });
    expect(s().files.base).toEqual({ [CI]: 'a\n', [DEPLOY]: 'theirs\n', [LINT]: 'new\n' });
    expect(dirtyPaths(s().files)).toEqual([CI]);
    expect(s().edit.past.at(-1)).toMatchObject({ origin: 'disk', label: 'Reloaded repo' });
    // Undo takes the folder's texts back out; they are then unsaved against the folder.
    expect(s().undo()).toBe(true);
    expect(s().files.byPath).toEqual({ [CI]: '# mine\na\n', [DEPLOY]: 'b\n' });
    expect(dirtyPaths(s().files).sort()).toEqual([CI, DEPLOY, LINT]);
  });

  it('asks about the files both changed, and does nothing when the author cancels', async () => {
    const { fake, sources, store, saver, s } = await opened({ [CI]: 'a\n', [DEPLOY]: 'b\n' });
    edit(store, CI);
    fake.set(CI, 'theirs\n');
    fake.set(DEPLOY, 'theirs\n');
    const reloading = sources.reload();
    const conflicts = await asked(store);
    expect(s().settling).toMatchObject({ mode: 'reload', folder: 'repo' });
    expect(conflicts.map((c) => [c.path, c.reason])).toEqual([[CI, 'changed-on-disk']]);
    const before = s().files;
    saver.answer(undefined);
    await reloading;
    expect(s().files).toBe(before);
  });

  it('keeps mine over the folder’s new base, so the next save writes it without asking', async () => {
    const { fake, sources, store, saver, s } = await opened({
      [CI]: withBom('a\n'),
      [DEPLOY]: 'b\n',
      [LINT]: 'c\n',
    });
    for (const path of [CI, DEPLOY, LINT]) {
      edit(store, path);
      fake.set(path, 'theirs\n');
    }
    const reloading = sources.reload();
    const conflicts = await asked(store);
    const stamp = (c: DiskConflict) => c.stamp ?? '';
    const [ci, deploy, lint] = conflicts;
    saver.answer({
      [CI]: { choice: 'mine', stamp: stamp(ci!) },
      [DEPLOY]: { choice: 'disk', stamp: stamp(deploy!) },
      [LINT]: { choice: 'skip', stamp: stamp(lint!) },
    });
    await reloading;
    expect(s().files.byPath).toEqual({ [CI]: '# mine\na\n', [DEPLOY]: 'theirs\n', [LINT]: '# mine\nc\n' });
    expect(s().files.base).toEqual({ [CI]: 'theirs\n', [DEPLOY]: 'theirs\n', [LINT]: 'c\n' });
    // Mine keeps its encoding and line endings; it takes the folder's BOM, which a save writes back.
    expect(s().files.meta[CI]).toEqual({ bom: false, eol: 'lf', utf8: true });
    const saving = saver.save();
    // Only the skipped file asks again.
    const again = await asked(store);
    expect(again.map((c) => c.path)).toEqual([LINT]);
    saver.answer({ [LINT]: { choice: 'mine', stamp: stamp(again[0]!) } });
    expect(await saving).toBe(true);
    expect(fake.written).toEqual([CI, LINT]);
    expect(fake.text(CI)).toBe('# mine\na\n');
  });

  it('says so when the folder holds what was read', async () => {
    const { sources, store, s } = await opened({ [CI]: 'a\n' });
    edit(store, CI);
    const before = s().files;
    await sources.reload();
    expect(s().files).toBe(before);
    expect(s().notices.map((n) => n.text)).toEqual(['repo: no changes']);
  });
});
