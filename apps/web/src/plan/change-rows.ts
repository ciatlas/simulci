import type { NodeId, Tri } from '@simulci/engine';
import type { CheckVerdict, DiffKind, PlanDiff } from '@simulci/engine/plan';
import { listed } from '../lib/words';
import { labelsOf, NAMED, type Planned, UNIT, WORKFLOW } from './changes';
import { type IndexedNode, type PlanIndex, planIndex } from './index';

/**
 * What a pin or an edit changed, row by row (synthesis § 7.4): every node the diff adds, removes or turns, and every
 * check name it adds, removes or turns, for the Details popover, the status line's sentence and the cards that flash
 * or get the added ring. A step's id follows its name, so a step renamed in place is one step, not one removed and
 * one added. A check that a workflow or job row already says (the checks of a job added, removed or turned) is
 * implied: Details lists it, the sentence does not.
 */

export type RowKind = DiffKind | 'check';

/** The verdicts of a row: the one it has once added, the one it had before it went, or both. */
type Verdicts =
  | { change: 'added'; to: Tri }
  | { change: 'removed'; from: Tri }
  | { change: 'changed'; from: Tri; to: Tri };

export type ChangeRow = Verdicts & {
  kind: RowKind;
  /** The node's label (`deploy`, `CI`, `build.#3`, `deploy in CI`), or the check's name. */
  label: string;
  /** The node, or the node that reports the check, in the plan that has it: the plan before, for a removed row. */
  id: NodeId;
  /** The node of the plan after whose card shows the row: itself, else the nearest ancestor of a removed one. */
  card?: NodeId;
  /** Where Details selects it, when the plan after has it: its depth-0 workflow and its unit path. */
  select?: { focus: string; sel?: string };
  /** Said already by a workflow or job row above it: Details lists it, the sentence leaves it out. */
  implied?: true;
};

/** A node row before its label: the node as the plan that has it indexes it. */
type NodeEntry = Verdicts & { kind: DiffKind; node: IndexedNode };

/**
 * The rows of a diff of `before` and `after`, in the order Details lists them: nodes turned, added and removed, each
 * in plan order, then check names removed, added and turned.
 */
export function changeRows(diff: PlanDiff, before: Planned, after: Planned): ChangeRow[] {
  const was = planIndex(before);
  const now = planIndex(after);
  const entries = samePlace([
    ...diff.changed.flatMap((c) =>
      entry(now, c.id, { change: 'changed', kind: c.kind, from: c.from, to: c.to }),
    ),
    ...diff.added.flatMap((a) => entry(now, a.id, { change: 'added', kind: a.kind, to: a.verdict })),
    ...diff.removed.flatMap((r) => entry(was, r.id, { change: 'removed', kind: r.kind, from: r.verdict })),
  ]);
  const shown = entries.filter((e) => e.change !== 'removed');
  const gone = entries.filter((e) => e.change === 'removed');
  const nodes = [...labelled(shown, after, now, now), ...labelled(gone, before, was, now)];
  const said = new Set(nodes.filter((r) => r.kind === 'workflow' || r.kind === 'job').map((r) => r.id));
  return [...nodes, ...checkRows(was, now, said)];
}

const entry = (index: PlanIndex, id: NodeId, verdicts: Verdicts & { kind: DiffKind }): NodeEntry[] => {
  const node = index.nodes.get(id);
  return node ? [{ ...verdicts, node }] : [];
};

/**
 * A step renamed in place: removed and added at one unit path of one workflow (`build.#3`), since its id follows its
 * name. The pair is that step turned when its verdict changed, and nothing when it did not.
 */
function samePlace(entries: readonly NodeEntry[]): NodeEntry[] {
  const removed = new Map<string, Removed>();
  for (const e of entries) {
    const place = placeOf(e);
    if (e.change === 'removed' && place !== undefined) removed.set(place, e);
  }
  const paired = new Set<NodeEntry>();
  const pair = (e: NodeEntry): NodeEntry[] => {
    const gone = e.change === 'added' ? removed.get(placeOf(e) ?? '') : undefined;
    if (e.change !== 'added' || !gone || paired.has(gone)) return [e];
    paired.add(gone);
    return gone.from === e.to
      ? []
      : [{ kind: e.kind, node: e.node, change: 'changed', from: gone.from, to: e.to }];
  };
  return entries.flatMap(pair).filter((e) => !paired.has(e));
}

type Removed = Extract<NodeEntry, { change: 'removed' }>;

const placeOf = (e: NodeEntry): string | undefined =>
  e.kind === 'step' && e.node.unitPath !== undefined ? `${e.node.workflow}\n${e.node.unitPath}` : undefined;

/** The entries as rows, labelled within the plan that has them and placed in the plan after. */
function labelled(
  entries: readonly NodeEntry[],
  planned: Planned,
  index: PlanIndex,
  now: PlanIndex,
): ChangeRow[] {
  const labels = labelsOf(
    entries.map((e) => e.node),
    planned.plan,
  );
  return entries.map(({ node, ...e }, i) => ({
    ...e,
    label: labels[i]!,
    id: node.id,
    ...placed(node.id, index, now),
  }));
}

