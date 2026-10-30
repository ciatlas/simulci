import type { Json, NodeId, RemoteUse, RunPlan } from './types';

/**
 * The canonical form of a plan, for snapshots and fingerprints: no engine version, `$schema`, positions, reads or
 * pin flags; jobs sorted by id and object keys sorted, so two plans of the same behaviour serialize alike. The
 * snapshot profile also folds matrix legs that are identical apart from their key into `sameAs` entries, and leaves
 * out where a remote was read (its commit, pin and host), so a lockfile bump that changes no behaviour changes no
 * snapshot.
 */

export type CanonicalProfile = 'snapshot' | 'hash';

const DROP_AT_ROOT = new Set(['engine', '$schema']);
const DROP_EVERYWHERE = new Set(['loc', 'reads']);
/** In the snapshot profile: of each `remotes[]` entry, and of a called remote workflow's `remote`. */
const SNAPSHOT_DROPS = new Map([
  ['remotes', new Set(['sha', 'pinned', 'host'])],
  ['remote', new Set(['sha'])],
]);

export function canonicalize(plan: RunPlan, profile: CanonicalProfile): Json {
  const root = plan as unknown as Record<string, Json>;
  const out: Record<string, Json> = {};
  for (const key of Object.keys(root).sort()) {
    if (DROP_AT_ROOT.has(key)) continue;
    out[key] = walk(root[key] as Json, key, profile);
  }
  return out;
}

function walk(value: Json, key: string, profile: CanonicalProfile): Json {
  if (Array.isArray(value)) return walkArray(value, key, profile);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, Json> = {};
  for (const k of Object.keys(value).sort()) {
    if (dropped(key, k, profile)) continue;
    out[k] = walk(value[k] as Json, k, profile);
  }
  return out;
}

/** Whether the canonical form leaves out field `k` of an object under `key`. */
const dropped = (key: string, k: string, profile: CanonicalProfile): boolean =>
  DROP_EVERYWHERE.has(k) ||
  (key === 'pin' && k === 'flag') ||
  (profile === 'snapshot' && SNAPSHOT_DROPS.get(key)?.has(k) === true);

function walkArray(value: Json[], key: string, profile: CanonicalProfile): Json[] {
  let items = value.map((v) => walk(v, key, profile));
  if (key === 'jobs') items = sortBy(items, 'jobId');
  if (key === 'legs' && profile === 'snapshot') items = foldLegs(items as Record<string, Json>[]);
  return items;
}

const keyText = (v: Json | undefined): string => (typeof v === 'string' ? v : JSON.stringify(v ?? ''));

function sortBy(items: Json[], field: string): Json[] {
  return [...items].sort((a, b) => {
    const x = keyText((a as Record<string, Json>)[field]);
    const y = keyText((b as Record<string, Json>)[field]);
    return x.localeCompare(y);
  });
}

/** What names a leg rather than describing its behaviour: left out of the comparison, kept on a folded entry. */
const LEG_IDENTITY = new Set(['id', 'legKey', 'values', 'check']);

/** Legs that behave identically once their `[legKey]` is masked keep only what names them, and point at the first. */
function foldLegs(legs: Record<string, Json>[]): Json[] {
  const seen = new Map<string, string>();
  return legs.map((leg) => {
    const legKey = typeof leg.legKey === 'string' ? leg.legKey : '';
    if (legKey === '') return leg;
    const behaviour = Object.fromEntries(Object.entries(leg).filter(([k]) => !LEG_IDENTITY.has(k)));
    const masked = JSON.stringify(behaviour).split(`[${legKey}]`).join('[*]');
    const first = seen.get(masked);
    if (first === undefined) {
      seen.set(masked, legKey);
      return leg;
    }
    const folded: Record<string, Json> = { legKey, sameAs: first };
    if (leg.values !== undefined) folded.values = leg.values;
    if (leg.check !== undefined) folded.check = leg.check;
    return folded;
  });
}

/** The plan reduced to one depth-0 workflow: its tree, and the unknowns, mocks and diagnostics under it. */
export function restrictPlan(plan: RunPlan, workflow: NodeId): RunPlan {
  const under = (id: string | undefined): boolean =>
    id !== undefined && (id === workflow || id.startsWith(`${workflow}#`) || id.startsWith(`${workflow}>`));
  const { remotes, ...rest } = plan;
  const kept: RemoteUse[] = [];
  for (const r of remotes ?? []) {
    const at = r.at.filter(under);
    if (at.length) kept.push({ ...r, at });
  }
  return {
    ...rest,
    workflows: plan.workflows.filter((w) => w.id === workflow),
    unknowns: plan.unknowns.filter((u) => under(u.id) || under(u.producer) || u.affects.some(under)),
    mocks: plan.mocks.filter((m) => under(m.at)),
    ...(kept.length ? { remotes: kept } : {}),
    diagnostics: plan.diagnostics.filter((d) => under(d.node) || d.node === undefined),
  };
}

/** A stable 32-bit FNV-1a fingerprint of the plan's hash form, as eight hex digits. */
export function planFingerprint(plan: RunPlan): string {
  const text = JSON.stringify(canonicalize(plan, 'hash'));
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
