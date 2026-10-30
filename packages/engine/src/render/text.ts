import type {
  JobPlan,
  LegPlan,
  NodeId,
  RemoteUse,
  RunPlan,
  StepPlan,
  Tri,
  WorkflowPlan,
} from '../plan/types';
import { remotesByLeg } from '../plan/select';
import { decidingClause, formatValue } from './reason';

/**
 * The plan as text: one line per workflow, job, leg and step with a mark (● runs, ○ skipped, ◐ maybe) and the
 * clause that decided it, then the unknowns with what would pin them and the remotes with where each was read.
 */

export const MARK: Record<Tri, string> = { yes: '●', no: '○', maybe: '◐' };

export function renderText(plan: RunPlan): string {
  const lines: string[] = [];
  const triggered = plan.workflows.filter((w) => w.triggered.verdict !== 'no');
  lines.push(`${plan.scenario.id} · ${triggered.length} of ${plan.workflows.length} workflows triggered`);
  const ctx: Ctx = { steps: plan.detail === 'steps', calls: remotesByLeg(plan) };
  for (const wf of plan.workflows) lines.push(...workflowLines(wf, ctx, 0));
  if (plan.unknowns.length) {
    lines.push('', 'Unknowns:');
    for (const u of plan.unknowns) {
      const affects = u.affects.length ? ` · affects ${u.affects.length}` : '';
      const pin = u.pin ? ` · pin: ${u.pin.layer} ${JSON.stringify(u.pin.fragment)}` : '';
      lines.push(`  ${u.id}${affects}${pin}`);
    }
  }
  lines.push(...remotesLines(plan));
  for (const d of plan.diagnostics) {
    const at = d.loc ? ` (${d.loc.file}:${d.loc.line})` : '';
    lines.push(`${d.severity}: ${d.message}${at}`);
  }
  return `${lines.join('\n')}\n`;
}

interface Ctx {
  steps: boolean;
  /** The remote workflow each calling leg names. */
  calls: Map<NodeId, RemoteUse>;
}

/** The remotes under the plan: each with the commit it was read at and its pin, or why it was not read. */
function remotesLines(plan: RunPlan): string[] {
  if (!plan.remotes?.length) return [];
  const lines = ['', 'Remotes:'];
  for (const r of plan.remotes)
    lines.push(`  ${r.ref}${r.sha ? ` → ${r.sha.slice(0, 7)}` : ''} (${remoteState(r)})`);
  return lines;
}

/** `pinned` for a remote read (`lockfile`, `sha-ref`, …), else why it was not. */
function remoteState(r: RemoteUse): string {
  if (r.state === 'simulated') return r.pinned ?? 'read';
  if (r.state === 'failed') return `not read: ${r.failure}`;
  if (r.state === 'limit') return 'not read: past a limit';
  return r.state === 'invalid' ? 'does not parse' : 'not fetched';
}

function workflowLines(wf: WorkflowPlan, ctx: Ctx, depth: number): string[] {
  const pad = '  '.repeat(depth);
  const remote = wf.remote ? ` (remote, ${wf.remote.sha.slice(0, 7)})` : '';
  const lines = [`${pad}${MARK[wf.triggered.verdict]} ${wf.path}${remote} — ${decidingClause(wf.triggered)}`];
  for (const job of wf.jobs) lines.push(...jobLines(job, ctx, depth + 1));
  return lines;
}

function jobLines(job: JobPlan, ctx: Ctx, depth: number): string[] {
  const pad = '  '.repeat(depth);
  const why = job.runs.verdict === 'yes' ? '' : ` — ${decidingClause(job.runs)}`;
  const lines = [`${pad}${MARK[job.runs.verdict]} ${job.jobId}${why}`];
  if (job.runs.verdict === 'no') return lines;
  const single = job.legs.length === 1 && job.legs[0]!.legKey === '';
  for (const leg of job.legs) lines.push(...legLines(leg, ctx, depth + 1, single));
  return lines;
}

function legLines(leg: LegPlan, ctx: Ctx, depth: number, single: boolean): string[] {
  const lines = single ? [] : [legHeader(leg, '  '.repeat(depth))];
  const inner = single ? depth : depth + 1;
  const remote = ctx.calls.get(leg.id);
  if (leg.call) lines.push(...workflowLines(leg.call, ctx, inner));
  else if (remote && leg.runs.verdict !== 'no')
    lines.push(`${'  '.repeat(inner)}└ ${remote.ref} (remote, ${remoteState(remote)})`);
  for (const step of ctx.steps ? (leg.steps ?? []) : []) lines.push(...stepLines(step, inner));
  return lines;
}

function legHeader(leg: LegPlan, pad: string): string {
  const name = leg.check?.name ?? `[${leg.legKey}]`;
  const why = leg.runs.verdict === 'yes' ? '' : ` — ${decidingClause(leg.runs)}`;
  return `${pad}${MARK[leg.runs.verdict]} ${name}${why}`;
}

function stepLines(step: StepPlan, depth: number): string[] {
  const pad = '  '.repeat(depth);
  const label = step.name ?? step.uses ?? step.stepId ?? step.key;
  const why = step.runs.verdict === 'yes' ? '' : ` — ${decidingClause(step.runs)}`;
  const outputs = Object.keys(step.outputs).length
    ? ` → ${Object.entries(step.outputs)
        .map(([k, v]) => `${k}=${formatValue(v)}`)
        .join(' ')}`
    : '';
  const lines = [`${pad}${MARK[step.runs.verdict]} ${label}${why}${outputs}`];
  if (step.composite) for (const inner of step.composite.steps) lines.push(...stepLines(inner, depth + 1));
  return lines;
}
