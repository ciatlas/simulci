import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  JobPlan,
  LegPlan,
  NodeId,
  RunPlan,
  ScenarioInput,
  StepPlan,
  WorkflowPlan,
} from '@simulci/engine';
import { describe, expect, it } from 'vitest';
import { handle, initialState } from '../src/worker/handle';
import type { Derived, Outline, PlanResponse } from '../src/worker/protocol';

const lab = join(import.meta.dirname, '../../../fixtures/routes-lab');
const expected = JSON.parse(readFileSync(join(lab, 'expected.json'), 'utf8')) as {
  runs: { workflow: string; event: string; action: string | null; ref: string; changed: string[] | null }[];
};

function walk(dir: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, walk(join(dir, entry.name), rel));
    else out[rel] = readFileSync(join(dir, entry.name), 'utf8');
  }
  return out;
}

const files = walk(join(lab, 'repo'));
const loaded = handle(initialState(), { id: 1, type: 'load', files, repository: 'ciatlas/simulci-lab' });
if (loaded.response.type !== 'loaded') throw new Error(loaded.response.type);
const outline = loaded.response.outline;

/** One scenario per distinct (event, ref, changed) seen in the lab. */
const scenarios = new Map<string, ScenarioInput>();
for (const run of expected.runs) {
  const s: ScenarioInput = { event: run.event, repository: 'ciatlas/simulci-lab' };
  if (run.changed) s.changed = run.changed;
  if (run.action) s.action = run.action;
  if (run.event === 'pull_request') Object.assign(s, { number: 1, base: 'main', head: 'probe/pr' });
  else s.ref = run.ref;
  scenarios.set(JSON.stringify(s), s);
}

type Node = [NodeId, string, { verdict: string; chain: unknown[] }];

function* nodes(wf: WorkflowPlan): Generator<Node> {
  yield [wf.id, 'workflow', wf.triggered];
  for (const job of wf.jobs) yield* jobNodes(job);
}
function* jobNodes(job: JobPlan): Generator<Node> {
  yield [job.id, 'job', job.runs];
  for (const leg of job.legs) yield* legNodes(leg, job);
}
function* legNodes(
  leg: LegPlan,
  job: JobPlan,
): Generator<[NodeId, string, { verdict: string; chain: unknown[] }]> {
  // A job without a matrix has one bare leg that shares its id: the job stands for it.
  if (leg.id !== job.id) yield [leg.id, 'leg', leg.runs];
  if (leg.call) yield* nodes(leg.call);
  for (const step of leg.steps ?? []) yield* stepNodes(step);
}
function* stepNodes(step: StepPlan): Generator<Node> {
  yield [step.id, 'step', step.runs];
  if (step.composite) {
    yield [step.composite.id, 'composite', step.runs];
    for (const inner of step.composite.steps) yield* stepNodes(inner);
  }
}

function check(plan: RunPlan, derived: Derived, o: Outline): void {
  const known = new Set(o.files.map((f) => f.path));
  for (const wf of plan.workflows) for (const node of nodes(wf)) checkNode(node, derived, known);
  for (const u of plan.unknowns) expect(derived.unknownPaths[u.id], u.id).toBeTypeOf('string');
}

function checkNode([id, kind, decision]: Node, derived: Derived, known: Set<string>): void {
  expect(derived.kinds[id], id).toBe(kind);
  // A composite instance is the using step's: its decision and lines are recorded under the step.
  if (kind === 'composite') return;
  expect(derived.clauses[id], id).toBeTypeOf('string');
  expect(derived.decidingIndex[id], id).toBeLessThan(decision.chain.length);
  if (kind !== 'workflow') expect(derived.unitPaths[id], id).toMatch(/./);
  const loc = derived.decidingLoc[id];
  if (decision.verdict === 'no') expect(loc, `${id} decided no`).toBeDefined();
  if (!loc) return;
  expect(known.has(loc.file), `${id} → ${loc.file}`).toBe(true);
  expect(loc.line, id).toBeGreaterThanOrEqual(1);
}

describe('the derived tables over the routes lab', () => {
  it('describe every workflow and job of the lab in the outline', () => {
    // The lab's .github/workflows/ also holds actions.lock, which is not a workflow.
    const workflows = Object.keys(files).filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f));
    expect(outline.workflows.map((w) => w.path).sort()).toEqual(workflows.sort());
    for (const w of outline.workflows) {
      expect(w.onLine, w.path).toBeGreaterThanOrEqual(1);
      expect(w.jobs.length, w.path).toBeGreaterThan(0);
      for (const e of w.events) expect(e.loc?.line, `${w.path} ${e.event}`).toBeGreaterThanOrEqual(1);
      for (const j of w.jobs) expect(j.line, `${w.path} ${j.id}`).toBeGreaterThan(w.onLine);
    }
    expect(outline.files.filter((f) => f.errors.length)).toEqual([]);
  });

  it(`cover every node of every plan (${scenarios.size} scenarios)`, () => {
    let plans = 0;
    for (const scenario of scenarios.values()) {
      const r = handle(loaded.state, {
        id: 2,
        type: 'simulate',
        project: 1,
        scenario,
        assume: [],
        detail: 'steps',
      });
      expect(r.response.type, JSON.stringify(scenario)).toBe('plan');
      const { plan, derived } = r.response as PlanResponse;
      check(plan, derived, outline);
      plans++;
    }
    expect(plans).toBe(scenarios.size);
  });
});
