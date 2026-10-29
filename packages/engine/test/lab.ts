import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AssumeEntry,
  type CheckVerdict,
  checksOf,
  type LegPlan,
  loadFiles,
  type Result,
  type RunPlan,
  type ScenarioInput,
  type StepPlan,
  simulate,
  type Tri,
  type Value,
  type WorkflowPlan,
} from '@simulci/engine';
import { isMap, isScalar, isSeq, parseDocument, type YAMLMap } from 'yaml';

/**
 * The routes lab (fixtures/routes-lab): the captured runs, the scenario each one ran, what the runner knew that the
 * simulator cannot, and the accuracy figure, which grades every observed outcome as predicted exactly, as "might"
 * with the unknown named, or wrongly.
 */

const lab = join(import.meta.dirname, '../../../fixtures/routes-lab');

/** The last lab commit that started a run; `repo/` is the lab's `.github/` tree there (fixtures/routes-lab/README.md). */
const CAPTURE = 'e623802ba524a344c2033c94c438a38fe0e8c07f';

interface LabJob {
  name: string;
  conclusion: string;
  steps: { number: number; name: string; conclusion: string }[];
  probes: Record<string, string>;
}

export interface LabRun {
  runId: number;
  workflow: string;
  event: string;
  action: string | null;
  ref: string;
  sha: string;
  message: string;
  changed: string[] | null;
  conclusion: string;
  jobs: LabJob[];
  checks: { name: string; conclusion: string }[];
}

export const labRuns = (JSON.parse(readFileSync(join(lab, 'expected.json'), 'utf8')) as { runs: LabRun[] })
  .runs;

function walk(dir: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, walk(full, rel));
    else out[rel] = readFileSync(full, 'utf8');
  }
  return out;
}

const files = walk(join(lab, 'repo'));
export const labProject = loadFiles(files, 'ciatlas/simulci-lab');

