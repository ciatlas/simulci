import { useEffect, useState } from 'react';
import { fetchOnce } from '../lib/lazy';
import type { OutlineInput } from '../worker/protocol';

/**
 * The bundled action catalog (synthesis § 4.8): the commonest actions, each at the ref an author would write today, the
 * commit that ref pointed at when the catalog was built, and its interface. `scripts/build-catalog.mjs` writes
 * `catalog/catalog.json`, which the build puts in a chunk of its own (`catalog-*`): it is fetched from the app's own
 * origin as a script the first time the palette or Properties asks, so nothing is ever fetched from GitHub
 * (no `connect-src` is needed).
 */

export interface CatalogAction {
  /** `owner/repo[/path]`, as `uses:` names it before the `@`. */
  uses: string;
  /** The tag or branch to write: `v5`, `v2.4.3`, `release/v1`. */
  ref: string;
  /** The commit `ref` pointed at when the catalog was built: what Pin to SHA writes. */
  sha: string;
  name: string;
  description?: string;
  inputs: CatalogInput[];
  outputs: string[];
  /** Its repository's SPDX licence; descriptions are dropped unless it is permissive. */
  license: string | null;
}

interface CatalogInput {
  id: string;
  required: boolean;
  default?: string;
  deprecated?: boolean;
  description?: string;
}

type Catalog = readonly CatalogAction[];

/** An input a step may pass, as With rows show it: an action's own (Outline) or the catalog's, which may be deprecated. */
export type DeclaredInput = OutlineInput & { deprecated?: boolean };

const loadCatalog = fetchOnce(() =>
  import('../catalog/catalog.json').then((m) => m.default as unknown as Catalog),
);

let loaded: Catalog | undefined;

/**
 * The catalog once its chunk is in, fetched on the first ask (`want`); `failed` when the fetch failed (the app was
 * redeployed under an open page). A component that asks again after a failure fetches again.
 */
export function useCatalog(want = true): { catalog?: Catalog; failed?: true } {
  const [state, setState] = useState<{ catalog?: Catalog; failed?: true }>(() =>
    loaded ? { catalog: loaded } : {},
  );
  useEffect(() => {
    let live = want && !state.catalog;
    if (live)
      loadCatalog().then(
        (catalog) => {
          loaded = catalog;
          if (live) setState({ catalog });
        },
        () => {
          if (live) setState({ failed: true });
        },
      );
    return () => {
      live = false;
    };
  }, [want, state.catalog]);
  return state;
}

/** A `uses:` as its action and ref: `actions/checkout@v4` → `actions/checkout`, `v4`. */
export function splitUses(uses: string): { name: string; ref?: string } {
  const at = uses.startsWith('docker://') || uses.startsWith('./') ? -1 : uses.lastIndexOf('@');
  return at <= 0 ? { name: uses } : { name: uses.slice(0, at), ref: uses.slice(at + 1) };
}

/** The catalog's entry for an action, whatever the case of its owner and repository (GitHub ignores it). */
export function catalogAction(catalog: Catalog | undefined, name: string): CatalogAction | undefined {
  const key = name.toLowerCase();
  return catalog?.find((a) => a.uses.toLowerCase() === key);
}

/** A catalog action's inputs as With rows take them. */
export function catalogInputs(action: CatalogAction): DeclaredInput[] {
  return action.inputs.map((i) => ({
    name: i.id,
    required: i.required,
    ...(i.default === undefined ? {} : { default: i.default }),
    ...(i.description === undefined ? {} : { description: i.description }),
    ...(i.deprecated ? { deprecated: true } : {}),
  }));
}

/** An input the step must set: required, and with no default to stand in. */
export const mustSet = (input: { required: boolean; default?: unknown }): boolean =>
  input.required && input.default === undefined;
