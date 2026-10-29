import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession } from '../src/engine/session';
import { createSessionStore } from '../src/state/store';
import type {
  CaseResult,
  EngineClient,
  LoadResult,
  SimulateResult,
  RefsResult,
  TestResult,
} from '../src/worker/client';
import type { Outline, ReadyResponse } from '../src/worker/protocol';

/**
 * Edges of the hold and the cadence (synthesis § 7.1, § 7.2): a load that failed between two edits forgets nothing
 * the hold compares with; a slow cycle sets the typing quiet by what the worker spent, not by the wait; an edit that
 * removes every project file still reaches the worker.
 */

function fakeClient() {
  const loads: ((r: LoadResult) => void)[] = [];
  const loaded: Record<string, string>[] = [];
  const simulates: { body: { project: number }; resolve: (r: SimulateResult) => void }[] = [];
  const restartListeners: ((n: number, project: number | undefined) => void)[] = [];
  const client: EngineClient = {
    ready: new Promise<ReadyResponse>(() => undefined),
    load: (body) =>
      new Promise<LoadResult>((resolve) => {
        loads.push(resolve);
        loaded.push(body.files);
      }),
    simulate: (body) => new Promise<SimulateResult>((resolve) => simulates.push({ body, resolve })),
    case: () => new Promise<CaseResult>(() => undefined),
    refs: () => new Promise<RefsResult>(() => undefined),
    test: () => new Promise<TestResult>(() => undefined),
    onRestart: (l) => restartListeners.push(l),
    onFailure: () => undefined,
    restarts: () => 0,
    terminate: () => undefined,
  };
  return { client, loads, loaded, simulates, restartListeners };
}

const CI = '.github/workflows/ci.yml';
const RELEASE = '.github/workflows/release.yml';

const outlineWith = (errors: Partial<Record<string, 'yaml' | 'workflow'>> = {}): Outline => ({
  files: [CI, RELEASE].map((path) => ({
    path,
    kind: 'workflow' as const,
    errors: errors[path] ? [{ line: 3, column: 1, message: 'bad', source: errors[path] }] : [],
  })),
  workflows: [],
  events: {},
});

const loadedAs = (project: number, o: Outline = outlineWith()) =>
  ({ id: project, type: 'loaded', project, outline: o, ms: 1 }) as const;

const plan = (project: number, text = 'plan'): SimulateResult =>
  ({
    id: 1,
    type: 'plan',
    project,
    plan: { workflows: [], unknowns: [], detail: 'steps' },
    derived: {},
    text,
    ms: { simulate: 1, derive: 0 },
  }) as never;

describe('the hold and the cadence, at their edges', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const planned = async (first: Outline = outlineWith()) => {
    const store = createSessionStore();
    const f = fakeClient();
    const session = createSession({ store, client: f.client, debounceMs: 100 });
    store
      .getState()
      .setFiles({ [CI]: 'on: push\n', [RELEASE]: 'on: release\n' }, { kind: 'sample', name: 'x' });
    await vi.advanceTimersByTimeAsync(0);
    f.loads[0]!(loadedAs(1, first));
    await vi.advanceTimersByTimeAsync(0);
    f.simulates[0]!.resolve(plan(1));
    await vi.advanceTimersByTimeAsync(0);
    return { store, f, session };
  };

  const op = (store: ReturnType<typeof createSessionStore>, path: string, insert: string): void => {
    const outcome = store.getState().transact({
      label: 'Op',
      origin: 'op',
      files: [{ path, edits: [{ from: 0, to: 0, insert }] }],
    });
    expect(outcome.ok).toBe(true);
  };

  it('compares a load with the last Outline committed, after a load that failed: a file broken since it was opened does not hold', async () => {
    // release.yml was broken when opened; ci.yml parses.
    const { store, f } = await planned(outlineWith({ [RELEASE]: 'yaml' }));
    op(store, CI, '#');
    await Promise.resolve();
    // The worker could not load this edit (core threw): the project goes, the plan stays.
    f.loads[1]!({ id: 2, type: 'error', kind: 'load', message: 'boom' });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().project).toEqual({ status: 'error' });
    expect(store.getState().plan).toBeDefined();
    // The next edit loads fine; only release.yml is broken, as it was on the plan shown.
    op(store, CI, '#');
    await Promise.resolve();
    f.loads[2]!(loadedAs(3, outlineWith({ [RELEASE]: 'yaml' })));
    await vi.advanceTimersByTimeAsync(0);
    // No hold: release.yml was broken on the plan shown already.
    expect(store.getState().project.held).toBeUndefined();
    expect(store.getState().project).toMatchObject({ status: 'ready', version: 3 });
  });
  it('sets the typing quiet by what the worker spent on the last edit, not by how long it waited', async () => {
    const { store, f } = await planned();
    store.getState().typed(CI, [{ from: 0, to: 0, insert: 'x' }]);
    await vi.advanceTimersByTimeAsync(150);
    expect(f.loads).toHaveLength(2);
    // This edit's cycle took 4 s (say the worker stalled and was replaced, and the replay answered).
    await vi.advanceTimersByTimeAsync(4000);
    f.loads[1]!(loadedAs(2));
    await vi.advanceTimersByTimeAsync(0);
    f.simulates[1]!.resolve(plan(2));
    await vi.advanceTimersByTimeAsync(0);
    // The worker spent 2 ms on it: the next key waits the 150 ms.
    store.getState().typed(CI, [{ from: 1, to: 1, insert: 'y' }]);
    await vi.advanceTimersByTimeAsync(150);
    expect(f.loads).toHaveLength(3);
  });

  it('loads an edit that removes every project file, so the worker does not keep the removed workflows', async () => {
    const { store, f } = await planned();
    const outcome = store.getState().transact({
      label: 'Remove',
      origin: 'op',
      files: [
        { path: CI, remove: true, edits: [] },
        { path: RELEASE, remove: true, edits: [] },
      ],
    });
    expect(outcome.ok).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    // The texts with no project file go to the worker like any edit's, and its empty project replaces the old one.
    expect(f.loaded).toHaveLength(2);
    expect(f.loaded[1]).toEqual({});
    f.loads[1]!(loadedAs(2, { files: [], workflows: [], events: {} }));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().project).toMatchObject({ status: 'ready', version: 2 });
    expect(f.simulates.map((x) => x.body.project)).toEqual([1, 2]);
  });
});
