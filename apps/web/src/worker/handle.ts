/* oxlint-disable no-restricted-imports -- the worker is where the engine runs */
import {
  AssumeListSchema,
  caseFromPlan,
  fileFromPlan,
  GivenSchema,
  type LoadedProject,
  loadFiles,
  mergeScenario,
  parseScenario,
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
  /** With the route tests and the snapshots of its load, which the `test` request runs. */
  project?: {
    version: number;
    loaded: LoadedProject;
    outline: Outline;
    tests: Record<string, string>;
    readonly: Record<string, string>;
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
    const loaded = loadFiles(request.files, request.repository);
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
      },
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { state, response: { id: request.id, type: 'error', kind: 'load', message } };
  }
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
  return { ...runRouteTests(project, request, project.version), ms: performance.now() - started };
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
  const result = simulate({ project: project.loaded, detail: 'steps', ...planInputs(request) });
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
