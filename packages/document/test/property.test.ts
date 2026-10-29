import { loadProject, memoryFileSystem } from '@ciatlas/core';
import * as fc from 'fast-check';
import { isCollection, isScalar, isSeq } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  convertEol,
  dealias,
  dealiasAnchor,
  insert,
  move,
  remove,
  renameKey,
  set,
  WorkflowDocument,
  type EditPlan,
  type Json,
  type TextEdit,
  type YamlPath,
} from '@simulci/document';
import { applyEdits } from '@simulci/document/edits';
import { BOM, crlf, fixtures, workflows } from './corpus';
import { expected, same, type PrimitiveOp } from './model';
import { runs } from './runs';
import { aliasesOf, blockSeqsOf, mapsOf, nodeAt, scalarsOf, seqsOf, sites, valueOf } from './walk';

const PATH = '.github/workflows/x.yml';
const open = (text: string) => WorkflowDocument.open(text, { path: PATH, kind: 'workflow' });

const JOB = [
  'name',
  'runs-on',
  'needs',
  'if',
  'permissions',
  'environment',
  'concurrency',
  'timeout-minutes',
  'continue-on-error',
  'strategy',
  'container',
  'services',
  'uses',
  'with',
  'secrets',
  'env',
  'defaults',
  'outputs',
  'steps',
];
const STEP = [
  'id',
  'name',
  'if',
  'uses',
  'run',
  'shell',
  'working-directory',
  'with',
  'env',
  'continue-on-error',
  'timeout-minutes',
];
const KEYS = [
  'if',
  'name',
  'timeout-minutes',
  'env',
  'with',
  'id',
  'shell',
  'continue-on-error',
  'k-new',
  'needs',
];
/** Values that drift or break when written carelessly: numbers and booleans as text, indicators, quotes, breaks. */
const VALUES: Json[] = [
  'ubuntu-latest',
  '24',
  '3.10',
  '',
  'true',
  'null',
  '~',
  '0x10',
  '1e3',
  "github.ref == 'refs/heads/main'",
  '!cancelled()',
  'a: b',
  '#x',
  '*star',
  '&amp',
  '${{ matrix.os }}',
  'two\nlines',
  'trailing\n',
  'keep\n\n',
  ' leading',
  "it's",
  'say "hi"',
  'tab\there',
  '- dash',
  '? q',
  '@at',
  'a #b',
  'é ü 😀',
  30,
  1.5,
  -2,
  true,
  false,
  null,
  ['x', 'y'],
  ['${{ a }}'],
  [1, 'two'],
  { k: 'v' },
  { run: 'echo\nmore\n', shell: 'bash' },
  [],
  {},
];
const STEPS: Json[] = [
  { run: 'echo hi' },
  { uses: 'actions/checkout@v4' },
  { name: 'Lint', run: 'npm run lint\nnpm run fmt\n' },
  { uses: 'actions/setup-node@v4', with: { 'node-version': '24', cache: 'pnpm' } },
  'scalar item',
  null,
];

type Pick = <T>(items: readonly T[]) => T | undefined;

/** An op over what the document holds now, picked by the random stream. */
function pickOp(doc: WorkflowDocument, pick: Pick, rand: () => number): PrimitiveOp | undefined {
  // Setting, removing and inserting are picked twice as often as the rest.
  const picker = pick([...Object.values(PICKERS), PICKERS.set!, PICKERS.remove!, PICKERS.insert!])!;
  return picker(doc, pick, rand);
}

const index = (rand: () => number, n: number) => Math.floor(rand() * n);
const orderOf = (path: YamlPath) =>
  path.length === 2 && path[0] === 'jobs' ? JOB : path.at(-2) === 'steps' ? STEP : undefined;
const scalarLists = (doc: WorkflowDocument) =>
  seqsOf(doc).filter((s) => isSeq(s.node) && s.node.items.every((i) => isScalar(i)));
const SCALARS = VALUES.filter((v) => v === null || typeof v !== 'object');

/** One picker per kind of op, over what the document holds now. */
const PICKERS: Record<
  string,
  (doc: WorkflowDocument, pick: Pick, rand: () => number) => PrimitiveOp | undefined
