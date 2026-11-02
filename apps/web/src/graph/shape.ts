import type { NodeId } from '@simulci/engine';
import { fnv1a } from '../lib/hash';
import { gridCells, stripRows } from './size';
import type { JobModel, ScopeModel, StepMark } from './types';

/**
 * A scope's shape: a hash of what decides its layout and nothing else, the key its positions are cached under. The
 * jobs in order, open step lists, the grid's cells and the strip's rows as size.ts counts them, `uses:` and the shape
 * of the workflow each one calls, and every `needs` edge. Verdicts, results, clauses and values never enter it, so a
 * scenario that only recolours the picture keeps every shape and moves nothing. Nor do the labels: what a label
 * decides is its card's width, which the layout cache keys by (layout.ts) and size.ts rounds up to a step, so
 * renaming a job lays it out again only when its card grows or shrinks by a step.
 */
export function shapeHash(
  scope: Pick<ScopeModel, 'id' | 'collapsed' | 'edges'>,
  jobs: readonly JobModel[],
  calleeShapes: Readonly<Record<NodeId, string>>,
): string {
  const parts = [scope.collapsed ? `${scope.id} collapsed` : scope.id];
  for (const job of jobs) parts.push(jobShape(job, calleeShapes));
  for (const edge of scope.edges) parts.push(`${edge.source}->${edge.target}`);
  return fnv1a(parts.join('\n'));
}

function jobShape(job: JobModel, calleeShapes: Readonly<Record<NodeId, string>>): string {
  const callee = job.callee === undefined ? '' : (calleeShapes[job.callee] ?? job.callee);
  // The strip shows the top-level steps, the open list every row, inner steps included: both sizes count, the
  // list's only while it is open.
  return [
    job.id,
    job.expanded ? `open ${rows(job.steps)}` : '',
    gridCells(job),
    job.count ?? '',
    job.uses ?? '',
    callee,
    job.stub ? 'stub' : '',
    stripRows(job),
  ].join('\0');
}

const rows = (steps: readonly StepMark[]): number => steps.reduce((n, s) => n + 1 + rows(s.inner), 0);
