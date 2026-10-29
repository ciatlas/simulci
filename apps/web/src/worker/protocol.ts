import type {
  AssumeEntry,
  Failure,
  GeneratedCase,
  Json,
  Loc,
  NodeId,
  Reference,
  ReferenceTarget,
  RunPlan,
  ScenarioInput,
  UnknownId,
} from '@simulci/engine';

/**
 * What the UI and the engine worker say to each other, version 1. The RunPlan JSON is the contract: the worker
 * loads, simulates and derives; the UI renders. Every request carries an id the reply echoes, so stale answers are
 * dropped; `PROTOCOL` is a tripwire asserted on `ready`, bumped on an incompatible change.
 */

export const PROTOCOL = 1 as const;
export const SUPPORTED_RUN_PLAN = 1 as const;

export interface LoadRequest {
  id: number;
  type: 'load';
  /** Repository files by path (`.github/workflows/ci.yml`, …). */
  files: Record<string, string>;
  /**
   * Route tests by path (`.github/simulci/tests/ci.test.yml`): never loaded into the project, only checked against
   * the test file schema, their failures reported as the Outline's `kind: 'test'` files.
   */
  tests?: Record<string, string>;
  /**
   * Read-only files by path, never loaded into the project either: the route tests' snapshots (`*.snap.json`), which a
   * `test` request checks the plans against.
   */
  readonly?: Record<string, string>;
  repository?: string;
}

export interface SimulateRequest {
  id: number;
  type: 'simulate';
  /** The project version `loaded` named; a stale one is answered with `error: stale`. */
  project: number;
  scenario: ScenarioInput;
  assume: AssumeEntry[];
  detail: 'legs' | 'steps';
  /**
   * Depth-0 workflows, by path, whose jobs are planned although nothing triggers them (the engine's
   * `planUntriggered`): edit mode's focused workflow, so an edit that stops it from running leaves its jobs to edit.
   */
  planUntriggered?: string[];
}

export interface CaseRequest {
  id: number;
  type: 'case';
  project: number;
  /** The depth-0 workflow the case is about. */
  workflow: string;
  scenario: ScenarioInput;
  assume: AssumeEntry[];
  detail: 'jobs' | 'steps';
  name?: string;
  format: 'test' | 'text' | 'mermaid';
  /**
   * The `given` of the test file the case is for, which `simulci test` merges into each case's scenario and mocks: the
   * case is planned under it, its `when` still the scenario sent. One the test file schema refuses is not applied (the
   * file's own failure says why).
   */
  given?: unknown;
}

/**
 * Where a job's or a step's id is written in its workflow, for a rename (synthesis § 3.3, § 8.3): the engine's
 * `referencesOf`, on the project `loaded` named.
 */
export interface RefsRequest {
  id: number;
  type: 'refs';
  project: number;
  target: ReferenceTarget;
}

/**
 * The route tests of the project `loaded` named, run as `simulci test` runs them (synthesis § 5.1), against the
 * snapshots of the same load; `ci` runs them as `simulci test --ci` does: a missing snapshot fails and `only` is invalid.
 * Off, a missing snapshot passes and is not written.
 */
export interface TestRequest {
  id: number;
  type: 'test';
  project: number;
  ci: boolean;
  /** Only the cases whose name contains the text. */
  filter?: string;
}

export type EngineRequest = LoadRequest | SimulateRequest | CaseRequest | RefsRequest | TestRequest;

export interface ModelInfo {
  id: string;
  version: string;
  presets: string[];
}

export interface ReadyResponse {
  type: 'ready';
  protocol: typeof PROTOCOL;
  engine: { version: string; runPlan: number };
  models: ModelInfo[];
  /**
   * Every event `on:` takes, with its activity types and the ones that apply when `types:` is omitted (both empty for
   * an event without types): what the triggers editor's Add event offers. Sent once, here.
   */
  events?: Record<string, { types: string[]; default: string[] }>;
}

export interface LoadedResponse {
  id: number;
  type: 'loaded';
  project: number;
  outline: Outline;
  ms: number;
}

export interface PlanResponse {
  id: number;
  type: 'plan';
  project: number;
  plan: RunPlan;
  derived: Derived;
  /** The plan as `simulci plan` prints it. */
  text: string;
  ms: { simulate: number; derive: number };
}

