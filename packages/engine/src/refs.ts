import {
  type ExprSite,
  type JobDecl,
  type LocatedRef,
  type Loc,
  lookup,
  type OccurrenceRole,
  type SourceFile,
  SymbolLocator,
  sym,
  type WorkflowDecl,
} from '@ciatlas/core';
import type { LoadedProject } from './remotes/state';

/**
 * Where a job's or a step's id is written, for a rename. A job's id is its key, an entry of each `needs:` naming it,
 * and the expressions reading it: `needs.<id>…`, and `jobs.<id>…` in a `workflow_call` output's value. A step's id is
 * its `id:` value and the `steps.<id>…` reads of its own job. Each place is cut to the id itself, so writing the new id
 * over every span renames it.
 */

export type ReferenceTarget =
  | { kind: 'job'; workflow: string; job: string }
  | { kind: 'step'; workflow: string; job: string; step: string };

export interface Reference {
  file: string;
  /** 1-based, like core's `Loc`. The span holds the id and nothing else. */
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  /** The id as written there, which may differ in case from the declared one: GitHub matches ids ignoring case. */
  text: string;
  /** `key`: the job's key or the step's `id:` value. `needs`: an entry of a job's `needs:`. `read`: an expression. */
  role: 'key' | 'needs' | 'read';
}

/** A place that names the target, before it is cut to the id. */
interface Found {
  loc: Loc;
  role: Reference['role'];
}

/**
 * Every place the job's or step's id is written, in file order; empty when the workflow, the job or the step does not
 * exist. Reads that name no single job or step (`toJSON(needs)`, `needs[matrix.job]`) are not references, nor is an id
 * a double-quoted scalar spells with an escape (`needs.\x62uild`), which no splice of the id could keep.
 */
export function referencesOf(loaded: LoadedProject, target: ReferenceTarget): Reference[] {
  const wf = loaded.index.project.workflows.get(target.workflow);
  const job = wf && lookup(wf.jobs, target.job);
  if (!wf || !job) return [];
  if (target.kind === 'job') return cut(wf.source, job.id, jobPlaces(loaded, wf, job), JOB_CONTEXTS);
  const step = job.steps.find((s) => s.id?.toLowerCase() === target.step.toLowerCase());
  if (!step?.id) return [];
  return cut(wf.source, step.id, stepPlaces(loaded, wf, job, step.id), STEP_CONTEXTS);
}

const JOB_CONTEXTS = new Set(['needs', 'jobs']);
const STEP_CONTEXTS = new Set(['steps']);

const ROLES: Partial<Record<OccurrenceRole, Reference['role']>> = {
  declaration: 'key',
  needs: 'needs',
  read: 'read',
};

/**
 * The job's own occurrences and those of its outputs, which core files under each output's symbol
 * (`needs.<id>.outputs.<name>`), with every `needs.<id>` and `jobs.<id>` read the expressions hold: a read of an
 * output nobody declares has no symbol to find it by. An output's declaration names the output, not the job.
 */
function jobPlaces(loaded: LoadedProject, wf: WorkflowDecl, job: JobDecl): Found[] {
  const own = sym.job(wf.path, job.id);
  const outputs = new Set([...Object.keys(job.outputs), ...loaded.index.jobOutputNames(job)]);
  const symbols = [own, ...[...outputs].map((name) => sym.jobOutput(wf.path, job.id, name))];
  const locator = new SymbolLocator(loaded.index);
  const occurrences = symbols
    .flatMap((s) => locator.occurrences(s))
    .filter((o) => o.role !== 'declaration' || o.symbol === own);
  return [...placesOf(occurrences), ...readsOf(wf, (site, ref) => readsJob(site, ref) && names(ref, job.id))];
}

/** `needs.<id>` anywhere, `jobs.<id>` only in a `workflow_call` output's value: elsewhere `jobs` is another context. */
const readsJob = (site: ExprSite, ref: LocatedRef) =>
  ref.context === 'needs' || (ref.context === 'jobs' && site.field === 'workflow.output');

/** The step's `id:` value and its reads, outputs included, in the expressions of its own job. */
function stepPlaces(loaded: LoadedProject, wf: WorkflowDecl, job: JobDecl, id: string): Found[] {
  const locator = new SymbolLocator(loaded.index);
  return [
    ...placesOf(locator.occurrences(sym.step(wf.path, job.id, id))),
    ...readsOf(wf, (site, ref) => site.job === job.id && ref.context === 'steps' && names(ref, id)),
  ];
}

const names = (ref: LocatedRef, id: string) => ref.path[0]?.toLowerCase() === id.toLowerCase();

function placesOf(occurrences: { loc: Loc; role: OccurrenceRole }[]): Found[] {
  return occurrences.flatMap((o) => {
    const role = ROLES[o.role];
    return role ? [{ loc: o.loc, role }] : [];
  });
}

function readsOf(wf: WorkflowDecl, keep: (site: ExprSite, ref: LocatedRef) => boolean): Found[] {
  return wf.sites.flatMap((site) =>
    site.segments.flatMap((seg) =>
      seg.refs.filter((ref) => keep(site, ref)).map((ref): Found => ({ loc: ref.loc, role: 'read' })),
    ),
  );
}

/** Each place cut to the id, once, in file order; a place where the id is not written as such is left out. */
function cut(source: SourceFile, id: string, found: Found[], contexts: Set<string>): Reference[] {
  const byStart = new Map<number, Reference>();
  for (const f of found) {
    const from = f.loc.file === source.path ? idStart(source, f, contexts) : undefined;
    if (from === undefined || byStart.has(from) || !idAt(source.text, from, id)) continue;
    const to = from + id.length;
    byStart.set(from, { ...source.loc(from, to), text: source.text.slice(from, to), role: f.role });
  }
  return [...byStart.entries()].sort(([a], [b]) => a - b).map(([, ref]) => ref);
}

/**
 * A read's first path segment, after its context: `needs.<id>`, `needs . <id>` or `needs['<id>']`, whose quotes a
 * single-quoted scalar doubles.
 */
const HEAD = /^([A-Za-z_][\w-]*)\s*(?:\.\s*|\[\s*'{1,2})/;

/**
 * Where the id starts in a place: in a key, a `needs:` entry or an `id:` value, past its quote if it has one; in a read,
 * past its context, which must be one the target is read through.
 */
function idStart(source: SourceFile, f: Found, contexts: Set<string>): number | undefined {
  const start = offsetOf(source, f.loc.line, f.loc.column);
  if (f.role !== 'read') return /["']/.test(source.text[start] ?? '') ? start + 1 : start;
  const head = HEAD.exec(source.text.slice(start, offsetOf(source, f.loc.endLine, f.loc.endColumn)));
  return head && contexts.has(head[1]!.toLowerCase()) ? start + head[0].length : undefined;
}

function offsetOf(source: SourceFile, line: number, column: number): number {
  return (source.lineCounter.lineStarts[line - 1] ?? source.text.length) + column - 1;
}

/** Whether the id is written at `at`, whole: the next character cannot continue a name. */
function idAt(text: string, at: number, id: string): boolean {
  return (
    text.slice(at, at + id.length).toLowerCase() === id.toLowerCase() &&
    !/[\w-]/.test(text[at + id.length] ?? '')
  );
}
