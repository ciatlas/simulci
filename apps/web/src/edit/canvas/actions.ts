import { freeId, ID, type NewJob, sameId, type WorkflowDocument, type WorkflowOp } from '@simulci/document';
import type { NodeId } from '@simulci/engine';
import { listed } from '../../lib/words';
import { callsOut } from '../../lib/unit-path';
import { planIndex, selectionOf } from '../../plan/index';
import type { SessionStore } from '../../state/store';
import type { Outline } from '../../worker/protocol';
import { type CatalogAction, catalogAction } from '../catalog';
import { type Dispatched, dispatch } from '../dispatch';
import { documents } from '../documents';
import { type Gestures, pendingEdges } from '../gestures';
import { refuseRemote } from '../remote';
import { dependentsOf, needsOf, needsTransitively } from '../needs';
import { type Target, targetOf } from '../selection';
import { moveStep, removeStep, stepTarget } from '../steps/actions';
import { type GestureUi, type PaletteOpen, removal } from './ui';

/**
 * The structural gestures of the canvas and the outline tree (synthesis § 4.2, § 4.5), as ops through the one dispatch
 * path. A card is a job of the focused workflow when the plan names it so and the text now still has it; a gesture
 * made on the plan's picture reads its target with `planned`, so a step picked by its position is refused while the
 * plan lags the text. Each op carries the revision its gesture read and a label in the past tense, which opens the
 * status line's sentence (C1). A removal that warns, or that takes needs with it, asks first; a removal that commits
 * offers Undo in a notice.
 */

/** The card of a node on the canvas, when it is drawn. */
export function cardElement(node: NodeId): Element | undefined {
  return document.querySelector(`.react-flow__node[data-id="${CSS.escape(node)}"]`) ?? undefined;
}

/** A job's node id, as the plan spells it: `<path>#<job>`. */
const jobNode = (file: string, job: string): NodeId => `${file}#${job}`;

/** Where a popover about a node opens: at its card when drawn, else at what has the focus (an outline row). */
function anchorFor(node: NodeId | undefined): Element | undefined {
  const card = node === undefined ? undefined : cardElement(node);
  if (card) return card;
  const active = document.activeElement;
  return active && active !== document.body ? active : undefined;
}

/** The job of the focused workflow a canvas node is, in the text now; a leg, a step or a called job is none. */
function jobAt(store: SessionStore, node: NodeId): (Target & { job: string }) | undefined {
  const sel = jobSel(store, node);
  const target = sel && targetOf(store, sel.focus, sel.job, { planned: true });
  return target?.job === undefined ? undefined : { ...target, job: target.job };
}

