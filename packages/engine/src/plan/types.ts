import type { RemoteFailureKind, RemoteKind, RemotePinned } from '../remotes/lock';
import type { Scenario } from '../scenario';

/**
 * RunPlan, schema version 1: what the engine emits and every consumer reads (text, JSON, Mermaid, tests, snapshots,
 * the app, annotations). A field is here iff computing it needs GitHub semantics, the evaluator or the mocks; lookup,
 * counting and formatting are functions over the plan. No prose except `Diagnostic.message`.
 *
 * Additive keys and new `kind` values keep the version; a change to a closed enum, the id grammar, the ordering or
 * the canonical form bumps it (a major release).
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Whether a unit runs for the scenario. */
export type Tri = 'yes' | 'no' | 'maybe';

/** A job, leg or step result as `needs.<id>.result`, `steps.<id>.outcome` and `conclusion` report it. */
export type Result = 'success' | 'failure' | 'cancelled' | 'skipped';
/** The closed, ordered set of results; `oneOf` lists candidates in this order. */
export const RESULTS: readonly Result[] = ['success', 'failure', 'cancelled', 'skipped'];

/** `<path>` for a workflow, `<workflow>#<job>`, `<job>[<legKey>]`, `<leg>/<stepKey>`, `<step>><actionPath>`. */
export type NodeId = string;
/** `<node>.outputs.<name>`, `<node>.outcome`, `<node>.env.<NAME>`, `inputs.x`, `hashFiles(<args>)`, `race:fail-fast:<leg>`, … */
export type UnknownId = string;
/** `assume[i]`, `cli[i]`, `config:<key>`, `model:<name>`. */
export type MockRef = string;

/** A source position, 1-based. */
export interface Loc {
  file: string;
  line: number;
  column: number;
}

/** A three-valued value: known (and who made it so), or unknown because of named unknowns, with finite candidates when there are. */
export type Value<T> =
  | { known: true; value: T; by?: MockRef }
  | { known: false; unknowns: UnknownId[]; oneOf?: T[] };

export interface EventReason {
  kind: 'event';
  event: string;
  /** The workflow listens to the event. */
  listens: boolean;
}

export interface TypesReason {
  kind: 'types';
  action?: string;
  allowed: string[];
  matched: Value<boolean>;
}

export type FilterKind =
  | 'branches'
  | 'branches-ignore'
  | 'tags'
  | 'tags-ignore'
  | 'paths'
  | 'paths-ignore'
  | 'workflows';

export interface FilterReason {
  kind: 'filter';
  filter: FilterKind;
  patterns: string[];
  /** The ref name, the changed files or the triggering workflow the patterns are matched against. */
  subject: Value<string | string[]>;
  matched: Value<boolean>;
  loc?: Loc;
}

export interface DefaultBranchReason {
  kind: 'default-branch';
  matched: boolean;
}

export interface SkipCiReason {
  kind: 'skip-ci';
  marker: string;
}

/** The parent decided: a job of an untriggered workflow, a step of a skipped job. */
export interface ParentReason {
  kind: 'parent';
  node: NodeId;
  verdict: Tri;
}

export interface IfReason {
  kind: 'if';
  /** The condition as written (empty when absent). */
  expr: string;
  /** The condition as GitHub evaluates it, with the implicit `success()`. */
  evaluated: string;
  implicitSuccess: boolean;
  /** The job or step status the status functions read. */
  status: Value<Result>;
  value: Value<boolean>;
  /** The expression with the known parts folded, when something stays unknown. */
  residual?: string;
  reads: { ref: string; value: Value<Json>; from?: NodeId }[];
  loc?: Loc;
}

export interface ScheduleReason {
  kind: 'schedule';
  crons: string[];
  cron?: string;
  matched: boolean;
}

export interface MatrixReason {
  kind: 'matrix';
  unknown: UnknownId;
}

export interface LimitReason {
  kind: 'limit';
  /** `nesting`, `workflows`, `matrix`, … per the platform profile. */
  limit: string;
}

