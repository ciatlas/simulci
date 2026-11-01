/* oxlint-disable no-restricted-imports -- the worker is where the engine runs */
import { ACTIONS_LOCK_FILE, remoteKey } from '@ciatlas/core';
import {
  AssumeListSchema,
  caseFromPlan,
  fileFromPlan,
  GivenSchema,
  type LoadedProject,
  type LoadOptions,
  loadFiles,
  mergeScenario,
  parseScenario,
  type NeededRemote,
  REMOTES_LOCK_FILE,
  type RemoteFailureInput,
  type RemoteInputs,
  type RemoteSourceInput,
  type RemotesMode,
  remotesNeeded,
  renderMermaid,
  renderText,
  ScenarioError,
  ScenarioInputSchema,
  type SimulateOptions,
  simulate,
} from '@simulci/engine';
import { carry, type FileCache, prefill } from './cache';
import { deriveTables } from './derived';
import { outlineOf } from './outline';
import type {
  CaseRequest,
  EngineRequest,
  EngineResponse,
  InvalidResponse,
  LoadRequest,
  Outline,
  RefsRequest,
  RemoteNeed,
  RemotePool,
  RemotePoolSource,
  SimulateRequest,
  TestRequest,
} from './protocol';
import { refsOf } from './refs';
import { runRouteTests, withTests } from './tests';

/**
 * The worker's state: one loaded project, numbered so a reply can be told from a stale one, and what its files' texts
 * gave, for the next load (worker/cache.ts).
 */
export interface WorkerState {
  /**
   * With the route tests and the snapshots of its load, which the `test` request runs, on the project as `simulci test`
   * loads it (`tested`: the plan's project when the load read no remote).
   */
  project?: {
    version: number;
    loaded: LoadedProject;
    outline: Outline;
    tests: Record<string, string>;
    readonly: Record<string, string>;
    tested: () => LoadedProject;
  };
  nextVersion: number;
  cache: FileCache;
}

export const initialState = (): WorkerState => ({ nextVersion: 1, cache: new Map() });

