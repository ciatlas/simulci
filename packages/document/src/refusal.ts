import type { FilterKey, WorkflowOp } from './ops/types';
import type { Eol, YamlPath } from './types';

/** Why an edit cannot be made, in the terms the author sees it. */
export type RefusalReason =
  // The whole file is locked (`WorkflowDocument.status`).
  | 'invalid-yaml'
  | 'duplicate-key'
  | 'multi-document'
  | 'directive'
  | 'generated'
  | 'too-large'
  // The target cannot be written in place.
  | 'alias'
  | 'shared-anchor'
  | 'anchor'
  | 'merge-key'
  | 'flow-shape'
  | 'unsupported-shape'
  // The target is not what the view thought.
  | 'not-found'
  | 'out-of-range'
  | 'moved'
  | 'stale'
  // The author's input.
  | 'invalid-id'
  | 'duplicate-id'
  | 'cycle'
  | 'exclusive-filter'
  | 'other-workflow'
  // simulci's own check of an edit failed (G6): nothing is written.
  | 'internal'
  // The store's, for files it holds read-only for both the pane and ops.
  | 'not-utf8'
  | 'mixed-eol';

/** A one-click way past a refusal. */
export type Fix =
  /** Run the ops; with `retry`, then the refused op again. The fix and the retry commit as one transaction. */
  | { kind: 'ops'; label: string; ops: WorkflowOp[]; retry: boolean }
  /**
   * Retry the op with `ctx.shared = 'all'`: change every use of a shared anchor. With `ops`, run them first (an anchor
   * the change would take with it, copied into its uses); the ops and the retry commit as one transaction.
   */
  | { kind: 'shared-all'; label: string; ops?: WorkflowOp[] }
  /** "Edit in YAML": open the pane on the line. */
  | { kind: 'reveal'; label: string; line: number }
  /** Edit a generated file anyway, this session. */
  | { kind: 'unlock'; label: string }
  /** Undo the last transaction (it broke the YAML). */
  | { kind: 'undo'; label: string }
  /** Copy what simulci's check found, for a bug report. */
  | { kind: 'report'; label: string; text: string };

export interface Refusal {
  ok: false;
  reason: RefusalReason;
  message: string;
  file: string;
  /** 1-based. */
  line?: number;
  at?: YamlPath;
  fixes: Fix[];
}

export function refuse(
  reason: RefusalReason,
  file: string,
  message: string,
  more: { line?: number; at?: YamlPath; fixes?: Fix[] } = {},
): Refusal {
  const refusal: Refusal = { ok: false, reason, message, file, fixes: more.fixes ?? [] };
  if (more.line !== undefined) refusal.line = more.line;
  if (more.at !== undefined) refusal.at = more.at;
  return refusal;
}

/** The file's name as the author knows it: `ci.yml` for `.github/workflows/ci.yml`. */
export const fileName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

const reveal = (line: number, label = `Show line ${line}`): Fix => ({ kind: 'reveal', label, line });

/** yaml's error codes in the author's words; others keep yaml's own message. */
const WHAT: Record<string, string> = {
  BAD_INDENT: 'bad indentation',
  TAB_AS_INDENT: 'a tab used as indentation',
  MISSING_CHAR: 'a missing character',
  MULTILINE_IMPLICIT_KEY: 'a key that spans lines',
  BLOCK_AS_IMPLICIT_KEY: 'a `: ` inside a value, which needs quotes',
  UNEXPECTED_TOKEN: 'an unexpected character',
  BAD_SCALAR_START: 'a value that cannot start with that character',
  BAD_DQ_ESCAPE: 'a bad escape in a double-quoted string',
  BAD_ALIAS: 'a bad alias',
  BAD_DIRECTIVE: 'a bad directive',
};

export function invalidYaml(file: string, line: number, code: string, message: string): Refusal {
  const what = WHAT[code] ?? message.replace(/\.$/, '').replace(/^\w/, (c) => c.toLowerCase());
  return refuse(
    'invalid-yaml',
    file,
    `${fileName(file)} does not parse at line ${line} (${what}). Fix it in the YAML pane; the graph shows the last version that parsed.`,
    { line, fixes: [reveal(line), { kind: 'undo', label: 'Undo the last change' }] },
  );
}

