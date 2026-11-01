import type { JobPlan, RunPlan, WorkflowPlan } from '../plan/types';

/** The plan as a Mermaid flowchart: a subgraph per triggered workflow, a node per job coloured by its verdict. */
export function renderMermaid(plan: RunPlan): string {
  const lines = ['flowchart LR'];
  let n = 0;
  const ids = new Map<string, string>();
  const idOf = (node: string) => {
    let id = ids.get(node);
    if (!id) {
      id = `n${++n}`;
      ids.set(node, id);
    }
    return id;
  };
  const emit = (wf: WorkflowPlan, depth: number) => {
    const pad = '  '.repeat(depth + 1);
    lines.push(`${pad}subgraph ${idOf(wf.id)}["${escapeLabel(wf.name ?? wf.path)}"]`);
    for (const job of wf.jobs) {
      lines.push(`${pad}  ${idOf(job.id)}["${escapeLabel(jobLabel(job))}"]:::${job.runs.verdict}`);
      for (const leg of job.legs) if (leg.call) emit(leg.call, depth + 1);
    }
    lines.push(`${pad}end`);
    for (const job of wf.jobs)
      for (const need of job.needs) lines.push(`${pad}${idOf(need)} --> ${idOf(job.id)}`);
  };
  for (const wf of plan.workflows) if (wf.triggered.verdict !== 'no') emit(wf, 0);
  lines.push(
    '  classDef yes fill:#dcfce7,stroke:#16a34a,color:#14532d',
    '  classDef no fill:#f3f4f6,stroke:#9ca3af,color:#6b7280',
    '  classDef maybe fill:#fef9c3,stroke:#ca8a04,color:#713f12',
  );
  return `${lines.join('\n')}\n`;
}

function jobLabel(job: JobPlan): string {
  const legs = job.matrix?.count !== undefined && job.matrix.count > 1 ? ` ×${job.matrix.count}` : '';
  const verdict = job.runs.verdict === 'yes' ? '' : job.runs.verdict === 'no' ? ' (skipped)' : ' (maybe)';
  return `${job.jobId}${legs}${verdict}`;
}

/**
 * A quoted label: quotes, tags and what a `%%{init}%%` directive is made of as Mermaid's entity codes, line breaks and
 * control characters as spaces.
 */
function escapeLabel(s: string): string {
  let flat = '';
  for (const c of s) flat += breaks(c.charCodeAt(0)) ? ' ' : c;
  return flat
    .replace(/#/g, '#35;')
    .replace(/"/g, '#quot;')
    .replace(/</g, '#lt;')
    .replace(/>/g, '#gt;')
    .replace(/%/g, '#37;')
    .replace(/\{/g, '#123;')
    .replace(/\}/g, '#125;');
}

/** A character that would end the statement it is in. */
const breaks = (code: number): boolean => code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029;