/** Reasons are an open set: a consumer renders the kinds it knows and names the others. */
export type Reason =
  | EventReason
  | TypesReason
  | FilterReason
  | DefaultBranchReason
  | SkipCiReason
  | ParentReason
  | IfReason
  | ScheduleReason
  | MatrixReason
  | LimitReason;

/** The verdict and the chain of reasons in evaluation order; the engine stops at the first `no`. */
export interface Decision {
  verdict: Tri;
  chain: Reason[];
}

export interface CheckStem {
  /** The check name with the matrix part elided. */
  stem: string;
  /** The one check GitHub reports when the job is skipped. */
  skippedName: string;
  certain: boolean;
}

export interface MatrixPlan {
  keys: string[];
  exact: boolean;
  dynamic: boolean;
  truncated: boolean;
  count?: number;
  failFast: Value<boolean>;
  maxParallel?: Value<number>;
  loc?: Loc;
}

export interface StepPlan {
  id: NodeId;
  /** `steps.<id>` or `~<slug>`. */
  key: string;
  index: number;
  stepId?: string;
  name?: string;
  uses?: string;
  run?: boolean;
  runs: Decision;
  outcome: Value<Result>;
  conclusion: Value<Result>;
  continueOnError: Value<boolean>;
  with: Record<string, Value<string>>;
  env: Record<string, Value<string>>;
  outputs: Record<string, Value<string>>;
  composite?: ActionPlan;
  /** Where the step is declared. */
  loc?: Loc;
}

/** A composite action's main steps, nested under the step that uses it. */
export interface ActionPlan {
  id: NodeId;
  path: string;
  /** The `inputs` context the inner steps read: the step's `with:` over the action's defaults. */
  inputs: Record<string, Value<Json>>;
  steps: StepPlan[];
  outputs: Record<string, Value<string>>;
}

export interface LegPlan {
  id: NodeId;
  /** `k=v` pairs sorted by key, `?` for an unknown value, `*` for an unknown matrix; empty without a matrix. */
  legKey: string;
  values: Record<string, Value<Json>>;
  origin?: 'product' | 'include';
  runs: Decision;
  result: Value<Result>;
  /** The composed check name (`caller / callee`); absent on a leg that calls a workflow. */
  check?: { name: string; certain: boolean };
  runsOn?: Value<string[]>;
  environment?: Value<string>;
  env: Record<string, Value<string>>;
  outputs: Record<string, Value<string>>;
  steps?: StepPlan[];
  call?: WorkflowPlan;
}

export interface JobPlan {
  id: NodeId;
  jobId: string;
  name?: string;
  needs: NodeId[];
  uses?: string;
  /** Before the matrix: the job-level `if:` and the needs cascade. */
  runs: Decision;
  /** What `needs.<id>.result` reads. */
  result: Value<Result>;
  /** As readers see them: `''` when the job is skipped, a race unknown when legs disagree. */
  outputs: Record<string, Value<string>>;
  check: CheckStem;
  matrix?: MatrixPlan;
  continueOnError: Value<boolean>;
  with?: Record<string, Value<Json>>;
  secrets?: Record<string, Value<boolean>>;
  legs: LegPlan[];
  /** Where the job is declared. */
  loc?: Loc;
}

export interface WorkflowPlan {
  id: NodeId;
  path: string;
  name?: string;
  /** The events listened to. */
  on: string[];
  triggered: Decision;
  conclusion: Value<Result>;
  inputs: Record<string, Value<Json>>;
  /** Carried from the file, never simulated. */
  concurrency?: { group?: string; cancelInProgress?: Value<boolean> };
  jobs: JobPlan[];
  outputs: Record<string, Value<string>>;
  /** The leg that calls this workflow, for a called instance. */
  caller?: NodeId;
  /** A called remote workflow: the ref it is shown by (`path` too) and the commit it was read at. */
  remote?: { ref: string; sha: string };
  depth: number;
}

