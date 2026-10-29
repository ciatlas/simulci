import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession } from '../src/engine/session';
import { reportable } from '../src/state/report';
import { createSessionStore, isBlocking, withTexts } from '../src/state/store';
import {
  type CaseResult,
  createEngineClient,
  type EngineClient,
  type LoadResult,
  type SimulateResult,
  type RefsResult,
  type TestResult,
  type WorkerLike,
} from '../src/worker/client';
import {
  type CaseRequest,
  type Outline,
  PROTOCOL,
  type ReadyResponse,
  SUPPORTED_RUN_PLAN,
  type TestRequest,
} from '../src/worker/protocol';

/** A client whose answers the test hands out in order. */
function fakeClient() {
  const loads: ((r: LoadResult) => void)[] = [];
  /** What each load sent, by the index of its answer in `loads`: the project's files, and the route tests apart. */
  const loaded: Record<string, string>[] = [];
  const tested: (Record<string, string> | undefined)[] = [];
  const simulates: {
    body: { project: number; scenario: { event: string }; planUntriggered?: string[] };
    resolve: (r: SimulateResult) => void;
  }[] = [];
  const cases: { body: Omit<CaseRequest, 'id' | 'type'>; resolve: (r: CaseResult) => void }[] = [];
  const runs: { body: Omit<TestRequest, 'id' | 'type'>; resolve: (r: TestResult) => void }[] = [];
  /** What each load sent as read-only files. */
  const readonly: (Record<string, string> | undefined)[] = [];
  let readyResolve!: (r: ReadyResponse) => void;
  let readyReject!: (e: Error) => void;
  const restartListeners: ((n: number, project: number | undefined) => void)[] = [];
  const failureListeners: ((message: string) => void)[] = [];
  const client: EngineClient = {
    ready: new Promise<ReadyResponse>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    }),
    load: (body) =>
      new Promise<LoadResult>((resolve) => {
        loads.push(resolve);
        loaded.push(body.files);
        tested.push(body.tests);
        readonly.push(body.readonly);
      }),
    simulate: (body) => new Promise<SimulateResult>((resolve) => simulates.push({ body, resolve })),
    case: (body) => new Promise<CaseResult>((resolve) => cases.push({ body, resolve })),
    refs: () => new Promise<RefsResult>(() => undefined),
    test: (body) => new Promise<TestResult>((resolve) => runs.push({ body, resolve })),
    onRestart: (l) => restartListeners.push(l),
    onFailure: (l) => failureListeners.push(l),
    restarts: () => 0,
    terminate: () => undefined,
  };
  /** The engine never started: `ready` rejects and the failure listeners hear why, as the real client does. */
  const fail = (message: string): void => {
    readyReject(new Error(message));
    for (const l of failureListeners) l(message);
  };
  return {
    client,
    loads,
    loaded,
    tested,
    readonly,
    simulates,
    cases,
    runs,
    readyResolve,
    fail,
    restartListeners,
  };
}

/** A worker for the real client that answers only when the test says. */
class FakeWorker implements WorkerLike {
  sent: { id: number; type: string; files?: Record<string, string>; project?: number }[] = [];
  private listeners: Record<string, ((event: { data: unknown }) => void)[]> = { message: [], error: [] };
  postMessage(message: unknown): void {
    this.sent.push(message as FakeWorker['sent'][number]);
  }
  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    this.listeners[type]?.push(listener);
  }
  terminate(): void {}
  reply(data: unknown): void {
    for (const l of this.listeners.message!) l({ data });
  }
  ready(): void {
    this.reply({
      type: 'ready',
      protocol: PROTOCOL,
      engine: { version: '0.1.0', runPlan: SUPPORTED_RUN_PLAN },
      models: [],
    });
  }
  /** Answers the load it was sent at `index` with `project`. */
  loaded(index: number, project: number): void {
    this.reply({ id: this.sent[index]!.id, type: 'loaded', project, outline, ms: 1 });
  }
  crash(): void {
    for (const l of this.listeners.error!) l({ data: undefined });
  }
}

const CI = '.github/workflows/ci.yml';

const outline: Outline = {
  files: [{ path: '.github/workflows/ci.yml', kind: 'workflow', errors: [] }],
  workflows: [
    {
      path: '.github/workflows/ci.yml',
      callable: false,
      events: [{ event: 'push', branches: ['main', 'release/**'] }, { event: 'pull_request' }],
      jobs: [],
      onLine: 1,
    },
  ],
  events: {},
};

const plan = (project: number): SimulateResult =>
  ({
    id: 1,
    type: 'plan',
    project,
    plan: { workflows: [], unknowns: [], detail: 'steps' },
    derived: {},
    text: 'plan',
    ms: { simulate: 1, derive: 0 },
  }) as never;