export function scenarioOf(run: LabRun): ScenarioInput {
  const s: ScenarioInput = {
    event: run.event,
    sha: run.sha.slice(0, 40),
    message: run.message,
    repository: 'ciatlas/simulci-lab',
  };
  if (run.changed) s.changed = run.changed;
  if (run.action) s.action = run.action;
  if (run.event === 'pull_request') {
    s.number = Number(/refs\/pull\/(\d+)\//.exec(run.ref)?.[1] ?? 1);
    s.base = 'main';
    s.head = 'probe/pr';
  } else s.ref = run.ref;
  return s;
}

/** What the runner knew and the simulator cannot: which scripted steps fail (cases.md). */
const ASSUME: Record<string, AssumeEntry[]> = {
  'case-continue-on-error-job.yml': [{ step: 'a.#1', outcome: 'failure' }],
  'case-continue-on-error-step.yml': [{ step: 'a.f', outcome: 'failure' }],
  'case-matrix-aggregate.yml': [
    { step: 'a[n=2].#1', outcome: 'failure' },
    { step: 'v[n=2].#1', outcome: 'failure' },
  ],
  'case-matrix-one-failed.yml': [{ step: 'a[n=2].#1', outcome: 'failure' }],
  'case-fail-fast-cancelled.yml': [{ step: 'a[n=2].#1', outcome: 'failure' }],
  'case-step-timeout.yml': [{ step: 'a.t', outcome: 'failure' }],
  'case-composite-action-status.yml': [{ step: 'a.u/#1', outcome: 'failure' }],
};
export const assumeFor = (workflow: string) => ASSUME[workflow.replace(/^.*\//, '')] ?? [];

// --- Probes ---------------------------------------------------------------------------------------------------------

/**
 * A step's `echo "probe: <label>=<value>"` lines. A value is an expression template (`${{ needs.a.result }}`), a
 * variable of the step's `env:` (`$M`), the same compacted by jq (`$(jq -c . <<< "$OUTPUTS")`, compared as JSON), or
 * plain text.
 */
type ProbeSource =
  | { kind: 'template'; env: string }
  | { kind: 'env'; name: string }
  | { kind: 'text'; value: string };

const PROBE_LINE = /^\s*echo "probe: ([^=]+)=(.*)"\s*$/;
const ENV_VALUE = /^\$([A-Z_][A-Z0-9_]*)$/;
const JQ_VALUE = /^\$\(jq -c \. <<< "\$([A-Z_][A-Z0-9_]*)"\)$/;

/** The probes of a step, by label, adding to its `env:` one variable per template so the plan evaluates it there. */
function probesOf(step: YAMLMap): Map<string, ProbeSource> {
  const out = new Map<string, ProbeSource>();
  const run = step.get('run');
  if (typeof run !== 'string') return out;
  for (const line of run.split('\n')) {
    const m = PROBE_LINE.exec(line);
    if (!m) continue;
    const label = m[1]!;
    const value = m[2]!;
    const env = ENV_VALUE.exec(value) ?? JQ_VALUE.exec(value);
    if (env) out.set(label, { kind: 'env', name: env[1]! });
    else if (value.includes('${{')) {
      const name = `SIMULCI_PROBE_${out.size}`;
      step.setIn(['env', name], value);
      out.set(label, { kind: 'template', env: name });
    } else if (value.includes('$')) throw new Error(`probe ${label}: no rule for the shell value ${value}`);
    else out.set(label, { kind: 'text', value });
  }
  return out;
}

/** The step lists of a workflow (`jobs.<id>.steps`) or a composite action (`runs.steps`). */
function stepLists(doc: ReturnType<typeof parseDocument>): { at: string; steps: YAMLMap[] }[] {
  const lists: { at: string; steps: YAMLMap[] }[] = [];
  const add = (at: string, seq: unknown) => {
    if (isSeq(seq)) lists.push({ at, steps: seq.items.filter(isMap) });
  };
  const jobs = doc.get('jobs');
  if (isMap(jobs))
    for (const pair of jobs.items)
      if (isScalar(pair.key) && isMap(pair.value)) add(String(pair.key.value), pair.value.get('steps'));
  const runs = doc.get('runs');
  if (isMap(runs)) add('', runs.get('steps'));
  return lists;
}

/**
 * The lab's files with every probe template moved into its step's `env:` too, so the plan evaluates it with that
 * step's contexts (steps before it, `job.status`, needs, matrix), and the probes of each step by file, list and index.
 */
function instrument(): {
  project: ReturnType<typeof loadFiles>;
  probes: Map<string, Map<string, ProbeSource>>;
} {
  const probes = new Map<string, Map<string, ProbeSource>>();
  const out: Record<string, string> = {};
  for (const [path, text] of Object.entries(files)) {
    if (!/\.ya?ml$/.test(path)) {
      out[path] = text;
      continue;
    }
    const doc = parseDocument(text);
    for (const { at, steps } of stepLists(doc))
      steps.forEach((step, i) => {
        const found = probesOf(step);
        if (found.size) probes.set(`${path}:${at}:${i}`, found);
      });
    out[path] = doc.toString();
  }
  return { project: loadFiles(out, 'ciatlas/simulci-lab'), probes };
}

const probed = instrument();

// --- Grading --------------------------------------------------------------------------------------------------------

type Grade = 'exact' | 'maybe' | 'wrong';
type Kind = 'triggers' | 'checks' | 'jobs' | 'steps' | 'probes';

export interface Accuracy {
  /** The lab commit the runs were captured up to. */
  capture: string;
  runs: number;
  compared: Record<Kind, number>;
  exact: number;
  maybe: number;
  wrong: number;
}

/** A known value is exact or wrong; an unknown one is "might", unless its candidates leave the observed one out. */
function gradeValue<T>(v: Value<T>, observed: T, same = (a: T, b: T) => a === b): Grade {
  if (v.known) return same(v.value, observed) ? 'exact' : 'wrong';
  return v.oneOf && !v.oneOf.some((c) => same(c, observed)) ? 'wrong' : 'maybe';
}

const gradeTri = (t: Tri, observed: boolean): Grade =>
  t === 'maybe' ? 'maybe' : (t === 'yes') === observed ? 'exact' : 'wrong';

class Tally {
  readonly compared: Record<Kind, number> = { triggers: 0, checks: 0, jobs: 0, steps: 0, probes: 0 };
  readonly grades: Record<Grade, number> = { exact: 0, maybe: 0, wrong: 0 };
  /** Each wrong prediction, for the test to print. */
  readonly wrong: string[] = [];

  add(kind: Kind, grade: Grade, where: string, detail: () => string) {
    this.compared[kind]++;
    this.grades[grade]++;
    if (grade === 'wrong') this.wrong.push(`${kind} ${where}: ${detail()}`);
  }
}

/** The legs (and skipped jobs) of a plan by node id, through called workflows. */
function legsById(plan: RunPlan): Map<string, LegPlan> {
  const out = new Map<string, LegPlan>();
  const visit = (wf: WorkflowPlan) => {
    for (const job of wf.jobs)
      for (const leg of job.legs) {
        out.set(leg.id, leg);
        if (leg.call) visit(leg.call);
      }
  };
  plan.workflows.forEach(visit);
  return out;
}

/** Where a step is declared: its file, its job (`''` in a composite action) and its index there. */
const stepKey = (step: StepPlan, at: string, i: number) => `${step.loc?.file}:${at}:${i}`;

/** Every step that can echo a probe: a leg's own steps and, nested, a composite action's. */
function emitters(
  steps: readonly StepPlan[],
  jobId: string,
): { step: StepPlan; probes: Map<string, ProbeSource> }[] {
  return steps.flatMap((step) => {
    const own = probed.probes.get(stepKey(step, jobId, step.index));
    const inner = step.composite ? emitters(step.composite.steps, '') : [];
    return [...(own ? [{ step, probes: own }] : []), ...inner];
  });
}

/** JSON compared with its keys in any order: the order of `toJSON(needs.<id>.outputs)` is a timing artifact. */
function sameText(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return canonical(JSON.parse(a)) === canonical(JSON.parse(b));
  } catch {
    return false;
  }
}
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => p.localeCompare(q)))
      : x,
  );