export function duplicateKey(file: string, at: YamlPath, key: string, lines: [number, number]): Refusal {
  const where = at.length === 0 ? fileName(file) : at.join('.');
  return refuse(
    'duplicate-key',
    file,
    `${where} has two \`${key}:\` keys (lines ${lines[0]} and ${lines[1]}); GitHub rejects the file.`,
    { line: lines[1], at: [...at, key], fixes: [reveal(lines[1])] },
  );
}

const COUNT = ['no', 'one', 'two', 'three', 'four', 'five'];

export function multiDocument(file: string, documents: number, line: number): Refusal {
  return refuse(
    'multi-document',
    file,
    `${fileName(file)} holds ${COUNT[documents] ?? documents} YAML documents (\`---\` on line ${line}); GitHub reads only the first.`,
    { line, fixes: [reveal(line)] },
  );
}

export function directive(file: string, source: string, line: number): Refusal {
  return refuse(
    'directive',
    file,
    `${fileName(file)} starts with a \`${source}\` directive; edit it in the YAML pane.`,
    { line, fixes: [reveal(line)] },
  );
}

export function generated(file: string, marker: string, line: number | undefined): Refusal {
  const unlock: Fix = { kind: 'unlock', label: 'Edit anyway' };
  const why =
    line === undefined
      ? marker === '.lock.yml'
        ? `is generated (its name ends in ${marker})`
        : `is marked generated ('${marker}')`
      : `says '${marker}' on line ${line}: it is generated`;
  return refuse('generated', file, `${fileName(file)} ${why}, and your edits would be overwritten.`, {
    ...(line === undefined ? {} : { line }),
    fixes: [unlock],
  });
}

export function tooLarge(file: string, bytes: number): Refusal {
  return refuse(
    'too-large',
    file,
    `${fileName(file)} is ${Math.round(bytes / 1024)} kB; edit files this large in the YAML pane.`,
    { fixes: [reveal(1, 'Edit in YAML')] },
  );
}

/** Where a path is, in the author's words: `deploy`, `deploy's step 2`, ``deploy's `runs-on` ``, `` `on.push` ``. */
export function describe(path: YamlPath): string {
  const [root, job, steps, index, ...rest] = path;
  if (root !== 'jobs' || typeof job !== 'string')
    return path.length === 0 ? 'the file' : `\`${path.join('.')}\``;
  if (steps === undefined) return job;
  if (steps === 'steps' && typeof index === 'number') {
    const step = `${job}'s step ${index + 1}`;
    return rest.length === 0 ? step : `${step} \`${rest.join('.')}\``;
  }
  return `${job}'s \`${path.slice(2).join('.')}\``;
}

export function notFound(file: string, path: YamlPath): Refusal {
  return refuse('not-found', file, `${subject(path)} is not in ${fileName(file)} any more.`, {
    at: path,
  });
}

export function outOfRange(file: string, path: YamlPath, length: number): Refusal {
  return refuse(
    'out-of-range',
    file,
    `${subject(path.slice(0, -1))} has ${length} item${length === 1 ? '' : 's'}; there is no item ${Number(path.at(-1)) + 1}.`,
    { at: path },
  );
}

export function aliasRefusal(
  file: string,
  at: YamlPath,
  alias: string,
  anchorLine: number | undefined,
): Refusal {
  const target = anchorLine === undefined ? `\`&${alias}\`` : `\`&${alias}\` on line ${anchorLine}`;
  const fixes: Fix[] = [
    {
      kind: 'ops',
      label: `Give ${describe(at)} its own value`,
      ops: [{ op: 'dealias', file, path: at }],
      retry: true,
    },
  ];
  if (anchorLine !== undefined) fixes.push(reveal(anchorLine, 'Edit the anchor'));
  return refuse('alias', file, `${subject(at)} is \`*${alias}\`, a reference to ${target}.`, {
    at,
    fixes,
  });
}

/**
 * The target is inside anchored nodes (innermost first) that aliases repeat elsewhere: "Change only here" copies each
 * into its uses, innermost first, so the outer definitions keep their lines; "Change all" edits every place the value
 * appears, `places` in all.
 */
