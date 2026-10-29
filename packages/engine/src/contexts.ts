import {
  type Combination,
  type ContextResolver,
  type EvalValue,
  lookup,
  matrixResolver,
  UNKNOWN,
} from '@ciatlas/core';
import type { Json, Result, Value } from './plan/types';
import { known, unknown } from './plan/values';
import type { Scenario } from './scenario';
import type { JobStatus } from './status';

/**
 * The contexts an expression reads at one point of the run, resolved from the scenario and the plan so far. One
 * lookup serves both core's evaluator (as a `ContextResolver`) and the reason chain (which records every read with
 * its value and the unknowns behind it).
 */

export interface NeedState {
  result: Value<Result>;
  outputs: Record<string, Value<string>>;
  /** The legs that call a workflow the plan does not load: they may set outputs beyond the ones listed. */
  open?: readonly string[];
}

export interface StepState {
  /** The node id of the step, which names its unknown outputs. */
  id: string;
  outcome: Value<Result>;
  conclusion: Value<Result>;
  outputs: Record<string, Value<string>>;
  /** The step may set outputs beyond the ones listed (a script that mentions nothing, a remote action without a model). */
  open?: boolean;
}

export interface ContextState {
  scenario: Scenario;
  /** The name of the workflow (`github.workflow`) and the job id (`github.job`). */
  workflow?: string;
  job?: string;
  /** `env` as far as it is known at this point: workflow, job and step env merged. */
  env?: Record<string, Value<string>>;
  /** `inputs`: a called workflow's, or the dispatch inputs. */
  inputs?: Record<string, Value<Json>>;
  /** `needs`: the jobs visible here (direct needs at a step, the transitive closure at a job-level `if:`). */
  needs?: Record<string, NeedState>;
  /** `jobs`, read by a reusable workflow's `outputs:`. */
  jobs?: Record<string, NeedState>;
  steps?: Record<string, StepState>;
  matrix?: Combination;
  status?: Value<JobStatus>;
  runsOn?: readonly string[];
  strategy?: { failFast: Value<boolean>; maxParallel?: Value<number>; jobIndex?: number; jobTotal?: number };
}

export interface ContextRef {
  context: string;
  path: string[];
}

/** The value of a context reference, with the unknown that explains a missing value. */
export function lookupContext(state: ContextState, ref: ContextRef): Value<Json> {
  const context = ref.context.toLowerCase();
  switch (context) {
    case 'github':
      return githubContext(state, ref.path);
    case 'env':
      return record(state.env ?? {}, ref.path, '');
    case 'vars':
      return varsContext(state.scenario, ref.path);
    case 'secrets':
      return secretsContext(state.scenario, ref.path);
    case 'inputs':
      return record(state.inputs ?? {}, ref.path, '');
    case 'needs':
      return needsContext(state.needs ?? {}, ref.path);
    case 'jobs':
      return needsContext(state.jobs ?? {}, ref.path);
    case 'steps':
      return stepsContext(state.steps ?? {}, ref.path);
    case 'matrix':
      return matrixContext(state.matrix, ref.path);
    case 'job':
      return jobContext(state, ref.path);
    case 'runner':
      return runnerContext(state.runsOn, ref.path);
    case 'strategy':
      return strategyContext(state.strategy, ref.path);
    default:
      return unknown([`${context}.${ref.path.join('.')}`]);
  }
}

/** Core's resolver over the same lookup: an unknown value is unknown there too. */
export function contextResolver(state: ContextState): ContextResolver {
  return (ref) => toEvalValue(lookupContext(state, ref));
}

export function toEvalValue(v: Value<Json>): EvalValue {
  return v.known ? { known: true, value: v.value, taint: [] } : UNKNOWN;
}