describe('the session', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps the event table the worker sends with ready', async () => {
    const store = createSessionStore();
    const f = fakeClient();
    createSession({ store, client: f.client, debounceMs: 100 });
    const events = { push: { types: [], default: [] } };
    f.readyResolve({
      type: 'ready',
      protocol: 1,
      engine: { version: '0.1.0', runPlan: 1 },
      models: [],
      events,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().engine).toMatchObject({ status: 'ready', events });
  });

  it('loads new files, applies the defaults, simulates at once and re-simulates after a quiet period', async () => {
    const store = createSessionStore();
    const f = fakeClient();
    createSession({ store, client: f.client, debounceMs: 100 });
    f.readyResolve({ type: 'ready', protocol: 1, engine: { version: '0.1.0', runPlan: 1 }, models: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().engine.status).toBe('ready');
    store.getState().setFiles({ '.github/workflows/ci.yml': 'on: push' }, { kind: 'sample', name: 'x' });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().project.status).toBe('loading');
    expect(f.loads).toHaveLength(1);
    f.loads[0]!({ id: 1, type: 'loaded', project: 1, outline, ms: 1 });
    await vi.advanceTimersByTimeAsync(0);
    const s = store.getState();
    expect(s.project).toMatchObject({ status: 'ready', version: 1, files: 1 });
    expect(s.scenario).toEqual({ event: 'push', branch: 'main' });
    expect(s.assumed).toEqual(['event', 'branch']);
    expect(s.focus).toBe('.github/workflows/ci.yml');
    expect(f.simulates).toHaveLength(1);
    expect(f.simulates[0]!.body).toMatchObject({ project: 1, scenario: { event: 'push', branch: 'main' } });
    f.simulates[0]!.resolve(plan(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().plan?.text).toBe('plan');
    expect(store.getState().stale).toBe(false);
    store.getState().patchScenario({ branch: 'release/1' });
    expect(store.getState().stale).toBe('inputs');
    expect(store.getState().assumed).toEqual(['event']);
    store.getState().patchScenario({ branch: 'release/2' });
    await vi.advanceTimersByTimeAsync(99);
    expect(f.simulates).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.simulates).toHaveLength(2);
    expect(f.simulates[1]!.body.scenario).toEqual({ event: 'push', branch: 'release/2' });
  });

  it('selects nothing in new files, and keeps the selection when the same files load again', async () => {
    const store = createSessionStore();
    const f = fakeClient();
    createSession({ store, client: f.client, debounceMs: 100 });
    store.getState().setFiles({ '.github/workflows/ci.yml': 'on: push' }, { kind: 'sample', name: 'x' });
    await vi.advanceTimersByTimeAsync(0);
    f.loads[0]!({ id: 1, type: 'loaded', project: 1, outline, ms: 1 });
    await vi.advanceTimersByTimeAsync(0);
    store.getState().select('.github/workflows/ci.yml', 'test');
    // A reply for another project: the same files are loaded again, and the author's place stays.
    f.simulates[0]!.resolve({ id: 2, type: 'error', kind: 'stale', message: 'another project' });
    await vi.advanceTimersByTimeAsync(0);
    f.loads[1]!({ id: 3, type: 'loaded', project: 2, outline, ms: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState()).toMatchObject({ focus: '.github/workflows/ci.yml', sel: 'test' });
    // Other files under the page's own scenario: their default focus, and no selection made in the files before.
    store.getState().setFiles({ '.github/workflows/ci.yml': 'on: [push]' }, { kind: 'sample', name: 'y' });
    await vi.advanceTimersByTimeAsync(0);
    f.loads[2]!({ id: 4, type: 'loaded', project: 3, outline, ms: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().focus).toBe('.github/workflows/ci.yml');
    expect(store.getState().sel).toBeUndefined();
    expect(store.getState().scenarioFrom).toBe('default');
  });

  it('keeps the page’s own scenario, the selection and the plan through texts edited within the epoch', async () => {
    const store = createSessionStore();
    const f = fakeClient();
    createSession({ store, client: f.client, debounceMs: 100 });
    store.getState().setFiles({ [CI]: 'on: push' }, { kind: 'sample', name: 'x' });
    await vi.advanceTimersByTimeAsync(0);
    f.loads[0]!({ id: 1, type: 'loaded', project: 1, outline, ms: 1 });
    await vi.advanceTimersByTimeAsync(0);
    f.simulates[0]!.resolve(plan(1));
    await vi.advanceTimersByTimeAsync(0);
    store.getState().select(CI, 'test');
    const { scenario, plan: shown } = store.getState();
    expect(store.getState().scenarioFrom).toBe('default');
    store.setState((s) => withTexts(s, { [CI]: 'on: [push]' }));
    // The new texts go to the worker in the same tick; the project they replace stays ready, and the plan stays.
    expect(f.loads).toHaveLength(1);
    await Promise.resolve();
    expect(f.loads).toHaveLength(2);
    expect(store.getState()).toMatchObject({ project: { status: 'ready', files: 1 }, stale: 'edit' });
    expect(store.getState().plan).toBe(shown);
    f.loads[1]!({ id: 2, type: 'loaded', project: 2, outline, ms: 1 });
    await vi.advanceTimersByTimeAsync(0);
    // Not the epoch's first load: no defaults, so the scenario and the selection are the author's still.
    expect(store.getState().scenario).toBe(scenario);
    expect(store.getState()).toMatchObject({ focus: CI, sel: 'test', project: { files: 2 } });
    expect(f.simulates[1]!.body).toMatchObject({ project: 2, scenario });
    f.simulates[1]!.resolve(plan(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().plan?.for).toMatchObject({ files: 2, epoch: 1, project: 2 });
    expect(store.getState().stale).toBe(false);
  });

  it('labels a plan with the files it was simulated from, not the newer texts the store holds', async () => {
    const store = createSessionStore();
    const f = fakeClient();
    const session = createSession({ store, client: f.client, debounceMs: 100 });
    store.getState().setFiles({ [CI]: 'on: push' }, { kind: 'sample', name: 'x' });
    await vi.advanceTimersByTimeAsync(0);
    f.loads[0]!({ id: 1, type: 'loaded', project: 1, outline, ms: 1 });
    await vi.advanceTimersByTimeAsync(0);
    f.simulates[0]!.resolve(plan(1));
    await vi.advanceTimersByTimeAsync(0);
    store.setState((s) => withTexts(s, { [CI]: 'on: [push]' }));
    // While the edit loads, the inputs change: the plan they bring is of the old texts, and says so.
    store.getState().patchScenario({ branch: 'dev' });
    session.simulateNow();
    expect(f.simulates[1]!.body).toMatchObject({ project: 1, scenario: { branch: 'dev' } });
    f.simulates[1]!.resolve(plan(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().files.version).toBe(2);
    expect(store.getState().plan?.for).toMatchObject({ files: 1, epoch: 1, project: 1 });
    expect(store.getState().stale).toBe('edit');
  });

  it('keeps the URL scenario, drops answers to older requests and routes invalid, stale and engine errors', async () => {
    const store = createSessionStore();
    store.getState().setScenario({ event: 'pull_request', base: 'main' }, { from: 'url' });
    const f = fakeClient();
    createSession({ store, client: f.client, debounceMs: 100 });
    store.getState().setFiles({ '.github/workflows/ci.yml': 'on: push' }, { kind: 'sample', name: 'x' });
    await vi.advanceTimersByTimeAsync(0);
    f.loads[0]!({ id: 1, type: 'loaded', project: 1, outline, ms: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().scenario).toEqual({ event: 'pull_request', base: 'main' });
    expect(store.getState().assumed).toEqual([]);
    const first = f.simulates[0]!;
    store.getState().patchScenario({ base: 'dev' });
    await vi.advanceTimersByTimeAsync(100);
    const second = f.simulates[1]!;
    first.resolve({ ...(plan(1) as object), text: 'old' } as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().plan).toBeUndefined();
    second.resolve({ id: 2, type: 'invalid', what: 'scenario', issues: [{ path: ['base'], message: 'no' }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().error).toMatchObject({ kind: 'scenario', message: 'no' });
    store.getState().patchScenario({ base: 'main' });
    expect(store.getState().error).toBeUndefined();
    await vi.advanceTimersByTimeAsync(100);
    f.simulates[2]!.resolve({ id: 3, type: 'error', kind: 'stale', message: 'another project' });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.loads).toHaveLength(2);
    f.loads[1]!({ id: 4, type: 'loaded', project: 2, outline, ms: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().project.version).toBe(2);
    expect(f.simulates[3]!.body.project).toBe(2);
    f.simulates[3]!.resolve({ id: 5, type: 'error', kind: 'engine', message: 'boom', stack: 'at x' });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().error).toMatchObject({ kind: 'engine', message: 'boom', stack: 'at x' });
  });

  it('reports a boot failure and a restart with its new project id', async () => {
    const store = createSessionStore();
    const f = fakeClient();
    createSession({ store, client: f.client });
    f.fail('the engine did not start');
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().engine.status).toBe('failed');
    expect(store.getState().error).toMatchObject({ kind: 'boot', message: 'the engine did not start' });
    store.getState().projectReady(3, outline, store.getState().files.version);
    f.restartListeners[0]!(1, 9);
    expect(store.getState().engine.restarts).toBe(1);
    expect(store.getState().project.version).toBe(9);
    // A project of texts the store has moved on from went with the old worker: the fresh one's id is not adopted.
    store.getState().projectReady(4, outline, store.getState().files.version - 1);
    f.restartListeners[0]!(2, 1);
    expect(store.getState().project.version).toBeUndefined();
    expect(store.getState().notices.map((n) => n.text)).toEqual([
      'the engine restarted',
      'the engine restarted again (2)',
    ]);
  });

  it('is busy while a load is unanswered and not once the only one left is answered for files gone since', async () => {
    const store = createSessionStore();
    const f = fakeClient();
    createSession({ store, client: f.client });
    f.readyResolve({ type: 'ready', protocol: 1, engine: { version: '0.1.0', runPlan: 1 }, models: [] });
    await vi.advanceTimersByTimeAsync(0);
    store.getState().setFiles({ '.github/workflows/a.yml': 'on: push' }, { kind: 'sample', name: 'a' });
    store.getState().setFiles({ '.github/workflows/b.yml': 'on: push' }, { kind: 'sample', name: 'b' });
    await vi.advanceTimersByTimeAsync(0);
    f.loads[0]!({ id: 1, type: 'loaded', project: 1, outline, ms: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().engine.busy).toBe(true);
    store.getState().forgetSource();
    f.loads[1]!({ id: 2, type: 'loaded', project: 2, outline, ms: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState()).toMatchObject({ project: { status: 'idle' }, engine: { busy: false } });
    expect(f.simulates).toHaveLength(0);
    store.getState().setFiles({ '.github/workflows/a.yml': 'on: push' }, { kind: 'sample', name: 'a' });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().engine.busy).toBe(true);
    // A folder from the last visit that needs a click before it can be read again: no files until then.
    store.getState().awaitReopen({ kind: 'folder', name: 'repo', readAt: 0 });
    f.loads[2]!({ id: 3, type: 'error', kind: 'load', message: 'not yaml' });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().engine.busy).toBe(false);
    expect(store.getState().error).toBeUndefined();
  });

  /** A session with `ci.yml` loaded as project 1 and a plan that holds it as a workflow an event starts. */
  const planned = async () => {
    const store = createSessionStore();
    const f = fakeClient();
    const session = createSession({ store, client: f.client, debounceMs: 100 });
    store.getState().setFiles({ [CI]: 'on: push' }, { kind: 'sample', name: 'x' });
    await vi.advanceTimersByTimeAsync(0);
    f.loads[0]!({ id: 1, type: 'loaded', project: 1, outline, ms: 1 });
    await vi.advanceTimersByTimeAsync(0);
    f.simulates[0]!.resolve({
      ...(plan(1) as object),
      plan: { workflows: [{ path: CI, depth: 0 }], unknowns: [], detail: 'steps' },
    } as never);
    await vi.advanceTimersByTimeAsync(0);
    return { store, f, session };
  };

  it('asks for a case under the scenario and the assumptions the store holds now, and answers what it got', async () => {
    const { store, f, session } = await planned();
    const before = store.getState().plan;
    const assume = [{ step: 'build.detect', outputs: { changed: 'true' } }];
    store.getState().patchScenario({ branch: 'release/1' });
    store.getState().setAssume(assume);
    const answer = session.testCase('steps');
    expect(f.cases.map((c) => c.body)).toEqual([
      {
        project: 1,
        workflow: CI,
        scenario: { event: 'push', branch: 'release/1' },
        assume,
        detail: 'steps',
        format: 'test',
      },
    ]);
    // The case is the dialog's: while it is out, the engine reads idle and the plan stays as the simulate left it.
    expect(store.getState().engine.busy).toBe(false);
    expect(store.getState().plan).toBe(before);
    const generated = {
      name: 'push release/1',
      when: {},
      then: {},
      allowMaybe: true,
      comments: ['ci.yml: maybe'],
    };
    f.cases[0]!.resolve({ id: 9, type: 'case', text: 'workflow: ci.yml\n', case: generated });
    expect(await answer).toEqual({
      type: 'case',
      text: 'workflow: ci.yml\n',
      maybes: 1,
      errors: [],
      case: generated,
    });
    // And so they stay once it is answered.
    expect(store.getState().plan).toBe(before);
    expect(store.getState().engine.busy).toBe(false);
  });

  it('asks for the plan as text or Mermaid with the jobs detail, and passes a failure on', async () => {
    const { f, session } = await planned();
    const text = session.testCase('text');
    const mermaid = session.testCase('mermaid');
    expect(f.cases.map((c) => [c.body.detail, c.body.format])).toEqual([
      ['jobs', 'text'],
      ['jobs', 'mermaid'],
    ]);
    f.cases[0]!.resolve({ id: 9, type: 'case', text: 'plan' });
    f.cases[1]!.resolve({ id: 10, type: 'error', kind: 'engine', message: 'boom' });
    expect(await text).toEqual({ type: 'case', text: 'plan', maybes: 0, errors: [] });
    expect(await mermaid).toEqual({ type: 'failed', message: 'boom' });
  });

  it('answers failed without asking the worker before there is a plan', async () => {
    const store = createSessionStore();
    const f = fakeClient();
    const session = createSession({ store, client: f.client });
    expect(await session.testCase('jobs')).toEqual({ type: 'failed', message: 'no plan yet' });
    store.getState().setFiles({ [CI]: 'on: push' }, { kind: 'sample', name: 'x' });
    await vi.advanceTimersByTimeAsync(0);
    f.loads[0]!({ id: 1, type: 'loaded', project: 1, outline, ms: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(await session.testCase('steps')).toEqual({ type: 'failed', message: 'no plan yet' });
    expect(f.cases).toEqual([]);
  });
});

const files = { '.github/workflows/ci.yml': 'on: push' };

const planReply = (id: number, project: number) => ({
  id,
  type: 'plan',
  project,
  plan: { workflows: [], unknowns: [], detail: 'steps' },
  derived: {},
  text: 'plan',
  ms: { simulate: 1, derive: 0 },
});

describe('the session over the real client', () => {
  const workers: FakeWorker[] = [];
  const spawn = () => {
    const w = new FakeWorker();
    workers.push(w);
    return w;
  };
  beforeEach(() => {
    vi.useFakeTimers();
    workers.length = 0;
  });
  afterEach(() => vi.useRealTimers());

  /** A session whose engine is up, with `files` loaded as project 1 and the first simulate in flight. */
  const started = async () => {
    const store = createSessionStore();
    createSession({ store, client: createEngineClient({ spawn }) });
    workers[0]!.ready();
    await vi.advanceTimersByTimeAsync(0);
    store.getState().setFiles(files, { kind: 'sample', name: 'x' });
    await vi.advanceTimersByTimeAsync(0);
    workers[0]!.loaded(0, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(workers[0]!.sent.map((m) => m.type)).toEqual(['load', 'simulate']);
    return store;
  };

  it('keeps the blocking boot error when the files came before the engine failed to start', async () => {
    const store = createSessionStore();
    store.getState().setFiles(files, { kind: 'sample', name: 'x' });
    createSession({ store, client: createEngineClient({ spawn }) });
    store
      .getState()
      .setFiles({ ...files, '.github/workflows/b.yml': 'on: push' }, { kind: 'sample', name: 'y' });
    await vi.advanceTimersByTimeAsync(5001);
    expect(store.getState()).toMatchObject({
      engine: { status: 'failed', busy: false },
      error: { kind: 'boot', message: 'the engine did not start' },
    });
    expect(isBlocking(store.getState().error)).toBe(true);
    expect(reportable(store.getState().error!)).toBe(false);
    store.getState().forgetSource();
    expect(store.getState().error).toMatchObject({ kind: 'boot' });
  });

  it('keeps the blocking boot error when the files come after the engine failed to start', async () => {
    const store = createSessionStore();
    createSession({ store, client: createEngineClient({ spawn }) });
    workers[0]!.crash();
    await vi.advanceTimersByTimeAsync(0);
    store.getState().setFiles(files, { kind: 'sample', name: 'x' });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState()).toMatchObject({
      engine: { status: 'failed', busy: false },
      error: { kind: 'boot', message: 'the engine failed to load' },
    });
  });

  it('marks the engine failed when the worker that replaces a stalled one never starts', async () => {
    const store = await started();
    await vi.advanceTimersByTimeAsync(3001);
    expect(workers).toHaveLength(2);
    workers[1]!.crash();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState()).toMatchObject({
      engine: { status: 'failed', busy: false },
      error: { kind: 'stopped', message: 'the engine failed to load' },
    });
    expect(isBlocking(store.getState().error)).toBe(true);
    expect(reportable(store.getState().error!)).toBe(true);
    store.getState().patchScenario({ branch: 'dev' });
    await vi.advanceTimersByTimeAsync(100);
    expect(store.getState().error).toMatchObject({ kind: 'stopped' });
  });

  it('marks the engine failed when it stalls once more than the restarts allow', async () => {
    const store = await started();
    for (const round of [1, 2]) {
      await vi.advanceTimersByTimeAsync(3001);
      workers[round]!.ready();
      await vi.advanceTimersByTimeAsync(0);
      workers[round]!.loaded(0, 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(workers[round]!.sent.map((m) => m.type)).toEqual(['load', 'simulate']);
    }
    await vi.advanceTimersByTimeAsync(3001);
    expect(store.getState()).toMatchObject({
      engine: { status: 'failed', busy: false },
      error: { kind: 'stopped', message: 'the engine stopped responding' },
    });
    store.getState().setFiles({ '.github/workflows/b.yml': 'on: push' }, { kind: 'sample', name: 'y' });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState()).toMatchObject({
      engine: { status: 'failed', busy: false },
      error: { kind: 'stopped', message: 'the engine stopped responding' },
    });
  });

  it('ends ready for the newest files when a restart catches one load in flight and one waiting', async () => {
    const store = createSessionStore();
    createSession({ store, client: createEngineClient({ spawn }) });
    workers[0]!.ready();
    await vi.advanceTimersByTimeAsync(0);
    store.getState().setFiles({ '.github/workflows/a.yml': 'on: push' }, { kind: 'sample', name: 'a' });
    store.getState().setFiles(files, { kind: 'sample', name: 'b' });
    await vi.advanceTimersByTimeAsync(3001);
    workers[1]!.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(workers[1]!.sent).toMatchObject([{ type: 'load', files }]);
    workers[1]!.loaded(0, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().project).toMatchObject({
      status: 'ready',
      version: 1,
      files: store.getState().files.version,
    });
    expect(workers[1]!.sent.map((m) => [m.type, m.project])).toEqual([
      ['load', undefined],
      ['simulate', 1],
    ]);
    workers[1]!.reply(planReply(workers[1]!.sent[1]!.id, 1));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().plan?.for).toEqual({
      files: store.getState().files.version,
      epoch: store.getState().files.epoch,
      project: 1,
      assume: store.getState().assume,
      scenario: store.getState().scenario,
    });
    expect(store.getState().engine.busy).toBe(false);
  });
});

const RELEASE = '.github/workflows/release.yml';

/** The Outline of `ci.yml` and `release.yml`, with what each file's parsers refused. */
const outlineWith = (errors: Partial<Record<string, 'yaml' | 'workflow'>> = {}): Outline => ({
  ...outline,
  files: [CI, RELEASE].map((path) => ({
    path,
    kind: 'workflow' as const,
    errors: errors[path]
      ? [{ line: 3, column: 1, message: 'Implicit keys need to be on a single line', source: errors[path] }]
      : [],
  })),
});

const loadedAs = (project: number, o: Outline = outlineWith()) =>
  ({ id: project, type: 'loaded', project, outline: o, ms: 1 }) as const;

describe('the session’s edit cadence and the hold', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** `ci.yml` and `release.yml` loaded as project 1, from an Outline that may already hold errors, and planned. */
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

  it('loads the ops of one tick in one load, at once, and keys typed in the pane after 150 ms of quiet', async () => {
    const { store, f } = await planned();
    op(store, CI, '# a\n');
    op(store, RELEASE, '# b\n');
    expect(f.loads).toHaveLength(1);
    await Promise.resolve();
    expect(f.loads).toHaveLength(2);
    expect(f.loaded[1]).toEqual({ [CI]: '# a\non: push\n', [RELEASE]: '# b\non: release\n' });

    store.getState().typed(CI, [{ from: 0, to: 0, insert: 'x' }]);
    await vi.advanceTimersByTimeAsync(100);
    store.getState().typed(CI, [{ from: 1, to: 1, insert: 'y' }]);
    await vi.advanceTimersByTimeAsync(149);
    expect(f.loads).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.loads).toHaveLength(3);
    expect(f.loaded[2]![CI]).toBe('xy# a\non: push\n');

    // An undo goes at once, and so does an op that comes while typing waits: the shorter delay wins.
    store.getState().undo();
    await Promise.resolve();
    expect(f.loads).toHaveLength(4);
    store.getState().typed(CI, [{ from: 0, to: 0, insert: 'z' }]);
    op(store, RELEASE, '#');
    await Promise.resolve();
    expect(f.loads).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(500);
    expect(f.loads).toHaveLength(5);
  });

  it('loads the last of three quick edits, and drops the answers to the two before it', async () => {
    const { store, f } = await planned();
    for (const insert of ['1', '2', '3']) {
      op(store, CI, insert);
      await Promise.resolve();
    }
    expect(f.loaded.slice(1).map((sent) => sent[CI])).toEqual([
      '1on: push\n',
      '21on: push\n',
      '321on: push\n',
    ]);
    f.loads[1]!(loadedAs(2));
    f.loads[2]!(loadedAs(3));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.simulates).toHaveLength(1);
    f.loads[3]!(loadedAs(4));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().project).toMatchObject({ version: 4, files: store.getState().files.version });
    expect(f.simulates[1]!.body.project).toBe(4);
  });

  it('holds a load that breaks the YAML of a file that parsed: the plan stays, a scenario change waits, a fix releases', async () => {
    const { store, f, session } = await planned();
    const shown = store.getState().plan;
    op(store, CI, 'on: :\n');
    await Promise.resolve();
    f.loads[1]!(loadedAs(2, outlineWith({ [CI]: 'yaml' })));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().project).toMatchObject({
      status: 'ready',
      version: 1,
      files: 1,
      held: { files: 2, broken: [{ path: CI, line: 3 }] },
    });
    expect(store.getState().plan).toBe(shown);
    expect(store.getState().stale).toBe('edit');
    expect(f.simulates).toHaveLength(1);

    // While held, nothing simulates, and the case waits with the plan.
    store.getState().patchScenario({ branch: 'dev' });
    await vi.advanceTimersByTimeAsync(500);
    session.simulateNow();
    expect(f.simulates).toHaveLength(1);
    expect(await session.testCase('jobs')).toEqual({
      type: 'failed',
      message: 'the plan waits for valid YAML: ci.yml line 3',
    });

    // Still broken: still held, against the plan shown.
    store.getState().typed(CI, [{ from: 0, to: 0, insert: ' ' }]);
    await vi.advanceTimersByTimeAsync(150);
    f.loads[2]!(loadedAs(3, outlineWith({ [CI]: 'yaml' })));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().project).toMatchObject({
      version: 1,
      held: { files: store.getState().files.version },
    });

    // Fixed: the project of the newest texts is ready and simulates the newest scenario.
    store.getState().undo();
    store.getState().undo();
    await Promise.resolve();
    f.loads[3]!(loadedAs(4));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().project).toMatchObject({ status: 'ready', version: 4 });
    expect(store.getState().project.held).toBeUndefined();
    expect(f.simulates[1]!.body).toMatchObject({ project: 4, scenario: { branch: 'dev' } });
  });

  it('sends route tests apart from the project, leaves the plan current after a test’s edit, and never holds for one', async () => {
    const TEST = '.github/simulci/tests/ci.test.yml';
    const store = createSessionStore();
    const f = fakeClient();
    createSession({ store, client: f.client, debounceMs: 100 });
    store
      .getState()
      .setFiles({ [CI]: 'on: push\n', [TEST]: 'workflow: ci.yml\n' }, { kind: 'sample', name: 'x' });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.loaded[0]).toEqual({ [CI]: 'on: push\n' });
    expect(f.tested[0]).toEqual({ [TEST]: 'workflow: ci.yml\n' });
    const withTest = (errors: Outline['files'][number]['errors']): Outline => ({
      ...outline,
      files: [...outline.files, { path: TEST, kind: 'test', errors }],
    });
    f.loads[0]!(loadedAs(1, withTest([])));
    await vi.advanceTimersByTimeAsync(0);
    f.simulates[0]!.resolve(plan(1));
    await vi.advanceTimersByTimeAsync(0);

    // A case added: the test file loads again at once, the plan is not of older texts, and its failure holds nothing.
    op(store, TEST, 'cases: [\n');
    expect(store.getState().stale).toBe(false);
    await Promise.resolve();
    expect(f.loaded[1]).toEqual({ [CI]: 'on: push\n' });
    expect(f.tested[1]).toEqual({ [TEST]: 'cases: [\nworkflow: ci.yml\n' });
    f.loads[1]!(
      loadedAs(2, withTest([{ line: 2, column: 1, message: 'T001 Flow sequence…', source: 'test' }])),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().project).toMatchObject({ status: 'ready', version: 2 });
    expect(store.getState().project.held).toBeUndefined();
    // No test, no `tests`.
    store.getState().setFiles({ [CI]: 'on: push\n' }, { kind: 'sample', name: 'y' });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.tested.at(-1)).toBeUndefined();
  });

  it('never holds for a converter’s error, nor for a file already broken on the plan shown', async () => {
    const { store, f } = await planned(outlineWith({ [RELEASE]: 'yaml' }));
    op(store, RELEASE, ' ');
    await Promise.resolve();
    f.loads[1]!(loadedAs(2, outlineWith({ [RELEASE]: 'yaml' })));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().project).toMatchObject({ version: 2 });
    expect(store.getState().project.held).toBeUndefined();
    expect(f.simulates).toHaveLength(2);

    op(store, CI, 'on: nope\n');
    await Promise.resolve();
    f.loads[2]!(loadedAs(3, outlineWith({ [CI]: 'workflow', [RELEASE]: 'yaml' })));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().project).toMatchObject({ version: 3 });
    expect(store.getState().project.held).toBeUndefined();
  });

  it('never holds the first load of a source, broken or not', async () => {
    const store = createSessionStore();
    const f = fakeClient();
    createSession({ store, client: f.client });
    store.getState().setFiles({ [CI]: 'on: :\n' }, { kind: 'sample', name: 'x' });
    await vi.advanceTimersByTimeAsync(0);
    f.loads[0]!(loadedAs(1, outlineWith({ [CI]: 'yaml' })));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().project).toMatchObject({ status: 'ready', version: 1 });
    expect(f.simulates).toHaveLength(1);
  });

  /** A plan that leaves ci.yml and release.yml untriggered. */
  const untriggered = (project: number): SimulateResult =>
    ({
      ...plan(project),
      plan: {
        workflows: [CI, RELEASE].map((path) => ({ path, depth: 0, triggered: { verdict: 'no' }, jobs: [] })),
      },
    }) as never;

  it('plans the focused workflow untriggered in edit mode only, and simulates again when that changes the plan', async () => {
    const { store, f, session } = await planned();
    // Nothing on screen is untriggered: edit mode changes no plan, so none goes out for it.
    store.getState().setEdit(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.simulates).toHaveLength(1);
    session.simulateNow();
    f.simulates[1]!.resolve(untriggered(1));
    await vi.advanceTimersByTimeAsync(0);

    // Both are untriggered on screen now: another focus, then leaving edit mode, each plan again.
    store.getState().setFocus(RELEASE);
    await vi.advanceTimersByTimeAsync(100);
    f.simulates[2]!.resolve(untriggered(1));
    await vi.advanceTimersByTimeAsync(0);
    store.getState().setEdit(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.simulates.map((x) => x.body.planUntriggered)).toEqual([undefined, [CI], [RELEASE], undefined]);
  });

  it('runs the route tests after a plan of new files, once per project and setting, with the snapshots sent', async () => {
    const store = createSessionStore();
    const f = fakeClient();
    createSession({ store, client: f.client, debounceMs: 100 });
    const TEST = '.github/simulci/tests/ci.test.yml';
    const SNAP = '.github/simulci/tests/__snapshots__/ci.test.snap.json';
    store
      .getState()
      .setFiles(
        { [CI]: 'on: push', [TEST]: 'workflow: ci.yml' },
        { kind: 'sample', name: 'x' },
        undefined,
        undefined,
        {
          [SNAP]: '{}',
        },
      );
    await vi.advanceTimersByTimeAsync(0);
    expect(f.readonly[0]).toEqual({ [SNAP]: '{}' });
    const tested: Outline = {
      ...outline,
      files: [...outline.files, { path: TEST, kind: 'test', errors: [] }],
    };
    f.loads[0]!({ id: 1, type: 'loaded', project: 1, outline: tested, ms: 1 });
    await vi.advanceTimersByTimeAsync(0);
    // The plan first: the tests wait for it.
    expect(f.runs).toHaveLength(0);
    f.simulates[0]!.resolve(plan(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.runs.map((r) => r.body)).toEqual([{ project: 1, ci: true }]);
    expect(store.getState().tests.status).toBe('running');
    // Busy is the plan's: a test run under way does not count.
    expect(store.getState().engine.busy).toBe(false);
    const summary = { passed: 1, failed: 0, invalid: 0, skipped: 0 };
    f.runs[0]!.resolve({ id: 2, type: 'tested', project: 1, files: [], summary, exitCode: 0, ms: 1 });
    await vi.advanceTimersByTimeAsync(0);
    const run = store.getState().tests.run!;
    expect(store.getState().tests.status).toBe('done');
    expect(run.summary).toEqual(summary);
    expect(run.for).toMatchObject({ project: 1, files: 1, ci: true });
    expect(run.for.digest).toMatch(/^[0-9a-f]{7}$/);
    // Another scenario plans again, but the project is the same: the tests do not run again.
    store.getState().patchScenario({ branch: 'dev' });
    await vi.advanceTimersByTimeAsync(100);
    f.simulates[1]!.resolve(plan(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.runs).toHaveLength(1);
    // "As CI" off runs them again, off CI.
    store.getState().setTestsCi(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.runs.map((r) => r.body.ci)).toEqual([true, false]);
  });

  it('loads again when Reload brings other snapshots, and clears the tab for a project with no tests', async () => {
    const store = createSessionStore();
    const f = fakeClient();
    createSession({ store, client: f.client, debounceMs: 100 });
    const SNAP = '.github/simulci/tests/__snapshots__/ci.test.snap.json';
    store.getState().setFiles({ [CI]: 'on: push' }, { kind: 'folder', name: 'repo', readAt: 1 });
    await vi.advanceTimersByTimeAsync(0);
    f.loads[0]!({ id: 1, type: 'loaded', project: 1, outline, ms: 1 });
    await vi.advanceTimersByTimeAsync(0);
    f.simulates[0]!.resolve(plan(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.runs).toHaveLength(0);
    expect(store.getState().tests).toEqual({ ci: true, status: 'idle' });
    const { epoch } = store.getState().files;
    store.getState().setReadonly(epoch, { [SNAP]: '{"schemaVersion":1,"cases":{}}' });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.loads).toHaveLength(2);
    expect(f.readonly[1]).toEqual({ [SNAP]: '{"schemaVersion":1,"cases":{}}' });
    // The same snapshots again change nothing.
    store.getState().setReadonly(epoch, { [SNAP]: '{"schemaVersion":1,"cases":{}}' });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.loads).toHaveLength(2);
  });

  it('never sends a route test to the engine', async () => {
    const TEST = '.github/simulci/tests/ci.test.yml';
    const store = createSessionStore();
    const f = fakeClient();
    createSession({ store, client: f.client });
    store.getState().setFiles({ [CI]: 'on: push\n', [TEST]: 'cases: []\n' }, { kind: 'sample', name: 'x' });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.loaded[0]).toEqual({ [CI]: 'on: push\n' });
    store.getState().transact({
      label: 'Op',
      origin: 'op',
      files: [
        { path: CI, edits: [{ from: 0, to: 0, insert: '#' }] },
        { path: TEST, edits: [{ from: 0, to: 0, insert: '#' }] },
      ],
    });
    await Promise.resolve();
    expect(f.loaded[1]).toEqual({ [CI]: '#on: push\n' });
  });
});

