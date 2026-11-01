import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEngineClient, type WorkerLike } from '../src/worker/client';
import { PROTOCOL, type ReadyResponse } from '../src/worker/protocol';

/** A worker that records what it was sent and answers when the test says. */
class FakeWorker implements WorkerLike {
  sent: { id: number; type: string }[] = [];
  terminated = false;
  private listeners: ((event: { data: unknown }) => void)[] = [];
  private errorListeners: ((event: { data: unknown }) => void)[] = [];
  postMessage(message: unknown): void {
    this.sent.push(message as { id: number; type: string });
  }
  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    if (type === 'message') this.listeners.push(listener);
    if (type === 'error') this.errorListeners.push(listener);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(data: unknown): void {
    for (const l of this.listeners) l({ data });
  }
  /** The script failed to load or threw at the top level. */
  crash(): void {
    for (const l of this.errorListeners) l({ data: undefined });
  }
  ready(over: Partial<ReadyResponse> = {}): void {
    this.reply({
      type: 'ready',
      protocol: PROTOCOL,
      engine: { version: '0.0.0', runPlan: 1 },
      models: [],
      ...over,
    });
  }
}

const plan = (id: number) => ({
  id,
  type: 'plan',
  project: 1,
  plan: {},
  derived: {},
  text: '',
  ms: { simulate: 1, derive: 1 },
});

