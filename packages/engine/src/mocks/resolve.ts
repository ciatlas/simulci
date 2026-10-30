import type { ActionModel, ModelContext } from '../models/types';
import {
  type Location,
  parseUnitPath,
  pathMatches,
  pathSpecificity,
  type UnitPath,
  UnitPathError,
  workflowMatches,
} from '../paths';
import type { Diagnostic, MockRef, NodeId, Result, Value } from '../plan/types';
import { known, unknown } from '../plan/values';
import type { AssumeEntry, AssumeLayer, MockLayers, MockValue } from './schema';

/**
 * Which mock decides each field of a unit. Layers closest to the test win (cli > case > given); within a layer the
 * entry naming more of the unit wins (a step over a job over a `uses:` pattern, then more matrix keys, a deeper path,
 * an explicit workflow); two entries of equal rank with different values conflict. Resolution is per field, so a
 * partial entry composes with others.
 */

export interface CompiledEntry {
  ref: MockRef;
  layer: AssumeLayer;
  index: number;
  entry: AssumeEntry;
  path?: UnitPath;
  /** The `uses:` pattern, lower-cased, with or without `@ref`. */
  uses?: { repo: string; ref?: string };
  rank: number;
  /** The nodes the entry was applied to; empty at the end means it matched nothing (SC102). */
  matched: NodeId[];
}

/** A value and the mock that stated it. */
export interface Fact<T> {
  value: Value<T>;
  by: MockRef;
}

export interface Facts {
  outcome?: Fact<Result>;
  outputs: Record<string, Fact<string>>;
  env: Record<string, Fact<string>>;
}

/** A shipped model at a step, with what it sees. */
export interface ModelUse {
  model: ActionModel;
  ctx: ModelContext;
}

interface Candidate {
  compiled: CompiledEntry;
  /** The entry with its `as:` preset folded in. */
  entry: AssumeEntry;
}

type Shipped = Pick<Facts, 'outcome' | 'outputs'>;

const LAYER_ORDER: AssumeLayer[] = ['given', 'case', 'cli'];

export class MockResolver {
  readonly entries: CompiledEntry[] = [];
  readonly diagnostics: Diagnostic[] = [];
  private readonly reported = new Set<MockRef>();

  constructor(layers: MockLayers) {
    for (const layer of LAYER_ORDER) {
      for (const [index, entry] of (layers[layer] ?? []).entries())
        this.entries.push(this.compile(entry, layer, index));
    }
  }

  private compile(entry: AssumeEntry, layer: AssumeLayer, index: number): CompiledEntry {
    const ref = `${layer === 'case' ? 'assume' : layer}[${index}]`;
    const compiled: CompiledEntry = { ref, layer, index, entry, rank: 0, matched: [] };
    const path = this.compilePath(entry, ref);
    if (path) compiled.path = path;
    if (entry.uses !== undefined) compiled.uses = compileUses(entry.uses);
    compiled.rank = rankOf(entry, compiled.path, compiled.uses);
    return compiled;
  }

  /** The unit path of a `step:` or `job:` entry (a `uses:` entry's `job:` is its scope), with `workflow:` and `matrix:` folded in. */
  private compilePath(entry: AssumeEntry, ref: MockRef): UnitPath | undefined {
    const text = entry.step ?? entry.job;
    if (text === undefined) return undefined;
    try {
      const path = parseUnitPath(text);
      if (entry.workflow !== undefined) path.workflow = entry.workflow;
      if (entry.matrix) addLeg(path, entry.matrix);
      return path;
    } catch (e) {
      if (!(e instanceof UnitPathError)) throw e;
      this.diagnostics.push({ severity: 'error', code: 'SC100', message: `${ref}: ${e.message}`, mock: ref });
      return undefined;
    }
  }

  /** The entries that name the unit at `location` (a step with its `uses:`, or a job). */
  candidates(location: Location, node: NodeId, uses?: string): CompiledEntry[] {
    const out = this.entries.filter((c) => namesUnit(c, location, uses));
    for (const c of out) c.matched.push(node);
    return out;
  }

