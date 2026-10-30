import {
  type ActionDecl,
  type Binding,
  type Combination,
  calledFunctions,
  expandMatrix,
  type InputDecl,
  type JobDecl,
  jobSegments,
  lookup,
  type MatrixExpansion,
  type ProjectIndex,
  parseExpression,
  type RemoteRef,
  remoteKey,
  type StepDecl,
  skippedCheckName,
  type UnitDecl,
  type UsesRef,
  type WorkflowDecl,
} from '@ciatlas/core';
import { z } from 'zod';
import type { ContextState, NeedState, StepState } from './contexts';
import { type Condition, evaluateCondition, evaluateValue, stringOf, substituteTemplates } from './evaluate';
import {
  type AssumeEntry,
  AssumeListSchema,
  type Facts,
  type MockLayers,
  MockResolver,
  type ModelUse,
} from './mocks/index';
import { type ActionModel, type ModelContext, modelFor, SHIPPED_MODELS } from './models/index';
import type { Location, LocationLink } from './paths';
import {
  callNodeId,
  compositeNodeId,
  jobNodeId,
  legKeyOf,
  legNodeId,
  stepKeyOf,
  stepNodeId,
} from './plan/ids';
import { assumePins, type UnitSite } from './plan/pins';
import type {
  ActionPlan,
  AppliedMock,
  Decision,
  Diagnostic,
  IfReason,
  JobPlan,
  Json,
  LegPlan,
  Loc,
  MatrixPlan,
  MockLayer,
  NodeId,
  Pin,
  Reason,
  RemoteUse,
  Result,
  RunPlan,
  StepPlan,
  Tri,
  Unknown,
  UnknownId,
  UnknownKind,
  Value,
  WorkflowPlan,
} from './plan/types';
import { candidates, combine, known, unknown } from './plan/values';
import {
  type PinContext,
  pinFor as remotePin,
  REMOTES_LOCK_FILE,
  type RemoteInputs,
  type RemotesMode,
} from './remotes/lock';
import {
  type LoadedProject,
  loadFiles,
  lookupRemote,
  namedByOrigin,
  pinContextOf,
  type RemoteLookup,
  remoteRefOf,
} from './remotes/state';
import { parseScenario, type Scenario, type ScenarioInput } from './scenario';
import { foldWrites } from './script-outputs';
import {
  type Expression,
  type JobSettings,
  readSettings,
  type StepSettings,
  type WorkflowSettings,
} from './settings';
import {
  type JobStatus,
  jobResult,
  jobStatusAfter,
  jobStatusFunctions,
  legResult,
  runConclusion,
  stepConclusion,
  stepStatusFunctions,
} from './status';
import { matchTrigger } from './triggers';
import { schemaUrl, VERSION } from './version';

/**
 * The planner: one three-valued pass over the project for a scenario. Workflows → jobs (in `needs` order) → legs
 * (one per matrix combination) → steps, with reusable workflows nested under the leg that calls them and composite
 * actions under the step that uses them. Opaque steps succeed with unknown outputs (mocks come in the next milestone).
 */

export interface SimulateOptions {
  /** Repository files by path (`.github/workflows/ci.yml`, `.github/actions/x/action.yml`, …), or a project loaded with `loadFiles`. */
  files?: Record<string, string>;
  project?: LoadedProject;
  scenario: ScenarioInput;
  detail?: 'legs' | 'steps';
  /** `owner/name`, for `uses:` references to this repository. */
  repository?: string;
  /** The remote files a host read, when `files` is given (see `loadFiles`). */
  remotes?: RemoteInputs;
  /** How the host read them, for the lockfile's diagnostics: `lock` by default. */
  remotesMode?: RemotesMode;
  /** How many reusable workflows may nest under a workflow before GitHub refuses to start it (lab R7: ten). */
  maxDepth?: number;
  /** Mocks for this run (the `case` layer): what opaque steps and jobs produce. */
  assume?: AssumeEntry[];
  /** Mocks by layer, when a caller distinguishes them (a test file's `given`, a command line). */
  mocks?: MockLayers;
  /** The action models to use, the shipped ones by default; `[]` switches them off. */
  models?: readonly ActionModel[];
  /**
   * Workflow paths whose jobs to plan although the scenario does not trigger them (an editor keeping the workflow it
   * edits on screen). Each job comes out skipped under the workflow; the workflow's own fields, the run's unknowns and
   * its checks stay as without the option.
   */
  planUntriggered?: string[];
}

export class MocksError extends Error {
  override name = 'MocksError';
}

export function simulate(opts: SimulateOptions): RunPlan {
  const scenario = parseScenario(opts.scenario);
  const repository = opts.repository ?? scenario.repository;
  const loaded =
    opts.project ??
    loadFiles(opts.files ?? {}, {
      ...(repository === undefined ? {} : { repository }),
      ...(opts.remotes ? { remotes: opts.remotes } : {}),
      ...(opts.remotesMode ? { mode: opts.remotesMode } : {}),
    });
  const layers: MockLayers = { ...opts.mocks };
  if (opts.assume) layers.case = [...(layers.case ?? []), ...opts.assume];
  for (const layer of ['given', 'case', 'cli'] as const) {
    const parsed = AssumeListSchema.safeParse(layers[layer] ?? []);
    if (!parsed.success) throw new MocksError(`invalid ${layer} mocks:\n${z.prettifyError(parsed.error)}`);
    layers[layer] = parsed.data;
  }
  return new Planner(
    loaded,
    scenario,
    opts.detail ?? 'steps',
    opts.maxDepth ?? 10,
    new MockResolver(layers),
    opts.models ?? SHIPPED_MODELS,
    new Set(opts.planUntriggered),
  ).run();
}

interface WorkflowContext {
  depth: number;
  /** The jobs and steps above this workflow when it is called. */
  chain?: LocationLink[];
  caller?: NodeId;
  triggered?: Decision;
  inputs?: Record<string, Value<Json>>;
  secrets?: string[];
  checkPrefix: string;
  /** A called remote workflow: the ref the plan shows it by, the ref name its `./` are shown at, and its commit. */
  remote?: { display: string; refName: string; sha: string };
}

/** The unit whose `uses:` a job or step names, and for a remote one the ref name its `./` and `$/` are shown at. */
interface Scope {
  unit: UnitDecl;
  refName?: string;
  /** The workflow of this repository that runs the unit, whose `actions.lock` entry pins its actions; none in a remote. */
  running?: string;
}

/** A remote a job or step names: its ref, how the plan shows it (`./` inside a remote at its parent's ref name), its state. */
interface RemoteTarget extends RemoteLookup {
  ref: RemoteRef;
  display: string;
}

/** A remote the plan uses: where, and the pin context of the `uses:` that says most about its commit. */
interface RemoteUseSite {
  target: RemoteTarget;
  at: (LegPlan | NodeId)[];
  context: PinContext;
}

/** What a workflow's jobs are planned with: its settings, node id, scenario, trigger decision, inputs and name. */
interface WorkflowSetup {
  settings: WorkflowSettings;
  id: NodeId;
  scenario: Scenario;
  triggered: Decision;
  inputs: Record<string, Value<Json>>;
  wfName: string;
}

interface JobContext {
  wf: WorkflowDecl;
  /** The workflow's path in locations: a remote one's ref as shown, so mocks and pins never see a commit. */
  wfPath: string;
  wfNode: NodeId;
  wfName: string;
  triggered: Decision;
  settings: JobSettings;
  wfEnv: Record<string, Value<string>>;
  inputs: Record<string, Value<Json>>;
  scenario: Scenario;
  planned: Map<string, JobPlan>;
  depth: number;
  checkPrefix: string;
  chain: LocationLink[];
  scope: Scope;
}

interface LegContext extends JobContext {
  job: JobDecl;
  jobNode: NodeId;
  jobRuns: Decision;
  needs: Record<string, NeedState>;
  failFast: Value<boolean>;
  index: number;
  total: number;
}

interface Segment {
  name: string;
  certain: boolean;
  /** The check name with the matrix part elided, when the job has a matrix. */
  stem?: string;
}

interface StepProduct {
  outcome: Value<Result>;
  outputs: Record<string, Value<string>>;
  open: boolean;
  composite?: ActionPlan;
  envWrites: Record<string, Value<string>>;
}

/** What an opaque step is: a local action, a remote action a shipped model knows, or neither. */
interface StepTarget {
  action?: ActionDecl;
  model?: ModelUse;
  /** Where the action's own `uses:` resolve. */
  scope?: Scope;
}

/** The outputs an opaque step may set before mocks: the names of its interface, those already valued, and whether it is open. */
interface Opaque {
  outputs: Record<string, Value<string>>;
  names: string[];
  open: boolean;
  what: string;
}

interface StepsResult {
  plans: StepPlan[];
  conclusions: Value<Result>[];
  /** The `steps` context after the last step, for the job's `outputs:`. */
  steps: Record<string, StepState>;
}

