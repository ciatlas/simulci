import { stringOf } from './values';
import {
  formatUnitPath,
  type PathSegment,
  type PathStep,
  parseUnitPath,
  type UnitPath,
  workflowMatches,
} from '../paths';
import type {
  ActionPlan,
  JobPlan,
  LegPlan,
  NodeId,
  RemoteUse,
  RunPlan,
  StepPlan,
  Tri,
  WorkflowPlan,
} from './types';

/**
 * Unit paths → plan nodes. A job without `[…]` is the JobPlan; with `[…]` the matching legs; a step is one StepPlan
 * per selected leg; `/` descends into a called workflow after a job and into a composite action after a step. A
 * name that does not exist where its parent is planned is an error (T204); a unit under a parent the plan did not
 * expand (an untriggered workflow, a skipped job, a callee that is not loaded, a remote one not fetched, not read,
 * past a cap or that does not parse) is reported as unexpanded, for the caller to treat as skipped or missing.
 */

export interface Selected {
  kind: 'job' | 'leg' | 'step';
  id: NodeId;
  /** The canonical unit path (`test[node=20,os=ubuntu-latest].unit`). */
  path: string;
  workflow: WorkflowPlan;
  job: JobPlan;
  leg?: LegPlan;
  step?: StepPlan;
  composite?: ActionPlan;
}

export interface Unexpanded {
  /** The node under which the path could not be followed. */
  at: NodeId;
  verdict: Tri;
  /** The canonical path of the boundary node. */
  path: string;
  reason:
    | 'skipped'
    | 'untriggered'
    | 'not-loaded'
    | 'not-fetched'
    | 'fetch-failed'
    | 'limit'
    | 'invalid'
    | 'no-steps';
  /** The remote the boundary calls, for the remote reasons. */
  remote?: RemoteUse;
}

const REMOTE_REASONS = {
  'not-fetched': 'not-fetched',
  failed: 'fetch-failed',
  limit: 'limit',
  invalid: 'invalid',
} as const;

/** Why a leg that runs has no callee: its remote's state, or not loaded. */
function callBoundary(leg: LegPlan, path: string, remotes: ReadonlyMap<NodeId, RemoteUse>): Unexpanded {
  const base = { at: leg.id, verdict: leg.runs.verdict, path };
  if (leg.runs.verdict === 'no') return { ...base, reason: 'skipped' };
  const remote = remotes.get(leg.id);
  const reason = remote && remote.state !== 'simulated' ? REMOTE_REASONS[remote.state] : 'not-loaded';
  return remote ? { ...base, reason, remote } : { ...base, reason };
}

/** The remote workflow each calling leg names, by leg id. */
export function remotesByLeg(plan: RunPlan): Map<NodeId, RemoteUse> {
  const out = new Map<NodeId, RemoteUse>();
  for (const r of plan.remotes ?? []) if (r.kind === 'workflow') for (const at of r.at) out.set(at, r);
  return out;
}

export interface Selection {
  nodes: Selected[];
  unexpanded?: Unexpanded;
}

export class SelectionError extends Error {
  override name = 'SelectionError';
  constructor(
    readonly code: 'T201' | 'T204',
    message: string,
  ) {
    super(message);
  }
}

