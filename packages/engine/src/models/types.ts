import type { NodeId, Result, Value } from '../plan/types';
import type { Scenario } from '../scenario';

/**
 * A shipped action model: what a well-known action produces, decided from the scenario and the step's `with:`.
 * Models are pure and versioned; a config entry with the same `uses:` layers over them.
 */

export interface ModelContext {
  scenario: Scenario;
  with: Record<string, Value<string>>;
  /** The `@ref` of the `uses:`, when written. */
  ref?: string;
  /** The commit a host read the action at, when it read it. */
  sha?: string;
  node: NodeId;
}

export interface ModelInterface {
  names: string[];
  /** The action may set outputs beyond `names`. */
  open: boolean;
}

export interface ModelProduct {
  outputs: Record<string, Value<string>>;
  outcome?: Value<Result>;
}

/** What a step or job can produce on its own; `skipped` is derived, never produced. */
export type Outcome = Exclude<Result, 'skipped'>;

export interface PresetFacts {
  outputs?: Record<string, string>;
  outcome?: Outcome;
}

export interface ActionModel {
  id: string;
  version: string;
  matches(uses: string): boolean;
  /** Named cases an author picks with `as:` (`hit`, `miss`). */
  presets: string[];
  preset(name: string, ctx: ModelContext): PresetFacts | undefined;
  interface(ctx: ModelContext): ModelInterface;
  produce(ctx: ModelContext): ModelProduct;
}

/** `owner/repo` or a sub-action of it, whatever the ref. */
export function usesRepo(uses: string): string {
  const text = uses.trim().toLowerCase();
  const at = text.indexOf('@');
  return at === -1 ? text : text.slice(0, at);
}

export const matchesRepo = (repo: string, uses: string): boolean => {
  const u = usesRepo(uses);
  return u === repo || u.startsWith(`${repo}/`);
};

/** A `with:` value when it is known, else undefined. */
export function knownWith(ctx: ModelContext, name: string): string | undefined {
  const v = ctx.with[name];
  return v?.known ? v.value : undefined;
}