export interface CaseResponse {
  id: number;
  type: 'case';
  text: string;
  case?: GeneratedCase;
  /**
   * The error diagnostics of the plan a test case was written from (a mock that matches nothing, a conflict):
   * `simulci test` reports a case invalid for any of them. Absent when there are none.
   */
  errors?: { code: string; message: string }[];
}

export interface RefsResponse {
  id: number;
  type: 'refs';
  project: number;
  /** Each place the id is written, cut to the id, in file order: what a rename writes the new id over. */
  refs: Reference[];
  /** False when the workflow reads the target in ways no rename can follow; `notes` says where. */
  exact: boolean;
  /** Each such read, as a sentence: `needs[matrix.job]` (line 40) reads a job it computes; it is not renamed. */
  notes: string[];
}

/** A case as `simulci test` reports it, with what the Tests tab offers for it. */
export interface TestedCase {
  name: string;
  status: 'passed' | 'failed' | 'invalid' | 'skipped';
  failures: Failure[];
  /** Accepted maybes, `snapshot not written here`: what passed with a remark. */
  notes: string[];
  /** Why the case was skipped. */
  reason?: string;
  /** The line of the case's `name:` in its test file. */
  line: number;
  /** The workflow line that decided the first failure, else the one that decided whether the workflow runs. */
  deciding?: Loc;
  /** The case's scenario and mocks, its file's `given` under them: what Load into scenario puts in the form. */
  scenario?: ScenarioInput;
  assume?: AssumeEntry[];
}

export interface TestedFile {
  path: string;
  /** The workflow the file tests, as `workflow:` names it, by repository path. */
  workflow?: string;
  status: TestedCase['status'];
  /** Problems with the file itself (T0xx, T1xx, T201, T104). */
  failures: Failure[];
  notes: string[];
  cases: TestedCase[];
}

/** The route tests' results, as `simulci test` reports them, without the plans. */
export interface TestedResponse {
  id: number;
  type: 'tested';
  project: number;
  files: TestedFile[];
  summary: { passed: number; failed: number; invalid: number; skipped: number };
  exitCode: 0 | 1 | 2;
  ms: number;
}

export interface InvalidResponse {
  id: number;
  type: 'invalid';
  what: 'scenario' | 'assume' | 'workflow';
  issues: { path: (string | number)[]; message: string }[];
}

export interface ErrorResponse {
  id: number;
  type: 'error';
  /** `stale`: another project is loaded; `load`: the files could not be loaded; `engine`: ours. */
  kind: 'stale' | 'load' | 'engine';
  message: string;
  stack?: string;
}

export type EngineResponse =
  | ReadyResponse
  | LoadedResponse
  | PlanResponse
  | CaseResponse
  | RefsResponse
  | TestedResponse
  | InvalidResponse
  | ErrorResponse;

/** One event under `on:`, as hints for the scenario form; never a result. */
export interface OutlineEvent {
  event: string;
  types?: { allowed: string[]; all: string[]; narrowed: boolean };
  branches?: string[];
  branchesIgnore?: string[];
  tags?: string[];
  tagsIgnore?: string[];
  paths?: string[];
  pathsIgnore?: string[];
  crons?: string[];
  /**
   * Each of `crons` in words, as GitHub words it (the engine's `describeCron`): `Runs at 06:00, only on Monday`;
   * null for a cron GitHub would not accept, whose problem is among the file's errors.
   */
  cronText?: (string | null)[];
  workflows?: string[];
  /** The line of the event key under `on:`, and of each filter key. */
  loc?: { line: number; filters: Record<string, number> };
}

export interface OutlineInput {
  name: string;
  type?: string;
  required: boolean;
  default?: Json;
  options?: string[];
  description?: string;
}

export interface OutlineStep {
  index: number;
  id?: string;
  name?: string;
  uses?: string;
  line: number;
}

export interface OutlineJob {
  id: string;
  name?: string;
  needs: string[];
  uses?: string;
  matrix: boolean;
  steps: OutlineStep[];
  line: number;
  /** The names of the job's `outputs:`, which the jobs that need it read; absent when it declares none. */
  outputs?: string[];
}

/** The interface a reusable workflow declares under `on.workflow_call`, for the jobs that call it. */
export interface OutlineCall {
  inputs: OutlineInput[];
  outputs: string[];
  secrets: string[];
}

