import {
  type CaseRequest,
  type CaseResponse,
  type EngineRequest,
  type EngineResponse,
  type ErrorResponse,
  type InvalidResponse,
  type LoadedResponse,
  type LoadRequest,
  type PlanResponse,
  PROTOCOL,
  type ReadyResponse,
  type RefsRequest,
  type RefsResponse,
  type SimulateRequest,
  SUPPORTED_RUN_PLAN,
  type TestedResponse,
  type TestRequest,
} from './protocol';

/**
 * The engine worker as promises. Requests wait for `ready`; per kind at most one is in flight and one waits (a newer
 * waiting request replaces the older one, which is answered `superseded`); a reply that is not for the request in
 * flight is dropped; a request that takes longer than the watchdog allows restarts the worker, which loads the newest
 * files again before the requests that were in flight are sent once more, and after two restarts for the same files
 * the client gives up with an error. A test run plans every case, so the watchdog gives it, and whatever waits behind
 * it in the worker, a longer allowance.
 */

export type Superseded = { type: 'superseded' };
export type LoadResult = LoadedResponse | ErrorResponse | Superseded;
export type SimulateResult = PlanResponse | InvalidResponse | ErrorResponse | Superseded;
export type CaseResult = CaseResponse | InvalidResponse | ErrorResponse | Superseded;
export type RefsResult = RefsResponse | ErrorResponse | Superseded;
export type TestResult = TestedResponse | ErrorResponse | Superseded;

export interface EngineClient {
  ready: Promise<ReadyResponse>;
  load(body: Omit<LoadRequest, 'id' | 'type'>): Promise<LoadResult>;
  simulate(body: Omit<SimulateRequest, 'id' | 'type'>): Promise<SimulateResult>;
  case(body: Omit<CaseRequest, 'id' | 'type'>): Promise<CaseResult>;
  refs(body: Omit<RefsRequest, 'id' | 'type'>): Promise<RefsResult>;
  test(body: Omit<TestRequest, 'id' | 'type'>): Promise<TestResult>;
  /** Called after the worker was restarted by the watchdog and the files were loaded again under `project`. */
  onRestart(listener: (restarts: number, project: number | undefined) => void): void;
  /**
   * Called once when the engine is gone for good: it never started, the worker replacing a stalled one never
   * started, or it stalled more often than the restarts allow. Every request from then on is answered with an error.
   */
  onFailure(listener: (message: string) => void): void;
  restarts(): number;
  terminate(): void;
}

export interface WorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
  terminate(): void;
}

