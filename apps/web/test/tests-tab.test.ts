/**
 * The Tests tab's state (synthesis § 5.1): the snapshots beside the files, read-only; the run and the "As CI" switch;
 * a case loaded into the scenario as a pin; the header's words; the tab as a preference; and the worker's request.
 */
import { describe, expect, it } from 'vitest';
import { headerOf, opensOnFailures } from '../src/panels/tests/words';
import { readPrefs } from '../src/state/prefs';
import { toStored } from '../src/state/persist';
import { reloadPlan } from '../src/state/reload';
import { createSessionStore, dirtyPaths, withTexts } from '../src/state/store';
import { isEngineRequest } from '../src/worker/protocol';

const CI = '.github/workflows/ci.yml';
const TEST = '.github/simulci/tests/ci.test.yml';
const SNAP = '.github/simulci/tests/__snapshots__/ci.test.snap.json';
const source = { kind: 'folder', name: 'repo', readAt: 1 } as const;

describe('the snapshots beside the files', () => {
  it('stay out of the texts: never dirty, kept through an edit, replaced on Reload of the same epoch only', () => {
    const store = createSessionStore();
    store
      .getState()
      .setFiles({ [CI]: 'on: push', [TEST]: 'workflow: ci.yml' }, source, undefined, undefined, {
        [SNAP]: '{}',
      });
    const files = store.getState().files;
    expect(files.readonly).toEqual({ [SNAP]: '{}' });
    expect(files.byPath[SNAP]).toBeUndefined();
    expect(dirtyPaths(files)).toEqual([]);
    expect(withTexts(store.getState(), { [CI]: 'on: [push]' }).files?.readonly).toEqual({ [SNAP]: '{}' });
    store.getState().setReadonly(files.epoch + 1, { [SNAP]: '[]' });
    expect(store.getState().files.readonly).toEqual({ [SNAP]: '{}' });
    store.getState().setReadonly(files.epoch, { [SNAP]: '[]' });
    expect(store.getState().files).toMatchObject({ version: files.version, readonly: { [SNAP]: '[]' } });
    store.getState().setReadonly(files.epoch, {});
    expect(store.getState().files.readonly).toBeUndefined();
    store.getState().setFiles({ [CI]: 'on: push' }, source);
    expect(store.getState().files.readonly).toBeUndefined();
  });

  it('come from the folder on Reload, never as files to take in', () => {
    const meta = { [CI]: { bom: false, eol: 'none', utf8: true } as const };
    const files = { byPath: { [CI]: 'on: push' }, base: { [CI]: 'on: push' }, meta };
    const plan = reloadPlan(files, { files: { [CI]: 'on: push', [SNAP]: '{}' }, meta, skipped: [] });
    expect(plan.disk).toEqual({});
    expect(plan.readonly).toEqual({ [SNAP]: '{}' });
  });

  it('are kept with a stored copy, and only with a copy', () => {
    expect(
      toStored({ kind: 'folder', name: 'repo', readAt: 1 }, { [CI]: 'x' }, undefined, undefined, {
        [SNAP]: '{}',
      }),
    ).toMatchObject({ kind: 'copy', readonly: { [SNAP]: '{}' } });
    expect(toStored({ kind: 'sample', name: 'starter' }, {}, undefined, undefined, { [SNAP]: '{}' })).toEqual(
      {
        kind: 'sample',
        name: 'starter',
      },
    );
  });
});

describe('the run and the switch', () => {
  const run = {
    files: [],
    summary: { passed: 14, failed: 1, invalid: 0, skipped: 0 },
    exitCode: 1 as const,
    ms: 3,
    for: { project: 1, files: 1, ci: true, digest: '3f2a9c1' },
  };

  it('keep the switch through new files, and forget the run', () => {
    const store = createSessionStore();
    expect(store.getState().tests).toEqual({ ci: true, status: 'idle' });
    store.getState().setTestsCi(false);
    store.getState().testsRunning();
    store.getState().testsReceived(run);
    expect(store.getState().tests).toEqual({ ci: false, status: 'done', run });
    store.getState().testsRunning();
    store.getState().testsFailed('boom');
    expect(store.getState().tests).toMatchObject({ status: 'failed', error: 'boom', run });
    store.getState().setFiles({ [CI]: 'on: push' }, source);
    expect(store.getState().tests).toEqual({ ci: false, status: 'idle' });
    store.getState().testsReceived(run);
    store.getState().testsCleared();
    expect(store.getState().tests).toEqual({ ci: false, status: 'idle' });
  });

  it('word the header as the synthesis does, naming skipped cases only when there are some', () => {
    expect(headerOf(run)).toBe('14 passed · 1 failed · 0 invalid · ran as CI on 3f2a9c1');
    expect(headerOf({ summary: { ...run.summary, skipped: 2 }, for: { ...run.for, ci: false } })).toBe(
      '14 passed · 1 failed · 0 invalid · 2 skipped · ran locally on 3f2a9c1',
    );
    const failure = { status: 'failed' as const, headline: 'x', detail: [], at: { line: 1, col: 1 } };
    expect(opensOnFailures({ status: 'failed', failures: [failure] })).toBe(true);
    expect(opensOnFailures({ status: 'invalid', failures: [] })).toBe(false);
    expect(opensOnFailures({ status: 'passed', failures: [] })).toBe(false);
  });

  it('load a case into the scenario as a pin, its workflow focused', () => {
    const store = createSessionStore();
    store.getState().setFiles({ [CI]: 'on: push' }, source);
    store.getState().select(CI, 'build');
    const assume = [{ job: 'build', outcome: 'success' as const }];
    store.getState().loadCase({ event: 'push', branch: 'main' }, assume, CI);
    const s = store.getState();
    expect(s).toMatchObject({
      scenario: { event: 'push', branch: 'main' },
      scenarioFrom: 'author',
      assumed: [],
      assume,
      focus: CI,
      sel: undefined,
    });
    expect(s.change).toMatchObject({ cause: 'pin', waitFor: { scenario: s.scenario, assume } });
  });
});

describe('the tab and its request', () => {
  it('is a preference the page remembers', () => {
    const stored = JSON.stringify({ v: 1, panel: 'tests' });
    expect(readPrefs({ getItem: () => stored, setItem: () => undefined }).panel).toBe('tests');
  });

  it('asks the worker with a project and the switch, and nothing else', () => {
    expect(isEngineRequest({ id: 1, type: 'test', project: 1, ci: true })).toBe(true);
    expect(isEngineRequest({ id: 1, type: 'test', project: 1, ci: false, filter: 'main' })).toBe(true);
    expect(isEngineRequest({ id: 1, type: 'test', project: 1 })).toBe(false);
    expect(isEngineRequest({ id: 1, type: 'test', project: '1', ci: true })).toBe(false);
    expect(isEngineRequest({ id: 1, type: 'test', project: 1, ci: true, filter: 3 })).toBe(false);
    expect(isEngineRequest({ id: 1, type: 'load', files: {}, readonly: {} })).toBe(true);
    expect(isEngineRequest({ id: 1, type: 'load', files: {}, readonly: 'x' })).toBe(false);
  });
});
