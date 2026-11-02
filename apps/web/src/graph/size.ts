import {
  CARD,
  type GridGeometry,
  type JobModel,
  type Metrics,
  type Point,
  type Size,
  type StepMark,
} from './types';

/**
 * Card sizes from labels and counts, never from verdicts, so a recolour never moves a card. A title's width goes up
 * in steps of 8 px, so a label typed or renamed within a step keeps the card's size, and with it the layout cached
 * for that size. A card is, top to bottom: the header, the subline, the strip of step marks, the leg grid, the open step list and the padding; a call
 * job's card then holds its callee, inset by `callPadding` on the left, the right and below.
 *
 * A skipped job has no legs and no steps in the plan, so the room is kept from what does not depend on the verdict:
 * every job that is not a call has at least one strip row, and a matrix job's grid is as large as its matrix. What
 * the plan alone cannot give still moves: more than one strip row of a job that turns skipped, the open list of a
 * skipped job, and the callee of a call job, which exists only while it might run. A remote callee the plan does not
 * simulate is a stub of a fixed size in its place, below the content.
 */

/** Room in the header besides the title: the mark and its gap before it, the badges after it. */
const TITLE_LEAD = 28;
const TITLE_TRAIL = 24;
/** The step a header's width goes up in: the narrowest and the widest card are whole steps. */
const TITLE_STEP = 8;
/** A remote callee's title bar besides its header: mark, glyph, counts, `called by …`, gaps and padding. */
const REMOTE_BAR = 200;
const REMOTE_MAX = 640;
const VALUE_CELL: Size = { width: 72, height: 20 };
const INDEX_CELL: Size = { width: 26, height: 18 };
/** Cells show the values up to this many legs, a mark and an index above it. */
const VALUE_LEGS = 48;
/** Above this many legs one row of counts stands for the cells. */
const CELL_LEGS = 512;
const MAX_COLS = 16;
/** The counts row is as wide as the narrowest card's content, so it never widens one. */
const HISTOGRAM: Size = { width: CARD.minWidth - 2 * CARD.padding, height: 20 };

/** The leg grid of a job with `count` legs. */
export function legGrid(count: number): GridGeometry {
  if (count > CELL_LEGS)
    return { cols: 1, rows: 1, cell: HISTOGRAM, values: false, histogram: true, ...HISTOGRAM };
  const values = count <= VALUE_LEGS;
  const cell = values ? VALUE_CELL : INDEX_CELL;
  if (count <= 0) return { cols: 0, rows: 0, cell, values, histogram: false, width: 0, height: 0 };
  const cols = Math.min(MAX_COLS, Math.ceil(Math.sqrt(count)));
  const rows = Math.ceil(count / cols);
  return { cols, rows, cell, values, histogram: false, width: cols * cell.width, height: rows * cell.height };
}

/** A job card's size; a call job's wraps its callee's laid-out size. */
export function cardSize(job: JobModel, metrics: Metrics, callee?: Size): Size {
  const frame = callFrame(job, metrics);
  if (!callee) return frame.min;
  return {
    width: Math.max(frame.min.width, callee.width + frame.extra.width),
    height: Math.max(frame.min.height, callee.height + frame.extra.height),
  };
}

/**
 * A card around a callee of any size: at least `min` (the card without it), and the callee's size plus `extra`. The
 * layout worker applies the same rule to a callee it lays out in the same request.
 */
export function callFrame(job: JobModel, metrics: Metrics): { min: Size; extra: Size } {
  const title = stepUp(TITLE_LEAD + metrics.width(job.label, 'title') + TITLE_TRAIL);
  const cells = gridCells(job);
  const grid = cells > 0 ? legGrid(cells).width + 2 * CARD.padding : 0;
  const stub = job.stub ? CARD.stub.width + 2 * CARD.callPadding : 0;
  const width = Math.max(clamp(title, CARD.minWidth, CARD.maxWidth), grid, stub, headerWidth(job, metrics));
  const height = contentHeight(job) + CARD.padding + (job.stub ? CARD.stub.height + CARD.callPadding : 0);
  return {
    min: { width, height },
    extra: { width: 2 * CARD.callPadding, height: height + CARD.callPadding },
  };
}

/**
 * Room for a remote callee's title bar, whose repository, file, ref and commit say what it is: the bar's mark, glyph,
 * counts and caller beside them, inside the card's call padding. Up to a cap, past which the bar cuts it short.
 */
function headerWidth(job: Pick<JobModel, 'calleeHeader'>, metrics: Metrics): number {
  if (job.calleeHeader === undefined) return 0;
  const bar = stepUp(metrics.width(job.calleeHeader, 'title') + REMOTE_BAR);
  return Math.min(bar, REMOTE_MAX) + 2 * CARD.callPadding;
}

/** Where a call job's callee sits inside its card, relative to the card's top-left corner. */
export function calleeOffset(job: JobModel): Point {
  return { x: CARD.callPadding, y: contentHeight(job) + CARD.padding };
}

/** The cells the grid has room for: every leg, or for a skipped job its matrix (one cell for `×?`); 0 without one. */
export function gridCells(job: Pick<JobModel, 'legs' | 'count'>): number {
  if (job.legs) return job.legs.length;
  return job.count === '?' ? 1 : (job.count ?? 0);
}

/** The strip's rows: one per 26 marks, at least one so a job that turns skipped keeps its height; a call has none. */
export function stripRows(job: Pick<JobModel, 'uses' | 'steps'>): number {
  if (job.uses !== undefined) return 0;
  return Math.max(1, Math.ceil(job.steps.length / CARD.marksPerRow));
}

/** Everything above the padding: header, subline, strip rows, grid and the open list. */
function contentHeight(job: JobModel): number {
  const strip = stripRows(job) * CARD.stripRow;
  const cells = gridCells(job);
  const grid = cells > 0 ? legGrid(cells).height : 0;
  return CARD.header + CARD.subline + strip + grid + (job.expanded ? listHeight(job.steps) : 0);
}

/** The open step list: a row per step and inner step up to the cap, and one for "+n" past it. */
function listHeight(steps: readonly StepMark[]): number {
  const all = rows(steps);
  const shown = Math.min(all, CARD.listCap) + (all > CARD.listCap ? 1 : 0);
  return shown * CARD.listRow;
}

const rows = (steps: readonly StepMark[]): number => steps.reduce((n, s) => n + 1 + rows(s.inner), 0);

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

/** The width rounded up to the next whole title step, so it never cuts into the title. */
const stepUp = (width: number): number => Math.ceil(width / TITLE_STEP) * TITLE_STEP;