describe('the hold over the real client', () => {
  const workers: FakeWorker[] = [];
  const spawn = () => {
    const w = new FakeWorker();
    workers.push(w);
    return w;
  };
  beforeEach(() => {
    vi.useFakeTimers();
    workers.length = 0;
  });
  afterEach(() => vi.useRealTimers());

  const broken = outlineWith({ [CI]: 'yaml' });

  it('replays the broken texts after a restart, holds them again and never simulates, so it cannot loop', async () => {
    const store = createSessionStore();
    createSession({ store, client: createEngineClient({ spawn }) });
    workers[0]!.ready();
    await vi.advanceTimersByTimeAsync(0);
    store.getState().setFiles({ [CI]: 'on: push\n' }, { kind: 'sample', name: 'x' });
    await vi.advanceTimersByTimeAsync(0);
    workers[0]!.loaded(0, 1);
    await vi.advanceTimersByTimeAsync(0);
    workers[0]!.reply(planReply(workers[0]!.sent[1]!.id, 1));
    await vi.advanceTimersByTimeAsync(0);
    store.getState().typed(CI, [{ from: 0, to: 0, insert: ':' }]);
    await vi.advanceTimersByTimeAsync(150);
    expect(workers[0]!.sent.map((m) => m.type)).toEqual(['load', 'simulate', 'load']);
    // The edit's load stalls: the watchdog starts another worker, which gets the newest (broken) texts.
    await vi.advanceTimersByTimeAsync(3001);
    workers[1]!.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(workers[1]!.sent).toMatchObject([{ type: 'load', files: { [CI]: ':on: push\n' } }]);
    workers[1]!.reply({ id: workers[1]!.sent[0]!.id, type: 'loaded', project: 1, outline: broken, ms: 1 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.getState().project.held).toMatchObject({ files: store.getState().files.version });
    expect(workers[1]!.sent.map((m) => m.type)).toEqual(['load']);
    expect(workers).toHaveLength(2);
    expect(store.getState().engine).toMatchObject({ status: 'ready', busy: false, restarts: 1 });
  });

  it('loads an edit made while a restart replays the texts before it, and ends ready for the newest', async () => {
    const store = createSessionStore();
    createSession({ store, client: createEngineClient({ spawn }) });
    workers[0]!.ready();
    await vi.advanceTimersByTimeAsync(0);
    store.getState().setFiles({ [CI]: 'on: push\n' }, { kind: 'sample', name: 'x' });
    await vi.advanceTimersByTimeAsync(0);
    workers[0]!.loaded(0, 1);
    await vi.advanceTimersByTimeAsync(0);
    workers[0]!.reply(planReply(workers[0]!.sent[1]!.id, 1));
    await vi.advanceTimersByTimeAsync(0);
    store.getState().transact({
      label: 'Op',
      origin: 'op',
      files: [{ path: CI, edits: [{ from: 0, to: 0, insert: '#' }] }],
    });
    await vi.advanceTimersByTimeAsync(3001);
    // The replacement is starting: an edit now waits for it, and replaces the replay's waiting load.
    store.getState().transact({
      label: 'Op',
      origin: 'op',
      files: [{ path: CI, edits: [{ from: 0, to: 0, insert: '!' }] }],
    });
    await vi.advanceTimersByTimeAsync(0);
    workers[1]!.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(workers[1]!.sent).toMatchObject([{ type: 'load', files: { [CI]: '!#on: push\n' } }]);
    workers[1]!.loaded(0, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().project).toMatchObject({
      status: 'ready',
      version: 1,
      files: store.getState().files.version,
    });
    workers[1]!.reply(planReply(workers[1]!.sent[1]!.id, 1));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().plan?.for.files).toBe(store.getState().files.version);
    expect(store.getState().stale).toBe(false);
  });
});