class Planner {
  private readonly unknowns = new Map<string, Unknown>();
  private readonly diagnostics: Diagnostic[] = [];
  private readonly applied: AppliedMock[] = [];
  private readonly models = new Map<string, string>();
  /** Every planned step and leg by id, with the location an assume entry is matched against. */
  private readonly units = new Map<NodeId, UnitSite>();
  /** The legs that call a workflow the plan does not load (by object: a dynamic matrix renames its leg). */
  private readonly openCalls = new WeakSet<LegPlan>();
  /** The remote workflows and actions the plan uses, by the ref it shows. */
  private readonly remoteUses = new Map<string, RemoteUseSite>();
  private readonly index: ProjectIndex;

  constructor(
    private readonly loaded: LoadedProject,
    private readonly scenario: Scenario,
    private readonly detail: 'legs' | 'steps',
    private readonly maxDepth: number,
    private readonly mocks: MockResolver,
    private readonly shipped: readonly ActionModel[],
    /** The depth-0 workflows whose jobs are planned although untriggered (`planUntriggered`). */
    private readonly untriggered: ReadonlySet<string>,
  ) {
    this.index = loaded.index;
  }

  run(): RunPlan {
    const workflows = [...this.index.project.workflows.values()].sort((a, b) => a.path.localeCompare(b.path));
    const plans = workflows.map((wf) => this.planWorkflow(wf, { depth: 0, checkPrefix: '' }));
    const remotes = this.finishRemotes();
    const plan: RunPlan = {
      $schema: schemaUrl('runPlan'),
      schemaVersion: 1,
      engine: { name: 'simulci', version: VERSION },
      scenario: this.scenario,
      detail: this.detail,
      workflows: plans,
      unknowns: [...this.unknowns.values()].sort(
        (a, b) => b.affects.length - a.affects.length || a.id.localeCompare(b.id),
      ),
      mocks: this.applied,
      models: [...this.models]
        .map(([id, version]) => ({ id, version }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      ...(remotes.length ? { remotes } : {}),
      diagnostics: this.finishDiagnostics(),
    };
    assumePins(plan, this.units);
    return plan;
  }

  /** The mocks' own diagnostics, plus the entries that named nothing in this plan (SC102). */
  private finishDiagnostics(): Diagnostic[] {
    const out = [...this.diagnostics, ...this.mocks.diagnostics];
    for (const c of this.mocks.unmatched()) {
      out.push({
        severity: 'error',
        code: 'SC102',
        message: `${c.ref} matches nothing in this plan`,
        mock: c.ref,
      });
    }
    return out;
  }

  // --- workflows ---------------------------------------------------------------------------------------------------

  private planWorkflow(wf: WorkflowDecl, ctx: WorkflowContext): WorkflowPlan {
    const setup = this.setupWorkflow(wf, ctx);
    const plan = workflowShell(wf, setup.id, setup.settings, setup.triggered, setup.inputs, ctx);
    if (setup.triggered.verdict === 'no') {
      if (ctx.depth === 0 && this.untriggered.has(wf.path)) plan.jobs = this.untriggeredJobs(wf, setup, ctx);
      return plan;
    }
    const { jobs, state } = this.planJobs(wf, setup, ctx);
    plan.jobs = jobs;
    plan.conclusion = runConclusion(jobs.map((j) => j.result));
    plan.outputs = this.callOutputs(wf, plan, state);
    return plan;
  }

  /**
   * The jobs of an untriggered workflow, asked for by `planUntriggered`: each is skipped under the workflow. The values
   * they read are no part of the run, so the unknowns they note are dropped.
   */
  private untriggeredJobs(wf: WorkflowDecl, setup: WorkflowSetup, ctx: WorkflowContext): JobPlan[] {
    const before = new Set(this.unknowns.keys());
    const { jobs } = this.planJobs(wf, setup, ctx);
    for (const id of this.unknowns.keys()) if (!before.has(id)) this.unknowns.delete(id);
    return jobs;
  }

  /** The jobs in `needs` order, listed as written, and the workflow's context for its outputs. */
  private planJobs(
    wf: WorkflowDecl,
    setup: WorkflowSetup,
    ctx: WorkflowContext,
  ): { jobs: JobPlan[]; state: ContextState } {
    const { id, settings, scenario, triggered, inputs, wfName } = setup;
    const base: ContextState = { scenario, workflow: wfName, inputs };
    const wfEnv = this.bindings(wf.env, base);
    const planned = new Map<string, JobPlan>();
    const jobCtx: Omit<JobContext, 'settings'> = {
      wf,
      wfPath: ctx.remote?.display ?? wf.path,
      wfNode: id,
      wfName,
      triggered,
      wfEnv,
      inputs,
      scenario,
      planned,
      depth: ctx.depth,
      checkPrefix: ctx.checkPrefix,
      chain: ctx.chain ?? [],
      scope: wf.external
        ? { unit: wf, ...(ctx.remote ? { refName: ctx.remote.refName } : {}) }
        : { unit: wf, running: wf.path },
    };
    for (const jobId of topoOrder(wf)) {
      const settingsOfJob = settings.jobs[jobId] ?? { id: jobId, if: 'success()', steps: [] };
      planned.set(jobId, this.planJob(wf.jobs[jobId]!, { ...jobCtx, settings: settingsOfJob }));
    }
    return { jobs: Object.keys(wf.jobs).map((k) => planned.get(k)!), state: { ...base, env: wfEnv } };
  }

  /** The workflow's settings, node id, scenario (a callee sees the secrets it is given), trigger decision and inputs. */
  private setupWorkflow(wf: WorkflowDecl, ctx: WorkflowContext): WorkflowSetup {
    const settings = this.settingsOf(wf);
    const id = ctx.caller === undefined ? wf.path : callNodeId(ctx.caller, ctx.remote?.display ?? wf.path);
    this.settingsDiagnostics(settings, wf.path, id);
    const scenario = ctx.secrets === undefined ? this.scenario : { ...this.scenario, secrets: ctx.secrets };
    const triggered = ctx.triggered ?? this.refusal(wf, id, this.triggerDecision(settings, id));
    const inputs = ctx.inputs ?? dispatchInputs(wf, scenario);
    return { settings, id, scenario, triggered, inputs, wfName: wf.name ?? wf.path };
  }

  private settingsOf(wf: WorkflowDecl): WorkflowSettings {
    let s = this.loaded.settings.get(wf.path);
    if (!s) {
      s = readSettings(wf.path, this.loaded.files[wf.path] ?? wf.source.text);
      this.loaded.settings.set(wf.path, s);
    }
    return s;
  }

  private settingsDiagnostics(settings: WorkflowSettings, file: string, node: NodeId): void {
    for (const e of settings.errors) {
      const d: Diagnostic = { severity: 'warning', code: 'parse', message: e.message, node };
      if (e.line !== undefined) d.loc = { file, line: e.line, column: e.column ?? 1 };
      this.diagnostics.push(d);
    }
  }

  private triggerDecision(settings: WorkflowSettings, node: NodeId): Decision {
    const m = matchTrigger(settings.events, this.scenario);
    for (const u of m.unknowns) this.register(u, m.decision.verdict === 'maybe' ? node : undefined);
    return m.decision;
  }

  /**
   * GitHub refuses to start a run whose reusable workflows nest more than `maxDepth` deep or that names more than 50 of
   * them, whatever its `if:`s say (lab R7): the workflow does not start, no job fails.
   */
  private refusal(wf: WorkflowDecl, id: NodeId, triggered: Decision): Decision {
    if (triggered.verdict === 'no') return triggered;
    const keys = new Set<string>();
    const depth = this.callDepth(wf, new Map(), new Set(), keys);
    let limit: string;
    let why: string;
    if (depth > this.maxDepth) {
      limit = 'nesting';
      why = Number.isFinite(depth)
        ? `its reusable workflows nest ${depth} deep, more than ${this.maxDepth}`
        : 'its reusable workflows call each other in a cycle';
    } else if (keys.size > MAX_CALLED_WORKFLOWS) {
      limit = 'workflows';
      why = `it names ${keys.size} reusable workflows, more than ${MAX_CALLED_WORKFLOWS}`;
    } else return triggered;
    this.diagnostics.push({
      severity: 'warning',
      code: 'refused',
      message: `GitHub does not start ${wf.path}: ${why}`,
      node: id,
    });
    return { verdict: 'no', chain: [...triggered.chain, { kind: 'limit', limit }] };
  }

  /**
   * How deep the calls under a workflow nest (1 for a call to a workflow that calls none), whatever their `if:`s, and
   * the key of every workflow called (a remote not read counts, with nothing under it). A cycle is infinitely deep.
   */
  private callDepth(
    wf: WorkflowDecl,
    done: Map<WorkflowDecl, number>,
    open: Set<WorkflowDecl>,
    keys: Set<string>,
  ): number {
    const memo = done.get(wf);
    if (memo !== undefined) return memo;
    if (open.has(wf)) return Number.POSITIVE_INFINITY;
    open.add(wf);
    let deepest = 0;
    for (const job of Object.values(wf.jobs)) {
      const { callee, remote } = this.resolveCallee(job, { unit: wf });
      const key = remote?.key ?? callee?.path;
      if (key === undefined) continue;
      keys.add(key);
      deepest = Math.max(deepest, 1 + (callee ? this.callDepth(callee, done, open, keys) : 0));
    }
    open.delete(wf);
    done.set(wf, deepest);
    return deepest;
  }

  /** The outputs a reusable workflow declares, read from its jobs. */
  private callOutputs(
    wf: WorkflowDecl,
    plan: WorkflowPlan,
    base: ContextState,
  ): Record<string, Value<string>> {
    if (!wf.call) return {};
    const jobs = Object.fromEntries(plan.jobs.map((j) => [j.jobId, this.needOf(j)]));
    return this.outputsOf(wf.call.outputs, { ...base, jobs });
  }

  // --- jobs --------------------------------------------------------------------------------------------------------

  private planJob(job: JobDecl, ctx: JobContext): JobPlan {
    const jobNode = jobNodeId(ctx.wfNode, job.id);
    const direct = job.needs.map((n) => n.id);
    const directResults = direct.map((n) => ctx.planned.get(n)?.result ?? known<Result>('skipped'));
    const ifState: ContextState = {
      scenario: ctx.scenario,
      workflow: ctx.wfName,
      job: job.id,
      env: ctx.wfEnv,
      inputs: ctx.inputs,
      needs: this.needsOf(closure(ctx.wf, job.id), ctx.planned),
    };
    const { runs, cond } = this.jobDecision(job, ctx, jobNode, directResults, ifState);
    const continueOnError = this.setting(ctx.settings.continueOnError, false, `${jobNode}.continue-on-error`);
    const exp = expandMatrix(job.matrix);
    const segments = jobSegments(job, checkInputs(ctx.inputs));
    const plan = jobShell(job, jobNode, ctx, runs, continueOnError, segments);
    if (job.uses) plan.with = this.bindingsJson(job.with, ifState);
    if (job.matrix) plan.matrix = this.matrixPlan(job, exp, ctx, jobNode);
    if (runs.verdict === 'no') {
      plan.legs = [skippedLeg(jobNode)];
      return plan;
    }
    const legCtx: Omit<LegContext, 'index'> = {
      ...ctx,
      job,
      jobNode,
      jobRuns: runs,
      needs: this.needsOf(direct, ctx.planned),
      failFast: plan.matrix?.failFast ?? known(true),
      total: exp.combos.length || 1,
    };
    plan.legs = this.legsOf(job, exp, segments, legCtx);
    for (const leg of plan.legs) {
      const location: Location = { workflow: ctx.wfPath, chain: [...ctx.chain, legLinkOf(job, leg)] };
      this.units.set(leg.id, { location, kind: 'job' });
      this.applyLegFacts(job, leg, jobNode, location);
    }
    this.failFast(plan);
    plan.result = this.jobResultOf(runs, cond, continueOnError, plan.legs);
    plan.outputs = this.jobOutputs(plan, jobNode);
    return plan;
  }

  /**
   * A mock on the job or one of its legs (`test[node=22]`, or `test` with `matrix:`): its outcome is the leg's result
   * (the steps stay planned), its outputs overlay the leg's. The job's result and outputs are then read from its legs.
   */
  private applyLegFacts(job: JobDecl, leg: LegPlan, jobNode: NodeId, location: Location): void {
    const facts = this.mocks.factsFor(location, leg.id, job.uses?.raw);
    if (facts.outcome) {
      leg.result = facts.outcome.value;
      this.record(facts.outcome.by, leg.id, 'outcome');
      if (job.steps.length)
        this.diagnoseOnce({
          severity: 'info',
          code: 'SC108',
          message: `${facts.outcome.by} sets the outcome of job ${job.id}; its steps are planned as written`,
          node: jobNode,
          mock: facts.outcome.by,
        });
    } else if (this.openCalls.has(leg)) this.noteValue(leg.result);
    const declared = job.uses ? Object.keys(leg.outputs) : Object.keys(job.outputs);
    this.overlayOutputs(leg.outputs, facts, leg.id, {
      closed: !this.openCalls.has(leg),
      names: declared,
      what: `job ${job.id}`,
    });
  }

  /** A diagnostic said once: every leg of a matrix that meets the same mock says the same thing. */
  private diagnoseOnce(d: Diagnostic): void {
    const said = this.diagnostics.some(
      (x) => x.code === d.code && x.mock === d.mock && x.message === d.message,
    );
    if (!said) this.diagnostics.push(d);
  }

  /**
   * Fail-fast: once a leg fails, the other legs are cancelled or finish first; `needs` reads the job as failed either way.
   * Whether a step of such a leg finished before the cancel is the same race (lab 6), so its conclusion is that race too.
   */
  private failFast(plan: JobPlan): void {
    if (!plan.matrix?.failFast.known || !plan.matrix.failFast.value) return;
    if (!plan.legs.some((l) => l.result.known && l.result.value === 'failure')) return;
    for (const leg of plan.legs) {
      if (!leg.result.known || leg.result.value !== 'success') continue;
      const id = `race:fail-fast:${leg.id}`;
      this.note([id]);
      leg.result = unknown([id], ['success', 'cancelled']);
      raceSteps(leg.steps ?? [], id);
    }
  }

  /** Mocked outputs over the unit's own; a name a closed interface does not declare is an error (SC101). */
  private overlayOutputs(
    outputs: Record<string, Value<string>>,
    facts: Facts,
    node: NodeId,
    iface: { closed: boolean; names: string[]; what: string },
  ): void {
    for (const [name, fact] of Object.entries(facts.outputs)) {
      if (iface.closed && !iface.names.includes(name)) {
        this.diagnoseOnce({
          severity: 'error',
          code: 'SC101',
          message: `${fact.by} sets output '${name}', which ${iface.what} does not declare${iface.names.length ? ` (it declares ${iface.names.join(', ')})` : ''}`,
          node,
          mock: fact.by,
        });
      }
      outputs[name] = fact.value.known ? { ...fact.value, by: fact.by } : fact.value;
      this.noteValue(fact.value);
      this.record(fact.by, node, `outputs.${name}`);
    }
  }

  private record(ref: string, at: NodeId, provides: string): void {
    const existing = this.applied.find((m) => m.ref === ref && m.at === at);
    if (existing) {
      if (!existing.provides.includes(provides)) existing.provides.push(provides);
      return;
    }
    this.applied.push({ ref, layer: layerOf(ref), at, provides: [provides] });
  }

  /** The job-level `if:` under the workflow's trigger, with the status functions answered from the direct needs. */
  private jobDecision(
    job: JobDecl,
    ctx: JobContext,
    jobNode: NodeId,
    directResults: Value<Result>[],
    ifState: ContextState,
  ): { runs: Decision; cond: Condition } {
    const cond = evaluateCondition(ctx.settings.if, ifState, jobStatusFunctions(directResults));
    const aggregate = combine(directResults, (rs) =>
      rs.some((r) => r === 'failure') ? 'failure' : rs.every((r) => r === 'success') ? 'success' : 'skipped',
    );
    const ifReason = this.ifReason(writtenIf(job), ctx.settings.if, aggregate, cond, job.ifSite?.loc);
    const parent: Reason = { kind: 'parent', node: ctx.wfNode, verdict: ctx.triggered.verdict };
    const runs = decide(ctx.triggered, cond.value, [parent, ifReason]);
    if (runs.verdict === 'maybe') this.noteValue(cond.value, jobNode);
    return { runs, cond };
  }

  private matrixPlan(job: JobDecl, exp: MatrixExpansion, ctx: JobContext, jobNode: NodeId): MatrixPlan {
    const matrix: MatrixPlan = {
      keys: exp.keys,
      exact: exp.exact,
      dynamic: exp.dynamic,
      truncated: exp.truncated,
      failFast: this.setting(ctx.settings.failFast, true, `${jobNode}.strategy.fail-fast`),
      loc: { file: ctx.wf.path, line: job.matrix!.loc.line, column: job.matrix!.loc.column },
    };
    if (!exp.dynamic && !exp.truncated) matrix.count = exp.combos.length;
    if (ctx.settings.maxParallel !== undefined)
      matrix.maxParallel = this.setting(ctx.settings.maxParallel, 0, `${jobNode}.strategy.max-parallel`);
    return matrix;
  }

  /** One leg per combination; a matrix only the run knows gives one placeholder leg. */
  private legsOf(
    job: JobDecl,
    exp: MatrixExpansion,
    segments: Segment[],
    ctx: Omit<LegContext, 'index'>,
  ): LegPlan[] {
    const fallback: Segment = { name: job.id, certain: false };
    if (!job.matrix) return [this.planLeg(undefined, segments[0] ?? fallback, { ...ctx, index: 0 })];
    if (!exp.dynamic && !exp.truncated) {
      return exp.combos.map((combo, i) => this.planLeg(combo, segments[i] ?? fallback, { ...ctx, index: i }));
    }
    const matrixUnknown = `${ctx.jobNode}.matrix`;
    this.note([matrixUnknown], ctx.jobNode);
    const leg = this.planLeg(undefined, segments[0] ?? fallback, { ...ctx, index: 0 });
    leg.legKey = '*';
    leg.id = legNodeId(ctx.jobNode, '*');
    const verdict: Tri = ctx.jobRuns.verdict === 'yes' ? 'maybe' : ctx.jobRuns.verdict;
    leg.runs = { verdict, chain: [...leg.runs.chain, { kind: 'matrix', unknown: matrixUnknown }] };
    return [leg];
  }

  /**
   * The result `needs` reads. A reader runs only where the workflow does, so a job `maybe` only because its workflow
   * is reads as its legs did; an `if:` the plan cannot decide adds `skipped`.
   */
  private jobResultOf(
    runs: Decision,
    cond: Condition,
    continueOnError: Value<boolean>,
    legs: LegPlan[],
  ): Value<Result> {
    const result = jobResult({ skipped: false, continueOnError, legResults: legs.map((l) => l.result) });
    return runs.verdict === 'maybe' ? orSkipped(result, cond.value, 'first') : result;
  }

  /** A job's outputs as readers see them: the legs' values, where an empty value never wins and the last to finish does (lab 8). */
  private jobOutputs(plan: JobPlan, jobNode: NodeId): Record<string, Value<string>> {
    const out: Record<string, Value<string>> = {};
    // A call job's outputs are the called workflow's, a plain job's its own; a mock on a leg may add one (SC101).
    const names = [...new Set(plan.legs.flatMap((l) => Object.keys(l.outputs)))];
    for (const name of names) {
      const values = plan.legs.map((l) => l.outputs[name] ?? this.unsetOutput(l, name));
      const ids = values.flatMap((v) => (v.known ? [] : v.unknowns));
      const nonEmpty = [...new Set(values.flatMap((v) => (v.known && v.value !== '' ? [v.value] : [])))];
      const chosen = nonEmpty[0] ?? '';
      if (ids.length) out[name] = unknown(ids);
      // The leg's own value, so a mocked one keeps its `by`.
      else if (nonEmpty.length <= 1) out[name] = values.find((v) => v.known && v.value === chosen)!;
      else {
        const race = `race:matrix-outputs:${jobNode}.${name}`;
        this.note([race]);
        out[name] = unknown([race], nonEmpty);
      }
    }
    return out;
  }

  // --- legs --------------------------------------------------------------------------------------------------------

  private planLeg(combo: Combination | undefined, seg: Segment, ctx: LegContext): LegPlan {
    const { job, jobNode } = ctx;
    const legKey = legKeyOf(combo);
    const legId = legNodeId(jobNode, legKey);
    const state = this.legState(combo, ctx);
    const runs: Decision = {
      verdict: ctx.jobRuns.verdict,
      chain: [{ kind: 'parent', node: jobNode, verdict: ctx.jobRuns.verdict }],
    };
    const leg: LegPlan = {
      id: legId,
      legKey,
      values: legValues(combo, legId),
      runs,
      result: known('success'),
      env: state.env ?? {},
      outputs: {},
    };
    if (combo) leg.origin = combo.origin;
    if (job.runsOn) leg.runsOn = this.runsOn(job, ctx.wf, state, legId);
    if (job.environment) leg.environment = this.environment(job, ctx.wf, state, legId);
    const location: Location = { workflow: ctx.wfPath, chain: [...ctx.chain, legLinkOf(job, leg)] };
    if (job.uses) {
      this.planCall(leg, state, seg, ctx, location);
      return leg;
    }
    leg.check = { name: `${ctx.checkPrefix}${seg.name}`, certain: seg.certain };
    const steps = this.planSteps(
      job.steps,
      ctx.settings.steps,
      legId,
      runs,
      state,
      undefined,
      location,
      ctx.scope,
    );
    if (this.detail === 'steps') leg.steps = steps.plans;
    leg.result = legResult(steps.conclusions);
    leg.outputs = this.outputsOf(job.outputs, { ...state, steps: steps.steps });
    return leg;
  }

  private legState(combo: Combination | undefined, ctx: LegContext): ContextState {
    const state: ContextState = {
      scenario: ctx.scenario,
      workflow: ctx.wfName,
      job: ctx.job.id,
      inputs: ctx.inputs,
      needs: ctx.needs,
      status: known('success'),
      steps: {},
      strategy: { failFast: ctx.failFast, jobIndex: ctx.index, jobTotal: ctx.total },
    };
    if (combo) state.matrix = combo;
    if (ctx.job.runsOn) state.runsOn = ctx.job.runsOn.labels;
    state.env = { ...ctx.wfEnv, ...this.bindings(ctx.job.env, state) };
    return state;
  }

  /** The labels of a leg: as declared, or a `runs-on: ${{ … }}` evaluated for the leg (its matrix values). */
  private runsOn(job: JobDecl, wf: WorkflowDecl, state: ContextState, legId: NodeId): Value<string[]> {
    if (!job.runsOn?.dynamic) return known(job.runsOn?.labels ?? []);
    const site = wf.sites.find(
      (s) => s.job === job.id && s.step === undefined && s.yamlPath.at(-1) === 'runs-on',
    );
    const v = site ? evaluateValue(site.text, state) : unknown<string>([`${legId}.runs-on`]);
    this.noteValue(v);
    return v.known ? known([v.value]) : unknown<string[]>(v.unknowns);
  }

  /** The environment of a leg: as declared, or an `environment: ${{ … }}` (or its `name:`) evaluated for the leg. */
  private environment(job: JobDecl, wf: WorkflowDecl, state: ContextState, legId: NodeId): Value<string> {
    const decl = job.environment!;
    if (!decl.dynamic) return known(decl.name);
    const site = wf.sites.find((s) => {
      if (s.job !== job.id || s.step !== undefined) return false;
      const tail = s.yamlPath.slice(-2);
      return tail.at(-1) === 'environment' || (tail[0] === 'environment' && tail[1] === 'name');
    });
    const v = site ? evaluateValue(site.text, state) : unknown<string>([`${legId}.environment`]);
    this.noteValue(v);
    return v;
  }

  /** A reusable workflow called by the leg: nested with the caller's inputs and secrets, its result from its jobs. */
  private planCall(
    leg: LegPlan,
    state: ContextState,
    seg: Segment,
    ctx: LegContext,
    location: Location,
  ): void {
    const { job } = ctx;
    const { callee, remote } = this.resolveCallee(job, ctx.scope);
    if (remote) this.useRemote(remote, leg, ctx.scope, job.uses!);
    if (!callee) {
      this.unsupportedCall(leg, job, remote);
      return;
    }
    const inputs = callInputs(job, callee, state);
    for (const v of Object.values(inputs)) this.noteValue(v);
    leg.call = this.planWorkflow(callee, {
      depth: ctx.depth + 1,
      chain: location.chain,
      caller: leg.id,
      triggered: {
        verdict: leg.runs.verdict,
        chain: [{ kind: 'parent', node: leg.id, verdict: leg.runs.verdict }],
      },
      inputs,
      secrets: job.secretsInherit ? this.inherited(ctx, remote) : Object.keys(job.secrets),
      checkPrefix: `${ctx.checkPrefix}${seg.name} / `,
      ...(remote?.source
        ? { remote: { display: remote.display, refName: refNameOf(remote.display), sha: remote.source.sha } }
        : {}),
    });
    const legResults = leg.call.jobs.map((j) => j.result);
    leg.result = jobResult({ skipped: false, continueOnError: known(false), legResults });
    // A copy: a mock on the calling job overlays the leg's outputs, not the called workflow's.
    leg.outputs = { ...leg.call.outputs };
  }

  /**
   * The workflow a job calls: in this repository's units a local one through the index, else the remote unit its ref
   * names (`./` and `$/` inside a remote name that remote's files at its commit; lab R2), with the remote's state.
   */
  private resolveCallee(job: JobDecl, scope: Scope): { callee?: WorkflowDecl; remote?: RemoteTarget } {
    if (!job.uses) return {};
    const remote = this.remoteTarget(scope, job.uses);
    if (!remote) return scope.unit.external ? {} : { callee: this.index.calleeOf(job) };
    const unit = remote.state === 'simulated' ? remote.unit : undefined;
    return unit?.kind === 'workflow' && unit.call ? { callee: unit, remote } : { remote };
  }

  private remoteTarget(scope: Scope, uses: UsesRef): RemoteTarget | undefined {
    const ref = remoteRefOf(scope.unit, uses);
    if (!ref) return undefined;
    const display = namedByOrigin(scope.unit, uses) ? atRefName(ref, scope.refName) : ref.raw;
    return { ...lookupRemote(this.loaded, ref), ref, display };
  }

  /** The secrets `secrets: inherit` passes: all of them, but only `GITHUB_TOKEN` to another owner's workflow (lab R6). */
  private inherited(ctx: JobContext, remote: RemoteTarget | undefined): string[] {
    const owner =
      ctx.scope.unit.origin?.owner ??
      (this.index.project.repository ?? this.scenario.repository)?.split('/')[0];
    const across = remote && owner !== undefined && remote.ref.owner.toLowerCase() !== owner.toLowerCase();
    return across ? [] : ctx.scenario.secrets;
  }

  /**
   * Records a use. Uses are one row per fetch key and shown ref: a `./` inside a remote is shown like a direct ref to
   * the same file at the parent's ref name, but is another remote. The pin context kept is the one that says most: an
   * `actions.lock` pin, else a use in this repository, else one in a remote.
   */
  private useRemote(target: RemoteTarget, at: LegPlan | NodeId, scope: Scope, uses: UsesRef): void {
    const row = `${target.key}\n${remoteKey(target.display)}`;
    const context = pinContextOf(
      this.loaded,
      scope.unit,
      uses,
      target.ref,
      scope.running ? [scope.running] : [],
    );
    const site = this.remoteUses.get(row);
    if (!site) this.remoteUses.set(row, { target, at: [at], context });
    else {
      site.at.push(at);
      if (contextRank(context) > contextRank(site.context)) site.context = context;
    }
  }

  /**
   * The remotes the plan lists (every workflow it calls, and the actions a host read or tried to), sorted by ref; and
   * the lockfile's word on each remote it uses, said at the first node that uses it.
   */
  private finishRemotes(): RemoteUse[] {
    const out: RemoteUse[] = [];
    for (const site of this.remoteUses.values()) {
      const at = [...new Set(site.at.map((a) => (typeof a === 'string' ? a : a.id)))].sort(byCodeUnit);
      const { issue } = remotePin(site.target.ref, site.context);
      if (issue) this.diagnostics.push({ ...issue, node: at[0]! });
      if (site.target.ref.kind === 'workflow' || site.target.state !== 'not-fetched')
        out.push(remoteUseOf(site.target, at));
    }
    const { lockError, mode } = this.loaded.remotes;
    if (lockError !== undefined && mode !== 'off') {
      const message = `${REMOTES_LOCK_FILE} cannot be read, so no remote is pinned by it: ${lockError}`;
      this.diagnostics.push({ severity: 'warning', code: 'remotes-lock-invalid', message });
    }
    return out.sort((a, b) => byCodeUnit(a.ref, b.ref) || byCodeUnit(a.at[0]!, b.at[0]!));
  }

  private unsupportedCall(leg: LegPlan, job: JobDecl, remote: RemoteTarget | undefined): void {
    this.callDiagnostics(leg.id, job, remote);
    leg.result =
      leg.runs.verdict === 'no'
        ? known('skipped')
        : unknown([`${leg.id}.call`], ['success', 'failure', 'skipped']);
    // Noted in `applyLegFacts`, unless a mock sets the outcome.
    if (leg.runs.verdict !== 'no') this.openCalls.add(leg);
  }

  /** Why a call is not planned: not fetched (`unsupported`), not read, past a cap, a parse error, or not callable. */
  private callDiagnostics(node: NodeId, job: JobDecl, remote: RemoteTarget | undefined): void {
    const shown = remote?.display ?? job.uses?.raw ?? '';
    if (remote?.state !== 'invalid') {
      this.diagnostics.push({ severity: 'warning', ...callProblem(shown, job, remote), node });
      return;
    }
    for (const e of remote.unit!.parseErrors) this.diagnoseOnce(parseDiagnostic(shown, e, node));
  }

  /** An output a leg does not list: empty, unless the leg calls a workflow the plan does not load. */
  private unsetOutput(leg: LegPlan, name: string): Value<string> {
    return this.openCalls.has(leg) ? unknown([`${leg.id}.outputs.${name}`]) : known('');
  }

  /** What `needs.<id>` reads of each planned job named. */
  private needsOf(ids: string[], planned: Map<string, JobPlan>): Record<string, NeedState> {
    const out: Record<string, NeedState> = {};
    for (const id of ids) {
      const p = planned.get(id);
      if (p) out[id] = this.needOf(p);
    }
    return out;
  }

  /** What `needs.<id>` (or `jobs.<id>`) reads of a planned job. */
  private needOf(p: JobPlan): NeedState {
    const open = p.legs.filter((l) => this.openCalls.has(l)).map((l) => l.id);
    return open.length
      ? { result: p.result, outputs: p.outputs, open }
      : { result: p.result, outputs: p.outputs };
  }

  // --- steps -------------------------------------------------------------------------------------------------------

  private planSteps(
    steps: StepDecl[],
    settings: StepSettings[],
    parentId: NodeId,
    parentRuns: Decision,
    state: ContextState,
    inputs: Record<string, Value<Json>> | undefined,
    parent: Location,
    scope: Scope,
  ): StepsResult {
    const taken = new Set<string>();
    const stepsState: Record<string, StepState> = {};
    const out: StepsResult = { plans: [], conclusions: [], steps: stepsState };
    let status: Value<JobStatus> = known('success');
    // `$GITHUB_ENV` writes a mock states reach the steps after it.
    const written: Record<string, Value<string>> = {};
    for (const step of steps) {
      const sid = stepNodeId(parentId, stepKeyOf(step, taken));
      const link: LocationLink = { kind: 'step', index: step.index + 1 };
      if (step.id !== undefined) link.id = step.id;
      if (step.uses) link.uses = step.uses.raw;
      const location: Location = { workflow: parent.workflow, chain: [...parent.chain, link] };
      const stepState: ContextState = {
        ...state,
        steps: stepsState,
        status,
        env: { ...state.env, ...written, ...this.bindings(step.env, state) },
      };
      if (inputs) stepState.inputs = inputs;
      const { plan, open, envWrites } = this.planStep(
        step,
        settings[step.index],
        sid,
        parentId,
        parentRuns,
        stepState,
        status,
        location,
        scope,
      );
      Object.assign(written, envWrites);
      out.plans.push(plan);
      if (step.id !== undefined)
        stepsState[step.id] = {
          id: sid,
          outcome: plan.outcome,
          conclusion: plan.conclusion,
          outputs: plan.outputs,
          open,
        };
      out.conclusions.push(plan.conclusion);
      status = jobStatusAfter(out.conclusions);
    }
    return out;
  }

  private planStep(
    step: StepDecl,
    st: StepSettings | undefined,
    sid: NodeId,
    parentId: NodeId,
    parentRuns: Decision,
    state: ContextState,
    status: Value<JobStatus>,
    location: Location,
    scope: Scope,
  ): { plan: StepPlan; open: boolean; envWrites: Record<string, Value<string>> } {
    this.units.set(sid, { location, kind: 'step' });
    const evaluated = st?.if ?? impliedIf(step);
    const cond = evaluateCondition(evaluated, state, stepStatusFunctions(status));
    const parent: Reason = { kind: 'parent', node: parentId, verdict: parentRuns.verdict };
    const ifReason = this.ifReason(
      writtenIf(step),
      evaluated,
      statusAsResult(status),
      cond,
      step.ifSite?.loc,
    );
    const runs = decide(parentRuns, cond.value, [parent, ifReason]);
    if (runs.verdict === 'maybe') this.noteValue(cond.value, sid);
    const continueOnError = this.setting(st?.continueOnError, false, `${sid}.continue-on-error`);
    const withValues = this.bindings(step.with, state);
    const target = this.stepTarget(step, sid, withValues, scope);
    const { outcome, outputs, open, composite, envWrites } = this.stepOutcome(
      step,
      target,
      sid,
      runs,
      cond,
      state,
      location,
    );
    const plan = stepShell(step, sid, parentId, runs, outcome, continueOnError, outputs);
    plan.with = withValues;
    plan.env = this.bindings(step.env, state);
    if (composite) plan.composite = composite;
    return { plan, open, envWrites };
  }

  /**
   * A `uses:` step's local action, or the shipped model of a remote one with what it sees (scenario, `with:`, `@ref`).
   * Inside a remote unit the index resolves nothing: its `./` is the job's workspace (lab R3), its `$/` the remote.
   */
  private stepTarget(
    step: StepDecl,
    sid: NodeId,
    withValues: Record<string, Value<string>>,
    scope: Scope,
  ): StepTarget {
    if (!step.uses) return {};
    const remote = this.remoteTarget(scope, step.uses);
    if (remote) this.useRemote(remote, sid, scope, step.uses);
    const action = remote || scope.unit.external ? undefined : this.index.actionOf(step);
    if (action)
      return { action, scope: { unit: action, ...(scope.running ? { running: scope.running } : {}) } };
    return this.modelTarget(remote?.display ?? step.uses.raw, sid, withValues);
  }

  private modelTarget(uses: string, sid: NodeId, withValues: Record<string, Value<string>>): StepTarget {
    const model = modelFor(uses, this.shipped);
    if (!model) return {};
    this.models.set(model.id, model.version);
    const ctx: ModelContext = { scenario: this.scenario, with: withValues, node: sid };
    const at = uses.indexOf('@');
    if (at !== -1) ctx.ref = uses.slice(at + 1);
    return { model: { model, ctx } };
  }

  /** What a step produces: skipped when it does not run; else as mocked or success, with outputs; a composite's inner steps decide unless mocked. */
  private stepOutcome(
    step: StepDecl,
    target: StepTarget,
    sid: NodeId,
    runs: Decision,
    cond: Condition,
    state: ContextState,
    location: Location,
  ): StepProduct {
    if (runs.verdict === 'no') return { outcome: known('skipped'), outputs: {}, open: false, envWrites: {} };
    const facts = this.mocks.factsFor(location, sid, step.uses?.raw, target.model);
    const envWrites = this.envWrites(step, sid, state, facts);
    const { produced, base } = this.producedOutcome(facts, runs, cond, sid);
    if (target.action?.using === 'composite') {
      return {
        ...this.compositeProduct(target, step, sid, state, runs, location, facts, produced, base),
        envWrites,
      };
    }
    const opaque = this.opaqueOutputs(step, target, sid, state);
    this.overlayOutputs(opaque.outputs, facts, sid, {
      closed: !opaque.open,
      names: opaque.names,
      what: opaque.what,
    });
    return { outcome: base, outputs: this.finishOutputs(opaque, sid), open: opaque.open, envWrites };
  }

  /**
   * The outputs in interface order, then the names only a mock added; a name nothing valued stays unknown. Only what
   * is unknown after the mocks is an unknown of the plan: a pinned output is not.
   */
  private finishOutputs(opaque: Opaque, sid: NodeId): Record<string, Value<string>> {
    const out: Record<string, Value<string>> = {};
    for (const name of opaque.names) out[name] = opaque.outputs[name] ?? outputUnknown(sid, name);
    for (const [name, v] of Object.entries(opaque.outputs)) out[name] ??= v;
    for (const v of Object.values(out)) this.noteValue(v);
    return out;
  }

  /** The `$GITHUB_ENV` writes the steps after this one read: the script's, under the mocked ones. */
  private envWrites(
    step: StepDecl,
    sid: NodeId,
    state: ContextState,
    facts: Facts,
  ): Record<string, Value<string>> {
    const writes = { ...this.scriptEnv(step, sid, state), ...this.envWritesOf(facts, sid) };
    for (const v of Object.values(writes)) this.noteValue(v);
    return writes;
  }

  private envWritesOf(facts: Facts, sid: NodeId): Record<string, Value<string>> {
    const envWrites: Record<string, Value<string>> = {};
    for (const [name, fact] of Object.entries(facts.env)) {
      envWrites[name] = fact.value;
      this.record(fact.by, sid, `env.${name}`);
    }
    return envWrites;
  }

  /** The outcome as mocked, else success; a step whose own `if:` is unknown may also have been skipped. */
  private producedOutcome(
    facts: Facts,
    runs: Decision,
    cond: Condition,
    sid: NodeId,
  ): { produced: Value<Result>; base: Value<Result> } {
    const produced: Value<Result> = facts.outcome ? facts.outcome.value : known('success');
    if (facts.outcome) this.record(facts.outcome.by, sid, 'outcome');
    const base = runs.verdict === 'yes' ? produced : orSkipped(produced, cond.value, 'last');
    return { produced, base };
  }

  /** A composite action under its step: a mocked outcome makes it opaque, otherwise its inner steps decide. */
  private compositeProduct(
    target: StepTarget,
    step: StepDecl,
    sid: NodeId,
    state: ContextState,
    runs: Decision,
    location: Location,
    facts: Facts,
    produced: Value<Result>,
    base: Value<Result>,
  ): Omit<StepProduct, 'envWrites'> {
    const action = target.action!;
    const composite = this.planComposite(action, step, sid, state, runs, location, target.scope!);
    const inner = facts.outcome ? produced : legResult(composite.steps.map((s) => s.conclusion));
    const outcome = combine([base, inner] as Value<Result>[], ([o, i]) =>
      o === 'skipped' ? 'skipped' : (i as Result),
    );
    const outputs = { ...composite.outputs };
    this.overlayOutputs(outputs, facts, sid, {
      closed: true,
      names: Object.keys(action.outputs),
      what: `action ${action.path}`,
    });
    return { outcome, outputs, open: false, composite };
  }

  /** The outputs an opaque step may set: a script's literal names, a local action's or a model's declared ones; the rest open. */
  private opaqueOutputs(step: StepDecl, target: StepTarget, sid: NodeId, state: ContextState): Opaque {
    if (step.run !== undefined) return this.scriptOutputs(step, sid, state);
    const uses = step.uses?.raw ?? '';
    if (target.action) {
      const names = Object.keys(target.action.outputs);
      return { outputs: {}, names, open: false, what: `action ${uses}` };
    }
    if (target.model) {
      const iface = target.model.model.interface(target.model.ctx);
      return { outputs: {}, names: iface.names, open: iface.open, what: `${target.model.model.id} (model)` };
    }
    return { outputs: {}, names: [], open: true, what: `action ${uses}` };
  }

  /** Literal `$GITHUB_OUTPUT` writes are known; the names core found that the fold could not value stay unknown. */
  private scriptOutputs(step: StepDecl, sid: NodeId, state: ContextState): Opaque {
    const outputs: Record<string, Value<string>> = {};
    const folded = foldWrites(substituteTemplates(step.run ?? '', state), {
      unknownId: (n) => `${sid}.outputs.${n}`,
    });
    for (const name of new Set([...step.writesOutputs.names, ...Object.keys(folded)]))
      outputs[name] = folded[name] ?? outputUnknown(sid, name);
    const open = !(step.writesOutputs.mentions && !step.writesOutputs.dynamic);
    return { outputs, names: Object.keys(outputs), open, what: 'the script' };
  }

  /** The `$GITHUB_ENV` writes of a script, as the steps after it read them. */
  private scriptEnv(step: StepDecl, sid: NodeId, state: ContextState): Record<string, Value<string>> {
    if (step.run === undefined) return {};
    const folded = foldWrites(substituteTemplates(step.run, state), {
      file: 'GITHUB_ENV',
      unknownId: (n) => `${sid}.env.${n}`,
    });
    return folded;
  }

  private planComposite(
    action: ActionDecl,
    step: StepDecl,
    stepNode: NodeId,
    state: ContextState,
    runs: Decision,
    location: Location,
    scope: Scope,
  ): ActionPlan {
    const id = compositeNodeId(stepNode, action.path);
    const given = this.bindings(step.with, state);
    const inputs: Record<string, Value<Json>> = {};
    for (const [name, decl] of Object.entries(action.inputs))
      inputs[name] = lookup(given, name) ?? inputDefault(decl);
    for (const [name, v] of Object.entries(given)) if (!(name in inputs)) inputs[name] = v;
    const inner = this.planSteps(
      action.steps,
      [],
      id,
      runs,
      { ...state, steps: {}, status: known('success') },
      inputs,
      location,
      scope,
    );
    const steps = Object.fromEntries(
      inner.plans
        .filter((p) => p.stepId !== undefined)
        .map((p) => [
          p.stepId!,
          { id: p.id, outcome: p.outcome, conclusion: p.conclusion, outputs: p.outputs },
        ]),
    );
    return {
      id,
      path: action.path,
      inputs,
      steps: inner.plans,
      outputs: this.outputsOf(action.outputs, { ...state, inputs, steps }),
    };
  }

  // --- values ------------------------------------------------------------------------------------------------------

  private ifReason(
    expr: string,
    evaluated: string,
    status: Value<Result>,
    cond: Condition,
    loc: Loc | undefined,
  ): IfReason {
    const reason: IfReason = {
      kind: 'if',
      expr,
      evaluated,
      implicitSuccess: expr.trim() !== evaluated,
      status,
      value: cond.value,
      reads: cond.reads,
    };
    if (loc) reason.loc = locOf(loc);
    return reason;
  }

  /** Declared outputs (`outputs:` of a job, a reusable workflow or a composite action), evaluated in `state`. */
  private outputsOf(
    decls: Record<string, { value?: unknown; site?: { text: string } }>,
    state: ContextState,
  ): Record<string, Value<string>> {
    const out: Record<string, Value<string>> = {};
    for (const [name, decl] of Object.entries(decls)) {
      const v = decl.site
        ? evaluateValue(decl.site.text, state)
        : known(stringOf((decl.value ?? null) as Json));
      this.noteValue(v);
      out[name] = v;
    }
    return out;
  }

  private bindings(bindings: Record<string, Binding>, state: ContextState): Record<string, Value<string>> {
    const out: Record<string, Value<string>> = {};
    for (const [name, b] of Object.entries(bindings)) {
      const v = b.site ? evaluateValue(b.site.text, state) : known(stringOf(b.value));
      this.noteValue(v);
      out[name] = v;
    }
    return out;
  }

  private bindingsJson(bindings: Record<string, Binding>, state: ContextState): Record<string, Value<Json>> {
    const out: Record<string, Value<Json>> = {};
    for (const [name, b] of Object.entries(bindings)) {
      const v: Value<Json> = b.site ? evaluateValue(b.site.text, state) : known(b.value);
      this.noteValue(v);
      out[name] = v;
    }
    return out;
  }

  private setting<T extends boolean | number>(
    value: T | Expression | undefined,
    fallback: T,
    id: string,
  ): Value<T> {
    if (value === undefined) return known(fallback);
    if (typeof value === 'object') {
      this.note([id]);
      return unknown([id]);
    }
    return known(value);
  }

  // --- unknowns ----------------------------------------------------------------------------------------------------

  private register(u: Unknown, affects: NodeId | undefined): void {
    const existing = this.unknowns.get(u.id);
    const entry = existing ?? u;
    if (!existing) this.unknowns.set(u.id, entry);
    if (affects !== undefined && !entry.affects.includes(affects)) entry.affects.push(affects);
  }

  private note(ids: readonly string[], affects?: NodeId): void {
    for (const id of ids) {
      const u: Unknown = { id, kind: kindOf(id), reads: [], affects: [] };
      const pin = pinFor(id);
      if (pin) u.pin = pin;
      this.register(u, affects);
    }
  }

  private noteValue(v: Value<unknown>, affects?: NodeId): void {
    if (!v.known) this.note(v.unknowns, affects);
  }
}

// --- helpers without state -----------------------------------------------------------------------------------------

function workflowShell(
  wf: WorkflowDecl,
  id: NodeId,
  settings: WorkflowSettings,
  triggered: Decision,
  inputs: Record<string, Value<Json>>,
  ctx: WorkflowContext,
): WorkflowPlan {
  const plan: WorkflowPlan = {
    id,
    path: ctx.remote?.display ?? wf.path,
    on: Object.keys(settings.events),
    triggered,
    conclusion: known('skipped'),
    inputs,
    jobs: [],
    outputs: {},
    depth: ctx.depth,
  };
  if (wf.name !== undefined) plan.name = wf.name;
  if (ctx.caller !== undefined) plan.caller = ctx.caller;
  if (ctx.remote) plan.remote = { ref: ctx.remote.display, sha: ctx.remote.sha };
  if (settings.concurrency) plan.concurrency = concurrencyOf(settings.concurrency, id);
  return plan;
}

function concurrencyOf(
  c: NonNullable<WorkflowSettings['concurrency']>,
  id: NodeId,
): NonNullable<WorkflowPlan['concurrency']> {
  const out: NonNullable<WorkflowPlan['concurrency']> = {};
  if (c.group !== undefined) out.group = c.group;
  const cip = c.cancelInProgress;
  if (cip !== undefined)
    out.cancelInProgress = typeof cip === 'boolean' ? known(cip) : unknown([`${id}.concurrency`]);
  return out;
}

function jobShell(
  job: JobDecl,
  jobNode: NodeId,
  ctx: JobContext,
  runs: Decision,
  continueOnError: Value<boolean>,
  segments: Segment[],
): JobPlan {
  const segment = segments[0];
  const plan: JobPlan = {
    id: jobNode,
    jobId: job.id,
    needs: job.needs.map((n) => jobNodeId(ctx.wfNode, n.id)),
    runs,
    result: known('skipped'),
    outputs: {},
    check: {
      stem: `${ctx.checkPrefix}${segment?.stem ?? job.id}`,
      skippedName: `${ctx.checkPrefix}${skippedCheckName(job)}`,
      certain: segments.every((s) => s.certain),
    },
    continueOnError,
    legs: [],
  };
  if (job.name !== undefined) plan.name = job.name;
  if (job.uses) plan.uses = job.uses.raw;
  plan.loc = locOf(job.loc);
  return plan;
}

const skippedLeg = (jobNode: NodeId): LegPlan => ({
  id: legNodeId(jobNode, ''),
  legKey: '',
  values: {},
  runs: { verdict: 'no', chain: [{ kind: 'parent', node: jobNode, verdict: 'no' }] },
  result: known('skipped'),
  env: {},
  outputs: {},
});

function stepShell(
  step: StepDecl,
  sid: NodeId,
  parentId: NodeId,
  runs: Decision,
  outcome: Value<Result>,
  continueOnError: Value<boolean>,
  outputs: Record<string, Value<string>>,
): StepPlan {
  const plan: StepPlan = {
    id: sid,
    key: sid.slice(parentId.length + 1),
    index: step.index,
    runs,
    outcome,
    conclusion: stepConclusion(outcome, continueOnError),
    continueOnError,
    with: {},
    env: {},
    outputs,
  };
  if (step.id !== undefined) plan.stepId = step.id;
  if (step.name !== undefined) plan.name = step.name;
  if (step.uses) plan.uses = step.uses.raw;
  if (step.run !== undefined) plan.run = true;
  plan.loc = locOf(step.loc);
  return plan;
}

/** GitHub's limit on the reusable workflows one run names (lab R7). */
const MAX_CALLED_WORKFLOWS = 50;

/** How much a `uses:`'s pin context says about a remote's commit: an `actions.lock` pin, a local use, a remote one. */
const contextRank = (c: PinContext): number => (c.actionsLock !== undefined ? 2 : c.inRemote ? 0 : 1);

/** By code unit, not locale, so every host orders alike. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A remote named through its unit's own repository, shown at the ref name the unit is shown at (GitHub records it so, lab R2). */
const atRefName = (ref: RemoteRef, refName: string | undefined): string =>
  `${ref.owner}/${ref.repo}${ref.path ? `/${ref.path}` : ''}@${refName ?? ref.ref}`;

const refNameOf = (display: string): string => display.slice(display.lastIndexOf('@') + 1);

function remoteUseOf(target: RemoteTarget, at: NodeId[]): RemoteUse {
  const use: RemoteUse = { ref: target.display, kind: target.ref.kind, state: target.state, at };
  if (target.source) {
    use.sha = target.source.sha;
    use.pinned = target.source.pinned;
    if (target.source.host !== undefined) use.host = target.source.host;
  }
  if (target.failure) use.failure = target.failure.failure;
  return use;
}

/** The diagnostic of a call that is not planned and whose file is not the problem. */
function callProblem(
  shown: string,
  job: JobDecl,
  remote: RemoteTarget | undefined,
): { code: string; message: string } {
  if (remote?.state === 'failed') {
    const { failure, message } = remote.failure!;
    return { code: 'remote-fetch-failed', message: `${shown}: not read (${failure}): ${message}` };
  }
  if (remote?.state === 'limit')
    return {
      code: 'remote-limit',
      message: `${shown}: not read, past the limit on how many remote files a run reads`,
    };
  const notLoaded = remote ? remote.state === 'not-fetched' : job.uses?.kind === 'remote-workflow';
  const why = notLoaded
    ? 'a remote reusable workflow is not loaded'
    : 'the called workflow was not found or cannot be called';
  return { code: 'unsupported', message: `${shown}: ${why}` };
}

/** A remote's parse error (an alias bomb is one), at its place in the remote's text. */
function parseDiagnostic(shown: string, e: { message: string; loc?: Loc }, node: NodeId): Diagnostic {
  const d: Diagnostic = { severity: 'warning', code: 'parse', message: `${shown}: ${e.message}`, node };
  if (e.loc) d.loc = locOf(e.loc);
  return d;
}

/** A plan position from a core one: file, line and column. */
const locOf = (loc: Loc): Loc => ({ file: loc.file, line: loc.line, column: loc.column });

function legValues(combo: Combination | undefined, legId: NodeId): Record<string, Value<Json>> {
  if (!combo) return {};
  return Object.fromEntries(
    Object.entries(combo.values).map(([k, c]) => [
      k,
      c.known ? known(c.value) : unknown([`${legId}.matrix.${k}`]),
    ]),
  );
}

/**
 * A result when the unit's own `if:` may leave it skipped: `skipped` joins its candidates (a job has listed it first, a
 * step last). A parent's `maybe` adds nothing: the unit's readers (`needs`, `steps`) run only where its parent does.
 */
function orSkipped(result: Value<Result>, cond: Value<boolean>, at: 'first' | 'last'): Value<Result> {
  if (cond.known) return result;
  const ids = [...cond.unknowns, ...(result.known ? [] : result.unknowns)];
  const options = candidates(result);
  if (!options) return unknown(ids);
  return unknown(ids, at === 'first' ? ['skipped', ...options] : [...options, 'skipped']);
}

const outputUnknown = (sid: NodeId, name: string): Value<string> => unknown([`${sid}.outputs.${name}`]);

/** A step that may succeed in a leg fail-fast may cancel: the cancel may come before it finishes (lab 6). */
function raceSteps(steps: StepPlan[], race: UnknownId): void {
  for (const step of steps) {
    const c = step.conclusion;
    const options = candidates(c);
    if (!options || options.includes('success')) {
      const ids = [race, ...(c.known ? [] : c.unknowns)];
      step.conclusion = unknown(ids, options && [...options, 'cancelled']);
    }
    if (step.composite) raceSteps(step.composite.steps, race);
  }
}

/** The link of a leg in a location: its job, with the leg's values (`?` for an unknown one) when it has a matrix. */
function legLinkOf(job: JobDecl, leg: LegPlan): LocationLink {
  const link: LocationLink = { kind: 'job', id: job.id };
  if (Object.keys(leg.values).length)
    link.leg = Object.fromEntries(
      Object.entries(leg.values).map(([k, v]) => [k, v.known ? stringOf(v.value) : '?']),
    );
  return link;
}

/** The verdict under a parent and an `if:` value: the first `no` wins, an unknown makes it `maybe`. */
function decide(parent: Decision, value: Value<boolean>, chain: Reason[]): Decision {
  if (parent.verdict === 'no') return { verdict: 'no', chain: chain.slice(0, 1) };
  let verdict: Tri;
  if (!value.known) verdict = 'maybe';
  else if (!value.value) verdict = 'no';
  else verdict = parent.verdict;
  return { verdict, chain };
}

/** The `if:` as written: the expression text, a YAML boolean as text, or empty. */
function writtenIf(unit: { ifSite?: { text: string }; ifValue?: boolean }): string {
  return unit.ifSite?.text ?? (unit.ifValue === undefined ? '' : String(unit.ifValue));
}

/** The job status as a result, for the reason chain. */
const statusAsResult = (status: Value<JobStatus>): Value<Result> => combine([status], ([s]) => s as Result);

/** A step's `if:` as GitHub evaluates it when the settings adapter has not seen the file (composite actions). */
function impliedIf(step: StepDecl): string {
  const written = writtenIf(step);
  if (written.trim() === '') return 'success()';
  const names = calledFunctions(parseExpression(written)).map((n) => n.toLowerCase());
  return names.some((n) => ['success', 'failure', 'cancelled', 'always'].includes(n))
    ? written
    : `success() && (${written})`;
}

/** The `inputs` context of a dispatched workflow: the declared inputs with the scenario's values or their defaults. */
function dispatchInputs(wf: WorkflowDecl, scenario: Scenario): Record<string, Value<Json>> {
  if (scenario.event !== 'workflow_dispatch' || !wf.dispatch) return {};
  const out: Record<string, Value<Json>> = {};
  for (const [name, decl] of Object.entries(wf.dispatch.inputs)) {
    const given = lookup(scenario.inputs, name);
    out[name] = given === undefined ? inputDefault(decl) : known(coerceInput(decl, given));
  }
  for (const [name, value] of Object.entries(scenario.inputs)) if (!(name in out)) out[name] = known(value);
  return out;
}

/** The values a caller passes to a reusable workflow, typed as the callee declares them; missing ones take their defaults. */
function callInputs(job: JobDecl, callee: WorkflowDecl, state: ContextState): Record<string, Value<Json>> {
  const out: Record<string, Value<Json>> = {};
  for (const [name, decl] of Object.entries(callee.call?.inputs ?? {})) {
    const b = lookup(job.with, name);
    if (!b) {
      out[name] = inputDefault(decl);
      continue;
    }
    const v: Value<Json> = b.site ? evaluateValue(b.site.text, state) : known(b.value);
    out[name] = v.known ? known(coerceInput(decl, v.value)) : v;
  }
  return out;
}

/** An input's value when not given: its default, else `false` for a boolean, `0` for a number and `''` otherwise. */
function inputDefault(decl: InputDecl): Value<Json> {
  if (decl.hasDefault) {
    if (decl.defaultSite) return unknown([`inputs.${decl.name}.default`]);
    return known(coerceInput(decl, decl.default ?? null));
  }
  return known(decl.type === 'boolean' ? false : decl.type === 'number' ? 0 : '');
}

function coerceInput(decl: InputDecl, value: Json): Json {
  if (decl.type === 'boolean') return value === true || value === 'true';
  if (decl.type === 'number') return typeof value === 'number' ? value : Number(value);
  if (value === null) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** Core's `InputValues` for check names, from the inputs context. */
function checkInputs(
  inputs: Record<string, Value<Json>>,
): Record<string, { known: true; value: Json } | { known: false }> {
  return Object.fromEntries(
    Object.entries(inputs).map(([k, v]) => [
      k,
      v.known ? { known: true as const, value: v.value } : { known: false as const },
    ]),
  );
}

/** Every ancestor through `needs`, nearest first. */
function closure(wf: WorkflowDecl, jobId: string): string[] {
  const seen: string[] = [];
  const visit = (id: string) => {
    for (const n of wf.jobs[id]?.needs ?? []) {
      if (seen.includes(n.id)) continue;
      seen.push(n.id);
      visit(n.id);
    }
  };
  visit(jobId);
  return seen;
}

/** Jobs in an order that plans every need first; a cycle leaves the rest in declaration order. */
function topoOrder(wf: WorkflowDecl): string[] {
  const ids = Object.keys(wf.jobs);
  const done = new Set<string>();
  const order: string[] = [];
  for (let progress = true; progress;) {
    progress = false;
    for (const id of ids) {
      if (done.has(id) || !wf.jobs[id]!.needs.every((n) => done.has(n.id) || !(n.id in wf.jobs))) continue;
      done.add(id);
      order.push(id);
      progress = true;
    }
  }
  for (const id of ids) if (!done.has(id)) order.push(id);
  return order;
}

const KINDS: [RegExp, UnknownKind][] = [
  [/^conflict:/, 'conflict'],
  // A variable the scenario does not set reads as `''`, as on GitHub: only the whole context is unknown (`toJSON(vars)`).
  [/^vars\./, 'var'],
  [/^inputs\./, 'input'],
  [/^secrets\./, 'secret'],
  [/^scenario\.changed$/, 'changed-files'],
  [/^(github|scenario)\./, 'event'],
  [/^runner\./, 'runner'],
  [/^race:/, 'race'],
  [/\.outputs\./, 'step-output'],
  [/\.outcome$/, 'outcome'],
  [/\.env\./, 'env'],
  [/matrix/, 'matrix'],
  [/hashfiles/i, 'hashfiles'],
];

/** The layer a mock ref belongs to: `model:<id>` is shipped, `given[i]`, `assume[i]` (the case) and `cli[i]` are the author's. */
function layerOf(ref: string): MockLayer {
  if (ref.startsWith('model:')) return 'shipped';
  if (ref.startsWith('given')) return 'given';
  return ref.startsWith('cli') ? 'cli' : 'case';
}

function kindOf(id: string): UnknownKind {
  return KINDS.find(([re]) => re.test(id))?.[1] ?? 'unsupported';
}

const SCENARIO_PINS: [RegExp, (name: string) => Json][] = [
  [/^inputs\.((?!.*\.default$).+)$/, (name) => ({ inputs: { [name]: '' } })],
  [/^github\.(sha)$/, () => ({ sha: '' })],
  [/^github\.(actor|triggering_actor)$/, () => ({ actor: { login: '' } })],
  [/^github\.(repository|repository_owner)$/, () => ({ repository: 'owner/name' })],
  [/^github\.(ref|ref_name|ref_type)$/, () => ({ tag: '' })],
  [/^scenario\.changed$/, () => ({ changed: ['path/to/file'] })],
];

/**
 * The scenario field that would pin an unknown read, when there is one. A step's or job's output, outcome or env
 * write is pinned by an assume entry, set over the finished plan (`assumePins`).
 */
function pinFor(id: string): Pin | undefined {
  for (const [re, fragment] of SCENARIO_PINS) {
    const m = re.exec(id);
    if (m) return { layer: 'scenario', fragment: fragment(m[1]!), at: ['when'] };
  }
  return undefined;
}
