import type { NodeId, Tri } from '@simulci/engine';
import { type Edge, type Node, type NodeHandle, Position } from '@xyflow/react';
import type { PendingEdge } from '../edit/gestures';
import { type CardState, jobLabel, needsLabel, scopeLabel } from './card';
import type { Flash } from './highlight';
import { cardOf, type NavAction, type NavKey } from './navigate';
import { calleeOffset } from './size';
import {
  CARD,
  type EdgeModel,
  type GraphLayout,
  type GraphModel,
  type JobModel,
  type Point,
  type ScopeLayout,
  type ScopeModel,
  type Size,
} from './types';

/**
 * The model and its layout as React Flow nodes and edges, and the rest of the canvas's pure glue: whether a node is
 * out of view, which key presses belong to the canvas, what a canvas key and a focused card do. Parents come before
 * their children and a child's position is relative to its parent, as React Flow wants; nothing is draggable. A
 * node's accessible name is React Flow's `ariaLabel`, on the element that takes the focus. The selected job's
 * dependency path (what it needs and what needs it, in its own workflow) is marked on, the other jobs of that
 * workflow off, and a faded call job fades the workflow it calls. While an unknown's "affects n" is hovered, the
 * cards it lights (highlight.ts) are on and every other card off instead, the selection keeping its outline; the
 * cards the last change changed flash, and the cards it added get the added ring.
 *
 * Every node comes with the size and the handles it is drawn with, so React Flow never waits on a measurement to
 * draw an edge and keeps none it would lose when a node object is replaced; `keepUnchanged` hands back the objects
 * that did not change, so a hover or a click re-renders only the cards it touches. One card is a tab stop: the one
 * that holds the selection, else the first workflow; the canvas keys move between the others.
 */

export interface FlowView {
  selected?: NodeId;
  hovered?: NodeId;
  /**
   * While an unknown's "affects n" is hovered: the cards it lights. Every other card fades, and every edge whose two
   * ends are not both lit, over the selection's dependency path while the hover lasts.
   */
  lit?: ReadonlySet<NodeId>;
  /** The cards the last change changed, which flash, and the ones it added, which get the ring. */
  flash?: Pick<Flash, 'parity' | 'cards' | 'ring'>;
  /**
   * In edit mode, the depth-0 workflow being edited (synthesis § 4.5): its jobs connect by their handles, its edges
   * take the focus and offer ✕, and the needs written since its picture are drawn dashed (`pending`).
   */
  editing?: NodeId;
  /** The edge the pointer or the focus is on, which shows its ✕. */
  hotEdge?: string;
  pending?: readonly PendingEdge[];
}

export type ScopeData = { scope: ScopeModel; caller?: string; state: CardState; editable?: boolean };
export type JobData = { job: JobModel; needs: string[]; state: CardState; editable?: boolean };
export type WorkflowFlowNode = Node<ScopeData, 'workflow'>;
export type JobFlowNode = Node<JobData, 'job'>;
export type FlowNode = WorkflowFlowNode | JobFlowNode;

export type NeedsEdgeData = {
  from: Tri;
  deciding: boolean;
  label?: string;
  onPath: boolean;
  /** Off the selected job's dependency path while its workflow shows one, or not lit at both ends by a hover. */
  faded: boolean;
  /** In the workflow being edited: ✕ removes the need, while the edge is `hot`. */
  removable?: boolean;
  hot?: boolean;
  /** Written, and not in a picture yet: drawn dashed. */
  pending?: boolean;
};
export type NeedsFlowEdge = Edge<NeedsEdgeData, 'needs'>;

export interface Flow {
  nodes: FlowNode[];
  edges: NeedsFlowEdge[];
}

interface DependencyPath {
  scope: NodeId;
  jobs: Set<NodeId>;
  edges: Set<string>;
}

interface Context {
  model: GraphModel;
  layout: GraphLayout;
  view: FlowView;
  /** The node that holds the selection: a workflow, or the job card a selected leg or step lies in. */
  card?: NodeId;
  path?: DependencyPath;
  out: Flow;
}

interface Placement extends Size {
  position: Point;
  parentId?: NodeId;
}

