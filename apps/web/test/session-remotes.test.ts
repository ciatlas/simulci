import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReadRemotes } from '../src/engine/remotes';
import { createSession } from '../src/engine/session';
import { createSessionStore, withTexts } from '../src/state/store';
import type { EngineClient, LoadResult, SimulateResult } from '../src/worker/client';
import type { LoadRequest, Outline, RemoteNeed, RemotePool } from '../src/worker/protocol';

/**
 * The page's half of the remotes loop (M4 synthesis § 5.3): no read before consent, the click reads at once, later
 * needs wait for 500 ms of quiet, each ref at its commit is asked once, and what comes back loads again with the
 * newest texts, whatever was edited while it was out.
 */

const CI = '.github/workflows/ci.yml';
const SHA = 'a'.repeat(40);
const DEPLOY: RemoteNeed = {
  ref: 'octo/ship/.github/workflows/deploy.yml@v1',
  kind: 'workflow',
  depth: 1,
  pin: { sha: SHA, pinned: 'lockfile' },
};
const BUILD: RemoteNeed = {
  ref: `octo/ship/.github/workflows/build.yml@${SHA}`,
  kind: 'workflow',
  depth: 2,
  pin: { sha: SHA, pinned: 'parent' },
};
const ACT: RemoteNeed = { ref: 'octo/act@v2', kind: 'action', depth: 1 };

