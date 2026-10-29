import type { AssumeEntry, ScenarioInput } from '@simulci/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession } from '../src/engine/session';
import { sampleByName } from '../src/input/samples';
import { createSessionStore, type PlanState } from '../src/state/store';
import type {
  CaseResult,
  EngineClient,
  LoadResult,
  SimulateResult,
  RefsResult,
  TestResult,
} from '../src/worker/client';
import { handle, initialState } from '../src/worker/handle';
import type { Outline, ReadyResponse, SimulateRequest } from '../src/worker/protocol';

/**
 * "This edit changed" settling through the session and the store (synthesis § 7.4): an edit opens a change over the
 * plan on screen, a burst keeps the plan from before its first edit and settles once, on the plan of its newest
 * files; a scenario change during the burst does not settle it, and the plan it brings becomes the one compared; a
 * pin settles by its very inputs as before, and an edit drops an unanswered pin. Plans are the starter's real ones,
 * so the sentences are the ones the status line says.
 */

const CI = '.github/workflows/ci.yml';
const starter = sampleByName('starter')!.files;
const push: ScenarioInput = { event: 'push', branch: 'main' };
const detect: AssumeEntry = { step: 'build.detect', outputs: { changed: 'true' } };

/** The starter's CI with its push filter on `release`: a push to main no longer triggers it. */
const untriggered = { ...starter, [CI]: starter[CI]!.replace('branches: [main]', 'branches: [release]') };

/** The worker's plan of `files` for a request, as the client hands it over. */
function planOf(files: Record<string, string>, body: Omit<SimulateRequest, 'id' | 'type'>): SimulateResult {
  const loaded = handle(initialState(), { id: 1, type: 'load', files, repository: 'o/r' });
  const r = handle(loaded.state, { ...body, id: 2, type: 'simulate', project: 1 });
  if (r.response.type !== 'plan') throw new Error(JSON.stringify(r.response));
  return { ...r.response, project: body.project };
}

function fakeClient() {
  const loads: ((r: LoadResult) => void)[] = [];
  const simulates: { body: Omit<SimulateRequest, 'id' | 'type'>; resolve: (r: SimulateResult) => void }[] =
    [];
  const client: EngineClient = {
    ready: new Promise<ReadyResponse>(() => undefined),
    load: () => new Promise<LoadResult>((resolve) => loads.push(resolve)),
    simulate: (body) => new Promise<SimulateResult>((resolve) => simulates.push({ body, resolve })),
    case: () => new Promise<CaseResult>(() => undefined),
    refs: () => new Promise<RefsResult>(() => undefined),
    test: () => new Promise<TestResult>(() => undefined),
    onRestart: () => undefined,
    onFailure: () => undefined,
    restarts: () => 0,
    terminate: () => undefined,
  };
  /** Answers the newest simulate with the plan of `files` for what it asked. */
  const answer = (files: Record<string, string>): void => {
    const last = simulates.at(-1)!;
    last.resolve(planOf(files, last.body));
  };
  return { client, loads, simulates, answer };
}

const outline: Outline = { files: [{ path: CI, kind: 'workflow', errors: [] }], workflows: [], events: {} };
const loaded = (project: number): LoadResult => ({ id: project, type: 'loaded', project, outline, ms: 1 });

describe('what an edit changed, settled through the session', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** The starter on screen under a push to main, its first plan answered. */
  async function showing() {
    const store = createSessionStore();
    const f = fakeClient();
    createSession({ store, client: f.client, debounceMs: 100, typingMs: 150 });
    store.getState().setScenario(push);
    store.getState().setFiles({ ...starter }, { kind: 'sample', name: 'starter' }, undefined);
    await vi.advanceTimersByTimeAsync(0);
    f.loads[0]!(loaded(1));
    await vi.advanceTimersByTimeAsync(0);
    f.answer(starter);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().plan).toBeDefined();
    return { store, f, first: store.getState().plan! };
  }

  /** A key typed at the end of the push filter's branch: `x` makes `main` `mainx`. */
  const key = (store: ReturnType<typeof createSessionStore>, insert: string): void => {
    const text = store.getState().files.byPath[CI]!;
    const at = text.indexOf(']', text.indexOf('branches: ['));
    expect(store.getState().typed(CI, [{ from: at, to: at, insert }]).ok).toBe(true);
  };

  it('settles a burst of typing once, on the plan of its newest files, against the plan from before its first key', async () => {
    const { store, f, first } = await showing();
    key(store, 'x');
    const opened = store.getState().change!;
    expect(opened).toMatchObject({ cause: 'edit', label: 'Edited ci.yml', quiet: true });
    expect(opened.before?.plan).toBe(first.plan);
    await vi.advanceTimersByTimeAsync(150);
    // The load of the first key commits and its plan is asked for; a second key comes before it answers.
    f.loads[1]!(loaded(2));
    await vi.advanceTimersByTimeAsync(0);
    key(store, 'y');
    const going = store.getState().change!;
    expect(going.seq).toBe(opened.seq);
    expect(going.before?.plan).toBe(first.plan);
    expect(going.waitFor.files).toBe(store.getState().files.version);
    // The first key's plan is of older files: it is shown, stale, and says nothing yet.
    f.answer(untriggered);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().plan?.for.files).toBeLessThan(going.waitFor.files!);
    expect(store.getState().change).toBe(going);

    await vi.advanceTimersByTimeAsync(150);
    f.loads[2]!(loaded(3));
    await vi.advanceTimersByTimeAsync(0);
    f.answer(untriggered);
    await vi.advanceTimersByTimeAsync(0);
    const settled = store.getState().change!;
    expect(settled.seq).toBe(opened.seq);
    expect(settled.after?.plan).toBe(store.getState().plan?.plan);
    expect(settled.after?.sentence).toBe('Edited ci.yml: CI is no longer triggered');
    expect(settled.before).toBeUndefined();

    // Another plan of the same files, for the same inputs, says nothing new: the change spoke once.
    store.getState().planReceived({ ...store.getState().plan! });
    expect(store.getState().change).toBe(settled);
  });

  it('does not settle a burst on the plan a scenario change brings, which becomes the plan compared', async () => {
    const { store, f } = await showing();
    key(store, 'x');
    // The scenario changes before the key's load goes out: its plan is of the files on screen, older than the key.
    store.getState().patchScenario({ branch: 'mainx' });
    await vi.advanceTimersByTimeAsync(100);
    expect(f.simulates).toHaveLength(2);
    f.answer(starter);
    await vi.advanceTimersByTimeAsync(0);
    const waiting = store.getState().change!;
    expect(waiting.after).toBeUndefined();
    expect(waiting.before?.plan).toBe(store.getState().plan?.plan);
    expect(waiting.before?.for.scenario).toBe(store.getState().scenario);

    await vi.advanceTimersByTimeAsync(50);
    f.loads[1]!(loaded(2));
    await vi.advanceTimersByTimeAsync(0);
    // On `mainx`, the key turns CI from not triggered to triggered: said against the plan of the same scenario.
    f.answer(store.getState().files.byPath);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().change?.after?.sentence).toBe('Edited ci.yml: CI might now be triggered');
  });

  it('says nothing of keys that changed no plan, and the status line keeps the summary', async () => {
    const { store, f } = await showing();
    // A comment changes no plan.
    const end = store.getState().files.byPath[CI]!.length;
    store.getState().typed(CI, [{ from: end, to: end, insert: '# note\n' }]);
    await vi.advanceTimersByTimeAsync(150);
    f.loads[1]!(loaded(2));
    await vi.advanceTimersByTimeAsync(0);
    f.answer(store.getState().files.byPath);
    await vi.advanceTimersByTimeAsync(0);
    const settled = store.getState().change!;
    expect(settled.after?.rows).toEqual([]);
    expect(settled.after?.sentence).toBeUndefined();
  });
});