function probeValue(step: StepPlan, source: ProbeSource): Value<string> {
  if (source.kind === 'text') return { known: true, value: source.value };
  const v = step.env[source.kind === 'template' ? source.env : source.name];
  if (!v) throw new Error(`step ${step.id}: no env ${JSON.stringify(source)}`);
  return v;
}

function gradeProbes(t: Tally, where: string, job: LabJob, leg: LegPlan | undefined) {
  const sources = leg ? emitters(leg.steps ?? [], jobIdOf(leg)) : [];
  for (const [label, observed] of Object.entries(job.probes)) {
    const at = `${where} probe ${label}`;
    // A label echoed twice keeps the last value (capture-lab.mjs), so the last step that may have echoed it counts.
    const echoers = sources.filter((s) => s.probes.has(label));
    const last = echoers.findLast((s) => s.step.runs.verdict !== 'no') ?? echoers.at(-1);
    if (!last) {
      t.add('probes', 'wrong', at, () => 'no predicted step echoes it');
      continue;
    }
    const runs = last.step.runs.verdict;
    if (runs !== 'yes') {
      t.add('probes', runs === 'maybe' ? 'maybe' : 'wrong', at, () => 'predicted not to run');
      continue;
    }
    const v = probeValue(last.step, last.probes.get(label)!);
    t.add(
      'probes',
      gradeValue(v, observed, sameText),
      at,
      () => `predicted ${JSON.stringify(v)}, was ${observed}`,
    );
  }
}

/** GitHub's own steps: "Set up job" (number 1, so a job's first step is 2), post steps and "Complete job" at the end. */
const GITHUB_STEP = /^(Set up job|Complete job|Post .+)$/;