const GITHUB_EVENT_PATH: Record<string, (s: Scenario) => Value<Json> | undefined> = {
  action: (s) => (s.action === undefined ? undefined : known(s.action)),
  'head_commit.message': (s) => (s.message === undefined ? undefined : known(s.message)),
  'pull_request.number': (s) => (s.number === undefined ? undefined : known(s.number)),
  'pull_request.merged': (s) => (s.merged === undefined ? undefined : known(s.merged)),
  'pull_request.base.ref': (s) => (s.baseRef === undefined ? undefined : known(s.baseRef)),
  'pull_request.head.ref': (s) => (s.headRef === undefined ? undefined : known(s.headRef)),
  'pull_request.head.repo.fork': (s) => known(s.actor.fork),
  'repository.default_branch': (s) => known(s.defaultBranch),
  'workflow_run.name': (s) => (s.workflow_run ? known(s.workflow_run.name) : undefined),
  'workflow_run.conclusion': (s) => (s.workflow_run ? known(s.workflow_run.conclusion) : undefined),
  'workflow_run.head_branch': (s) =>
    s.workflow_run?.branch === undefined ? undefined : known(s.workflow_run.branch),
  ref: (s) => (s.ref === undefined ? undefined : known(s.ref)),
};

const opt = (v: Json | undefined): Value<Json> | undefined => (v === undefined ? undefined : known(v));

/** `github.<prop>` from the scenario; a property the scenario does not carry is unknown by that name. */
const GITHUB_PROPS: Record<string, (state: ContextState) => Value<Json> | undefined> = {
  event_name: ({ scenario }) => known(scenario.event),
  ref: ({ scenario }) => opt(scenario.ref),
  ref_name: ({ scenario }) => opt(scenario.refName),
  ref_type: ({ scenario }) => opt(scenario.refType),
  sha: ({ scenario }) => opt(scenario.sha),
  base_ref: ({ scenario }) => known(scenario.baseRef ?? ''),
  head_ref: ({ scenario }) => known(scenario.headRef ?? ''),
  repository: ({ scenario }) => opt(scenario.repository),
  repository_owner: ({ scenario }) => opt(scenario.repository?.split('/')[0]),
  actor: ({ scenario }) => opt(scenario.actor.login),
  triggering_actor: ({ scenario }) => opt(scenario.actor.login),
  workflow: (state) => opt(state.workflow),
  job: (state) => opt(state.job),
  server_url: () => known('https://github.com'),
  api_url: () => known('https://api.github.com'),
};

function githubContext(state: ContextState, path: string[]): Value<Json> {
  const [head, ...rest] = path;
  const key = head?.toLowerCase();
  const id = `github.${path.join('.')}`;
  if (key === 'event') return githubEvent(state.scenario, rest, id);
  const value = key === undefined ? undefined : GITHUB_PROPS[key]?.(state);
  return value ?? unknown([id]);
}

function githubEvent(scenario: Scenario, path: string[], id: string): Value<Json> {
  const lower = path.map((p) => p.toLowerCase());
  if (lower[0] === 'inputs') {
    // `github.event.inputs` holds every value as a string; a missing input is empty.
    const name = path[1];
    if (name === undefined) return unknown([id]);
    const v = lookup(scenario.inputs, name);
    return known(v === undefined ? '' : String(v));
  }
  const value = GITHUB_EVENT_PATH[lower.join('.')]?.(scenario);
  return value ?? unknown([id]);
}

/** The scenario's `vars` are the variables that exist; one that does not reads as empty (lab unknown-or-true). */
function varsContext(scenario: Scenario, path: string[]): Value<Json> {
  const name = path[0];
  if (name === undefined) return unknown(['vars']);
  return known(lookup(scenario.vars, name) ?? '');
}

/** A secret that exists has an opaque value; one that does not reads as empty. `GITHUB_TOKEN` always exists. */
function secretsContext(scenario: Scenario, path: string[]): Value<Json> {
  const name = path[0];
  if (name === undefined) return unknown(['secrets']);
  const exists =
    name.toLowerCase() === 'github_token' ||
    scenario.secrets.some((s) => s.toLowerCase() === name.toLowerCase());
  return exists ? unknown([`secrets.${name}`]) : known('');
}

