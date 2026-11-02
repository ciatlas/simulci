import type { NodeId, Tri } from '@simulci/engine';
import type { RemoteStub } from './remote';

/**
 * The shapes and measures every graph module shares. The canvas holds workflow instances (a depth-0 workflow, or the
 * workflow a job's representative leg calls) and jobs; legs are a grid inside the job card and steps a strip, never
 * nodes of their own. `model.ts` builds a GraphModel from the plan, `size.ts` measures it, the layout worker places
 * each scope's jobs, `flow.ts` turns the result into React Flow nodes.
 */

/** A workflow instance: what one ELK layout places. */
export interface ScopeModel {
  /** The workflow's node id: its path at depth 0, `<leg>><path>` for a called one. */
  id: NodeId;
  path: string;
  name?: string;
  verdict: Tri;
  /** The deciding clause of its trigger (or of the call), as the CLI words it. */
  clause: string;
  /** Its own jobs by verdict. */
  counts: Record<Tri, number>;
  depth: number;
  /** The job whose card holds this called workflow. */
  caller?: NodeId;
  /** One line, nothing laid out: an untriggered depth-0 workflow, or a callee past depth 2 the author has not opened. */
  collapsed: boolean;
  /**
   * The workflow being edited, laid out although nothing triggers it, its jobs as they would be planned: drawn
   * dimmed under the banner that says so (app/UntriggeredBanner.tsx).
   */
  dimmed?: true;
  /** A remote callee: `octo/ship · deploy.yml @ v1` and the commit it was read at (`4a7c0e1`). */
  remote?: { title: string; sha: string };
  /** In declaration order. */
  jobs: NodeId[];
  edges: EdgeModel[];
  /** What decides the layout and nothing else (`shape.ts`): a scenario change that only recolours keeps it. */
  shape: string;
}

/** A job card. */
export interface JobModel {
  id: NodeId;
  /** The scope it sits in. */
  scope: NodeId;
  jobId: string;
  /** `name ?? jobId`. */
  label: string;
  verdict: Tri;
  /** The deciding clause, when the job does not plainly run. */
  clause?: string;
  /**
   * What the result adds to the verdict: `failure`, `success | cancelled`, …; never a known success, nor `skipped`
   * for a job the verdict already calls skipped or might run.
   */
  result?: string;
  uses?: string;
  /** The check name with the matrix part elided. */
  check?: string;
  needs: NodeId[];
  /** The matrix size when the job has a matrix (`×count` on the subline), known or not: `?` when only the run knows. */
  count?: number | '?';
  /**
   * Every leg, as grid cells; absent for a job with one unnamed leg, and for a skipped job, whose card still keeps
   * the grid's room and draws it as skipped cells (size.ts `gridCells`).
   */
  legs?: LegCell[];
  /** The leg whose steps and callee the card shows (the author's pick, else the first). */
  representative?: NodeId;
  /** The representative leg's steps; empty for a call, a skipped job or `detail: legs`. */
  steps: StepMark[];
  /** The step list is open. */
  expanded: boolean;
  /** The scope of the workflow the representative leg calls. */
  callee?: NodeId;
  /** A remote callee's title bar, `octo/ship · deploy.yml @ v1 (4a7c0e1)`: the card is at least wide enough for it. */
  calleeHeader?: string;
  /**
   * In its place, for a call that might run and whose remote callee the plan does not simulate (not fetched, not
   * read, past a cap, a file that does not parse): a dashed stub that says so.
   */
  stub?: RemoteStub;
}

export interface LegCell {
  id: NodeId;
  legKey: string;
  /** The values as a short label (`node=22`, `22 · linux`); the check name when it has one. */
  label: string;
  verdict: Tri;
  result?: string;
  /** For the one `∗` cell of a matrix only the run knows: the matrix reason, as the CLI words it. */
  reason?: string;
}

export interface StepMark {
  id: NodeId;
  /** `name ?? uses ?? stepId ?? key`. */
  label: string;
  verdict: Tri;
  /** Its composite action's inner steps, indented in the list, absent from the strip. */
  inner: StepMark[];
  /** Outputs summarised (`changed=true sha=?`), for the list. */
  outputs?: string;
}