export function sharedAnchor(
  file: string,
  at: YamlPath,
  defs: readonly { name: string; line: number }[],
  uses: readonly number[],
  places: number,
): Refusal {
  const n = uses.length;
  const names = defs.map((d) => `\`&${d.name}\``).join(' and ');
  return refuse(
    'shared-anchor',
    file,
    `${subject(at)} is inside ${names}, which ${n} other place${n === 1 ? '' : 's'} reuse${n === 1 ? 's' : ''} (line${n === 1 ? '' : 's'} ${uses.join(', ')}).`,
    {
      at,
      fixes: [
        { kind: 'ops', label: 'Change only here', ops: defs.map((d) => copyAnchor(file, d)), retry: true },
        { kind: 'shared-all', label: `Change all ${places} uses` },
      ],
    },
  );
}

/** The op that copies an anchor into its uses; it names the definition's line when the name is used twice. */
export function copyAnchor(
  file: string,
  def: { name: string; line: number; redefined?: boolean },
): WorkflowOp {
  return def.redefined
    ? { op: 'dealiasAnchor', file, anchor: def.name, line: def.line }
    : { op: 'dealiasAnchor', file, anchor: def.name };
}

/**
 * Anchors an edit would take with it while aliases elsewhere use them. The fix copies each into its uses, the last
 * one first, so the lines of the ones above it stay as they are named.
 */
export function orphanedAnchor(
  file: string,
  at: YamlPath,
  defs: readonly { name: string; line: number; redefined: boolean }[],
  uses: readonly number[],
): Refusal {
  const [first] = defs;
  const what =
    defs.length === 1
      ? `on line ${first!.line} defines \`&${first!.name}\``
      : `defines ${defs.map((d) => `\`&${d.name}\` (line ${d.line})`).join(' and ')}`;
  const n = uses.length;
  return refuse(
    'anchor',
    file,
    `${subject(at)} ${what}, which ${n} other place${n === 1 ? '' : 's'} reuse${n === 1 ? 's' : ''} (line${n === 1 ? '' : 's'} ${uses.join(', ')}).`,
    {
      at,
      line: first!.line,
      fixes: [
        {
          kind: 'ops',
          label: 'Copy into its uses first',
          ops: defs.toSorted((a, b) => b.line - a.line).map((def) => copyAnchor(file, def)),
          retry: true,
        },
      ],
    },
  );
}

export function danglingAlias(
  file: string,
  alias: { name: string; line: number; forward: boolean },
  anchorLine?: number,
): Refusal {
  const why = alias.forward
    ? `comes before its anchor${anchorLine === undefined ? '' : ` on line ${anchorLine}`}, and YAML needs the anchor first`
    : `names no anchor before it`;
  return refuse('anchor', file, `\`*${alias.name}\` on line ${alias.line} ${why}. Fix it in the YAML pane.`, {
    line: alias.line,
    fixes: [reveal(alias.line)],
  });
}

export function mergeKey(file: string, at: YamlPath, line: number): Refusal {
  return refuse(
    'merge-key',
    file,
    `${subject(at)} uses a YAML merge key (\`<<:\` on line ${line}), which GitHub does not apply; edit it in the YAML pane.`,
    { at, line, fixes: [reveal(line)] },
  );
}

export function flowShape(file: string, at: YamlPath, line: number, why: string): Refusal {
  return refuse('flow-shape', file, `${subject(at)} is written inline ${why}; edit it in the YAML pane.`, {
    at,
    line,
    fixes: [reveal(line)],
  });
}