/**
 * A remote workflow or action the plan uses. `simulated`: read and planned from its file; `invalid`: read, but its file
 * does not parse, so it is planned as not read; `failed`: the host could not read it (`failure` says why); `limit`: past
 * a host's cap; `not-fetched`: the host did not try. Every workflow the plan calls is listed; an action only when the
 * host read it or tried to.
 */
export interface RemoteUse {
  /** The `uses:` as written; a `./` or `$/` inside a remote as `owner/repo/path@<the ref its parent is shown at>`. */
  ref: string;
  kind: RemoteKind;
  state: 'simulated' | 'invalid' | 'failed' | 'limit' | 'not-fetched';
  /** The legs that call it, or the steps that use it (planned under `detail: 'legs'` too, though not listed there). */
  at: NodeId[];
  sha?: string;
  pinned?: RemotePinned;
  /** The host that served it, when not the run's. */
  host?: string;
  failure?: RemoteFailureKind;
}

/**
 * What an unknown is, from its id: `step-output` `<node>.outputs.<name>` (a step's, or a leg's from a mock), `outcome`
 * `<node>.outcome`, `env` `<step>.env.<NAME>` (a `$GITHUB_ENV` write), `race` `race:…`, `conflict` `conflict:…`
 * (SC103), `var` the whole `vars` context (a variable the scenario does not set reads as `''`, as on GitHub, so
 * `vars.X` is never unknown), and the scenario's (`input`, `secret`, `event`, `changed-files`, …).
 */
export type UnknownKind =
  | 'step-output'
  | 'outcome'
  | 'env'
  | 'race'
  | 'matrix'
  | 'var'
  | 'input'
  | 'secret'
  | 'event'
  | 'runner'
  | 'changed-files'
  | 'hashfiles'
  | 'conflict'
  | 'unsupported';

/** What a mock or scenario field would pin. `fragment` is written by the mock layer named. */
export interface Pin {
  layer: 'scenario' | 'config' | 'assume';
  fragment: Json;
  /** The path under which the fragment goes (e.g. `['when', 'changed']`). */
  at?: string[];
  flag?: string;
}

export interface Unknown {
  id: UnknownId;
  kind: UnknownKind;
  /** The step or leg (a job's one bare leg shares its id) whose output, outcome or env write it is; a race's leg. */
  producer?: NodeId;
  loc?: Loc;
  reads: Loc[];
  /** The nodes that run `maybe` because of it; the rank is its length. */
  affects: NodeId[];
  /**
   * What would pin it: a scenario field, or an assume entry naming the producer (`step:` or `job:` by unit path, its
   * leg as `matrix:`, `workflow:` when another workflow has a job of the same id) with the field prefilled (`''`, the
   * outcome `failure`, a race's leg `cancelled`). Absent: nothing the author writes pins it.
   */
  pin?: Pin;
  gap?: string;
}

export type MockLayer = 'builtin' | 'shipped' | 'config' | 'given' | 'case' | 'cli';

export interface AppliedMock {
  ref: MockRef;
  layer: MockLayer;
  loc?: Loc;
  at: NodeId;
  /** The fields it supplied: `outcome`, `outputs.<name>`, `env.<NAME>`. */
  provides: string[];
}

export type Severity = 'error' | 'warning' | 'info';

/** `error` makes the plan invalid (`simulci test` exits 2); the engine still returns it. */
export interface Diagnostic {
  severity: Severity;
  /** `SC1xx` for mocks, open for other kinds. */
  code: string;
  message: string;
  loc?: Loc;
  node?: NodeId;
  mock?: MockRef;
}

export interface RunPlan {
  $schema?: string;
  schemaVersion: 1;
  engine?: { name: 'simulci'; version: string };
  scenario: Scenario;
  detail: 'legs' | 'steps';
  workflows: WorkflowPlan[];
  /** Ranked by the number of nodes affected, then id. */
  unknowns: Unknown[];
  mocks: AppliedMock[];
  models: { id: string; version: string }[];
  /** Sorted by ref; absent when the plan uses no remote workflow and no remote action a host read. */
  remotes?: RemoteUse[];
  diagnostics: Diagnostic[];
}