export interface EdgeModel {
  /** `<source>-><target>`. */
  id: string;
  source: NodeId;
  target: NodeId;
  /** The verdict of the needed job: a skipped source fades the edge, a might-run one dashes it. */
  from: Tri;
  /**
   * The need decided the target's verdict through its `if:` (worker/deciding.ts): the verdict would differ had the
   * needs succeeded, and this need is one that kept them from it, known not to succeed or, while none is known,
   * only the run knows.
   */
  deciding: boolean;
  /** For a deciding edge: `result: failure`, `result: ?`. */
  label?: string;
}

export interface GraphModel {
  /** Depth-0 scopes in plan order (minus untriggered ones when they are hidden). */
  roots: NodeId[];
  /** Every scope, callees included. */
  scopes: Record<NodeId, ScopeModel>;
  jobs: Record<NodeId, JobModel>;
}

/** What the author changed about the picture, apart from the plan. */
export interface GraphUi {
  /** Jobs whose step list is open. */
  expanded: readonly NodeId[];
  /** Per job, the leg whose steps and callee the card shows. */
  representative: Readonly<Record<NodeId, NodeId>>;
  /** Callees past depth 2 the author opened. */
  opened: readonly NodeId[];
  hideUntriggered: boolean;
  /** The one depth-0 workflow to draw, by path: edit mode's focused workflow. Absent, every one is drawn. */
  only?: string;
}

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Text widths in px: canvas `measureText` in the browser, a width table in tests. */
export interface Metrics {
  width(text: string, font: 'title' | 'body' | 'mono'): number;
}

/** The leg grid inside a card. */
export interface GridGeometry {
  cols: number;
  rows: number;
  cell: Size;
  /** Cells show the values (up to 48 legs); above that a mark and an index. */
  values: boolean;
  /** Above 512 legs: one histogram row instead of cells. */
  histogram: boolean;
  width: number;
  height: number;
}

/** The fixed measures of a card, in px, shared by `size.ts` and the node components. */
export const CARD = {
  minWidth: 168,
  maxWidth: 320,
  /** Mark, label, badges. */
  header: 28,
  /** The clause, `×count`, `uses:`, the check: reserved on every card so a recolour never resizes it. */
  subline: 14,
  /** One row of step marks. */
  stripRow: 14,
  marksPerRow: 26,
  listRow: 20,
  /** Step rows shown before "+n". */
  listCap: 40,
  padding: 8,
  /** Around a called workflow inside its job card. */
  callPadding: 12,
  /** An untriggered root or a closed callee. */
  collapsed: { width: 320, height: 44 },
  /** A remote callee's stub: its title line and a sentence of up to two lines, inset by `callPadding`. */
  stub: { width: 296, height: 58 },
  /** Between depth-0 workflows in the root stack. */
  rootGap: 24,
  /** ELK `elk.padding` of a workflow compound: room for its title bar. */
  scopePadding: { top: 40, left: 16, bottom: 16, right: 16 },
} as const;

/** One scope's placement: its size and its jobs' top-left corners, relative to the scope. */
export interface ScopeLayout extends Size {
  positions: Record<NodeId, Point>;
}

/** Everything placed: what `flow.ts` needs besides the model. */
export interface GraphLayout {
  /** Laid-out scopes (collapsed ones have none). */
  scopes: Record<NodeId, ScopeLayout>;
  /** The root stack: each depth-0 scope's top-left corner and size. */
  roots: Record<NodeId, Point & Size>;
  /** Every job card's size (a call job's includes its callee). */
  cards: Record<NodeId, Size>;
}

/** What the canvas shows, committed only once the positions exist: the previous picture stays until then. */
export interface GraphState {
  model: GraphModel;
  layout: GraphLayout;
  /**
   * The plan it was built from: that plan's own `for` object (`PlanState['for']`), not a copy, since the flash
   * compares the two by identity to tell the picture of the change's plan from an older one.
   */
  for: { files: number; epoch: number; project: number };
  /** Milliseconds the layout worker took, when it ran. */
  ms?: number;
}
