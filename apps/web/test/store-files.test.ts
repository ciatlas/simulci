import { describe, expect, it } from 'vitest';
import type { GraphState } from '../src/graph/types';
import { createSessionStore, type PlanState, remotePool, remotePoolKey, withTexts } from '../src/state/store';

const CI = '.github/workflows/ci.yml';
const RELEASE = '.github/workflows/release.yml';
const FOLDER = { kind: 'folder', name: 'repo', readAt: 0 } as const;

/** A store showing a plan and a picture of the starter's two workflows, with a node selected. */
function showing() {
  const store = createSessionStore();
  const a = store.getState();
  a.setFiles({ [CI]: 'on: push', [RELEASE]: 'on: release' }, FOLDER, {
    [CI]: { bom: true, eol: 'none', utf8: true },
  });
  const { epoch, version } = store.getState().files;
  const plan = { for: { files: version, epoch, project: 1 } } as PlanState;
  a.planReceived(plan);
  a.graphReady({ for: plan.for } as GraphState);
  a.select(CI, 'build');
  return { store, plan };
}

describe('the files in the store', () => {
  it('starts a new epoch with a new source, every file at the new version, as read and as opened', () => {
    const { store } = showing();
    const first = store.getState().files;
    expect(first).toMatchObject({ version: 1, epoch: 1, revs: { [CI]: 1, [RELEASE]: 1 } });
    expect(first.base).toEqual(first.byPath);
    expect(first.opened).toEqual(first.byPath);
    store.getState().setFiles({ [CI]: 'on: [push]' }, { kind: 'sample', name: 'starter' });
    const next = store.getState();
    expect(next.files).toMatchObject({
      version: 2,
      epoch: 2,
      byPath: { [CI]: 'on: [push]' },
      revs: { [CI]: 2 },
      base: { [CI]: 'on: [push]' },
      opened: { [CI]: 'on: [push]' },
    });
    expect([next.plan, next.graph, next.stale]).toEqual([undefined, undefined, false]);
  });

  it('moves the version and the edited files’ revs within the epoch, and keeps the screen', () => {
    const { store, plan } = showing();
    const before = store.getState();
    store.setState((s) => withTexts(s, { [CI]: 'on: [push]', [RELEASE]: 'on: release' }));
    const after = store.getState();
    expect(after.files).toMatchObject({
      version: 2,
      epoch: 1,
      byPath: { [CI]: 'on: [push]', [RELEASE]: 'on: release' },
      revs: { [CI]: 2, [RELEASE]: 1 },
    });
    // What was read and opened stays, and so does what reading found.
    expect(after.files.base).toBe(before.files.base);
    expect(after.files.opened).toBe(before.files.opened);
    expect(after.files.meta).toEqual(before.files.meta);
    // The plan of the old texts, its picture, the selection and the scenario stay: the plan is stale for the edit.
    expect(after.plan).toBe(plan);
    expect(after.graph).toBe(before.graph);
    expect([after.focus, after.sel, after.scenario]).toEqual([CI, 'build', before.scenario]);
    expect(after.stale).toBe('edit');
    // The next edit moves only what it changes; a new path gets the meta of a string and no base.
    store.setState((s) => withTexts(s, { [RELEASE]: 'on: [release]', 'action.yml': 'runs: {}' }));
    expect(store.getState().files).toMatchObject({
      version: 3,
      epoch: 1,
      revs: { [CI]: 2, [RELEASE]: 3, 'action.yml': 3 },
      meta: { 'action.yml': { bom: false, eol: 'none', utf8: true } },
    });
    expect(store.getState().files.base).not.toHaveProperty('action.yml');
  });

  it('moves nothing for texts the files already hold, and keeps no plan stale that is not there', () => {
    const { store } = showing();
    const files = store.getState().files;
    store.setState((s) => withTexts(s, { [CI]: 'on: push' }));
    expect(store.getState().files).toBe(files);
    store.getState().forgetSource();
    store.getState().setFiles({ [CI]: 'on: push' }, FOLDER);
    store.setState((s) => withTexts(s, { [CI]: 'on: [push]' }));
    expect(store.getState().stale).toBe(false);
  });

  it('says which change left the plan behind: the inputs, the texts, and none once a plan of the texts comes', () => {
    const { store, plan } = showing();
    store.getState().patchScenario({ branch: 'dev' });
    expect(store.getState().stale).toBe('inputs');
    store.setState((s) => withTexts(s, { [CI]: 'on: [push]' }));
    expect(store.getState().stale).toBe('edit');
    // The plan of an input changed while the edit loaded is of the old texts: it is still behind the edit.
    store.getState().planReceived({ ...plan, for: { ...plan.for } });
    expect(store.getState().stale).toBe('edit');
    store.getState().planReceived({ ...plan, for: { ...plan.for, files: 2 } });
    expect(store.getState().stale).toBe(false);
  });

  it('starts a new epoch when the source goes, and when a stored folder waits for Reopen', () => {
    const { store } = showing();
    store.setState((s) => withTexts(s, { [CI]: 'on: [push]' }));
    store.getState().forgetSource();
    expect(store.getState()).toMatchObject({
      source: { kind: 'none' },
      files: { version: 3, epoch: 2, byPath: {}, meta: {}, revs: {}, base: {}, opened: {} },
      focus: undefined,
      sel: undefined,
      plan: undefined,
    });
    store.getState().awaitReopen(FOLDER);
    expect(store.getState()).toMatchObject({
      source: FOLDER,
      files: { version: 4, epoch: 3, byPath: {}, meta: {}, revs: {}, base: {}, opened: {} },
      project: { status: 'idle' },
    });
  });
});

describe('the remotes in the store', () => {
  const SHA = 'a'.repeat(40);
  const NEED = { ref: 'octo/act@v2', kind: 'action', depth: 1 } as const;

  it('pools what was read by ref and commit, beside the files, and sends nothing before consent', () => {
    const store = createSessionStore();
    const a = store.getState();
    a.setFiles({ [CI]: 'on: push' }, FOLDER);
    const files = store.getState().files;
    a.setRemotesNeeded([NEED]);
    a.remotesFetching();
    // A failed resolve, then the ref read at the commit resolved: the success replaces the failure.
    a.remotesRead({ sources: [], failed: [{ ...NEED, failure: 'timeout', message: 'slow' }] }, false);
    const source = {
      ref: NEED.ref,
      kind: NEED.kind,
      sha: SHA,
      text: 'name: act',
      pinned: 'resolved',
    } as const;
    a.remotesRead({ sources: [source], failed: [] }, true);
    const { remotes } = store.getState();
    expect(remotes).toMatchObject({ status: 'done', consent: 'none', failed: {}, needed: [NEED] });
    expect(remotes.byKey).toEqual({ [remotePoolKey(NEED.ref, SHA)]: source });
    // No pane tab, no dirty state: the files did not move.
    expect(store.getState().files).toBe(files);
    expect(remotePool(remotes)).toBeUndefined();
    a.consentRemotes();
    expect(remotePool(store.getState().remotes)).toEqual({ sources: [source], failed: [] });
    // A new source keeps what was read and needs nothing until its load says so.
    a.setFiles({ [RELEASE]: 'on: release' }, FOLDER);
    expect(store.getState().remotes).toMatchObject({ byKey: remotes.byKey, needed: [], consent: 'page' });
  });
});