export function toFlow(model: GraphModel, layout: GraphLayout, view: FlowView): Flow {
  const card = view.selected === undefined ? undefined : cardOf(model, view.selected);
  const ctx: Context = {
    model,
    layout,
    view,
    card,
    path: card === undefined ? undefined : dependencyPath(model, card),
    out: { nodes: [], edges: [] },
  };
  for (const id of model.roots) {
    const scope = model.scopes[id];
    const at = layout.roots[id];
    if (scope && at)
      emitScope(ctx, scope, { position: { x: at.x, y: at.y }, width: at.width, height: at.height });
  }
  const nodes = ctx.out.nodes;
  const stop = card !== undefined && nodes.some((n) => n.id === card) ? card : nodes[0]?.id;
  for (const n of nodes) n.domAttributes = { tabIndex: n.id === stop ? 0 : -1 };
  return ctx.out;
}

/** A workflow, then its jobs (each followed by the workflow it calls), then its edges. */
function emitScope(ctx: Context, scope: ScopeModel, place: Placement, faded = false): void {
  const caller = scope.caller === undefined ? undefined : ctx.model.jobs[scope.caller]?.label;
  ctx.out.nodes.push({
    id: scope.id,
    type: 'workflow',
    ...place,
    measured: { width: place.width, height: place.height },
    draggable: false,
    selected: ctx.card === scope.id,
    ariaLabel: scopeLabel(scope, caller),
    data: {
      scope,
      caller,
      state: stateOf(ctx, scope.id, faded ? 'off' : undefined),
      ...(scope.id === ctx.view.editing && !scope.collapsed ? { editable: true } : {}),
    },
  });
  const laid = scope.collapsed ? undefined : ctx.layout.scopes[scope.id];
  if (laid) emitInside(ctx, scope, laid, faded);
}

/** A laid-out workflow's jobs and the edges between the ones the layout placed. */
function emitInside(ctx: Context, scope: ScopeModel, laid: ScopeLayout, faded: boolean): void {
  const placed = new Set<NodeId>();
  for (const id of scope.jobs) {
    const job = ctx.model.jobs[id];
    const at = laid.positions[id];
    const size = ctx.layout.cards[id];
    if (!job || !at || !size) continue;
    emitJob(
      ctx,
      job,
      { position: at, parentId: scope.id, ...size },
      faded ? 'off' : pathOf(ctx, scope.id, id),
    );
    placed.add(id);
  }
  for (const e of scope.edges)
    if (placed.has(e.source) && placed.has(e.target)) ctx.out.edges.push(edgeOf(ctx, scope.id, e, faded));
  ctx.out.edges.push(...pendingEdges(ctx, scope, placed));
}

/** In the workflow being edited, the needs written since the picture between two cards it places, not drawn yet. */
function pendingEdges(ctx: Context, scope: ScopeModel, placed: ReadonlySet<NodeId>): NeedsFlowEdge[] {
  if (scope.id !== ctx.view.editing) return [];
  const drawn = new Set(scope.edges.map((e) => e.id));
  return (ctx.view.pending ?? []).flatMap(({ source, target }) => {
    const id = `${source}->${target}`;
    if (drawn.has(id) || !placed.has(source) || !placed.has(target)) return [];
    const data: NeedsEdgeData = { from: 'yes', deciding: false, onPath: false, faded: false, pending: true };
    return [
      { id: `pending:${id}`, type: 'needs', source, target, selectable: false, focusable: false, data },
    ];
  });
}

function emitJob(ctx: Context, job: JobModel, place: Placement, path: CardState['path']): void {
  const needs = job.needs.map((n) => ctx.model.jobs[n]?.label ?? n);
  ctx.out.nodes.push({
    id: job.id,
    type: 'job',
    ...place,
    measured: { width: place.width, height: place.height },
    handles: handlesOf(place.width),
    draggable: false,
    selected: ctx.card === job.id,
    ariaLabel: jobLabel(job, needs),
    data: {
      job,
      needs,
      state: stateOf(ctx, job.id, path),
      ...(job.scope === ctx.view.editing ? { editable: true } : {}),
    },
  });
  emitCallee(ctx, job, path === 'off');
}

/** base.css draws a handle 5 px square, centred on the card's edge; JobNode puts both on the header line. */
const HANDLE = 5;