/** Where a node of `index` is in the plan after: its card's node, and itself to select when that plan has it. */
function placed(id: NodeId, index: PlanIndex, now: PlanIndex): Pick<ChangeRow, 'card' | 'select'> {
  const here = now.nodes.get(id);
  if (here)
    return {
      card: id,
      select: { focus: here.workflow, ...(here.unitPath === undefined ? {} : { sel: here.unitPath }) },
    };
  for (let at = index.nodes.get(id)?.parent; at !== undefined; at = index.nodes.get(at)?.parent)
    if (now.nodes.has(at)) return { card: at };
  return {};
}

/**
 * The check names removed, added and turned, each with the node that reports it. Checks are paired as `diffPlans`
 * pairs them, the k-th of a name with the k-th of that name, so a second `build` is an added one.
 */
function checkRows(was: PlanIndex, now: PlanIndex, said: ReadonlySet<NodeId>): ChangeRow[] {
  const row = (c: CheckVerdict, index: PlanIndex, verdicts: Verdicts): ChangeRow => ({
    ...verdicts,
    kind: 'check',
    label: c.name,
    id: c.node,
    ...placed(c.node, index, now),
    ...(underAny(index, c.node, said) ? { implied: true } : {}),
  });
  const before = byName(was.checks);
  const after = byName(now.checks);
  const removed = ordinals(was.checks)
    .filter(([c, k]) => !after.get(c.name)?.[k])
    .map(([c]) => row(c, was, { change: 'removed', from: c.runs }));
  const paired = ordinals(now.checks).map(([c, k]) => ({ c, old: before.get(c.name)?.[k] }));
  const added = paired.filter(({ old }) => !old).map(({ c }) => row(c, now, { change: 'added', to: c.runs }));
  const turned = paired.flatMap(({ c, old }) =>
    old && old.runs !== c.runs ? [row(c, now, { change: 'changed', from: old.runs, to: c.runs })] : [],
  );
  return [...removed, ...added, ...turned];
}

/** The checks of each name, in plan order. */
function byName(checks: readonly CheckVerdict[]): Map<string, CheckVerdict[]> {
  const out = new Map<string, CheckVerdict[]>();
  for (const c of checks) out.set(c.name, [...(out.get(c.name) ?? []), c]);
  return out;
}

/** Each check with its place among the checks of its name: 0 for the first `build`, 1 for the second. */
function ordinals(checks: readonly CheckVerdict[]): [CheckVerdict, number][] {
  const seen = new Map<string, number>();
  return checks.map((c) => {
    const k = seen.get(c.name) ?? 0;
    seen.set(c.name, k + 1);
    return [c, k];
  });
}

/** Whether the node or one of its ancestors is among `ids`. */
function underAny(index: PlanIndex, id: NodeId, ids: ReadonlySet<NodeId>): boolean {
  for (let at: NodeId | undefined = id; at !== undefined; at = index.nodes.get(at)?.parent)
    if (ids.has(at)) return true;
  return false;
}

const NEW_WORKFLOW: Record<Tri, string> = {
  yes: 'is triggered',
  no: 'is not triggered',
  maybe: 'might be triggered',
};
const NEW_UNIT: Record<Tri, string> = { yes: 'runs', no: 'is skipped', maybe: 'might run' };

/** A row in words: `deploy is now skipped`, `new job lint runs`, `job lint removed`, `check 'Deploy' removed`. */
export function clauseOf(row: ChangeRow): string {
  if (row.kind === 'check')
    return `check '${row.label}' ${row.change === 'changed' ? UNIT[row.to] : row.change}`;
  if (row.change === 'removed') return `${row.kind} ${row.label} removed`;
  if (row.change === 'changed') return `${row.label} ${(row.kind === 'workflow' ? WORKFLOW : UNIT)[row.to]}`;
  return `new ${row.kind} ${row.label} ${(row.kind === 'workflow' ? NEW_WORKFLOW : NEW_UNIT)[row.to]}`;
}

/** The kinds the sentence names; steps and legs are only counted there, and named in Details. */
const NAMED_KINDS: ReadonlySet<RowKind> = new Set(['workflow', 'job', 'check']);

/**
 * What the status line says of an edit (synthesis § 7.4): what the author did, then the workflows and jobs added,
 * removed or turned and the check names added, removed or turned, up to three, then how many more Details has. A
 * renamed check is the classic required-check footgun, so check names are named like jobs. "Changed push branches:
 * CI is no longer triggered", "Edited ci.yml: new job lint runs; 2 more in Details", "Undo Typed in ci.yml: no
 * verdict changed".
 */
export function changeSentence(rows: readonly ChangeRow[], label: string): string {
  const said = rows.filter((r) => !r.implied);
  const named = said
    .filter((r) => NAMED_KINDS.has(r.kind))
    .slice(0, NAMED)
    .map(clauseOf);
  const rest = said.length - named.length;
  if (named.length) return `${label}: ${listed(named)}${rest > 0 ? `; ${rest} more in Details` : ''}`;
  if (rest > 0) return `${label}: ${rest} ${rest === 1 ? 'change' : 'changes'} in Details`;
  return `${label}: no verdict changed`;
}