/** `needs.<id>.result` and `needs.<id>.outputs.<name>`; a job not visible here, or an output it did not set, reads as empty. */
function needsContext(needs: Record<string, NeedState>, path: string[]): Value<Json> {
  const [id, field, name] = path;
  if (id === undefined) return unknown(['needs']);
  const need = lookup(needs, id);
  if (!need) return known(field === undefined ? null : '');
  if (field?.toLowerCase() === 'result') return need.result;
  if (field?.toLowerCase() === 'outputs')
    return name === undefined ? unknown([`needs.${id}.outputs`]) : needOutput(need, name);
  return known(null);
}

/** An output a call that is not loaded may have set is unknown, named by each such leg. */
function needOutput(need: NeedState, name: string): Value<string> {
  const open = need.open ?? [];
  return (
    lookup(need.outputs, name) ??
    (open.length ? unknown(open.map((leg) => `${leg}.outputs.${name}`)) : known(''))
  );
}

function stepsContext(steps: Record<string, StepState>, path: string[]): Value<Json> {
  const [id, field, name] = path;
  if (id === undefined) return unknown(['steps']);
  const step = lookup(steps, id);
  if (!step) return known(field === undefined ? null : '');
  return stepField(step, id, field?.toLowerCase(), name);
}

function stepField(
  step: StepState,
  id: string,
  key: string | undefined,
  name: string | undefined,
): Value<Json> {
  if (key === 'outcome') return step.outcome;
  if (key === 'conclusion') return step.conclusion;
  if (key !== 'outputs') return known(null);
  if (name === undefined) return unknown([`steps.${id}.outputs`]);
  // A step whose interface is open (a script that mentions nothing, a remote action without a model) may have set it.
  return lookup(step.outputs, name) ?? (step.open ? unknown([`${step.id}.outputs.${name}`]) : known(''));
}

function matrixContext(matrix: Combination | undefined, path: string[]): Value<Json> {
  if (!matrix) return known(null);
  const v = matrixResolver(matrix)({ context: 'matrix', path });
  if (v === undefined) return known(null);
  return v.known ? known(v.value) : unknown([`matrix.${path.join('.')}`]);
}

function jobContext(state: ContextState, path: string[]): Value<Json> {
  const key = path[0]?.toLowerCase();
  if (key === 'status') return state.status ?? unknown(['job.status']);
  return unknown([`job.${path.join('.')}`]);
}

/** `runner.os` and `runner.arch` from a hosted label; anything else only the runner knows. */
function runnerContext(runsOn: readonly string[] | undefined, path: string[]): Value<Json> {
  const key = path[0]?.toLowerCase();
  const hosted = hostedRunner(runsOn);
  if (hosted && key === 'os') return known(hosted.os);
  if (hosted && key === 'arch') return known(hosted.arch);
  return unknown([`runner.${path.join('.')}`]);
}

function hostedRunner(runsOn: readonly string[] | undefined): { os: string; arch: string } | undefined {
  const label = runsOn?.map((l) => l.toLowerCase()).find((l) => /^(ubuntu|windows|macos)-/.test(l));
  if (label === undefined) return undefined;
  if (label.startsWith('ubuntu')) return { os: 'Linux', arch: 'X64' };
  if (label.startsWith('windows')) return { os: 'Windows', arch: 'X64' };
  // macos-13 and the large runners are Intel; macos-14 and later are Apple silicon.
  const intel = label.startsWith('macos-13') || label.includes('large');
  return { os: 'macOS', arch: intel ? 'X64' : 'ARM64' };
}

function strategyContext(strategy: ContextState['strategy'], path: string[]): Value<Json> {
  const key = path[0]?.toLowerCase();
  if (!strategy) return known(null);
  if (key === 'fail-fast') return strategy.failFast;
  if (key === 'max-parallel') return strategy.maxParallel ?? known(null);
  if (key === 'job-index')
    return strategy.jobIndex === undefined ? unknown(['strategy.job-index']) : known(strategy.jobIndex);
  if (key === 'job-total')
    return strategy.jobTotal === undefined ? unknown(['strategy.job-total']) : known(strategy.jobTotal);
  return known(null);
}

function record(values: Record<string, Value<Json>>, path: string[], missing: string): Value<Json> {
  const name = path[0];
  if (name === undefined) return unknown(['record']);
  return lookup(values, name) ?? known(missing);
}
