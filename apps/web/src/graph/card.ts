import type { NodeId, Tri } from '@simulci/engine';
import { MARK } from '@simulci/engine/render';
import { planIndex, resolveSelection, selectionOf } from '../plan/index';
import type { SessionState, SessionStore } from '../state/store';
import { MARK_LABEL } from '../lib/words';
import {
  CARD,
  type EdgeModel,
  type GridGeometry,
  type JobModel,
  type LegCell,
  type Point,
  type ScopeModel,
  type StepMark,
} from './types';

/**
 * What a card shows and what a click on it does, as plain functions the node components call: the words and the
 * status attributes the styles key on, the leg grid's cells, the step strip's marks, the step list's rows, and the
 * store actions behind a click. Status is told three ways (the mark's shape, the border the attributes pick, the
 * word), so nothing here hands out a colour.
 */

const VERDICTS: readonly Tri[] = ['yes', 'no', 'maybe'];

/**
 * The accessible name of a job card: the verdict word, the label, the clause, a result that is not success, the
 * jobs it needs by label, so no fact of its hover card is there alone, and a remote callee's stub.
 */
export function jobLabel(job: JobModel, needs: readonly string[] = []): string {
  const clause = job.clause ? ` — ${job.clause}` : '';
  const result = job.result ? `, result ${job.result}` : '';
  const after = needs.length ? `, needs ${needs.join(', ')}` : '';
  const stub = job.stub ? `; calls ${job.stub.title}, ${job.stub.status}` : '';
  return `${MARK_LABEL[job.verdict]} ${job.label}${clause}${result}${after}${stub}`;
}

/**
 * The accessible name of a `needs` edge: who needs whom, the needed job's verdict word, and for the need that
 * decided its target, the result that did.
 */
export function needsLabel(source: string, target: string, edge: Pick<EdgeModel, 'from' | 'label'>): string {
  const decided = edge.label ? `; ${edge.label} decided ${target}` : '';
  return `${target} needs ${source} (${MARK_LABEL[edge.from]})${decided}`;
}

/** A leg cell's `<title>`: its label, its verdict word, why only the run knows it, and a result that is not success. */
export function legTitle(leg: LegCell): string {
  const reason = leg.reason ? ` — ${leg.reason}` : '';
  const result = leg.result ? `, result ${leg.result}` : '';
  return `${leg.label}: ${MARK_LABEL[leg.verdict]}${reason}${result}`;
}

/** A workflow's name, else its path; a remote one's repository, file and ref (`octo/ship · deploy.yml @ v1`). */
export const scopeTitle = (scope: ScopeModel): string => scope.name ?? scope.remote?.title ?? scope.path;

/** A callee past depth 2: it stays one line until the author opens it, and closes again on their word. */
export const deepCallee = (scope: ScopeModel): boolean => scope.caller !== undefined && scope.depth > 2;

/**
 * The accessible name of a workflow: the verdict word, its title, the commit a remote one was read at, its clause, and
 * its caller when it is called.
 */
export function scopeLabel(scope: ScopeModel, caller?: string): string {
  const clause = scope.clause ? ` — ${scope.clause}` : '';
  const by = caller === undefined ? '' : `, called by ${caller}`;
  const remote = scope.remote ? `, remote, read at ${scope.remote.sha}` : '';
  return `${MARK_LABEL[scope.verdict]} ${scopeTitle(scope)}${remote}${clause}${by}`;
}

/** The parts of a card's subline, each absent when it has nothing to say. */
export interface Subline {
  /** The verdict word and the deciding clause, for a job that does not plainly run. */
  status?: string;
  count?: string;
  uses?: string;
  /** The check stem, unless it only repeats the label. */
  check?: string;
}

export function subline(job: JobModel): Subline {
  return {
    status: job.clause ? `${MARK_LABEL[job.verdict]} — ${job.clause}` : undefined,
    count: job.count === undefined ? undefined : `×${job.count}`,
    uses: job.uses,
    check: job.check && job.check !== job.label ? job.check : undefined,
  };
}

export type Tone = 'danger' | 'skip' | 'unknown' | 'muted';

/** The tone of a result badge: a failure is the danger colour, a result only the run knows is unknown. */
export function resultTone(result: string): Tone {
  if (result.includes('?') || result.includes('|')) return 'unknown';
  if (result.includes('failure')) return 'danger';
  if (result.includes('cancelled') || result.includes('skipped')) return 'skip';
  return 'muted';
}

/** A workflow's own jobs by verdict, the empty verdicts left out, in the order runs, skipped, might run. */
export function countParts(counts: Record<Tri, number>): { verdict: Tri; n: number; glyph: string }[] {
  return VERDICTS.filter((v) => counts[v] > 0).map((v) => ({ verdict: v, n: counts[v], glyph: MARK[v] }));
}

/** The counts as words, for a screen reader: `4 runs, 1 skipped`. */
export const countsText = (counts: Record<Tri, number>): string =>
  countParts(counts)
    .map((p) => `${p.n} ${MARK_LABEL[p.verdict]}`)
    .join(', ');

/** How a card stands towards the selection, a hovered unknown and the last change, as `flow.ts` works it out. */
export interface CardState {
  /** The card holds the selection: it is the selected node, or the selected leg or step is inside it. */
  selected: boolean;
  /** The selected leg or step inside the card. */
  inner?: NodeId;
  /**
   * On the selected job's dependency path, or off it and faded; absent while its scope shows no path. While an
   * unknown's "affects n" is hovered, lit or faded by that instead, on every card.
   */
  path?: 'on' | 'off';
  hovered: boolean;
  /** The last change changed what the card shows: it flashes once, the value following the change's parity. */
  flash?: 'a' | 'b';
  /** The last change added the card: it gets the added ring for two seconds, the value following the parity. */
  added?: 'a' | 'b';
}