const outline: Outline = {
  files: [{ path: CI, kind: 'workflow', errors: [] }],
  workflows: [{ path: CI, callable: false, events: [{ event: 'push' }], jobs: [], onLine: 1 }],
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

/** A client that records each load's body and answers when the test says; plans answer at once. */
function fakeClient() {
  const loads: { body: Omit<LoadRequest, 'id' | 'type'>; resolve: (r: LoadResult) => void }[] = [];
  let project = 0;
  const client: EngineClient = {
    ready: Promise.resolve({ type: 'ready', protocol: 1, engine: { version: '0', runPlan: 1 }, models: [] }),
    load: (body) => new Promise<LoadResult>((resolve) => loads.push({ body, resolve })),
    simulate: (body) => Promise.resolve(plan(body.project)),
    case: () => new Promise(() => undefined),
    refs: () => new Promise(() => undefined),
    test: () => new Promise(() => undefined),
    onRestart: () => undefined,
    onFailure: () => undefined,
    restarts: () => 0,
    terminate: () => undefined,
  };
  /** Answers load `i` as loaded, needing `needed`. */
  const answer = (i: number, needed: RemoteNeed[] = []): void =>
    loads[i]!.resolve({
      id: i,
      type: 'loaded',
      project: ++project,
      outline,
      ms: 1,
      ...(needed.length ? { remotesNeeded: needed } : {}),
    });
  return { client, loads, answer };
}

/** A reader whose answers the test hands out, with what each read asked for. */
function fakeReader() {
  const reads: { needs: RemoteNeed[]; resolve: (p: RemotePool) => void; signal: AbortSignal }[] = [];
  const read: ReadRemotes = (needs, signal) =>
    new Promise<RemotePool>((resolve) => reads.push({ needs, resolve, signal }));
  const found = (needs: RemoteNeed[]): RemotePool => ({
    sources: needs.map((n) => ({
      ref: n.ref,
      kind: n.kind,
      sha: n.pin?.sha ?? SHA,
      text: `# ${n.ref}`,
      pinned: n.pin?.pinned ?? 'resolved',
    })),
    failed: [],
  });
  return { read, reads, found };
}

function setUp() {
  const store = createSessionStore();
  const f = fakeClient();
  const r = fakeReader();
  const session = createSession({ store, client: f.client, readRemotes: r.read });
  store.getState().setFiles({ [CI]: 'on: push' }, { kind: 'sample', name: 'x' });
  return { store, f, r, session };
}

const refsOf = (pool: RemotePool | undefined): string[] => (pool?.sources ?? []).map((s) => s.ref).sort();

describe('the remotes loop', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reads nothing before consent and sends no pool, while the chip has the count', async () => {
    const { store, f, r } = setUp();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.loads[0]!.body.remotes).toBeUndefined();
    f.answer(0, [DEPLOY, ACT]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.getState().remotes.needed).toEqual([DEPLOY, ACT]);
    expect(r.reads).toHaveLength(0);
    expect(f.loads).toHaveLength(1);
  });

  it('reads at the click, loads again with what came back, and goes on level by level until nothing is needed', async () => {
    const { store, f, r } = setUp();
    await vi.advanceTimersByTimeAsync(0);
    f.answer(0, [DEPLOY, ACT]);
    await vi.advanceTimersByTimeAsync(0);
    store.getState().consentRemotes();
    // The click reads at once.
    expect(r.reads.map((x) => x.needs)).toEqual([[DEPLOY, ACT]]);
    expect(store.getState().remotes.status).toBe('fetching');
    r.reads[0]!.resolve(r.found([DEPLOY, ACT]));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().remotes.status).toBe('done');
    expect(f.loads).toHaveLength(2);
    expect(refsOf(f.loads[1]!.body.remotes)).toEqual([ACT.ref, DEPLOY.ref]);
    // The next level waits for the quiet.
    f.answer(1, [BUILD]);
    await vi.advanceTimersByTimeAsync(499);
    expect(r.reads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.reads.map((x) => x.needs)).toEqual([[DEPLOY, ACT], [BUILD]]);
    r.reads[1]!.resolve(r.found([BUILD]));
    await vi.advanceTimersByTimeAsync(0);
    expect(refsOf(f.loads[2]!.body.remotes)).toEqual([ACT.ref, BUILD.ref, DEPLOY.ref]);
    f.answer(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.getState().remotes.needed).toEqual([]);
    expect(f.loads).toHaveLength(3);
    expect(r.reads).toHaveLength(2);
  });

  it('asks for each ref at its commit once, in flight or done, so a need the pool cannot meet does not spin', async () => {
    const { store, f, r } = setUp();
    store.getState().consentRemotes();
    await vi.advanceTimersByTimeAsync(0);
    f.answer(0, [DEPLOY]);
    await vi.advanceTimersByTimeAsync(500);
    expect(r.reads).toHaveLength(1);
    // An edit's load needs the same ref again while it is out: not asked twice.
    store.setState((s) => withTexts(s, { [CI]: 'on: [push]' }));
    await vi.advanceTimersByTimeAsync(0);
    f.answer(1, [DEPLOY, ACT]);
    await vi.advanceTimersByTimeAsync(500);
    expect(r.reads.map((x) => x.needs)).toEqual([[DEPLOY], [ACT]]);
    // What came back does not meet the need (say the worker still names it): the loop stops there.
    r.reads[0]!.resolve({ sources: [], failed: [] });
    r.reads[1]!.resolve({ sources: [], failed: [] });
    await vi.advanceTimersByTimeAsync(0);
    f.answer(f.loads.length - 1, [DEPLOY, ACT]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(r.reads).toHaveLength(2);
  });

  it('loads what came back with the newest texts, an edit made while it was out included', async () => {
    const { store, f, r } = setUp();
    store.getState().consentRemotes();
    await vi.advanceTimersByTimeAsync(0);
    f.answer(0, [DEPLOY]);
    await vi.advanceTimersByTimeAsync(500);
    expect(r.reads).toHaveLength(1);
    store.setState((s) => withTexts(s, { [CI]: 'on: [push, pull_request]' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.loads).toHaveLength(2);
    expect(f.loads[1]!.body.files[CI]).toBe('on: [push, pull_request]');
    r.reads[0]!.resolve(r.found([DEPLOY]));
    await vi.advanceTimersByTimeAsync(0);
    const last = f.loads.at(-1)!.body;
    expect(last.files[CI]).toBe('on: [push, pull_request]');
    expect(refsOf(last.remotes)).toEqual([DEPLOY.ref]);
    // The edit's own load, answered late, is of the same texts: it commits, and so does the one with the remote.
    f.answer(1, [DEPLOY]);
    f.answer(f.loads.length - 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.getState().project).toMatchObject({
      status: 'ready',
      files: store.getState().files.version,
    });
    expect(store.getState().remotes.needed).toEqual([]);
    expect(r.reads).toHaveLength(1);
  });

  it('drops a load answered for older texts, and keeps the needs of the newest', async () => {
    const { store, f } = setUp();
    await vi.advanceTimersByTimeAsync(0);
    store.setState((s) => withTexts(s, { [CI]: 'on: [push]' }));
    await vi.advanceTimersByTimeAsync(0);
    f.answer(1, [ACT]);
    f.answer(0, [DEPLOY]);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().remotes.needed).toEqual([ACT]);
  });

  it('keeps what was read across sources, and a new source starts with nothing needed', async () => {
    const { store, f, r } = setUp();
    store.getState().consentRemotes();
    await vi.advanceTimersByTimeAsync(0);
    f.answer(0, [DEPLOY]);
    await vi.advanceTimersByTimeAsync(500);
    r.reads[0]!.resolve(r.found([DEPLOY]));
    await vi.advanceTimersByTimeAsync(0);
    store.getState().setFiles({ [CI]: 'on: pull_request' }, { kind: 'sample', name: 'y' });
    expect(store.getState().remotes.needed).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(refsOf(f.loads.at(-1)!.body.remotes)).toEqual([DEPLOY.ref]);
  });

  it('reads nothing the files before needed when a repository opened over them gives consent', async () => {
    const { store, f, r } = setUp();
    await vi.advanceTimersByTimeAsync(0);
    f.answer(0, [DEPLOY, ACT]);
    await vi.advanceTimersByTimeAsync(0);
    // As sources.openGitHub does: the repository's files, then consent for them.
    store.getState().setFiles({ [CI]: 'on: pull_request' }, { kind: 'sample', name: 'y' });
    store.getState().consentRemotes('source');
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.reads).toHaveLength(0);
    f.answer(1, [BUILD]);
    await vi.advanceTimersByTimeAsync(500);
    expect(r.reads.map((x) => x.needs)).toEqual([[BUILD]]);
  });

  it('asks for references again once a load of the same texts with remotes took the place of the project asked', async () => {
    const { store, f, session } = setUp();
    await vi.advanceTimersByTimeAsync(0);
    f.answer(0);
    await vi.advanceTimersByTimeAsync(0);
    const asked: number[] = [];
    f.client.refs = (body) => {
      asked.push(body.project);
      return Promise.resolve(
        asked.length === 1
          ? { id: 1, type: 'error', kind: 'stale', message: `project ${body.project} is not loaded` }
          : { id: 2, type: 'refs', project: body.project, refs: [], exact: true, notes: [] },
      );
    };
    const found = session.refs({ kind: 'job', workflow: CI, job: 'build' });
    await vi.advanceTimersByTimeAsync(0);
    // Remotes came in: the same texts load again, and that project replaces the one the first ask named.
    store
      .getState()
      .remotesRead({ sources: [], failed: [{ ...ACT, failure: 'timeout', message: 'slow' }] }, true);
    await vi.advanceTimersByTimeAsync(0);
    f.answer(1);
    expect(await found).toMatchObject({ ok: true, project: 2 });
    expect(asked).toEqual([1, 2]);
  });

  it('takes a reader that failed to load as each need not read, and stops reading once disposed', async () => {
    const store = createSessionStore();
    const f = fakeClient();
    let signal: AbortSignal | undefined;
    const session = createSession({
      store,
      client: f.client,
      readRemotes: (_, s) => {
        signal = s;
        return Promise.reject(new Error('The page could not fetch the GitHub reader'));
      },
    });
    store.getState().setFiles({ [CI]: 'on: push' }, { kind: 'sample', name: 'x' });
    store.getState().consentRemotes();
    await vi.advanceTimersByTimeAsync(0);
    f.answer(0, [DEPLOY]);
    await vi.advanceTimersByTimeAsync(500);
    expect(Object.values(store.getState().remotes.failed)).toEqual([
      expect.objectContaining({ ref: DEPLOY.ref, sha: SHA, failure: 'unreachable' }),
    ]);
    expect(f.loads.at(-1)!.body.remotes?.failed).toHaveLength(1);
    session.dispose();
    expect(signal?.aborted).toBe(true);
  });
});
