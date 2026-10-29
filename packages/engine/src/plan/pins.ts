import { formatUnitPath, type Location, type LocationLink, type PathSegment, type PathStep } from '../paths';
import type { Json, NodeId, Pin, RunPlan } from './types';

/**
 * Assume pins for the unknowns a mock decides: a step's or job's output, outcome or `$GITHUB_ENV` write, and a
 * fail-fast leg's result. The entry names the unit as an author writes it: `step:` or `job:` by unit path, the leg of
 * the path's last segment as `matrix:` values (a value with a `/` or an object cannot be written as `[k=v]`), and
 * `workflow:` (the unit's own file) only when another workflow of the plan has a job of the same id as the unit's
 * first job. A unit whose path cannot hold a leg further up keeps its unknown without a pin.
 */

/** A planned unit an entry can name: where it was planned, and whether a `step:` or a `job:` entry names it. */
export interface UnitSite {
  location: Location;
  kind: 'step' | 'job';
}

type About =
  | { field: 'outputs' | 'env'; name: string }
  | { field: 'outcome' }
  /** `race:fail-fast:<leg>`: the leg may have been cancelled. */
  | { field: 'cancelled' };

const RACE = 'race:fail-fast:';
const ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Sets `producer` and an assume `pin` on every unknown about a planned unit's field. */
export function assumePins(plan: RunPlan, units: ReadonlyMap<NodeId, UnitSite>): void {
  for (const u of plan.unknowns) {
    const ref = unitRef(u.id, units);
    if (!ref) continue;
    u.producer = ref.node;
    const pin = pinOf(plan, ref.node, units.get(ref.node)!, ref.about);
    if (pin) u.pin = pin;
  }
}

/** The unit an unknown is about and what of it: the longest unit id followed by `.outputs.`, `.env.` or `.outcome`. */
function unitRef(
  id: string,
  units: ReadonlyMap<NodeId, UnitSite>,
): { node: NodeId; about: About } | undefined {
  if (id.startsWith(RACE)) {
    const node = id.slice(RACE.length);
    return units.get(node)?.kind === 'job' ? { node, about: { field: 'cancelled' } } : undefined;
  }
  if (id.startsWith('race:') || id.startsWith('conflict:')) return undefined;
  for (let dot = id.lastIndexOf('.'); dot > 0; dot = id.lastIndexOf('.', dot - 1)) {
    const node = id.slice(0, dot);
    if (!units.has(node)) continue;
    const about = aboutOf(id.slice(dot + 1));
    return about ? { node, about } : undefined;
  }
  return undefined;
}

function aboutOf(rest: string): About | undefined {
  // `<leg>.call`: the result of a called workflow the plan does not load.
  if (rest === 'outcome' || rest === 'call') return { field: 'outcome' };
  for (const field of ['outputs', 'env'] as const) {
    if (rest.startsWith(`${field}.`) && rest.length > field.length + 1)
      return { field, name: rest.slice(field.length + 1) };
  }
  return undefined;
}

function pinOf(plan: RunPlan, node: NodeId, site: UnitSite, about: About): Pin | undefined {
  if (about.field === 'env' && site.kind === 'job') return undefined;
  const named = namedBy(site.location);
  if (!named) return undefined;
  const entry: Record<string, Json> = {};
  if (sharesJobId(plan, node, site.location)) entry.workflow = site.location.workflow;
  entry[site.kind] = named.path;
  if (named.matrix) entry.matrix = named.matrix;
  if (about.field === 'cancelled' || about.field === 'outcome')
    entry.outcome = about.field === 'cancelled' ? 'cancelled' : 'failure';
  else entry[about.field] = { [about.name]: '' };
  return { layer: 'assume', fragment: entry, at: ['assume'] };
}

/**
 * The unit path of a location, with the leg of its last segment taken out as `matrix:` values; undefined when a leg
 * further up cannot be written in the path, or an id is not one a path holds.
 */
function namedBy(location: Location): { path: string; matrix?: Record<string, string> } | undefined {
  const segments = segmentsOf(location);
  if (!segments) return undefined;
  const last = segments.at(-1)!;
  const own = last.job === undefined ? undefined : last.leg;
  if (own) delete last.leg;
  if (!segments.every((s) => s.leg === undefined || legInPath(s.leg))) return undefined;
  const path = formatUnitPath({ segments });
  return own && Object.keys(own).length ? { path, matrix: own } : { path };
}

/** The chain as path segments: a job opens one, a step after a job's step opens one inside its composite action. */
function segmentsOf(location: Location): PathSegment[] | undefined {
  const segments: PathSegment[] = [];
  for (const link of location.chain) {
    if (link.kind === 'step') addStep(segments, link);
    else if (ID.test(link.id))
      segments.push(link.leg ? { job: link.id, leg: { ...link.leg } } : { job: link.id });
    else return undefined;
  }
  return segments.length ? segments : undefined;
}

/** A step joins its job's segment, or opens one inside the composite action of the step before it. */
function addStep(segments: PathSegment[], link: Extract<LocationLink, { kind: 'step' }>): void {
  const step: PathStep = link.id !== undefined && ID.test(link.id) ? { id: link.id } : { index: link.index };
  const last = segments.at(-1);
  if (last?.job !== undefined && last.step === undefined) last.step = step;
  else segments.push({ step });
}

/** Whether `[k=v,…]` reads back as these values: no `/`, `,` or `]`, no surrounding space, no `=` in a key. */
const legInPath = (leg: Record<string, string>): boolean =>
  Object.entries(leg).every(([k, v]) => plainCell(k) && !k.includes('=') && plainCell(v));

const plainCell = (s: string): boolean => s.trim() === s && !/[/,\]]/.test(s);

/**
 * Whether another triggered workflow of the plan has a job of the same id as the unit's first job. An untriggered
 * one's jobs (`planUntriggered`) are never planned units, so no entry can name them.
 */
function sharesJobId(plan: RunPlan, node: NodeId, location: Location): boolean {
  const first = location.chain[0];
  if (first?.kind !== 'job') return false;
  return plan.workflows.some(
    (w) =>
      w.depth === 0 &&
      w.triggered.verdict !== 'no' &&
      !node.startsWith(`${w.id}#`) &&
      w.jobs.some((j) => j.jobId === first.id),
  );
}
