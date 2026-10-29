import { expect, vi } from 'vitest';
import type { RenameTarget } from '../src/edit/rename/run';
import { createSession, type Session } from '../src/engine/session';
import { createSessionStore, type SessionStore } from '../src/state/store';
import type { EngineClient } from '../src/worker/client';
import { handle, initialState, type WorkerState } from '../src/worker/handle';
import type { EngineRequest } from '../src/worker/protocol';

/**
 * The rename tests' page in this thread: a store, a session, and the worker's handler answering each request a
 * microtask later, as a worker would. `disposeSessions` ends the sessions a test opened.
 */

export const CI = '.github/workflows/ci.yml';
export const FOLDER = { kind: 'folder', name: 'repo', readAt: 0 } as const;

function inlineClient(): EngineClient & { sent: EngineRequest[] } {
  let state: WorkerState = initialState();
  let id = 0;
  const sent: EngineRequest[] = [];
  const ask = <R>(body: Omit<EngineRequest, 'id'>): Promise<R> =>
    new Promise((resolve) =>
      queueMicrotask(() => {
        const request = { ...body, id: ++id } as EngineRequest;
        sent.push(request);
        const out = handle(state, request);
        state = out.state;
        resolve(out.response as R);
      }),
    );
  return {
    sent,
    ready: Promise.resolve({
      type: 'ready',
      protocol: 1,
      engine: { version: 'test', runPlan: 1 },
      models: [],
    }),
    load: (body) => ask({ ...body, type: 'load' }),
    simulate: (body) => ask({ ...body, type: 'simulate' }),
    case: (body) => ask({ ...body, type: 'case' }),
    refs: (body) => ask({ ...body, type: 'refs' }),
    test: (body) => ask({ ...body, type: 'test' }),
    onRestart: () => undefined,
    onFailure: () => undefined,
    restarts: () => 0,
    terminate: () => undefined,
  };
}

const sessions: Session[] = [];

export function disposeSessions(): void {
  for (const s of sessions.splice(0)) s.dispose();
}

/** The plan of the newest texts and the assume entries now is on screen. */
export const planned = (store: SessionStore) =>
  vi.waitFor(() => {
    const s = store.getState();
    expect(s.plan?.for.files).toBe(s.files.version);
    expect(s.plan?.for.assume).toBe(s.assume);
  });

/** A store and a session over the inline worker, with a plan of the files on screen. */
export async function opened(byPath: Record<string, string>) {
  const store = createSessionStore();
  const client = inlineClient();
  const session = createSession({ store, client });
  sessions.push(session);
  store.getState().setFiles(byPath, FOLDER);
  await planned(store);
  return { store, session, client };
}

export const text = (store: SessionStore, path = CI): string => store.getState().files.byPath[path]!;

export const jobTarget = (store: SessionStore, file: string, job: string): RenameTarget => ({
  file,
  rev: store.getState().files.revs[file]!,
  job,
});

/** Each depth-0 workflow's job, by `<file>:<job>`, and the result its first leg plans. */
export const results = (store: SessionStore): Record<string, unknown> =>
  Object.fromEntries(
    (store.getState().plan?.plan.workflows ?? []).flatMap((w) =>
      w.jobs.map((j) => {
        const result = j.legs[0]?.result;
        return [
          `${w.path.split('/').at(-1)}:${j.jobId}`,
          result && 'value' in result ? result.value : undefined,
        ];
      }),
    ),
  );
