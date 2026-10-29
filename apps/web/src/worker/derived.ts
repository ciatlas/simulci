/* oxlint-disable no-restricted-imports -- the worker is where the engine runs */
import {
  type Decision,
  decidingClause,
  decidingReason,
  type JobPlan,
  type LegPlan,
  type Loc,
  type NodeId,
  type Reason,
  type RunPlan,
  type StepPlan,
  unitPathOfId,
  unitPaths,
  type WorkflowPlan,
} from '@simulci/engine';
import { decidingNeeds } from './deciding';
import type { Derived, Outline, OutlineEvent } from './protocol';

/** The lookups the UI needs over a plan, computed here with the engine's own functions. */
export function deriveTables(plan: RunPlan, outline: Outline): Derived {
  const d: Derived = {
    unitPaths: {},
    kinds: {},
    clauses: {},
    decidingIndex: {},
    decidingLoc: {},
    decidingNeeds: {},
    unknownPaths: {},
  };
  const paths = new Map<NodeId, string>();
  for (const wf of plan.workflows) {
    if (wf.depth !== 0) continue;
    for (const [id, p] of unitPaths(wf)) paths.set(id, p);
    walkWorkflow(wf, outline, d, undefined);
  }
  for (const [id, p] of paths) d.unitPaths[id] = p;
  for (const u of plan.unknowns) d.unknownPaths[u.id] = unitPathOfId(u.id, paths);
  return d;
}

function record(
  d: Derived,
  id: NodeId,
  kind: Derived['kinds'][string],
  decision: Decision,
  loc: Loc | undefined,
): void {
  d.kinds[id] = kind;
  d.clauses[id] = decidingClause(decision);
  const reason = decidingReason(decision.chain, decision.verdict);
  d.decidingIndex[id] = reason ? decision.chain.indexOf(reason) : -1;
  if (loc) d.decidingLoc[id] = loc;
}

function walkWorkflow(wf: WorkflowPlan, outline: Outline, d: Derived, parentLoc: Loc | undefined): void {
  // A called workflow is decided by the calling job: its deciding line is the caller's, its own `on:` only as a fallback.
  const own = triggerLoc(wf, outline);
  const loc = wf.depth === 0 ? own : decisionLoc(wf.triggered, parentLoc, own);
  record(d, wf.id, 'workflow', wf.triggered, loc);
  for (const job of wf.jobs) walkJob(job, wf, outline, d);
}

function walkJob(job: JobPlan, wf: WorkflowPlan, outline: Outline, d: Derived): void {
  const loc = decisionLoc(job.runs, d.decidingLoc[wf.id], job.loc);
  record(d, job.id, 'job', job.runs, loc);
  const needs = decidingNeeds(job, wf);
  if (needs.length) d.decidingNeeds[job.id] = needs;
  for (const leg of job.legs) walkLeg(leg, job, wf, outline, d);
}

function walkLeg(leg: LegPlan, job: JobPlan, wf: WorkflowPlan, outline: Outline, d: Derived): void {
  if (leg.id !== job.id) {
    const loc = decisionLoc(leg.runs, d.decidingLoc[job.id], job.matrix?.loc ?? job.loc);
    record(d, leg.id, 'leg', leg.runs, loc);
  }
  const parentLoc = d.decidingLoc[leg.id] ?? d.decidingLoc[job.id];
  if (leg.call) walkWorkflow(leg.call, outline, d, parentLoc);
  for (const step of leg.steps ?? []) walkStep(step, parentLoc, d);
}

function walkStep(step: StepPlan, parentLoc: Loc | undefined, d: Derived): void {
  record(d, step.id, 'step', step.runs, decisionLoc(step.runs, parentLoc, step.loc));
  if (!step.composite) return;
  d.kinds[step.composite.id] = 'composite';
  for (const inner of step.composite.steps) walkStep(inner, d.decidingLoc[step.id], d);
}

/** Where a job's, leg's or step's deciding reason is written: its `if:`, its parent's reason, else its own line. */
function decisionLoc(decision: Decision, parentLoc: Loc | undefined, own: Loc | undefined): Loc | undefined {
  const reason = decidingReason(decision.chain, decision.verdict);
  if (!reason) return own;
  if (reason.kind === 'if') return reason.loc ?? own;
  if (reason.kind === 'parent') return parentLoc ?? own;
  if (reason.kind === 'matrix') return own;
  return own;
}

/** The `on:` line that decided a workflow: the filter's key, the event's key, or `on` itself. */
export function triggerLoc(wf: WorkflowPlan, outline: Outline): Loc | undefined {
  const o = outline.workflows.find((w) => w.path === wf.path);
  if (!o) return undefined;
  const reason = decidingReason(wf.triggered.chain, wf.triggered.verdict);
  const e = o.events.find((x) => x.event === triggerEvent(wf.triggered.chain, reason));
  const line = reason && e?.loc ? reasonLine(reason, e.loc) : o.onLine;
  return { file: wf.path, line, column: 1 };
}

/** The event the trigger decision is about: the reason's own, else the chain's event gate. */
function triggerEvent(chain: Reason[], reason: Reason | undefined): string | undefined {
  if (reason && 'event' in reason && typeof reason.event === 'string') return reason.event;
  const gate = chain.find((r) => r.kind === 'event');
  return gate?.kind === 'event' ? gate.event : undefined;
}

function reasonLine(reason: Reason, loc: NonNullable<OutlineEvent['loc']>): number {
  if (reason.kind === 'filter') return loc.filters[reason.filter] ?? loc.line;
  if (reason.kind === 'types') return loc.filters.types ?? loc.line;
  return loc.line;
}