  /** The facts the mocks state for the unit, field by field; a shipped model is the layer under them all. */
  factsFor(location: Location, node: NodeId, uses?: string, use?: ModelUse): Facts {
    const candidates = this.candidates(location, node, uses).map((compiled): Candidate => ({
      compiled,
      entry: this.effective(compiled, node, use),
    }));
    const shipped = use ? shippedFacts(use) : undefined;
    const facts: Facts = { outputs: {}, env: {} };
    if (!candidates.length && !shipped) return facts;
    const outcome =
      this.pick(candidates, node, 'outcome', (e) =>
        e.outcome === undefined ? undefined : known<Result>(e.outcome),
      ) ?? shipped?.outcome;
    if (outcome) facts.outcome = outcome;
    facts.outputs = this.pickRecord(candidates, node, 'outputs', shipped?.outputs);
    facts.env = this.pickRecord(candidates, node, 'env');
    return facts;
  }

  /** One group of named fields: the author's layers decide each name, else the model's. */
  private pickRecord(
    candidates: Candidate[],
    node: NodeId,
    field: 'outputs' | 'env',
    shipped: Record<string, Fact<string>> = {},
  ): Record<string, Fact<string>> {
    const out: Record<string, Fact<string>> = {};
    for (const name of names(candidates, field, shipped)) {
      const v =
        this.pick(candidates, node, `${field}.${name}`, (e) =>
          mockValue(e[field]?.[name], `${node}.${field}.${name}`),
        ) ?? shipped[name];
      if (v) out[name] = v;
    }
    return out;
  }

  /** The entry with its `as:` preset resolved against the unit's model: the preset's facts under the entry's own. */
  private effective(c: CompiledEntry, node: NodeId, use: ModelUse | undefined): AssumeEntry {
    const { entry } = c;
    if (entry.as === undefined) return entry;
    const preset = use?.model.preset(entry.as, use.ctx);
    if (!preset) {
      this.reportPreset(c, node, use);
      return entry;
    }
    const merged: AssumeEntry = { ...entry, outputs: { ...preset.outputs, ...entry.outputs } };
    const outcome = entry.outcome ?? preset.outcome;
    if (outcome !== undefined) merged.outcome = outcome;
    return merged;
  }

  /** An `as:` that names no preset of the unit's model, or a unit without one (SC105), once per entry. */
  private reportPreset(c: CompiledEntry, node: NodeId, use: ModelUse | undefined): void {
    if (this.reported.has(c.ref)) return;
    this.reported.add(c.ref);
    const what = use
      ? `${use.model.id} (presets: ${use.model.presets.join(', ') || 'none'})`
      : 'a unit without a model';
    this.diagnostics.push({
      severity: 'error',
      code: 'SC105',
      message: `${c.ref}: as '${c.entry.as}' names no preset of ${what}`,
      node,
      mock: c.ref,
    });
  }

  /** The value of one field from the closest layer's best-ranked entries; equal rank and different values conflict (SC103). */
  private pick<T>(
    candidates: Candidate[],
    node: NodeId,
    field: string,
    read: (e: AssumeEntry) => Value<T> | undefined,
  ): { value: Value<T>; by: MockRef } | undefined {
    for (const layer of LAYER_ORDER.toReversed()) {
      const providing = candidates.filter((c) => c.compiled.layer === layer && read(c.entry) !== undefined);
      if (!providing.length) continue;
      const top = Math.max(...providing.map((c) => c.compiled.rank));
      const best = providing.filter((c) => c.compiled.rank === top);
      const values = best.map((c) => ({ by: c.compiled.ref, value: read(c.entry)! }));
      const distinct = new Set(values.map((v) => JSON.stringify(v.value)));
      if (distinct.size > 1) {
        this.diagnostics.push({
          severity: 'error',
          code: 'SC103',
          message: `${best.map((c) => c.compiled.ref).join(' and ')} both set ${field} of ${node} to different values`,
          node,
          mock: best[0]!.compiled.ref,
        });
        return { value: unknown<T>([`conflict:${node}.${field}`]), by: best[0]!.compiled.ref };
      }
      return values[0]!;
    }
    return undefined;
  }