/** The nodes a unit path names in the plan, from its qualifier or the default workflow. */
export function selectNodes(plan: RunPlan, path: string | UnitPath, defaultWorkflow?: string): Selection {
  const unit = typeof path === 'string' ? parseUnitPath(path) : path;
  const name = unit.workflow ?? defaultWorkflow;
  const roots = plan.workflows.filter((w) => w.depth === 0);
  const wf = name === undefined ? undefined : roots.find((w) => workflowMatches(name, w.path));
  if (!wf) {
    const known = roots.map((w) => w.path.replace(/^.*\//, '')).join(', ');
    throw new SelectionError('T201', `no workflow '${name ?? ''}' in the plan (workflows: ${known})`);
  }
  const out: Selection = { nodes: [] };
  selectIn(wf, unit.segments, 0, '', out, remotesByLeg(plan));
  return out;
}

function selectIn(
  wf: WorkflowPlan,
  segments: PathSegment[],
  i: number,
  prefix: string,
  out: Selection,
  remotes: ReadonlyMap<NodeId, RemoteUse>,
): void {
  const seg = segments[i]!;
  if (wf.jobs.length === 0) {
    const path = prefix.replace(/\/$/, '');
    out.unexpanded ??= { at: wf.id, verdict: wf.triggered.verdict, path, reason: 'untriggered' };
    return;
  }
  const job = wf.jobs.find((j) => j.jobId === seg.job);
  if (!job) throw noJob(wf, seg.job!, prefix);
  const legs = seg.leg ? legsOf(job, seg, prefix) : job.legs;
  if (seg.step) {
    for (const leg of legs) selectStep(wf, job, leg, segments, i, prefix, out);
    return;
  }
  if (i === segments.length - 1) selectUnit(wf, job, legs, seg, prefix, out);
  else selectCalled(job, legs, segments, i, prefix, out, remotes);
}

/** The last segment without a step: the job itself, or the legs its `[…]` picks. */
function selectUnit(
  wf: WorkflowPlan,
  job: JobPlan,
  legs: LegPlan[],
  seg: PathSegment,
  prefix: string,
  out: Selection,
): void {
  if (!seg.leg) {
    out.nodes.push({ kind: 'job', id: job.id, path: `${prefix}${job.jobId}`, workflow: wf, job });
    return;
  }
  for (const leg of legs)
    out.nodes.push(selected('leg', wf, job, leg, `${prefix}${job.jobId}${legSuffix(leg)}`));
}

/** `a/x`: a job of the workflow `a` calls, per selected leg. */
function selectCalled(
  job: JobPlan,
  legs: LegPlan[],
  segments: PathSegment[],
  i: number,
  prefix: string,
  out: Selection,
  remotes: ReadonlyMap<NodeId, RemoteUse>,
): void {
  const name = `${prefix}${job.jobId}`;
  if (!job.uses) {
    throw new SelectionError(
      'T204',
      `'${name}' does not call a reusable workflow; / descends into a called workflow (write ${name}.x for a step)`,
    );
  }
  for (const leg of legs) {
    const path = `${name}${legSuffix(leg)}`;
    if (leg.call) selectIn(leg.call, segments, i + 1, `${path}/`, out, remotes);
    else out.unexpanded ??= callBoundary(leg, path, remotes);
  }
}

function selectStep(
  wf: WorkflowPlan,
  job: JobPlan,
  leg: LegPlan,
  segments: PathSegment[],
  i: number,
  prefix: string,
  out: Selection,
): void {
  const seg = segments[i]!;
  const legPath = `${prefix}${job.jobId}${legSuffix(leg)}`;
  if (leg.call) {
    const jobs = leg.call.jobs.map((j) => j.jobId).join(', ');
    throw new SelectionError(
      'T204',
      `'${legPath}' calls a reusable workflow and has no steps; / descends into its jobs (${jobs})`,
    );
  }
  if (!leg.steps) {
    out.unexpanded ??= {
      at: leg.id,
      verdict: leg.runs.verdict,
      path: legPath,
      reason: leg.runs.verdict === 'no' ? 'skipped' : 'no-steps',
    };
    return;
  }
  const step = findStep(leg.steps, seg.step!);
  if (!step) throw noStep(leg.steps, seg.step!, legPath);
  const stepPath = `${legPath}.${stepName(step)}`;
  descendSteps(wf, job, leg, step, segments, i + 1, stepPath, out);
}

/** The step itself, or the inner steps of its composite action (`a.u/#2/...`). */
function descendSteps(
  wf: WorkflowPlan,
  job: JobPlan,
  leg: LegPlan,
  step: StepPlan,
  segments: PathSegment[],
  i: number,
  path: string,
  out: Selection,
): void {
  if (i === segments.length) {
    const node = selected('step', wf, job, leg, path);
    node.step = step;
    out.nodes.push(node);
    return;
  }
  const inner = segments[i]!.step!;
  if (!step.composite) {
    const what =
      step.uses === undefined
        ? `'${path}' is a run step; / descends into a composite action's steps`
        : `'${path}' uses ${step.uses}, which is not a composite action in the project; its steps are not in the plan`;
    throw new SelectionError('T204', what);
  }
  const found = findStep(step.composite.steps, inner);
  if (!found) throw noStep(step.composite.steps, inner, path);
  const node = selected('step', wf, job, leg, `${path}/${stepName(found)}`);
  node.step = found;
  node.composite = step.composite;
  if (i + 1 < segments.length) descendSteps(wf, job, leg, found, segments, i + 1, node.path, out);
  else out.nodes.push(node);
}

function legsOf(job: JobPlan, seg: PathSegment, prefix: string): LegPlan[] {
  const want = Object.entries(seg.leg!);
  const name = `${prefix}${job.jobId}`;
  const selector = `[${want.map(([k, v]) => `${k}=${v}`).join(',')}]`;
  if (!job.matrix) throw new SelectionError('T204', `'${name}' has no matrix; drop the ${selector}`);
  for (const [k] of want) {
    if (!job.matrix.keys.some((key) => key.toLowerCase() === k.toLowerCase()))
      throw new SelectionError(
        'T204',
        `no matrix key '${k}' in '${name}' (keys: ${job.matrix.keys.join(', ')})`,
      );
  }
  if (job.matrix.dynamic || job.matrix.truncated)
    throw new SelectionError(
      'T204',
      `the matrix of '${name}' is only known at run time; its legs cannot be selected`,
    );
  const legs = job.legs.filter((leg) =>
    want.every(([k, v]) => {
      const cell = Object.entries(leg.values).find(([key]) => key.toLowerCase() === k.toLowerCase())?.[1];
      return cell?.known === true && stringOf(cell.value) === v;
    }),
  );
  if (legs.length === 0) {
    const have = job.legs.map((l) => `[${l.legKey}]`).join(', ');
    throw new SelectionError('T204', `no leg of '${name}' matches ${selector} (legs: ${have})`);
  }
  return legs;
}

function findStep(steps: StepPlan[], want: PathStep): StepPlan | undefined {
  return want.id !== undefined ? steps.find((s) => s.stepId === want.id) : steps[want.index! - 1];
}

const stepName = (step: StepPlan): string => step.stepId ?? `#${step.index + 1}`;
const legSuffix = (leg: LegPlan): string => (leg.legKey === '' ? '' : `[${leg.legKey}]`);

function selected(
  kind: 'leg' | 'step',
  wf: WorkflowPlan,
  job: JobPlan,
  leg: LegPlan,
  path: string,
): Selected {
  return { kind, id: leg.id, path, workflow: wf, job, leg };
}

function noJob(wf: WorkflowPlan, jobId: string, prefix: string): SelectionError {
  const ids = wf.jobs.map((j) => j.jobId);
  const near = closest(jobId, ids);
  const where = prefix ? `under '${prefix.replace(/\/$/, '')}'` : `in ${wf.path.replace(/^.*\//, '')}`;
  return new SelectionError(
    'T204',
    `no job '${jobId}' ${where} (jobs: ${ids.join(', ')})${near ? `; did you mean '${near}'?` : ''}`,
  );
}

function noStep(steps: StepPlan[], want: PathStep, parent: string): SelectionError {
  const names = steps.map((s) =>
    s.stepId !== undefined ? s.stepId : `#${s.index + 1}${s.name ? ` '${s.name}'` : ''}`,
  );
  const wanted = want.id !== undefined ? `'${want.id}'` : `#${want.index}`;
  const near =
    want.id === undefined
      ? undefined
      : closest(
          want.id,
          steps.flatMap((s) => (s.stepId === undefined ? [] : [s.stepId])),
        );
  return new SelectionError(
    'T204',
    `no step ${wanted} in '${parent}' (steps: ${names.join(', ')})${near ? `; did you mean '${near}'?` : ''}`,
  );
}

/** The nearest candidate within two edits of the name, when one is nearer than the rest. */
export function closest(name: string, candidates: string[]): string | undefined {
  const scored = candidates
    .filter((c) => c !== name)
    .map((c) => ({ c, d: editDistance(name.toLowerCase(), c.toLowerCase()) }))
    .filter(({ d }) => d <= 2)
    .sort((a, b) => a.d - b.d);
  const [best, next] = scored;
  return best && (!next || next.d > best.d) ? best.c : undefined;
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** The canonical unit path of every node of a depth-0 workflow, by node id (a single leg shares its job's id). */
export function unitPaths(wf: WorkflowPlan, prefix = ''): Map<NodeId, string> {
  const paths = new Map<NodeId, string>();
  for (const job of wf.jobs) {
    paths.set(job.id, `${prefix}${job.jobId}`);
    for (const leg of job.legs) legPaths(leg, `${prefix}${job.jobId}${legSuffix(leg)}`, paths);
  }
  return paths;
}

function legPaths(leg: LegPlan, legPath: string, paths: Map<NodeId, string>): void {
  if (!paths.has(leg.id)) paths.set(leg.id, legPath);
  if (leg.call) for (const [id, p] of unitPaths(leg.call, `${legPath}/`)) paths.set(id, p);
  for (const step of leg.steps ?? []) stepPaths(step, `${legPath}.${stepName(step)}`, paths);
}

function stepPaths(step: StepPlan, path: string, paths: Map<NodeId, string>): void {
  paths.set(step.id, path);
  if (!step.composite) return;
  paths.set(step.composite.id, path);
  for (const inner of step.composite.steps) stepPaths(inner, `${path}/${stepName(inner)}`, paths);
}

/** A node or unknown id in unit-path form (`a.detect.outputs.sha`, `race:fail-fast:a[n=1]`); ids outside the workflow unchanged. */
export function unitPathOfId(id: string, paths: Map<NodeId, string>): string {
  const race = /^(race:[a-z-]+:)(.*)$/.exec(id);
  if (race) return `${race[1]}${unitPathOfId(race[2]!, paths)}`;
  const direct = paths.get(id);
  if (direct !== undefined) return direct;
  let best: NodeId | undefined;
  for (const node of paths.keys()) {
    if (id.startsWith(`${node}.`) && (best === undefined || node.length > best.length)) best = node;
  }
  return best === undefined ? id : `${paths.get(best)}${id.slice(best.length)}`;
}

export { formatUnitPath };
