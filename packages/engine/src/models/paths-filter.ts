import { parse } from 'yaml';
import type { Value } from '../plan/types';
import { known, unknown } from '../plan/values';
import type { ChangedFile, ChangeStatus } from '../scenario';
import { anyMatcher, changedFiles } from './changes';
import { type ActionModel, knownWith, type ModelContext, matchesRepo } from './types';

/**
 * `dorny/paths-filter`: one output per filter, `'true'` when any changed file matches one of its patterns (each
 * pattern on its own, so a `!pattern` adds the files it does not name rather than excluding), and `changes`, the
 * JSON list of the filters that matched. `filters` is YAML: a pattern, a list of patterns, or a list of
 * `status: pattern` objects (`added|modified|deleted`); its `action.yml` declares only `changes`. A `filters` that
 * names a file is opaque.
 */

type Filter = { patterns: string[]; statuses?: ChangeStatus[] }[];

const STATUS: Record<string, ChangeStatus[]> = {
  added: ['added'],
  modified: ['modified'],
  deleted: ['removed'],
  renamed: ['renamed'],
};

function parseFilters(ctx: ModelContext): Record<string, Filter> | undefined {
  const text = knownWith(ctx, 'filters');
  if (text === undefined || !text.includes(':')) return undefined;
  let doc: unknown;
  try {
    // Errors only: yaml prints a warning to stderr, quoting the line, and this text may be another repository's.
    doc = parse(text, { logLevel: 'error' });
  } catch {
    return undefined;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return undefined;
  const out: Record<string, Filter> = {};
  for (const [name, value] of Object.entries(doc as Record<string, unknown>)) out[name] = parseFilter(value);
  return out;
}

function parseFilter(value: unknown): Filter {
  const items = Array.isArray(value) ? value : [value];
  return items.flatMap((item): Filter => {
    if (typeof item === 'string') return [{ patterns: [item] }];
    if (item && typeof item === 'object') {
      return Object.entries(item as Record<string, unknown>).map(([status, pattern]) => ({
        patterns: Array.isArray(pattern) ? pattern.map(String) : [String(pattern)],
        statuses: status.split('|').flatMap((s) => STATUS[s.trim()] ?? []),
      }));
    }
    return [];
  });
}

export const pathsFilterModel: ActionModel = {
  id: 'dorny/paths-filter',
  version: '1',
  matches: (uses) => matchesRepo('dorny/paths-filter', uses),
  presets: [],
  preset: () => undefined,
  interface(ctx) {
    const filters = parseFilters(ctx);
    return filters
      ? { names: ['changes', ...Object.keys(filters)], open: false }
      : { names: ['changes'], open: true };
  },
  produce(ctx) {
    const filters = parseFilters(ctx);
    if (!filters) return { outputs: { changes: unknown([`${ctx.node}.outputs.changes`]) } };
    const files = changedFiles(ctx.scenario);
    if (files) return { outputs: decide(filters, files) };
    const names = ['changes', ...Object.keys(filters)];
    return {
      outputs: Object.fromEntries(names.map((name) => [name, unknown<string>(['scenario.changed'])])),
    };
  },
};

/** Each filter against the changed files, and `changes`, the names of those that matched. */
function decide(filters: Record<string, Filter>, files: ChangedFile[]): Record<string, Value<string>> {
  const outputs: Record<string, Value<string>> = {};
  const matched: string[] = [];
  for (const [name, filter] of Object.entries(filters)) {
    const hit = filter.some((rule) => {
      const match = anyMatcher(rule.patterns);
      return files.some(
        (file) => (!rule.statuses || rule.statuses.includes(file.status)) && match(file.path),
      );
    });
    if (hit) matched.push(name);
    outputs[name] = known(hit ? 'true' : 'false');
  }
  outputs.changes = known(JSON.stringify(matched));
  return outputs;
}