  /** Entries that matched nothing, after the plan (SC102). */
  unmatched(): CompiledEntry[] {
    return this.entries.filter((c) => c.matched.length === 0);
  }
}

function compileUses(uses: string): { repo: string; ref?: string } {
  const at = uses.indexOf('@');
  return at === -1
    ? { repo: uses.toLowerCase() }
    : { repo: uses.slice(0, at).toLowerCase(), ref: uses.slice(at + 1).toLowerCase() };
}

/** step > job > uses+job > uses, then what the path names, then a pinned `@ref`. */
function rankOf(entry: AssumeEntry, path: UnitPath | undefined, uses: { ref?: string } | undefined): number {
  const kind =
    entry.step !== undefined ? 3000 : entry.uses === undefined ? 2000 : entry.job !== undefined ? 1000 : 0;
  return kind + (path ? pathSpecificity(path) : 0) + (uses?.ref === undefined ? 0 : 5);
}

function addLeg(path: UnitPath, matrix: Record<string, string | number | boolean>): void {
  const last = path.segments.at(-1)!;
  last.leg = { ...last.leg, ...Object.fromEntries(Object.entries(matrix).map(([k, v]) => [k, String(v)])) };
}

/** Whether an entry names the unit: a step entry a step, a job entry a job, a uses entry a step or a calling job using what it names. */
function namesUnit(c: CompiledEntry, location: Location, uses: string | undefined): boolean {
  const isStep = location.chain.at(-1)?.kind === 'step';
  if (c.entry.uses !== undefined) return usesEntryNames(c, location, isStep, uses);
  if (!c.path) return false;
  return (c.entry.step !== undefined) === isStep && pathMatches(c.path, location);
}

function usesEntryNames(
  c: CompiledEntry,
  location: Location,
  isStep: boolean,
  uses: string | undefined,
): boolean {
  if (uses === undefined || !usesMatches(c.uses!, uses)) return false;
  if (c.entry.workflow !== undefined && !workflowMatches(c.entry.workflow, location.workflow)) return false;
  // The `job:` scope is a step's job, or the calling job itself.
  const chain = isStep ? location.chain.slice(0, -1) : location.chain;
  return !c.path || pathMatches(c.path, { workflow: location.workflow, chain });
}

/** What a shipped model produces at the unit, as the layer under the author's. */
function shippedFacts(use: ModelUse): Shipped {
  const by = `model:${use.model.id}`;
  const product = use.model.produce(use.ctx);
  const outputs = Object.fromEntries(
    Object.entries(product.outputs).map(([name, value]) => [name, { value, by }]),
  );
  return product.outcome ? { outcome: { value: product.outcome, by }, outputs } : { outputs };
}

/** The field names any layer states: the model's first, in its order, then the author's. */
function names(
  candidates: Candidate[],
  field: 'outputs' | 'env',
  shipped: Record<string, unknown> = {},
): string[] {
  return [
    ...new Set([...Object.keys(shipped), ...candidates.flatMap((c) => Object.keys(c.entry[field] ?? {}))]),
  ];
}

function mockValue(v: MockValue | undefined, unknownId: string): Value<string> | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'object') return unknown([unknownId]);
  return known(typeof v === 'string' ? v : String(v));
}

/** `actions/cache` matches `actions/cache@v4`, `actions/cache/restore@v4`; `actions/cache@v4` matches that ref only. */
export function usesMatches(pattern: { repo: string; ref?: string }, uses: string): boolean {
  const text = uses.trim().toLowerCase();
  const at = text.indexOf('@');
  const repo = at === -1 ? text : text.slice(0, at);
  const ref = at === -1 ? undefined : text.slice(at + 1);
  if (repo !== pattern.repo && !repo.startsWith(`${pattern.repo}/`)) return false;
  return pattern.ref === undefined || pattern.ref === ref;
}