/** One request to one response, pure over the state: the worker and its tests call it. */
export function handle(
  state: WorkerState,
  request: EngineRequest,
): { state: WorkerState; response: EngineResponse } {
  try {
    if (request.type === 'load') return load(state, request);
    if (!state.project || state.project.version !== request.project) {
      return {
        state,
        response: {
          id: request.id,
          type: 'error',
          kind: 'stale',
          message: `project ${request.project} is not loaded`,
        },
      };
    }
    if (request.type === 'refs') return { state, response: refs(state.project, request) };
    if (request.type === 'test') return { state, response: test(state.project, request) };
    const invalid = validate(request);
    if (invalid) return { state, response: invalid };
    return {
      state,
      response: request.type === 'simulate' ? plan(state.project, request) : testCase(state.project, request),
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const response: EngineResponse = { id: request.id, type: 'error', kind: 'engine', message };
    if (e instanceof Error && e.stack) response.stack = e.stack;
    return { state, response };
  }
}

function load(state: WorkerState, request: LoadRequest): { state: WorkerState; response: EngineResponse } {
  const started = performance.now();
  try {
    const { loaded, needed } = withRemotes(request, request.remotes ? 'fetch' : 'off');
    const cache = carry(state.cache, request.files);
    prefill(loaded, cache);
    // The route tests are only checked: the project, the plan and the cache never hold them.
    const outline = withTests(outlineOf(loaded, cache), request.tests);
    const version = state.nextVersion;
    return {
      state: {
        project: {
          version,
          loaded,
          outline,
          tests: request.tests ?? {},
          readonly: request.readonly ?? {},
          tested: request.remotes ? once(() => withRemotes(request, 'lock').loaded) : () => loaded,
        },
        nextVersion: version + 1,
        cache,
      },
      response: {
        id: request.id,
        type: 'loaded',
        project: version,
        outline,
        ms: performance.now() - started,
        ...(needed.length ? { remotesNeeded: needed } : {}),
      },
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { state, response: { id: request.id, type: 'error', kind: 'load', message } };
  }
}

/** How deep remotes are followed (the engine's `remotesNeeded` stops there too), and how many are read at most. */
const MAX_DEPTH = 10;
const MAX_UNITS = 200;

/**
 * The project of a load with the remotes the page read (M4 synthesis § 5.3), as `simulci test` reads them in `mode`:
 * level by level, each ref the project needs is taken from the pool when it holds that ref at the commit its pin
 * names (an unpinned ref: as resolved live), so the worker pins exactly as the CLI does, whatever the pool holds besides
 * (another source's pins, a ref an edit since dropped). Past 200 remotes the rest are past the cap. What the project
 * still needs comes back, for the page to read; without a pool nothing is read and the load is as it always was. The
 * lock files ride in `readonly`; the engine reads them among the files, and the Outline lists only the project's.
 */
function withRemotes(
  request: LoadRequest,
  mode: RemotesMode,
): { loaded: LoadedProject; needed: RemoteNeed[] } {
  const files = { ...request.files, ...locksOf(request.readonly) };
  const opts: LoadOptions = request.repository === undefined ? {} : { repository: request.repository };
  const pool = request.remotes;
  const answer = (loaded: LoadedProject, needed: NeededRemote[]) => ({
    loaded: { ...loaded, files: request.files },
    needed: needed.map((n) => withDigest(loaded, n)),
  });
  if (!pool) {
    const loaded = loadFiles(files, opts);
    return answer(loaded, remotesNeeded(loaded, 'fetch'));
  }
  const taken: Required<RemoteInputs> = { sources: [], failed: [], limited: [] };
  for (let level = 0; ; level++) {
    const loaded = loadFiles(files, { ...opts, remotes: taken, mode });
    const needed = remotesNeeded(loaded, mode);
    const found = level <= MAX_DEPTH ? needed.flatMap((n) => inPool(pool, withDigest(loaded, n))) : [];
    if (!found.length) return answer(loaded, needed);
    // Admitted in core's order (by `remoteKey`), a read that failed counting toward the cap as core counts it.
    for (const f of found.sort((a, b) => byKey(a.ref, b.ref))) take(taken, f);
  }
}

/** A remote into what a load reads while fewer than 200 are (a file, or why it was not read), else past the cap. */
function take(taken: Required<RemoteInputs>, found: RemoteSourceInput | RemoteFailureInput): void {
  if (taken.sources.length + taken.failed.length >= MAX_UNITS) taken.limited.push(found.ref);
  else if ('text' in found) taken.sources.push(found);
  else taken.failed.push(found);
}

/** By `remoteKey`, then as written, by code unit: the order core admits a level's refs in. */
const byKey = (a: string, b: string): number => {
  const [x, y] = [remoteKey(a), remoteKey(b)];
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

/** The lock files among the read-only files: the engine reads them from the project's files. */
const locksOf = (readonly: Record<string, string> = {}): Record<string, string> =>
  Object.fromEntries(
    [REMOTES_LOCK_FILE, ACTIONS_LOCK_FILE].flatMap((p) =>
      readonly[p] === undefined ? [] : [[p, readonly[p]]],
    ),
  );

/**
 * What the pool holds of a need: its file read at the need's commit (or resolved live), or why it could not be. A file
 * read for another pin whose digest is not the one the lockfile records for that commit fails as `simulci test` fails
 * it, `digest`.
 */
function inPool(pool: RemotePool, need: RemoteNeed): (RemoteSourceInput | RemoteFailureInput)[] {
  const key = remoteKey(need.ref);
  const sha = need.pin?.sha;
  const source = pool.sources.findLast(
    (s) => remoteKey(s.ref) === key && (sha === undefined ? s.pinned === 'resolved' : s.sha === sha),
  );
  if (source)
    return [
      digestFailure(need, source) ?? { ...source, ref: need.ref, pinned: need.pin?.pinned ?? 'resolved' },
    ];
  const failure = pool.failed.findLast((f) => remoteKey(f.ref) === key && f.sha === sha);
  if (!failure) return [];
  const { sha: _, ...rest } = failure;
  return [{ ...rest, ref: need.ref }];
}

/** A `digest` failure when the file's digest is known and is not the one the lockfile records for its commit. */
function digestFailure(need: RemoteNeed, source: RemotePoolSource): RemoteFailureInput | undefined {
  if (!need.digest || !source.digest || source.digest === need.digest) return undefined;
  const message = `the digest of ${need.ref} at ${source.sha.slice(0, 7)} is ${source.digest}, not ${need.digest}`;
  return { ref: need.ref, kind: need.kind, failure: 'digest', message };
}

/** A need with the digest its lockfile entry records, when that entry is for the commit to read. */
function withDigest(loaded: LoadedProject, need: RemoteNeed): RemoteNeed {
  const lock = loaded.remotes.lock?.remotes ?? {};
  const key = Object.hasOwn(lock, need.ref)
    ? need.ref
    : Object.keys(lock).find((k) => remoteKey(k) === remoteKey(need.ref));
  const entry = key === undefined ? undefined : lock[key];
  return entry?.digest && need.pin?.sha === entry.sha ? { ...need, digest: entry.digest } : need;
}

/** `make`'s value, made the first time it is asked for. */
function once<T>(make: () => T): () => T {
  let made: { value: T } | undefined;
  return () => (made ??= { value: make() }).value;
}

/** The scenario and the mocks checked before the engine sees them, so a mistake comes back with its path. */
function validate(request: SimulateRequest | CaseRequest): InvalidResponse | undefined {
  const scenario = ScenarioInputSchema.safeParse(request.scenario);
  if (!scenario.success)
    return { id: request.id, type: 'invalid', what: 'scenario', issues: issuesOf(scenario.error.issues) };
  const assume = AssumeListSchema.safeParse(request.assume);
  if (!assume.success)
    return { id: request.id, type: 'invalid', what: 'assume', issues: issuesOf(assume.error.issues) };
  try {
    parseScenario(request.scenario);
  } catch (e) {
    if (!(e instanceof ScenarioError)) throw e;
    return { id: request.id, type: 'invalid', what: 'scenario', issues: [{ path: [], message: e.message }] };
  }
  return undefined;
}

interface ZodIssueLike {
  path: PropertyKey[];
  message: string;
  /** zod 4: the issues of each union member that was tried. */
  errors?: ZodIssueLike[][];
}

/** The leaf issues: a union's own "Invalid input" says less than the issues of the member that was meant. */
const issuesOf = (issues: ZodIssueLike[]): InvalidResponse['issues'] =>
  issues
    .flatMap((i) => leaves(i, []))
    .map((i) => ({
      path: i.path.map((p) => (typeof p === 'number' ? p : String(p))),
      message: i.message,
    }));

/** A member's issues have paths relative to the union; they are returned under the full path. */
function leaves(issue: ZodIssueLike, prefix: PropertyKey[]): ZodIssueLike[] {
  const path = [...prefix, ...issue.path];
  const nested = (issue.errors ?? []).flat().flatMap((e) => leaves(e, path));
  return nested.length ? nested : [{ ...issue, path }];
}

function plan(project: NonNullable<WorkerState['project']>, request: SimulateRequest): EngineResponse {
  const started = performance.now();
  const result = simulate({
    project: project.loaded,
    scenario: request.scenario,
    assume: request.assume,
    detail: request.detail,
    planUntriggered: request.planUntriggered,
  });
  const simulated = performance.now();
  const derived = deriveTables(result, project.outline);
  const text = renderText(result);
  return {
    id: request.id,
    type: 'plan',
    project: project.version,
    plan: result,
    derived,
    text,
    ms: { simulate: simulated - started, derive: performance.now() - simulated },
  };
}

function test(project: NonNullable<WorkerState['project']>, request: TestRequest): EngineResponse {
  const started = performance.now();
  const tested = { ...project, loaded: project.tested() };
  return { ...runRouteTests(tested, request, project.version), ms: performance.now() - started };
}

function refs(project: NonNullable<WorkerState['project']>, request: RefsRequest): EngineResponse {
  return {
    id: request.id,
    type: 'refs',
    project: project.version,
    ...refsOf(project.loaded, request.target),
  };
}

/**
 * What a case is planned from: the request's scenario and mocks, under its test file's `given` as `simulci test` runs a
 * case (`mergeScenario`, and the `given` mock layer beneath the case's). A `given` the schema refuses, or one that
 * leaves no valid scenario, is not applied.
 */
function planInputs(request: CaseRequest): Pick<SimulateOptions, 'scenario' | 'assume' | 'mocks'> {
  const plain = { scenario: request.scenario, assume: request.assume };
  if (request.given === undefined || request.format !== 'test') return plain;
  const given = GivenSchema.safeParse(request.given);
  if (!given.success) return plain;
  const scenario = mergeScenario(given.data, request.scenario);
  try {
    parseScenario(scenario);
  } catch (e) {
    if (e instanceof ScenarioError) return plain;
    throw e;
  }
  return {
    scenario,
    assume: request.assume,
    ...(given.data.assume ? { mocks: { given: given.data.assume } } : {}),
  };
}

function testCase(project: NonNullable<WorkerState['project']>, request: CaseRequest): EngineResponse {
  const known = project.outline.workflows.some(
    (w) => w.path === request.workflow || w.path.endsWith(`/${request.workflow}`),
  );
  if (!known)
    return {
      id: request.id,
      type: 'invalid',
      what: 'workflow',
      issues: [{ path: ['workflow'], message: `no workflow at ${request.workflow}` }],
    };
  // A test case is planned as `simulci test` will run it: on the project with only the pinned remotes.
  const loaded = request.format === 'test' ? project.tested() : project.loaded;
  const result = simulate({ project: loaded, detail: 'steps', ...planInputs(request) });
  if (request.format === 'text') return { id: request.id, type: 'case', text: renderText(result) };
  if (request.format === 'mermaid') return { id: request.id, type: 'case', text: renderMermaid(result) };
  const opts = {
    plan: result,
    workflow: request.workflow,
    scenario: request.scenario,
    assume: request.assume,
    detail: request.detail,
    ...(request.name === undefined ? {} : { name: request.name }),
  };
  const response: EngineResponse = {
    id: request.id,
    type: 'case',
    text: fileFromPlan(opts),
    case: caseFromPlan(opts),
  };
  const errors = result.diagnostics
    .filter((d) => d.severity === 'error')
    .map((d) => ({ code: d.code, message: d.message }));
  return errors.length ? { ...response, errors } : response;
}