/** The unit path of a job of the focused workflow, in edit mode: a job alone, not a leg, a step or a called job. */
function jobSel(store: SessionStore, node: NodeId): { focus: string; job: string } | undefined {
  const s = store.getState();
  const at = s.plan && s.edit.on ? selectionOf(planIndex(s.plan), node) : undefined;
  return at?.sel && at.focus === s.focus && !/[[./]/.test(at.sel)
    ? { focus: at.focus, job: at.sel }
    : undefined;
}

/** The selection as a place in the focused workflow's text, read as the canvas shows it. */
function selected(store: SessionStore): Target | undefined {
  const s = store.getState();
  if (!s.edit.on || s.focus === undefined || callsOut(s.sel)) return undefined;
  return targetOf(store, s.focus, s.sel, { planned: true });
}

const docOf = (store: SessionStore, file: string): WorkflowDocument | undefined =>
  documents(store).of(store.getState(), file);

/** Whether a drag from `source`'s handle may end on `target`'s: two jobs of one file, a need it lacks, no loop. */
export function canConnect(store: SessionStore, source: NodeId, target: NodeId): boolean {
  const a = jobAt(store, source);
  const b = jobAt(store, target);
  if (!a || !b || a.file !== b.file || sameId(a.job, b.job)) return false;
  const doc = docOf(store, b.file);
  const current = doc && needsOf(doc, b.job);
  if (!doc || !current || current.some((n) => sameId(n, a.job))) return false;
  return !needsTransitively(doc, a.job, b.job);
}

/** A drop on another job's handle: it needs the dragged one. A loop is refused with its sentence at the card. */
export function connect(store: SessionStore, ui: GestureUi, source: NodeId, target: NodeId): void {
  const a = jobAt(store, source);
  const b = jobAt(store, target);
  if (!a || !b || a.file !== b.file) return;
  const result = addNeed(store, b, a.job);
  if (result && !result.ok) ui.refused(result.refused.seq, cardElement(target));
}

/**
 * One need added to a job's: an op the document refuses when it would loop (with the `cycle` sentence) or when the
 * needs are not a list of names. A need it has already writes nothing. The new edge is drawn dashed until a picture
 * of its text has it.
 */
export function addNeed(
  store: SessionStore,
  at: { file: string; rev: number; job: string },
  need: string,
): Dispatched | undefined {
  const doc = docOf(store, at.file);
  const current = doc ? needsOf(doc, at.job) : undefined;
  if (current?.some((n) => sameId(n, need))) return undefined;
  const result = dispatch(
    store,
    { op: 'setNeeds', file: at.file, job: at.job, needs: [...(current ?? []), need] },
    { revs: { [at.file]: at.rev }, label: `Connected ${need} to ${at.job}` },
  );
  if (result.ok && result.changed)
    pendingEdges.add(store, {
      source: jobNode(at.file, need),
      target: jobNode(at.file, at.job),
      files: store.getState().files.version,
    });
  return result;
}

/** ✕ on an edge, or Delete on it: the need goes, after asking when expressions still read it. */
export function disconnect(store: SessionStore, ui: GestureUi, source: NodeId, target: NodeId): void {
  const a = jobAt(store, source);
  const b = jobAt(store, target);
  if (a && b && a.file === b.file) removeNeed(store, ui, b, a.job, cardElement(target));
}

/** One need out of a job's, asking first when its outputs are still read; the notice offers Undo. */
export function removeNeed(
  store: SessionStore,
  ui: GestureUi,
  at: { file: string; rev: number; job: string },
  need: string,
  anchor?: Element,
): void {
  const doc = docOf(store, at.file);
  const current = doc ? needsOf(doc, at.job) : undefined;
  if (current && !current.some((n) => sameId(n, need))) return;
  const what = `${at.job}'s need on ${need}`;
  removal(store, ui, {
    op: {
      op: 'setNeeds',
      file: at.file,
      job: at.job,
      needs: (current ?? []).filter((n) => !sameId(n, need)),
    },
    meta: { revs: { [at.file]: at.rev }, label: `Removed ${what}` },
    toast: `Removed ${what}`,
    ask: { title: `Remove ${what}?`, action: 'Remove the need', lines: [] },
    anchor,
  });
}

/**
 * Delete on the canvas or the outline: the selected job, asking first when jobs need it (their needs on it go too) or
 * expressions read it. A leg is not removed on its own; a step is (`removeStepAt`, given by the steps' gestures).
 */
function removeSelectedJob(store: SessionStore, ui: GestureUi, target: Target): boolean {
  const s = store.getState();
  const job = target.job;
  const doc = docOf(store, target.file);
  if (job === undefined || target.step || !doc || s.sel?.includes('[')) return false;
  const dependents = dependentsOf(doc, job);
  const one = dependents.length === 1;
  const theirs = one ? `its need on ${job} goes` : `their needs on ${job} go`;
  const lines =
    dependents.length === 0 ? [] : [`${listed(dependents)} ${one ? 'needs' : 'need'} it: ${theirs} too.`];
  removal(store, ui, {
    op: { op: 'removeJob', file: target.file, job },
    meta: { revs: { [target.file]: target.rev }, label: `Removed job ${job}` },
    toast: removedJobText(job, dependents),
    ask: { title: `Remove job ${job}?`, action: `Remove ${job}`, lines },
    anchor: cardElement(jobNode(target.file, job)),
    always: dependents.length > 0,
  });
  return true;
}

/** "Removed lint", "Removed lint and deploy's need on it", "Removed lint and deploy's and preview's needs on it". */
export function removedJobText(job: string, dependents: readonly string[]): string {
  if (dependents.length === 0) return `Removed ${job}`;
  const needs = dependents.length === 1 ? 'need' : 'needs';
  return `Removed ${job} and ${listed(dependents.map((d) => `${d}'s`))} ${needs} on it`;
}

/**
 * What Add job writes (synthesis § 4.2): its id, runner, needs and, when asked, a first step that checks out; or, from
 * the palette, the reusable workflow it calls.
 */
export interface NewJobForm {
  id: string;
  after?: string;
  runsOn: string;
  needs: string[];
  checkout?: string;
  uses?: string;
}

export function addJobOp(file: string, form: NewJobForm): Extract<WorkflowOp, { op: 'addJob' }> {
  const labels = form.runsOn
    .split(',')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const job: NewJob = form.uses === undefined ? {} : { uses: form.uses };
  if (labels.length > 0 && form.uses === undefined)
    job['runs-on'] = labels.length === 1 ? labels[0]! : labels;
  if (form.needs.length > 0) job.needs = form.needs;
  if (form.checkout) job.steps = [{ uses: form.checkout }];
  return { op: 'addJob', file, id: form.id, ...(form.after === undefined ? {} : { after: form.after }), job };
}

/** Adds the job; its card is selected by the op, and takes the focus once a picture draws it. */
export function addJob(
  store: SessionStore,
  ui: GestureUi,
  at: { file: string; rev: number },
  form: NewJobForm,
): Dispatched {
  const calls = form.uses === undefined ? '' : ` calling ${form.uses}`;
  const label = `Added job ${form.id}${form.after === undefined ? '' : ` after ${form.after}`}${calls}`;
  const result = dispatch(store, addJobOp(at.file, form), { revs: { [at.file]: at.rev }, label });
  if (result.ok && result.changed) ui.added(jobNode(at.file, form.id), store.getState().files.version);
  return result;
}

/** Why an id typed into Add job cannot be one: the engine's id rule, or a job of the file has it whatever its case. */
export function idProblem(id: string, taken: readonly string[]): string | undefined {
  if (!ID.test(id)) return 'Job ids start with a letter or _, then letters, digits, - or _.';
  const same = taken.find((t) => sameId(t, id));
  return same === undefined ? undefined : `A job ${same} already exists; ids ignore case.`;
}

/** The id Add job offers: `job`, else the first free `job-2`, `job-3`. */
export const offeredId = (doc: WorkflowDocument): string =>
  freeId(
    'job',
    doc.jobs().map((j) => j.id),
  );

/** The runner Add job offers: the job it follows's own label, else the file's commonest, else `ubuntu-latest`. */
export function runsOnFor(doc: WorkflowDocument, after: string | undefined): string {
  const label = (id: string): string[] => {
    const value = doc.get(['jobs', id, 'runs-on'])?.value;
    return typeof value === 'string' && !value.includes('${{') ? [value] : [];
  };
  return (after === undefined ? [] : label(after))[0] ?? commonest(doc.jobs().flatMap((j) => label(j.id)));
}

/** The label written most often, the first written on a tie; GitHub's default runner when there is none. */
function commonest(labels: readonly string[]): string {
  const times = (label: string): number => labels.filter((l) => l === label).length;
  return (
    labels.reduce<string | undefined>(
      (best, l) => (best === undefined || times(l) > times(best) ? l : best),
      undefined,
    ) ?? 'ubuntu-latest'
  );
}

/**
 * Checkout as this repository writes it (its commonest ref), else at the bundled catalog's ref; none while the
 * repository has none and the catalog is not in.
 */
export function checkoutOf(
  outline: Outline | undefined,
  catalog?: readonly CatalogAction[],
): string | undefined {
  const counts = new Map<string, number>();
  for (const wf of outline?.workflows ?? [])
    for (const job of wf.jobs)
      for (const step of job.steps)
        if (step.uses?.startsWith('actions/checkout@'))
          counts.set(step.uses, (counts.get(step.uses) ?? 0) + 1);
  const used = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const ref = catalogAction(catalog, 'actions/checkout')?.ref;
  return used ?? (ref === undefined ? undefined : `actions/checkout@${ref}`);
}

/** The gestures the page asks for, answered on this store with this host's popovers and questions. */
export function gesturesOf(store: SessionStore, ui: GestureUi): Gestures {
  // A gesture on a job or step of a remote callee refuses with where to make it (edit/remote.ts).
  const remote = (): boolean => refuseRemote(store, (seq, node) => ui.refused(seq, cardElement(node)));
  return {
    addJob: (after) => (after === undefined && remote()) || openAddJob(store, ui, after),
    needs: () => remote() || openNeeds(store, ui),
    palette: (at) => (at === undefined && remote()) || openPalette(store, ui, at),
    remove: () => {
      if (remote()) return true;
      const target = selected(store);
      if (target?.step)
        return removeStep(store, ui, target, { anchor: anchorFor(stepCard(target.file, target.job)) });
      return target !== undefined && removeSelectedJob(store, ui, target);
    },
    move: (by) => {
      if (remote()) return true;
      const target = selected(store);
      return target?.step !== undefined && moveStep(store, ui, target, target.step.index + by);
    },
    rename: (at) => (at ? renameRow(store, ui, at.node, at.anchor) : remote() || openRename(store, ui)),
    canConnect: (source, target) => canConnect(store, source, target),
    connect: (source, target) => connect(store, ui, source, target),
    disconnect: (source, target) => disconnect(store, ui, source, target),
    menu: (node, at) => openMenu(store, ui, node, at),
  };
}

/**
 * Add job, after the job given, else after the selected job (a leg's or a step's job), else for the workflow alone:
 * at its card, at the workflow's frame, or at what has the focus.
 */
function openAddJob(store: SessionStore, ui: GestureUi, after?: string): boolean {
  const at = workflowAt(store);
  if (!at) return false;
  const known = jobOf(store, at.file, after ?? selected(store)?.job);
  const anchor = anchorFor(known === undefined ? at.file : jobNode(at.file, known));
  ui.open({
    kind: 'addJob',
    file: at.file,
    rev: at.rev,
    ...(known === undefined ? {} : { after: known }),
    anchor,
  });
  return true;
}

/** The focused workflow, in edit mode, as a place in its text. */
function workflowAt(store: SessionStore): Target | undefined {
  const s = store.getState();
  return s.edit.on && s.focus !== undefined ? targetOf(store, s.focus, undefined) : undefined;
}

/** A job of the file by its exact id, when the text now has it. */
const jobOf = (store: SessionStore, file: string, job: string | undefined): string | undefined =>
  job === undefined
    ? undefined
    : docOf(store, file)
        ?.jobs()
        .find((j) => j.id === job)?.id;

const stepCard = (file: string, job: string | undefined): NodeId | undefined =>
  job === undefined ? undefined : jobNode(file, job);

/**
 * The palette: at the place given (+ between steps, + Add step) or for the step given (Change…), else after the
 * selected step or last in the selected job.
 */
function openPalette(
  store: SessionStore,
  ui: GestureUi,
  at?: { job: string; index: number; change?: boolean },
): boolean {
  const open = at?.change ? changeAt(store, at) : at ? insertAt(store, at) : afterSelection(store);
  if (open) ui.open(open);
  return open !== undefined;
}

/** The palette for another action of the step at a place: its fingerprint read now. */
function changeAt(store: SessionStore, at: { job: string; index: number }): PaletteOpen | undefined {
  const file = workflowAt(store)?.file;
  const step = file === undefined ? undefined : stepTarget(store, file, at.job, at.index);
  return (
    step && {
      kind: 'palette',
      file: step.file,
      rev: step.rev,
      job: at.job,
      index: at.index,
      change: step.step.fp,
    }
  );
}

/** The palette for a step at a place in a job of the focused workflow. */
function insertAt(store: SessionStore, at: { job: string; index: number }): PaletteOpen | undefined {
  const wf = workflowAt(store);
  return wf && { kind: 'palette', file: wf.file, rev: wf.rev, job: at.job, index: at.index };
}

/** The palette for a step after the selected one, else last in the selected job. */
function afterSelection(store: SessionStore): PaletteOpen | undefined {
  const target = selected(store);
  if (target?.job === undefined) return undefined;
  const count =
    docOf(store, target.file)
      ?.jobs()
      .find((j) => j.id === target.job)?.steps.length ?? 0;
  const index = target.step ? target.step.index + 1 : count;
  return { kind: 'palette', file: target.file, rev: target.rev, job: target.job, index };
}

/**
 * Rename, over the selected job's card title (a leg's job), or for the selected step's id at its job's card; at the
 * outline row with the focus when the card is not drawn.
 */
function openRename(store: SessionStore, ui: GestureUi, at?: Element): boolean {
  const target = selected(store);
  if (target?.job === undefined) return false;
  const card = cardElement(jobNode(target.file, target.job));
  const title = target.step ? undefined : card?.querySelector('.sc-card-label');
  const anchor = at ?? title ?? anchorFor(jobNode(target.file, target.job));
  const { file, rev, job, step } = target;
  ui.open({ kind: 'rename', target: { file, rev, job, ...(step ? { step } : {}) }, anchor });
  return true;
}

/** Rename from an outline row: the row's node is selected, as its menu does, and the input opens at the row. */
function renameRow(store: SessionStore, ui: GestureUi, node: NodeId, anchor: Element): boolean {
  const s = store.getState();
  if (!s.plan || !s.edit.on) return false;
  const { focus, sel } = selectionOf(planIndex(s.plan), node);
  if (focus !== s.focus || sel === undefined || callsOut(sel)) return false;
  s.select(focus, sel);
  return openRename(store, ui, anchor);
}

/** What it needs, under the selected job's card (a leg's or a step's job). */
function openNeeds(store: SessionStore, ui: GestureUi): boolean {
  const target = selected(store);
  if (target?.job === undefined) return false;
  ui.open({
    kind: 'needs',
    file: target.file,
    rev: target.rev,
    job: target.job,
    anchor: anchorFor(jobNode(target.file, target.job)),
  });
  return true;
}

/** The outline rows that have actions: the workflow's, its jobs' and their steps'. */
const ACTIONABLE: ReadonlySet<string> = new Set(['workflow', 'job', 'step']);

/** An outline row's actions: the row is selected, so each acts on it as its key would. */
function openMenu(store: SessionStore, ui: GestureUi, node: NodeId, anchor: Element): boolean {
  const s = store.getState();
  const index = s.plan && s.edit.on ? planIndex(s.plan) : undefined;
  if (!index || !ACTIONABLE.has(index.nodes.get(node)?.kind ?? '')) return false;
  const { focus, sel } = selectionOf(index, node);
  if (focus !== s.focus || callsOut(sel)) return false;
  s.select(focus, sel);
  ui.open({ kind: 'menu', node, anchor });
  return true;
}