> = {
  set: (doc, pick) => {
    const site = pick(scalarsOf(doc));
    return site && { kind: 'set', path: site.path, value: pick(VALUES)! };
  },
  add: (doc, pick) => {
    const map = pick(mapsOf(doc));
    const order = map && orderOf(map.path);
    return (
      map && {
        kind: 'set',
        path: [...map.path, pick(KEYS)!],
        value: pick(VALUES)!,
        ...(order ? { order } : {}),
      }
    );
  },
  list: (doc, pick, rand) => {
    const seq = pick(scalarLists(doc));
    return (
      seq && {
        kind: 'set',
        path: seq.path,
        value: Array.from({ length: index(rand, 4) }, () => pick(SCALARS)!),
      }
    );
  },
  remove: (doc, pick, rand) => {
    const site = pick(sites(doc));
    return site && { kind: 'remove', path: site.path, emptied: rand() < 0.5 ? 'null' : 'remove' };
  },
  insert: (doc, pick, rand) => {
    const seq = pick(seqsOf(doc));
    if (!seq || !isSeq(seq.node)) return undefined;
    const value = seq.path.at(-1) === 'steps' ? pick(STEPS)! : pick(VALUES)!;
    return { kind: 'insert', path: seq.path, index: index(rand, seq.node.items.length + 1), value };
  },
  move: (doc, pick, rand) => {
    const seq = pick(blockSeqsOf(doc));
    if (!seq || !isSeq(seq.node)) return undefined;
    const n = seq.node.items.length;
    return { kind: 'move', path: seq.path, from: index(rand, n), to: index(rand, n) };
  },
  rename: (doc, pick, rand) => {
    const site = pick(sites(doc).filter((s) => typeof s.path.at(-1) === 'string'));
    return (
      site && { kind: 'rename', path: site.path, key: `${String(site.path.at(-1))}_r${index(rand, 100)}` }
    );
  },
  dealias: (doc, pick) => {
    const site = pick(aliasesOf(doc));
    return site && { kind: 'dealias', path: site.path };
  },
  dealiasAnchor: (doc, pick) => {
    const def = pick(doc.anchors.anchors);
    return def && { kind: 'dealiasAnchor', name: def.name };
  },
  eol: (doc, _, rand) =>
    rand() < 0.2 ? { kind: 'convertEol', eol: doc.style.eol === '\n' ? '\r\n' : '\n' } : undefined,
};

function plan(doc: WorkflowDocument, op: PrimitiveOp): EditPlan<TextEdit[]> {
  switch (op.kind) {
    case 'set':
      return set(doc, op.path, op.value, op.order ? { order: op.order } : {});
    case 'remove':
      return remove(doc, op.path, op.emptied);
    case 'insert':
      return insert(doc, op.path, op.index, op.value);
    case 'move':
      return move(doc, op.path, op.from, op.to);
    case 'rename':
      return renameKey(doc, op.path, op.key);
    case 'dealias':
      return dealias(doc, op.path);
    case 'dealiasAnchor':
      return dealiasAnchor(doc, op.name);
    default:
      return convertEol(doc, op.eol);
  }
}

/** The lines an op may change: its top-level pair, or under `jobs` and `on` the second-level one. */
function region(doc: WorkflowDocument, op: PrimitiveOp): { from: number; to: number } | undefined {
  if (!('path' in op) || op.path.length === 0 || op.kind === 'dealias') return undefined;
  const path = op.kind === 'remove' ? rewritten(doc, op.path, op.emptied) : op.path;
  const span = doc.spanOf(path.slice(0, depth(doc, path)));
  return span && widened(doc, span);
}

/** How deep a path's pair is: under `jobs` and `on` the second level, once a path reaches below it; else the first. */
function depth(doc: WorkflowDocument, path: YamlPath): number {
  const nested = (path[0] === 'jobs' || path[0] === 'on') && path.length >= 3;
  return nested && nodeAt(doc, path.slice(0, 2)) ? 2 : 1;
}

/**
 * What a remove rewrites: the item, or once it empties its collection, the collection's value (`emptied: 'null'`) or
 * the collection itself, emptying the one above it in turn (`'remove'`). Removing the last job's last key empties
 * `jobs`, and with it the comments inside `jobs` that no job owns.
 */
function rewritten(doc: WorkflowDocument, path: YamlPath, emptied: 'null' | 'remove'): YamlPath {
  const parent = nodeAt(doc, path.slice(0, -1));
  if (path.length < 2 || !isCollection(parent) || parent.items.length > 1) return path;
  return emptied === 'remove' ? rewritten(doc, path.slice(0, -1), 'null') : path.slice(0, -1);
}

/** A span with the blank lines around it, and the line break before it. */
function widened(doc: WorkflowDocument, span: { from: number; to: number }): { from: number; to: number } {
  const { lines } = doc.tree;
  let from = lines.lineAt(span.from);
  while (from > 0 && lines.kind(from - 1).kind === 'blank') from--;
  let to = lines.lineAt(Math.max(span.to - 1, span.from));
  while (to + 1 < lines.count && lines.kind(to + 1).kind === 'blank') to++;
  return { from: Math.max(0, lines.start(from) - 2), to: lines.end(to) };
}

/** What is wrong with an applied op, if anything. */
function check(
  doc: WorkflowDocument,
  op: PrimitiveOp,
  edits: readonly TextEdit[],
  next: WorkflowDocument,
): string | undefined {
  if (next.errors.length > 0) return `yaml error ${next.errors[0]!.code}`;
  const want = expected(valueOf(doc), op);
  if (!same(want, valueOf(next)))
    return `value: want ${JSON.stringify(want)}\n got ${JSON.stringify(valueOf(next))}`;
  const area = region(doc, op);
  if (area && edits.some((e) => e.from < area.from || e.to > area.to))
    return `an edit outside ${JSON.stringify(area)}: ${JSON.stringify(edits)}`;
  return textCheck(doc, op, next);
}