/**
 * The attributes the canvas styles key on: the verdict picks the border, the rest the outline, the fade, the flash
 * and the added ring.
 */
export function cardAttrs(verdict: Tri, state: CardState): Record<string, string> {
  const attrs: Record<string, string> = { 'data-verdict': verdict };
  if (state.selected) attrs['data-selected'] = state.inner === undefined ? 'self' : 'inner';
  if (state.path) attrs['data-path'] = state.path;
  if (state.flash) attrs['data-flash'] = state.flash;
  if (state.added) attrs['data-added'] = state.added;
  return attrs;
}

/** The top-left corner of grid cell `i`, cells filled row by row, the space the cells leave shared between them. */
export function cellAt(i: number, g: GridGeometry): Point {
  const col = i % g.cols;
  const row = Math.floor(i / g.cols);
  const gapX = g.cols > 1 ? (g.width - g.cols * g.cell.width) / (g.cols - 1) : 0;
  const gapY = g.rows > 1 ? (g.height - g.rows * g.cell.height) / (g.rows - 1) : 0;
  return { x: col * (g.cell.width + gapX), y: row * (g.cell.height + gapY) };
}

/** Mono characters at the grid's 10 px that fit a cell, its inner padding left free. */
export const cellChars = (g: GridGeometry): number => Math.max(1, Math.floor((g.cell.width - 8) / 6));

/** The text cut to `max` characters, an ellipsis standing for the rest. */
export const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;

/** The histogram row of a matrix too large for cells: `● 1,800 ○ 0 ◐ 200`. */
export function histogram(legs: readonly { verdict: Tri }[]): { verdict: Tri; glyph: string; n: string }[] {
  const counts: Record<Tri, number> = { yes: 0, no: 0, maybe: 0 };
  for (const leg of legs) counts[leg.verdict]++;
  return VERDICTS.map((v) => ({ verdict: v, glyph: MARK[v], n: counts[v].toLocaleString('en') }));
}

export interface StripLayout {
  width: number;
  height: number;
  /** The diameter of one mark. */
  size: number;
  at: (i: number) => Point;
}

/** The step strip: rows of up to `CARD.marksPerRow` marks across the width given, `CARD.stripRow` high each. */
export function stripLayout(count: number, width: number): StripLayout {
  const perRow = Math.max(1, Math.min(count, CARD.marksPerRow));
  const pitch = Math.min(12, width / perRow);
  const size = Math.max(4, Math.min(10, pitch - 2));
  const rows = Math.max(1, Math.ceil(count / CARD.marksPerRow));
  return {
    width: perRow * pitch,
    height: rows * CARD.stripRow,
    size,
    at: (i) => ({
      x: (i % CARD.marksPerRow) * pitch + (pitch - size) / 2,
      y: Math.floor(i / CARD.marksPerRow) * CARD.stripRow + (CARD.stripRow - size) / 2,
    }),
  };
}

export interface ListRow {
  step: StepMark;
  /** 0 for a step of the job, 1 for a composite action's inner step, and so on. */
  depth: number;
}

/** The step list's rows, inner steps after their composite step, cut at `cap`; `more` counts the rows left out. */
export function listRows(
  steps: readonly StepMark[],
  cap: number = CARD.listCap,
): { rows: ListRow[]; more: number } {
  const all: ListRow[] = [];
  const walk = (list: readonly StepMark[], depth: number): void => {
    for (const step of list) {
      all.push({ step, depth });
      walk(step.inner, depth + 1);
    }
  };
  walk(steps, 0);
  return { rows: all.slice(0, cap), more: Math.max(0, all.length - cap) };
}

/** The attributes of a `needs` edge's path, which the canvas styles key on. */
export function edgeAttrs(data: {
  from: Tri;
  deciding: boolean;
  onPath: boolean;
  faded: boolean;
}): Record<string, string> {
  const attrs: Record<string, string> = { 'data-from': data.from };
  if (data.deciding) attrs['data-deciding'] = 'true';
  if (data.onPath) attrs['data-path'] = 'on';
  else if (data.faded) attrs['data-path'] = 'off';
  return attrs;
}

/** The node the store's selection names in the current plan. */
export function selectedNode(s: Pick<SessionState, 'plan' | 'focus' | 'sel'>): NodeId | undefined {
  return s.plan && resolveSelection(planIndex(s.plan), s.focus, s.sel);
}

/** What a click on a card does to the store. */
export interface CardActions {
  /**
   * Selects a node by its id; one the current plan does not hold is ignored. A leg also becomes the one whose steps
   * and callee its card shows.
   */
  select: (id: NodeId) => void;
  toggleExpanded: (job: NodeId) => void;
  toggleOpened: (scope: NodeId) => void;
  /** Selects the focused workflow, as a click on the pane does. */
  selectFocus: () => void;
}

export function cardActions(store: SessionStore): CardActions {
  const select = (id: NodeId): void => {
    const s = store.getState();
    const index = s.plan && planIndex(s.plan);
    const node = index?.nodes.get(id);
    if (!index || !node) return;
    // A leg picked on the canvas, by its cell or by the keys, is the one its card shows.
    if (node.kind === 'leg' && node.parent !== undefined && s.ui.representative[node.parent] !== id)
      s.setRepresentative(node.parent, id);
    const { focus, sel } = selectionOf(index, id);
    s.select(focus, sel);
  };
  return {
    select,
    toggleExpanded: (job) => store.getState().toggleExpanded(job),
    toggleOpened: (scope) => store.getState().toggleOpened(scope),
    selectFocus: () => {
      const s = store.getState();
      s.select(s.focus, undefined);
    },
  };
}