/** Where JobNode's handles are, so an edge has its ends before React Flow measures the card. */
function handlesOf(width: number): NodeHandle[] {
  const y = CARD.header / 2 - HANDLE / 2;
  const box = { y, width: HANDLE, height: HANDLE };
  return [
    { type: 'target', position: Position.Left, x: -HANDLE / 2, ...box },
    { type: 'source', position: Position.Right, x: width - HANDLE / 2, ...box },
  ];
}

/** The workflow a call job's representative leg calls, inside its card; one line while it is collapsed. */
function emitCallee(ctx: Context, job: JobModel, faded: boolean): void {
  const callee = job.callee === undefined ? undefined : ctx.model.scopes[job.callee];
  const size = callee?.collapsed ? CARD.collapsed : callee && ctx.layout.scopes[callee.id];
  if (!callee || !size) return;
  const width = callee.collapsed ? size.width : Math.max(size.width, roomIn(ctx, job));
  const place = { position: calleeOffset(job), parentId: job.id, width, height: size.height };
  emitScope(ctx, callee, place, faded);
}

/** A callee is as wide as its card lets it be: a card widened for a remote's title bar widens the frame with it. */
const roomIn = (ctx: Context, job: JobModel): number =>
  (ctx.layout.cards[job.id]?.width ?? 0) - 2 * CARD.callPadding;

function stateOf(ctx: Context, id: NodeId, path: CardState['path']): CardState {
  const selected = ctx.card === id;
  const inner = selected && ctx.view.selected !== id ? ctx.view.selected : undefined;
  const { lit, flash } = ctx.view;
  return {
    selected,
    inner,
    path: lit ? litPath(lit, id) : path,
    hovered: ctx.view.hovered === id,
    flash: flash?.cards.has(id) ? flash.parity : undefined,
    added: flash?.ring.has(id) ? flash.parity : undefined,
  };
}

const litPath = (lit: ReadonlySet<NodeId>, id: NodeId): CardState['path'] => (lit.has(id) ? 'on' : 'off');

function pathOf(ctx: Context, scope: NodeId, job: NodeId): CardState['path'] {
  if (ctx.path?.scope !== scope) return undefined;
  return ctx.path.jobs.has(job) ? 'on' : 'off';
}

function edgeOf(ctx: Context, scope: NodeId, e: EdgeModel, faded: boolean): NeedsFlowEdge {
  const look = ctx.view.lit ? litEdge(ctx.view.lit, e) : pathEdge(ctx, scope, e, faded);
  const label = (id: NodeId): string => ctx.model.jobs[id]?.label ?? id;
  const removable = scope === ctx.view.editing;
  return {
    id: e.id,
    type: 'needs',
    source: e.source,
    target: e.target,
    selectable: false,
    focusable: removable,
    ariaLabel: needsLabel(label(e.source), label(e.target), e),
    data: {
      from: e.from,
      deciding: e.deciding,
      label: e.label,
      ...look,
      ...(removable ? { removable, hot: ctx.view.hotEdge === e.id } : {}),
    },
  };
}

type EdgeLook = Pick<NeedsEdgeData, 'onPath' | 'faded'>;

/** On the selected job's path, or faded off it or under a faded call job. */
function pathEdge(ctx: Context, scope: NodeId, e: EdgeModel, faded: boolean): EdgeLook {
  const onPath = !faded && (ctx.path?.edges.has(e.id) ?? false);
  return { onPath, faded: faded || (ctx.path?.scope === scope && !onPath) };
}

/** While a hover lights cards, an edge stays only between two lit ones; the path's accent waits for it to end. */
const litEdge = (lit: ReadonlySet<NodeId>, e: EdgeModel): EdgeLook => ({
  onPath: false,
  faded: !(lit.has(e.source) && lit.has(e.target)),
});

/** What a job needs and what needs it, transitively, in its workflow, and the edges on the way through it. */
function dependencyPath(model: GraphModel, card: NodeId): DependencyPath | undefined {
  const job = model.jobs[card];
  const scope = job && model.scopes[job.scope];
  if (!scope) return undefined;
  const up = reach(card, scope.edges, (e) => [e.target, e.source]);
  const down = reach(card, scope.edges, (e) => [e.source, e.target]);
  const through = (e: EdgeModel): boolean =>
    (up.has(e.source) && (e.target === card || up.has(e.target))) ||
    (down.has(e.target) && (e.source === card || down.has(e.source)));
  return {
    scope: scope.id,
    jobs: new Set([card, ...up, ...down]),
    edges: new Set(scope.edges.filter(through).map((e) => e.id)),
  };
}