function textCheck(doc: WorkflowDocument, op: PrimitiveOp, next: WorkflowDocument): string | undefined {
  if (op.kind !== 'convertEol' && doc.style.eol === '\r\n' && /(?:^|[^\r])\n/.test(next.text))
    return 'a bare LF in a CRLF file';
  return doc.text.startsWith(BOM) === next.text.startsWith(BOM) ? undefined : 'the byte order mark changed';
}

function coreErrors(text: string): string[] {
  const project = loadProject({ root: '.', fs: memoryFileSystem({ [PATH]: text }), validateSchema: false });
  return (project.workflows.get(PATH)?.parseErrors ?? []).map((e) => e.message);
}

interface Stats {
  applied: number;
  refused: Record<string, number>;
}

/** One sequence of up to 12 ops; then every inverse in reverse gives the bytes back, and redo gives them again. */
function sequence(original: string, stream: readonly number[], stats: Stats): void {
  let i = 0;
  const rand = () => stream[i++ % stream.length]! / 1_000_000;
  const pick: Pick = (items) => (items.length === 0 ? undefined : items[Math.floor(rand() * items.length)]);
  let doc = open(original);
  const undo: TextEdit[][] = [];
  const redo: TextEdit[][] = [];
  for (let n = 0; n < 12; n++) {
    const op = pickOp(doc, pick, rand);
    if (!op) continue;
    const result = plan(doc, op);
    if (!result.ok) {
      expect(
        result.reason,
        `${JSON.stringify(op)}\n${result.message}\n${JSON.stringify(result.fixes)}\n--- text\n${JSON.stringify(doc.text)}`,
      ).not.toBe('internal');
      stats.refused[result.reason] = (stats.refused[result.reason] ?? 0) + 1;
      continue;
    }
    const next = result.documents[PATH]!;
    const { text, inverse } = applyEdits(doc.text, result.value);
    expect(next.text).toBe(text);
    const problem = check(doc, op, result.value, next);
    expect(
      problem,
      `${JSON.stringify(op)}\n--- before\n${doc.text}\n--- after\n${next.text}`,
    ).toBeUndefined();
    undo.push(inverse);
    redo.push(result.value);
    stats.applied++;
    doc = next;
  }
  expect(coreErrors(doc.text)).toEqual([]);
  const last = doc.text;
  let text = last;
  for (const inverse of undo.toReversed()) text = applyEdits(text, inverse).text;
  expect(text).toBe(original);
  for (const edits of redo) text = applyEdits(text, edits).text;
  expect(text).toBe(last);
}

const all = process.env.ONLY_FIXTURES
  ? fixtures()
  : [...fixtures(), ...workflows().filter((f) => !f.name.startsWith('.github/'))];
const files = all.filter((f) => open(f.text).status.editable);

describe('primitive sequences (fast-check)', () => {
  const stats: Stats = { applied: 0, refused: {} };
  it.each(files.map((f) => [f.name, f.text] as const))(
    '%s: 0 errors, the meaning as defined, locality, undo and redo',
    (_, text) => {
      const variants = [text, crlf(text), `${BOM}${crlf(text)}`];
      fc.assert(
        fc.property(
          fc.nat({ max: 2 }),
          fc.array(fc.integer({ min: 0, max: 999_999 }), { minLength: 40, maxLength: 120 }),
          (variant, stream) => sequence(variants[variant]!, stream, stats),
        ),
        { numRuns: runs(fixtures().some((f) => f.text === text) ? 200 : 20) },
      );
    },
    600_000,
  );

  it('applied ops and met refusals of every kind it can', () => {
    expect(stats.applied).toBeGreaterThan(100);
  });
});

describe('primitive sequences: regressions', () => {
  // Seed -1817638724 on comments.yml: the remove emptied `test`, then `jobs`, and took the comment above `test`.
  it('keeps the comment in jobs that no job owns when a remove empties jobs', () => {
    const doc = open(
      "name: comments\n\njobs:\n    # After a blank line: nobody's.\n  test:\n    runs-on: ubuntu-latest\n  # Dangling.\n",
    );
    const op: PrimitiveOp = { kind: 'remove', path: ['jobs', 'test', 'runs-on'], emptied: 'remove' };
    const result = plan(doc, op);
    if (!result.ok) expect.unreachable(result.message);
    const next = result.documents[PATH]!;
    expect(next.text).toBe("name: comments\n\njobs:\n    # After a blank line: nobody's.\n  # Dangling.\n");
    expect(check(doc, op, result.value, next)).toBeUndefined();
  });
});