export interface ClientOptions {
  spawn: () => WorkerLike;
  /** Milliseconds `ready` may take before the page is told the engine failed to load. */
  readyTimeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

type Kind = EngineRequest['type'];
type Body = Omit<EngineRequest, 'id'>;

interface Pending {
  body: Body;
  resolve: (response: EngineResponse | Superseded) => void;
  id?: number;
  timer?: unknown;
  /** The load a restarted worker is sent first; its answer lets the other requests go. */
  replay?: boolean;
}

/** The project the client last knew loaded, and the load that gave it. */
interface Previous {
  project: number | undefined;
  load: Body | undefined;
}

const MIN_WATCHDOG_MS = 3000;
const MAX_RESTARTS = 2;
/** A test run plans each of its cases: it may take this long, or as long as this many plans. */
const TEST_WATCHDOG_MS = 30_000;
const TEST_RUN_PLANS = 200;

export function createEngineClient(options: ClientOptions): EngineClient {
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let worker: WorkerLike;
  let readyResolve!: (r: ReadyResponse) => void;
  let readyReject!: (e: Error) => void;
  let ready = new Promise<ReadyResponse>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  let isReady = false;
  let failure: string | undefined;
  /** Between a restart and the replayed load's answer: requests wait, so none is answered `stale`. */
  let replaying = false;
  let nextId = 1;
  let lastMs = 0;
  let restarts = 0;
  /** What stalled last: a load whose replay is answered was a passing stall, which no later one adds to. */
  let stalledKind: Kind | undefined;
  let lastLoad: Body | undefined;
  let lastProject: number | undefined;
  /** The load whose answer named `lastProject`: what a replay must be for the requests about it to follow it. */
  let lastLoaded: Body | undefined;
  const inFlight = new Map<Kind, Pending>();
  const waiting = new Map<Kind, Pending>();
  const listeners: ((restarts: number, project: number | undefined) => void)[] = [];
  const failureListeners: ((message: string) => void)[] = [];

  /** How long a request may take: a test run longer, and a request the worker answers only after a test run as long. */
  const allowance = (kind: Kind): number => {
    const plan = Math.max(MIN_WATCHDOG_MS, 20 * lastMs);
    const test = Math.max(TEST_WATCHDOG_MS, TEST_RUN_PLANS * lastMs);
    return kind === 'test' ? test : inFlight.has('test') ? plan + test : plan;
  };

  const post = (pending: Pending): void => {
    const id = nextId++;
    pending.id = id;
    pending.timer = setTimer(() => stalled(pending.body.type), allowance(pending.body.type));
    inFlight.set(pending.body.type, pending);
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a Worker's postMessage takes a transfer list, not an origin
    worker.postMessage({ ...pending.body, id });
    if (pending.body.type === 'load') lastLoad = pending.body;
  };

  const settle = (pending: Pending, response: EngineResponse | Superseded): void => {
    if (pending.timer !== undefined) clearTimer(pending.timer);
    pending.resolve(response);
  };

  const onMessage = (data: unknown): void => {
    if (typeof data !== 'object' || data === null) return;
    const response = data as EngineResponse;
    if (response.type === 'ready') return onReady(response);
    if (!('id' in response)) return;
    const kind: Kind | undefined = [...inFlight.entries()].find(([, p]) => p.id === response.id)?.[0];
    if (kind === undefined) return; // not the request in flight: a stale or replayed answer
    const pending = inFlight.get(kind)!;
    inFlight.delete(kind);
    const previous = { project: lastProject, load: lastLoaded };
    learn(response, pending);
    settle(pending, response);
    if (pending.replay) replayed(previous, response, pending.body);
    const next = waiting.get(kind);
    if (next) {
      waiting.delete(kind);
      post(next);
    }
  };

  /**
   * A restarted worker answered the replayed load: the waiting requests go on. A load that stalled and loads now
   * means the engine works; a stalled simulate counts on until a plan comes, so a plan that always stalls still ends
   * in a failure rather than in restarts without end.
   */
  const replayed = (previous: Previous, response: EngineResponse, body: Body): void => {
    resume(previous, response, body);
    if (response.type === 'loaded' && stalledKind === 'load') restarts = 0;
  };

  /** What a reply teaches the client: how long a plan takes, which project is loaded, that the engine is well. */
  const learn = (response: EngineResponse, pending: Pending): void => {
    if (response.type === 'plan') {
      lastMs = response.ms.simulate + response.ms.derive;
      restarts = 0;
    }
    if (response.type === 'loaded') {
      lastProject = response.project;
      lastLoaded = pending.body;
    }
  };

  const onReady = (response: ReadyResponse): void => {
    if (response.protocol !== PROTOCOL || response.engine.runPlan !== SUPPORTED_RUN_PLAN) {
      readyReject(
        new Error(
          `the engine speaks protocol ${response.protocol} with RunPlan ${response.engine.runPlan}; this page expects ${PROTOCOL} and ${SUPPORTED_RUN_PLAN}: reload`,
        ),
      );
      return;
    }
    isReady = true;
    readyResolve(response);
    if (!replaying) flushWaiting();
  };

  const flushWaiting = (): void => {
    for (const [kind, pending] of waiting) {
      if (!inFlight.has(kind)) {
        waiting.delete(kind);
        post(pending);
      }
    }
  };

  /** Settles everything queued with an engine error; later requests settle at once until a fresh client is made. */
  const failAll = (message: string): void => {
    if (failure !== undefined) return;
    failure = message;
    for (const l of failureListeners) l(message);
    const failed = (id: number): ErrorResponse => ({ id, type: 'error', kind: 'engine', message });
    for (const p of inFlight.values()) {
      if (p.timer !== undefined) clearTimer(p.timer);
      settle(p, failed(p.id ?? 0));
    }
    inFlight.clear();
    for (const p of waiting.values()) settle(p, failed(0));
    waiting.clear();
  };

  const stalled = (kind: Kind): void => {
    if (failure !== undefined) return;
    restarts++;
    stalledKind = kind;
    if (restarts > MAX_RESTARTS) {
      failAll('the engine stopped responding');
      worker.terminate();
      return;
    }
    requeue();
    worker.terminate();
    replaying = true;
    spawn();
    ready.then(
      () => replayLoad(),
      () => undefined, // failAll, called from spawn, settles the requests waiting for the replacement
    );
  };

  /** Each request in flight waits for the replacement worker, unless a newer one of its kind already waits. */
  const requeue = (): void => {
    for (const [kind, p] of inFlight) {
      if (p.timer !== undefined) clearTimer(p.timer);
      if (waiting.has(kind)) p.resolve({ type: 'superseded' });
      else waiting.set(kind, p);
    }
    inFlight.clear();
  };

  /** A fresh worker gets the newest load first, else the last one sent; the other requests wait for its answer. */
  const replayLoad = (): void => {
    const load = waiting.get('load') ?? (lastLoad ? { body: lastLoad, resolve: () => undefined } : undefined);
    if (!load) return resume({ project: lastProject, load: lastLoaded });
    waiting.delete('load');
    load.replay = true;
    post(load);
  };

  /**
   * The fresh worker numbers projects from 1 again. When the replayed load is the one the old project came from, its
   * answer's id replaces the old one in the waiting requests, and the restart listeners learn it so later requests
   * carry it. When it is a newer load, the old project's texts are gone: a request about it is answered `stale`, as
   * the old worker would have answered it once the newer load was in, never sent to texts it was not asked about.
   */
  const resume = (previous: Previous, answer?: EngineResponse, replay?: Body): void => {
    const project = answer?.type === 'loaded' ? answer.project : undefined;
    const same = replay === previous.load;
    for (const [kind, p] of waiting) {
      const body = p.body as { type: string; project?: number };
      if (body.type === 'load' || project === undefined || body.project !== previous.project) continue;
      if (same) body.project = project;
      else {
        waiting.delete(kind);
        settle(p, {
          id: 0,
          type: 'error',
          kind: 'stale',
          message: `project ${previous.project} is not loaded`,
        });
      }
    }
    replaying = false;
    flushWaiting();
    for (const l of listeners) l(restarts, project);
  };

  const submit = (pending: Pending): void => {
    const kind = pending.body.type;
    if (failure !== undefined) {
      settle(pending, { id: 0, type: 'error', kind: 'engine', message: failure });
      return;
    }
    if (!isReady || replaying || inFlight.has(kind)) {
      const older = waiting.get(kind);
      if (older) settle(older, { type: 'superseded' });
      waiting.set(kind, pending);
      return;
    }
    post(pending);
  };

  const spawn = (): void => {
    isReady = false;
    ready = new Promise<ReadyResponse>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    worker = options.spawn();
    worker.addEventListener('message', (event) => onMessage(event.data));
    worker.addEventListener('error', () => readyReject(new Error('the engine failed to load')));
    const timeout = setTimer(() => {
      if (!isReady) readyReject(new Error('the engine did not start'));
    }, options.readyTimeoutMs ?? 5000);
    ready.then(
      () => clearTimer(timeout),
      (e: Error) => {
        clearTimer(timeout);
        failAll(e.message);
      },
    );
  };

  const request = <R>(body: Body): Promise<R> =>
    new Promise<R>((resolve) =>
      submit({ body, resolve: resolve as (r: EngineResponse | Superseded) => void }),
    );

  spawn();
  return {
    get ready() {
      return ready;
    },
    load: (body) => request<LoadResult>({ ...body, type: 'load' }),
    simulate: (body) => request<SimulateResult>({ ...body, type: 'simulate' }),
    case: (body) => request<CaseResult>({ ...body, type: 'case' }),
    refs: (body) => request<RefsResult>({ ...body, type: 'refs' }),
    test: (body) => request<TestResult>({ ...body, type: 'test' }),
    onRestart: (listener) => {
      listeners.push(listener);
    },
    onFailure: (listener) => {
      failureListeners.push(listener);
    },
    restarts: () => restarts,
    terminate: () => {
      for (const p of inFlight.values()) settle(p, { type: 'superseded' });
      for (const p of waiting.values()) settle(p, { type: 'superseded' });
      inFlight.clear();
      waiting.clear();
      failure = 'the engine was shut down';
      worker.terminate();
    },
  };
}

/** The real worker, as the app spawns it. */
export const spawnEngineWorker = (): WorkerLike =>
  new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' });