/** The jobs reached from `start` along the edges, each edge read as `[from, to]` by `dir`. */
function reach(
  start: NodeId,
  edges: readonly EdgeModel[],
  dir: (e: EdgeModel) => [NodeId, NodeId],
): Set<NodeId> {
  const next = new Map<NodeId, NodeId[]>();
  for (const e of edges) {
    const [from, to] = dir(e);
    next.set(from, [...(next.get(from) ?? []), to]);
  }
  const seen = new Set<NodeId>();
  const queue = [start];
  for (let at = queue.pop(); at !== undefined; at = queue.pop())
    for (const n of next.get(at) ?? []) {
      if (n === start || seen.has(n)) continue;
      seen.add(n);
      queue.push(n);
    }
  return seen;
}

export interface Rect extends Point, Size {}

/** Whether a node's rectangle (flow coordinates) is not wholly inside the viewport the transform shows. */
export function outsideView(rect: Rect, transform: readonly [number, number, number], view: Size): boolean {
  const [tx, ty, zoom] = transform;
  const x = rect.x * zoom + tx;
  const y = rect.y * zoom + ty;
  return x < 0 || y < 0 || x + rect.width * zoom > view.width || y + rect.height * zoom > view.height;
}

const OWN_KEYS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A']);

export interface KeyPress extends NavKey {
  /** The element the key went to: read for its tag and whether it is editable, nothing else. */
  target: unknown;
  ctrlKey: boolean;
  metaKey: boolean;
}

/** Whether a key press is the canvas's: not typed into a field, not a button's own key, and no Ctrl or Meta. */
export function canvasKey(e: KeyPress): boolean {
  if (e.ctrlKey || e.metaKey) return false;
  const t = (e.target ?? {}) as { tagName?: string; isContentEditable?: boolean };
  return !t.isContentEditable && !OWN_KEYS.has((t.tagName ?? '').toUpperCase());
}

type Navigate = (
  key: NavKey,
  at: NodeId | undefined,
  model: GraphModel,
  layout: GraphLayout,
) => NavAction | undefined;

/**
 * What a key press on the canvas asks for, when it is the canvas's and a picture is on it. It acts from the
 * selection, or from the focused card when that card does not hold the selection (the URL moved it meanwhile), but
 * not while the keys are still moving the focus to the card they selected (`moving`): the focus follows a frame
 * later, and a key pressed before then goes on from the selection.
 */
export function keyAction(
  e: KeyPress,
  navigate: Navigate,
  selected: NodeId | undefined,
  graph: { model: GraphModel; layout: GraphLayout } | undefined,
  moving?: NodeId,
): NavAction | undefined {
  if (!graph || !canvasKey(e)) return undefined;
  const focused = nodeIdOf(e.target);
  const fromFocus =
    focused !== undefined && moving === undefined && holder(graph.model, selected) !== focused;
  return navigate(
    { key: e.key, altKey: e.altKey },
    fromFocus ? focused : selected,
    graph.model,
    graph.layout,
  );
}

/** The card that holds a selection: the node itself, or the job card a leg or a step is in. */
const holder = (model: GraphModel, selected: NodeId | undefined): NodeId | undefined =>
  selected === undefined ? undefined : cardOf(model, selected);

/** The canvas node an element is: React Flow's node element carries its id, anything inside it is not the node. */
export function nodeIdOf(el: unknown): NodeId | undefined {
  const e = el as {
    classList?: { contains(name: string): boolean };
    getAttribute?(name: string): string | null;
  };
  if (!e?.classList?.contains('react-flow__node')) return undefined;
  return e.getAttribute?.('data-id') ?? undefined;
}

/** The canvas edge an element is: React Flow's edge element carries its id. */
export function edgeIdOf(el: unknown): string | undefined {
  const e = el as {
    classList?: { contains(name: string): boolean };
    getAttribute?(name: string): string | null;
  };
  if (!e?.classList?.contains('react-flow__edge')) return undefined;
  return e.getAttribute?.('data-id') ?? undefined;
}

/** An edit key on the canvas: remove the selection, move the selected step, or take the focused edge's need away. */
export type EditKey = 'remove' | 'up' | 'down' | { source: NodeId; target: NodeId };