describe('the engine client', () => {
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

  it('holds requests until ready, keeps one in flight and one waiting per kind, and drops stale replies', async () => {
    const client = createEngineClient({ spawn });
    const w = workers[0]!;
    const load = client.load({ files: {} });
    expect(w.sent).toEqual([]);
    w.ready();
    await client.ready;
    expect(w.sent).toEqual([{ id: 1, type: 'load', files: {} }]);
    const a = client.simulate({ project: 1, scenario: { event: 'push' }, assume: [], detail: 'steps' });
    const b = client.simulate({
      project: 1,
      scenario: { event: 'push', branch: 'x' },
      assume: [],
      detail: 'steps',
    });
    const c = client.simulate({
      project: 1,
      scenario: { event: 'push', branch: 'y' },
      assume: [],
      detail: 'steps',
    });
    expect(w.sent.map((m) => m.type)).toEqual(['load', 'simulate']);
    expect(await b).toEqual({ type: 'superseded' });
    w.reply({ id: 1, type: 'loaded', project: 1, outline: {}, ms: 1 });
    expect((await load).type).toBe('loaded');
    w.reply(plan(99));
    w.reply(plan(2));
    expect((await a).type).toBe('plan');
    expect(w.sent.map((m) => m.id)).toEqual([1, 2, 3]);
    w.reply(plan(3));
    expect((await c).type).toBe('plan');
  });

  it('restarts a stalled worker, replays the load and the request under the new project id, and gives up after two restarts', async () => {
    const client = createEngineClient({ spawn });
    const restarts: [number, number | undefined][] = [];
    client.onRestart((n, project) => restarts.push([n, project]));
    const failures: string[] = [];
    client.onFailure((message) => failures.push(message));
    workers[0]!.ready();
    await client.ready;
    void client.load({ files: { a: '' } });
    workers[0]!.reply({ id: 1, type: 'loaded', project: 1, outline: {}, ms: 1 });
    const stalled = client.simulate({ project: 1, scenario: { event: 'push' }, assume: [], detail: 'steps' });
    await vi.advanceTimersByTimeAsync(3001);
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    workers[1]!.ready();
    await client.ready;
    await vi.advanceTimersByTimeAsync(0);
    expect(workers[1]!.sent.map((m) => m.type)).toEqual(['load']);
    workers[1]!.reply({ id: workers[1]!.sent[0]!.id, type: 'loaded', project: 7, outline: {}, ms: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(workers[1]!.sent.map((m) => [m.type, (m as { project?: number }).project])).toEqual([
      ['load', undefined],
      ['simulate', 7],
    ]);
    expect(restarts).toEqual([[1, 7]]);
    workers[1]!.reply({ ...plan(workers[1]!.sent[1]!.id), project: 7 });
    expect((await stalled).type).toBe('plan');
    // Three stalls in a row with no plan between them exhaust the budget.
    const again = client.simulate({ project: 7, scenario: { event: 'push' }, assume: [], detail: 'steps' });
    for (let round = 0; round < 2; round++) {
      await vi.advanceTimersByTimeAsync(3001);
      const w = workers.at(-1)!;
      w.ready();
      await client.ready;
      await vi.advanceTimersByTimeAsync(0);
      w.reply({ id: w.sent[0]!.id, type: 'loaded', project: 1, outline: {}, ms: 1 });
      await vi.advanceTimersByTimeAsync(0);
      expect(w.sent.map((m) => m.type)).toEqual(['load', 'simulate']);
    }
    await vi.advanceTimersByTimeAsync(3001);
    expect(await again).toMatchObject({
      type: 'error',
      kind: 'engine',
      message: 'the engine stopped responding',
    });
    expect(client.restarts()).toBe(3);
    expect(workers).toHaveLength(4);
    expect(failures).toEqual(['the engine stopped responding']);
  });

  it('replays a stalled load with its own promise and holds waiting requests until the new project is known', async () => {
    const client = createEngineClient({ spawn });
    workers[0]!.ready();
    await client.ready;
    const load = client.load({ files: { a: '' }, tests: { 't.test.yml': '' } });
    const sim = client.simulate({ project: 1, scenario: { event: 'push' }, assume: [], detail: 'steps' });
    await vi.advanceTimersByTimeAsync(3001);
    expect(workers).toHaveLength(2);
    workers[1]!.ready();
    await client.ready;
    await vi.advanceTimersByTimeAsync(0);
    // Only the load went out, route tests and all; the simulate waits for the project id.
    expect(workers[1]!.sent.map((m) => m.type)).toEqual(['load']);
    expect(workers[1]!.sent[0]).toMatchObject({ files: { a: '' }, tests: { 't.test.yml': '' } });
    workers[1]!.reply({ id: workers[1]!.sent[0]!.id, type: 'loaded', project: 1, outline: {}, ms: 1 });
    expect((await load).type).toBe('loaded');
    await vi.advanceTimersByTimeAsync(0);
    expect(workers[1]!.sent.map((m) => [m.type, (m as { project?: number }).project])).toEqual([
      ['load', undefined],
      ['simulate', 1],
    ]);
    workers[1]!.reply({ ...plan(workers[1]!.sent[1]!.id), project: 1 });
    expect((await sim).type).toBe('plan');
  });

  it('replays a load with every remote it carried, so a restarted worker loses none (M4 failure mode 18)', async () => {
    const client = createEngineClient({ spawn });
    workers[0]!.ready();
    await client.ready;
    const remotes = {
      sources: [
        {
          ref: 'octo/act@v2',
          kind: 'action' as const,
          sha: 'a'.repeat(40),
          text: 'name: act',
          pinned: 'resolved' as const,
        },
      ],
      failed: [
        { ref: 'octo/gone@v1', kind: 'action' as const, failure: 'not-found' as const, message: 'gone' },
      ],
    };
    const readonly = { '.github/simulci/remotes.lock.yml': 'version: 1\nremotes: {}\n' };
    const load = client.load({ files: { a: '' }, readonly, remotes });
    await vi.advanceTimersByTimeAsync(3001);
    workers[1]!.ready();
    await client.ready;
    await vi.advanceTimersByTimeAsync(0);
    expect(workers[1]!.sent).toEqual([{ id: 2, type: 'load', files: { a: '' }, readonly, remotes }]);
    workers[1]!.reply({ id: 2, type: 'loaded', project: 1, outline: {}, ms: 1 });
    expect((await load).type).toBe('loaded');
  });

  it('replays the newest load after a restart and answers the one it replaced as superseded', async () => {
    const client = createEngineClient({ spawn });
    workers[0]!.ready();
    await client.ready;
    const answers: Record<string, unknown> = {};
    void client.load({ files: { a: '' } }).then((r) => (answers.a = r));
    void client.load({ files: { b: '' } }).then((r) => (answers.b = r));
    expect(workers[0]!.sent).toEqual([{ id: 1, type: 'load', files: { a: '' } }]);
    await vi.advanceTimersByTimeAsync(3001);
    expect(answers).toEqual({ a: { type: 'superseded' } });
    workers[1]!.ready();
    await client.ready;
    await vi.advanceTimersByTimeAsync(0);
    expect(workers[1]!.sent).toEqual([{ id: 2, type: 'load', files: { b: '' } }]);
    workers[1]!.reply({ id: 2, type: 'loaded', project: 1, outline: {}, ms: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(answers.b).toMatchObject({ type: 'loaded', project: 1 });
  });

  it('holds a request made during the replayed load and sends it under the new project id', async () => {
    const client = createEngineClient({ spawn });
    workers[0]!.ready();
    await client.ready;
    void client.load({ files: { a: '' } });
    workers[0]!.reply({ id: 1, type: 'loaded', project: 4, outline: {}, ms: 1 });
    const stalled = client.simulate({ project: 4, scenario: { event: 'push' }, assume: [], detail: 'steps' });
    await vi.advanceTimersByTimeAsync(3001);
    workers[1]!.ready();
    await client.ready;
    await vi.advanceTimersByTimeAsync(0);
    const newer = client.simulate({
      project: 4,
      scenario: { event: 'push', branch: 'x' },
      assume: [],
      detail: 'steps',
    });
    expect(workers[1]!.sent.map((m) => m.type)).toEqual(['load']);
    expect(await stalled).toEqual({ type: 'superseded' });
    workers[1]!.reply({ id: workers[1]!.sent[0]!.id, type: 'loaded', project: 1, outline: {}, ms: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(workers[1]!.sent.map((m) => [m.type, (m as { project?: number }).project])).toEqual([
      ['load', undefined],
      ['simulate', 1],
    ]);
    workers[1]!.reply({ ...plan(workers[1]!.sent[1]!.id), project: 1 });
    expect((await newer).type).toBe('plan');
  });

  it('tells its failure listeners once when the engine is gone for good, and nothing on terminate', async () => {
    const failures: string[] = [];
    const boot = createEngineClient({ spawn, readyTimeoutMs: 100 });
    boot.onFailure((message) => failures.push(`boot: ${message}`));
    workers[0]!.crash();
    await vi.advanceTimersByTimeAsync(101);
    expect(failures).toEqual(['boot: the engine failed to load']);
    const later = createEngineClient({ spawn });
    later.onFailure((message) => failures.push(`later: ${message}`));
    workers[1]!.ready();
    await later.ready;
    void later.load({ files: { a: '' } });
    await vi.advanceTimersByTimeAsync(3001);
    workers[2]!.crash();
    await vi.advanceTimersByTimeAsync(5000);
    expect(failures).toEqual(['boot: the engine failed to load', 'later: the engine failed to load']);
    const ended = createEngineClient({ spawn, readyTimeoutMs: 100 });
    ended.onFailure((message) => failures.push(`ended: ${message}`));
    ended.terminate();
    await vi.advanceTimersByTimeAsync(101);
    expect(failures).toHaveLength(2);
  });

  it('settles the held requests when the replacement worker never starts, and is final after terminate', async () => {
    const client = createEngineClient({ spawn, readyTimeoutMs: 100 });
    workers[0]!.ready();
    await client.ready;
    void client.load({ files: { a: '' } });
    workers[0]!.reply({ id: 1, type: 'loaded', project: 1, outline: {}, ms: 1 });
    const stalled = client.simulate({ project: 1, scenario: { event: 'push' }, assume: [], detail: 'steps' });
    const waitingCase = client.case({
      project: 1,
      workflow: 'ci.yml',
      scenario: { event: 'push' },
      assume: [],
      detail: 'jobs',
      format: 'test',
    });
    await vi.advanceTimersByTimeAsync(3001);
    expect(workers).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(101);
    expect(await stalled).toMatchObject({
      type: 'error',
      kind: 'engine',
      message: 'the engine did not start',
    });
    expect(await waitingCase).toMatchObject({ type: 'error', kind: 'engine' });
    const after = createEngineClient({ spawn });
    workers[2]!.ready();
    await after.ready;
    after.terminate();
    expect(workers[2]!.terminated).toBe(true);
    const late = await after.load({ files: {} });
    expect(late).toMatchObject({ type: 'error', kind: 'engine', message: 'the engine was shut down' });
    expect(workers).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(5000);
    expect(workers).toHaveLength(3);
  });

  it('gives a page a fresh restart budget once a plan comes back', async () => {
    const client = createEngineClient({ spawn });
    workers[0]!.ready();
    await client.ready;
    void client.load({ files: { a: '' } });
    workers[0]!.reply({ id: 1, type: 'loaded', project: 1, outline: {}, ms: 1 });
    for (let round = 0; round < 3; round++) {
      const sim = client.simulate({ project: 1, scenario: { event: 'push' }, assume: [], detail: 'steps' });
      await vi.advanceTimersByTimeAsync(3001);
      const w = workers.at(-1)!;
      w.ready();
      await client.ready;
      await vi.advanceTimersByTimeAsync(0);
      w.reply({ id: w.sent[0]!.id, type: 'loaded', project: 1, outline: {}, ms: 1 });
      await vi.advanceTimersByTimeAsync(0);
      w.reply({ ...plan(w.sent[1]!.id), project: 1 });
      expect((await sim).type).toBe('plan');
      expect(client.restarts()).toBe(0);
    }
    expect(workers).toHaveLength(4);
  });

  it('runs the route tests beside a plan, never superseding it, and gives them and what waits behind them longer', async () => {
    const client = createEngineClient({ spawn });
    const w = workers[0]!;
    w.ready();
    await client.ready;
    const tested = client.test({ project: 1, ci: true });
    const planned = client.simulate({ project: 1, scenario: { event: 'push' }, assume: [], detail: 'steps' });
    // Each has its own slot: both are posted, neither answered superseded.
    expect(w.sent.map((m) => m.type)).toEqual(['test', 'simulate']);
    // The simulate waits behind the test run in the worker: past its own watchdog, nothing restarts yet.
    await vi.advanceTimersByTimeAsync(3000);
    expect(workers).toHaveLength(1);
    const summary = { passed: 0, failed: 0, invalid: 0, skipped: 0 };
    w.reply({ id: 1, type: 'tested', project: 1, files: [], summary, exitCode: 0, ms: 2900 });
    w.reply(plan(2));
    expect(await tested).toMatchObject({ type: 'tested' });
    expect(await planned).toMatchObject({ type: 'plan' });
    // A test run alone may take 30 s before the worker counts as stalled.
    void client.test({ project: 1, ci: false });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(workers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(workers).toHaveLength(2);
  });

  it('rejects ready on a protocol mismatch and when the worker never starts', async () => {
    const client = createEngineClient({ spawn });
    workers[0]!.ready({ protocol: 2 as never });
    await expect(client.ready).rejects.toThrow(/protocol 2/);
    const slow = createEngineClient({ spawn, readyTimeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(101);
    await expect(slow.ready).rejects.toThrow(/did not start/);
  });
});