/** A local action (`action.yml` under its directory): what a step that uses it may pass and read. */
export interface OutlineAction {
  /** The directory `uses: ./<dir>` points at, repository-relative. */
  dir: string;
  file: string;
  name?: string;
  /** `runs.using`: `composite`, `node20`, `docker`. */
  using?: string;
  inputs: OutlineInput[];
  outputs: string[];
}

export interface OutlineWorkflow {
  path: string;
  name?: string;
  callable: boolean;
  generated?: string;
  /** In declaration order, `workflow_call` excluded. */
  events: OutlineEvent[];
  dispatch?: OutlineInput[];
  /** Its `workflow_call` interface, when other workflows may call it. */
  call?: OutlineCall;
  jobs: OutlineJob[];
  onLine: number;
}

export interface OutlineFile {
  path: string;
  kind: 'workflow' | 'action' | 'test' | 'other';
  /**
   * `yaml`: the YAML parser refused the text (core's `parseErrors`), which the edit hold watches for; `workflow`: the
   * workflow converter refused what parsed (an unknown event, a bad filter); `test`: a route test's failure as `simulci
   * test` reports it before running a case (T001 YAML, T002 schema, T103 a duplicate name), which never holds the
   * plan: no route test is in it.
   */
  errors: { line: number; column: number; message: string; source?: 'yaml' | 'workflow' | 'test' }[];
  /** Core's marker of a generated workflow or action (`DO NOT EDIT`, `.lock.yml`): the pane keeps it read-only. */
  generated?: string;
}

/** What the project holds, for the form, the outline tree and the YAML pane: hints, never results. */
export interface Outline {
  files: OutlineFile[];
  workflows: OutlineWorkflow[];
  /** The activity types of the events present, from the engine's table. */
  events: Record<string, { types: string[]; default: string[] }>;
  /** The local actions the workflows use, by directory; absent when there are none. */
  actions?: OutlineAction[];
}

/** Lookups over the plan computed by the worker with the engine's own functions, so the main thread needs no engine. */
export interface Derived {
  unitPaths: Record<NodeId, string>;
  kinds: Record<NodeId, 'workflow' | 'job' | 'leg' | 'step' | 'composite'>;
  /** The deciding clause of every node, worded as the CLI words it. */
  clauses: Record<NodeId, string>;
  /** The index of the deciding reason in the node's chain. */
  decidingIndex: Record<NodeId, number>;
  /** Where the deciding reason is written, when the plan or the outline knows. */
  decidingLoc: Record<NodeId, Loc>;
  /** The needs whose results decided a job through its `if:` (worker/deciding.ts), for jobs that have any. */
  decidingNeeds: Record<NodeId, NodeId[]>;
  unknownPaths: Record<UnknownId, string>;
}

const TYPES = new Set(['load', 'simulate', 'case', 'refs', 'test']);

const isObject = (v: unknown): boolean => typeof v === 'object' && v !== null;

/** Whether a message is a request the worker answers: the shape is checked, not trusted. */
export function isEngineRequest(data: unknown): data is EngineRequest {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  if (typeof d.id !== 'number' || typeof d.type !== 'string' || !TYPES.has(d.type)) return false;
  if (d.type === 'load')
    return isObject(d.files) && [d.tests, d.readonly].every((m) => m === undefined || isObject(m));
  if (d.type === 'refs') return typeof d.project === 'number' && isTarget(d.target);
  if (d.type === 'test')
    return (
      typeof d.project === 'number' &&
      typeof d.ci === 'boolean' &&
      (d.filter === undefined || typeof d.filter === 'string')
    );
  return (
    typeof d.project === 'number' &&
    typeof d.scenario === 'object' &&
    d.scenario !== null &&
    Array.isArray(d.assume)
  );
}

/** A job (`workflow`, `job`) or a step (and `step`) to find the references of, all strings. */
function isTarget(target: unknown): target is ReferenceTarget {
  if (typeof target !== 'object' || target === null) return false;
  const t = target as Record<string, unknown>;
  const named = typeof t.workflow === 'string' && typeof t.job === 'string';
  return named && (t.kind === 'job' || (t.kind === 'step' && typeof t.step === 'string'));
}