describe('what a change waits for, in the store', () => {
  /** The starter's plan for these inputs and files, as the session receives it. */
  function planState(files: number, scenario: ScenarioInput, assume: AssumeEntry[] = []): PlanState {
    const r = planOf(starter, { project: 1, scenario, assume, detail: 'steps' });
    if (r.type !== 'plan') throw new Error(r.type);
    return { ...r, for: { files, epoch: 1, project: 1, scenario, assume } };
  }

  function showing() {
    const store = createSessionStore();
    store.getState().setFiles({ ...starter }, { kind: 'sample', name: 'starter' });
    store.getState().setScenario(push);
    const s = store.getState();
    s.planReceived(planState(s.files.version, s.scenario, s.assume));
    return store;
  }

  const op = (store: ReturnType<typeof createSessionStore>, label = 'Op') =>
    store
      .getState()
      .transact({ label, origin: 'op', files: [{ path: CI, edits: [{ from: 0, to: 0, insert: '# a\n' }] }] });

  const answer = (store: ReturnType<typeof createSessionStore>) => {
    const s = store.getState();
    s.planReceived(planState(s.files.version, s.scenario, s.assume));
  };

  it('always says something of an op, an undo and a redo, no verdict changed included', () => {
    const store = showing();
    op(store, 'Added a comment');
    answer(store);
    expect(store.getState().change?.after?.sentence).toBe('Added a comment: no verdict changed');
    store.getState().undo();
    expect(store.getState().change).toMatchObject({ cause: 'edit', label: 'Undo Added a comment' });
    answer(store);
    expect(store.getState().change?.after?.sentence).toBe('Undo Added a comment: no verdict changed');
    store.getState().redo();
    answer(store);
    expect(store.getState().change?.after?.sentence).toBe('Redo Added a comment: no verdict changed');
  });

  it('drops an unanswered pin for the edit, which is said against the plan on screen', () => {
    const store = showing();
    const shown = store.getState().plan!;
    store.getState().pinAssume([detect]);
    const pin = store.getState().change!;
    expect(pin.cause).toBe('pin');
    op(store);
    const edit = store.getState().change!;
    expect(edit).toMatchObject({ cause: 'edit', label: 'Op' });
    expect(edit.seq).toBeGreaterThan(pin.seq);
    expect(edit.before?.plan).toBe(shown.plan);
    // The pin's own plan, for older files, does not settle anything: the pin is gone, and the edit waits.
    const s = store.getState();
    s.planReceived(planState(shown.for.files, s.scenario, s.assume));
    expect(store.getState().change?.after).toBeUndefined();
  });

  it('keeps an answered change through an edit of a file the plan does not read', () => {
    const store = showing();
    op(store);
    answer(store);
    const settled = store.getState().change;
    expect(
      store.getState().transact({
        label: 'Test file',
        origin: 'op',
        files: [
          {
            path: '.github/simulci/ci.test.yml',
            create: true,
            edits: [{ from: 0, to: 0, insert: 'cases: []\n' }],
          },
        ],
      }).ok,
    ).toBe(true);
    expect(store.getState().change).toBe(settled);
  });

  it('opens no edit change without a plan to compare with', () => {
    const store = createSessionStore();
    store.getState().setFiles({ ...starter }, { kind: 'sample', name: 'starter' });
    op(store);
    expect(store.getState().change).toBeUndefined();
  });

  it('lets an edit answered for other inputs than the plan before go, saying nothing it cannot compare', () => {
    const store = showing();
    op(store);
    store.getState().patchScenario({ branch: 'dev' });
    answer(store);
    expect(store.getState().change).toBeUndefined();
  });
});