/** Whether a reason starts with a job's id as its subject, as `describe` writes it. */
const startsWithId = (why: string, id: string): boolean =>
  why.startsWith(id) && /^(?:'s | (?:is|cannot|would|starts|has) )/.test(why.slice(id.length));

export function unsupported(file: string, at: YamlPath, why: string, line?: number): Refusal {
  // A sentence starts with a capital, but a job id keeps its case (`build's step 1 …`, `build is not a map`).
  const id = at[0] === 'jobs' && typeof at[1] === 'string' && startsWithId(why, at[1]);
  return refuse(
    'unsupported-shape',
    file,
    `${id ? why : why.replace(/^[a-z]/, (c) => c.toUpperCase())}; edit it in the YAML pane.`,
    {
      at,
      ...(line === undefined ? {} : { line, fixes: [reveal(line)] }),
    },
  );
}

export function duplicateId(file: string, at: YamlPath, key: string): Refusal {
  return refuse('duplicate-id', file, `${subject(at.slice(0, -1))} already has \`${key}\`.`, {
    at,
  });
}

export function stale(file: string, line: number): Refusal {
  return refuse(
    'stale',
    file,
    `${fileName(file)} changed at line ${line} while the edit was prepared; try again.`,
    { line },
  );
}

/** A file the op would create is there already: the view thought it missing. */
export function exists(file: string): Refusal {
  return refuse('stale', file, `${fileName(file)} exists already; try again.`);
}

/** `branches` next to `branches-ignore` (or tags, paths): the fix switches the filter there to the one asked for. */
export function exclusiveFilter(
  file: string,
  event: string,
  present: FilterKey,
  wanted: FilterKey,
  line: number | undefined,
): Refusal {
  const fix: Fix = {
    kind: 'ops',
    label: `Switch to ${wanted}`,
    ops: [{ op: 'switchFilter', file, event, from: present, to: wanted }],
    retry: true,
  };
  return refuse(
    'exclusive-filter',
    file,
    `${event} already uses \`${present}\`; GitHub accepts one of the two.`,
    {
      at: ['on', event, present],
      ...(line === undefined ? {} : { line }),
      fixes: [fix],
    },
  );
}

/** A case for a test file whose `workflow:` names another workflow; the fix puts it in a file of its own. */
export function otherWorkflow(
  file: string,
  workflow: string,
  line: number | undefined,
  fixes: Fix[],
): Refusal {
  return refuse('other-workflow', file, `${fileName(file)} tests ${workflow}.`, {
    at: ['workflow'],
    ...(line === undefined ? {} : { line }),
    fixes,
  });
}

export function mixedEol(file: string): Refusal {
  const convert = (eol: Eol, label: string): Fix => ({
    kind: 'ops',
    label,
    ops: [{ op: 'convertEol', file, eol }],
    retry: true,
  });
  return refuse(
    'mixed-eol',
    file,
    `${fileName(file)} mixes CRLF and LF line endings; convert it to one first.`,
    {
      fixes: [convert('\n', 'Convert to LF'), convert('\r\n', 'Convert to CRLF')],
    },
  );
}

export function internal(file: string, line: number | undefined, report: string): Refusal {
  const fixes: Fix[] = [{ kind: 'report', label: 'Copy report', text: report }];
  if (line !== undefined) fixes.unshift(reveal(line));
  return refuse('internal', file, 'simulci could not make this edit cleanly; nothing was changed.', {
    ...(line === undefined ? {} : { line }),
    fixes,
  });
}

/** A path as a sentence's subject: job ids keep their case; "the file" starts with a capital. */
const subject = (path: YamlPath): string => {
  const text = describe(path);
  return text === 'the file' ? 'The file' : text;
};

export function moved(file: string, at: YamlPath): Refusal {
  return refuse(
    'moved',
    file,
    'The selected step changed in the text; the graph will catch up in a moment.',
    { at },
  );
}

/** `job` needing `need` closes a loop: `need` already reaches `job` through `through`. */
export function cycle(file: string, job: string, need: string, through: readonly string[]): Refusal {
  const via = through.length === 0 ? '' : ` through ${through.join(', ')}`;
  const message =
    need.toLowerCase() === job.toLowerCase()
      ? `${job} cannot need itself.`
      : `${need} already needs ${job}${via}; ${job} needing ${need} would loop.`;
  return refuse('cycle', file, message, { at: ['jobs', job, 'needs'] });
}

export function recursiveAlias(file: string, name: string, line: number): Refusal {
  return refuse(
    'anchor',
    file,
    `\`*${name}\` on line ${line} is inside \`&${name}\`, the node it names. Fix it in the YAML pane.`,
    {
      line,
      fixes: [reveal(line)],
    },
  );
}

export function aliasBomb(file: string): Refusal {
  return refuse(
    'anchor',
    file,
    `The aliases in ${fileName(file)} expand to too many nodes to check an edit; edit it in the YAML pane.`,
    {
      fixes: [reveal(1, 'Edit in YAML')],
    },
  );
}