function gradeSteps(t: Tally, where: string, job: LabJob, leg: LegPlan | undefined) {
  // Whether a step inside a leg that fail-fast cancelled finished first is timing (cases.md, case 6): not compared.
  if (job.conclusion === 'cancelled') return;
  for (const observed of job.steps) {
    if (GITHUB_STEP.test(observed.name)) continue;
    const at = `${where} step ${observed.number} ${observed.name}`;
    const p = leg?.steps?.[observed.number - 2];
    if (!p) {
      t.add('steps', 'wrong', at, () => 'no predicted step');
      continue;
    }
    const v: Value<Result> = p.runs.verdict === 'no' ? { known: true, value: 'skipped' } : p.conclusion;
    t.add(
      'steps',
      gradeValue(v, observed.conclusion as Result),
      at,
      () => `predicted ${JSON.stringify(v)}, was ${observed.conclusion}`,
    );
  }
}

/** A captured job against the check of its name, the leg that reports it and that leg in the probed plan. */
function gradeJob(
  t: Tally,
  at: string,
  job: LabJob,
  check: CheckVerdict | undefined,
  leg: LegPlan | undefined,
  probedLeg: LegPlan | undefined,
) {
  t.add('checks', check ? gradeTri(check.runs, job.conclusion !== 'skipped') : 'wrong', at, () =>
    check ? `predicted runs ${check.runs}, was ${job.conclusion}` : 'no predicted check of this name',
  );
  t.add('jobs', check ? gradeValue(check.result, job.conclusion as Result) : 'wrong', at, () =>
    check ? `predicted ${JSON.stringify(check.result)}, was ${job.conclusion}` : 'no predicted check',
  );
  gradeSteps(t, at, job, leg);
  gradeProbes(t, at, job, probedLeg);
}

function gradeRun(t: Tally, run: LabRun) {
  const plan = simulate({ project: labProject, scenario: scenarioOf(run), assume: assumeFor(run.workflow) });
  const where = `${run.workflow} [${run.event} ${run.ref}]`;
  const wf = plan.workflows.find((w) => w.path === run.workflow)!;
  t.add('triggers', gradeTri(wf.triggered.verdict, true), where, () => `predicted ${wf.triggered.verdict}`);
  for (const d of plan.diagnostics)
    if (d.severity === 'error') throw new Error(`${where}: ${d.code} ${d.message}`);

  const predicted = new Map(
    checksOf(plan)
      .filter((c) => c.node.startsWith(run.workflow))
      .map((c) => [c.name, c]),
  );
  const instrumented = simulate({
    project: probed.project,
    scenario: scenarioOf(run),
    assume: assumeFor(run.workflow),
  });
  const legs = legsById(plan);
  const probedLegs = legsById(instrumented);
  for (const job of run.jobs) {
    const check = predicted.get(job.name);
    predicted.delete(job.name);
    gradeJob(
      t,
      `${where} ${job.name}`,
      job,
      check,
      check && legs.get(check.node),
      check && probedLegs.get(check.node),
    );
  }
  // A check the plan names that GitHub did not create is wrong too.
  for (const name of predicted.keys())
    t.add('checks', 'wrong', `${where} ${name}`, () => 'predicted, not created');
}

/** The job id of a leg, from its node id `<file>#<job>`, `<file>#<job>[<leg>]` or `<caller>><file>#<job>`. */
const jobIdOf = (leg: LegPlan) => leg.id.replace(/\[.*$/, '').replace(/^.*#/, '');

/** Grades every captured run; `wrong` lists each wrong prediction. */
export function measure(): { accuracy: Accuracy; wrong: string[] } {
  const t = new Tally();
  for (const run of labRuns) gradeRun(t, run);
  return {
    accuracy: { capture: CAPTURE, runs: labRuns.length, compared: t.compared, ...t.grades },
    wrong: t.wrong,
  };
}