/**
 * What a key press on the canvas asks of the edit runtime (synthesis § 4.2): Delete or Backspace removes the need of
 * the focused edge, else the selection; Alt+↑ and Alt+↓ move the selected step. On a card, only the selection that
 * card holds, so a key never edits another node than the one the focus is on. Typed into a field, or with Ctrl or
 * Meta, it is none.
 */
export function editKey(
  e: KeyPress & { shiftKey?: boolean },
  model: GraphModel | undefined,
  selected: NodeId | undefined,
): EditKey | undefined {
  const key = keyOf(e);
  if (key === undefined) return undefined;
  const card = nodeIdOf(e.target);
  if (card !== undefined) return model && holder(model, selected) === card ? key : undefined;
  if (key !== 'remove') return undefined;
  const edge = edgeIdOf(e.target);
  if (edge === undefined) return 'remove';
  for (const scope of Object.values(model?.scopes ?? {})) {
    const found = scope.edges.find((x) => x.id === edge);
    if (found) return { source: found.source, target: found.target };
  }
  return undefined;
}

/** Delete or Backspace, Alt+↑ or Alt+↓, given to the canvas. */
function keyOf(e: KeyPress & { shiftKey?: boolean }): 'remove' | 'up' | 'down' | undefined {
  if (!canvasKey(e) || e.shiftKey) return undefined;
  if (e.altKey) return e.key === 'ArrowUp' ? 'up' : e.key === 'ArrowDown' ? 'down' : undefined;
  return e.key === 'Delete' || e.key === 'Backspace' ? 'remove' : undefined;
}

/** How focus came to a card: `keys` when the canvas keys put it there, `keyboard` when it shows a focus ring. */
export interface FocusCause {
  keys: boolean;
  keyboard: boolean;
}

/**
 * What focus arriving on a card asks for. Where the canvas keys put it, nothing more; any other focus (Tab, a click,
 * a screen reader) selects the card unless it holds the selection already, so the keys act on the card that has the
 * focus, and a keyboard focus brings it into view (React Flow's own pan on focus is off: it misplaces a card inside
 * a workflow).
 */
export function cardFocus(
  card: NodeId,
  selected: NodeId | undefined,
  model: GraphModel,
  cause: FocusCause,
): { select?: NodeId; centre?: NodeId } {
  if (cause.keys) return {};
  const select = holder(model, selected) === card ? {} : { select: card };
  return cause.keyboard ? { ...select, centre: card } : select;
}

/**
 * The new flow with each node and edge that did not change replaced by the object it was before, and the old lists
 * when nothing changed, so React Flow keeps its internal nodes and the node components' memo holds.
 */
export function keepUnchanged(prev: Flow | undefined, next: Flow): Flow {
  if (!prev) return next;
  return { nodes: kept(prev.nodes, next.nodes), edges: kept(prev.edges, next.edges) };
}

function kept<T extends { id: string }>(before: T[], now: T[]): T[] {
  const old = new Map(before.map((x) => [x.id, x]));
  const list = now.map((x) => {
    const was = old.get(x.id);
    return was !== undefined && same(was, x, 3) ? was : x;
  });
  return list.length === before.length && list.every((x, i) => x === before[i]) ? before : list;
}

/** Whether two values match: objects and arrays key by key down to `depth` levels, by identity below that. */
function same(a: unknown, b: unknown, depth: number): boolean {
  if (Object.is(a, b)) return true;
  if (depth === 0 || typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = Object.keys(x);
  return keys.length === Object.keys(y).length && keys.every((k) => same(x[k], y[k], depth - 1));
}

/** What the canvas does for each of `navigate()`'s answers. */
export interface NavEffects {
  /** `undefined` selects the focused workflow. */
  select: (id: NodeId | undefined) => void;
  toggle: (job: NodeId) => void;
  fit: () => void;
  centre: (id: NodeId) => void;
  actualSize: () => void;
  /** Focus leaves the canvas. */
  leave: () => void;
}

export function runNav(action: NavAction, fx: NavEffects): void {
  if ('select' in action) fx.select(action.select);
  else if ('toggle' in action) fx.toggle(action.toggle);
  else if ('centre' in action) fx.centre(action.centre);
  else if ('fit' in action) fx.fit();
  else if ('actualSize' in action) fx.actualSize();
  else fx.leave();
}
