import { loadProject, memoryFileSystem } from '@ciatlas/core';
import { describe, expect, it } from 'vitest';
import {
  convertEol,
  dealias,
  dealiasAnchor,
  insert,
  move,
  remove,
  renameKey,
  replaceAt,
  set,
  WorkflowDocument,
  type EditPlan,
  type TextEdit,
} from '@simulci/document';
import { applyEdits } from '@simulci/document/edits';
import { BOM, crlf, fixture } from './corpus';
import { valueOf } from './walk';

const PATH = '.github/workflows/ci.yml';
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
const WORKFLOW = ['name', 'run-name', 'on', 'permissions', 'env', 'defaults', 'concurrency', 'jobs'];

type Run = (doc: WorkflowDocument) => EditPlan<TextEdit[]>;

/** A golden: a fixture, an op, and the text it gives, kept in `golden/primitives/<name>.yml` and read by eye once. */
const cases: [name: string, fixture: string, run: Run][] = [
  // The day-one defects of the design pass's harness and prototypes.
  ['remove-last-filter-keeps-event', 'events.yml', (d) => remove(d, ['on', 'push', 'branches'])],
  ['remove-last-filter-item-keeps-key', 'events.yml', (d) => remove(d, ['on', 'push', 'branches', 0])],
  [
    'flow-list-set-keeps-comment',
    'events.yml',
    (d) => set(d, ['on', 'push', 'branches'], ['main', 'release/**']),
  ],
  ['filter-under-null-event', 'events.yml', (d) => set(d, ['on', 'pull_request', 'branches'], ['main'])],
  ['move-step-with-nested-map', 'events.yml', (d) => move(d, ['jobs', 'build', 'steps'], 0, 2)],
  ['types-kept-3.10', 'events.yml', (d) => set(d, ['jobs', 'build', 'runs-on'], '3.10')],
  ['types-kept-24', 'events.yml', (d) => set(d, ['jobs', 'build', 'steps', 1, 'name'], '24')],
  [
    'types-kept-true',
    'events.yml',
    (d) => set(d, ['jobs', 'build', 'steps', 0, 'with', 'submodules'], 'true'),
  ],
  ['types-kept-empty', 'events.yml', (d) => set(d, ['name'], '')],
  ['types-number', 'events.yml', (d) => set(d, ['jobs', 'build', 'timeout-minutes'], '45', { as: 'number' })],
  [
    'block-literal-rewritten',
    'events.yml',
    (d) => set(d, ['jobs', 'build', 'steps', 2, 'run'], 'echo one\necho two\necho three\n'),
  ],
  [
    'block-literal-to-one-line',
    'events.yml',
    (d) => set(d, ['jobs', 'build', 'steps', 2, 'run'], 'echo once'),
  ],
  [
    'plain-to-block-literal',
    'events.yml',
    (d) => set(d, ['jobs', 'build', 'steps', 1, 'run'], 'npm ci\nnpm test\n'),
  ],
  [
    'anchored-runs-on-only-here',
    'anchored-runs-on.yml',
    (d) => onlyHere(d, ['jobs', 'build', 'runs-on'], 'self-hosted'),
  ],
  [
    'anchored-runs-on-all-uses',
    'anchored-runs-on.yml',
    (d) => set(d, ['jobs', 'build', 'runs-on'], 'self-hosted', { shared: 'all' }),
  ],
  // Keys and their order.
  [
    'add-key-by-order',
    'events.yml',
    (d) => set(d, ['jobs', 'build', 'if'], "github.ref == 'refs/heads/main'", { order: JOB }),
  ],
  ['add-first-key-by-order', 'events.yml', (d) => set(d, ['jobs', 'build', 'name'], 'Build', { order: JOB })],
  [
    'add-before-inline-first-key',
    'events.yml',
    (d) => set(d, ['jobs', 'build', 'steps', 1, 'id'], 'test', { order: STEP }),
  ],
  [
    'add-map-in-order',
    'events.yml',
    (d) =>
      set(d, ['jobs', 'build', 'steps', 1, 'env', 'CI'], 'true', {
        order: (p) => (p.length === 4 ? STEP : undefined),
      }),
  ],
  [
    'add-workflow-key-after-header',
    'comments.yml',
    (d) => set(d, ['run-name'], 'Run ${{ github.ref }}', { order: WORKFLOW }),
  ],
  [
    'add-job-blank-separated',
    'comments.yml',
    (d) => set(d, ['jobs', 'lint'], { 'runs-on': 'ubuntu-latest', steps: [{ run: 'npm run lint' }] }),
  ],
  ['rename-key-keeps-quotes', 'quoted.yml', (d) => renameKey(d, ['jobs', 'build'], 'compile')],
  ['set-under-quoted-keys', 'quoted.yml', (d) => set(d, ['jobs', 'build', 'runs-on'], 'macos-latest')],
  ['rename-job', 'events.yml', (d) => renameKey(d, ['jobs', 'build'], 'test')],
  // Sequences.
  [
    'insert-step-first',
    'comments.yml',
    (d) => insert(d, ['jobs', 'build', 'steps'], 0, { uses: 'actions/checkout@v4' }),
  ],
  [
    'insert-step-blank-separated',
    'comments.yml',
    (d) => insert(d, ['jobs', 'build', 'steps'], 1, { run: 'npm ci' }, { commentBefore: ['Install.'] }),
  ],
  [
    'append-step-packed',
    'events.yml',
    (d) => insert(d, ['jobs', 'build', 'steps'], 3, { name: 'Lint', run: 'npm run lint\nnpm run fmt\n' }),
  ],
  [
    'append-step-no-final-newline',
    'packed-no-final-newline.yml',
    (d) => insert(d, ['jobs', 'b', 'steps'], 1, { run: 'echo c' }),
  ],
  ['remove-last-job-no-final-newline', 'packed-no-final-newline.yml', (d) => remove(d, ['jobs', 'b'])],
  [
    'insert-step-four-spaces',
    'indent4.yml',
    (d) => insert(d, ['jobs', 'build', 'steps'], 1, { name: 'Install', run: 'npm ci' }),
  ],
  ['add-key-four-spaces', 'indent4.yml', (d) => set(d, ['jobs', 'lint', 'needs'], ['build'], { order: JOB })],
  ['insert-step-flush', 'flush.yml', (d) => insert(d, ['jobs', 'build', 'steps'], 2, { run: 'make dist' })],
  ['flow-list-insert-padded', 'flush.yml', (d) => insert(d, ['jobs', 'build', 'needs'], 1, 'test')],
  ['flow-list-remove', 'flush.yml', (d) => remove(d, ['on', 'pull_request', 'types', 0])],
  [
    'flow-map-step-add-key',
    'shapes.yml',
    (d) => set(d, ['jobs', 'flow-steps', 'steps', 0, 'name'], 'Checkout'),
  ],
  ['remove-step-with-comments', 'comments.yml', (d) => remove(d, ['jobs', 'build', 'steps', 0])],
  ['remove-inline-first-key', 'comments.yml', (d) => remove(d, ['jobs', 'build', 'steps', 0, 'name'])],
  ['remove-job-with-comments', 'comments.yml', (d) => remove(d, ['jobs', 'build'])],
  ['remove-needs-emptied', 'comments.yml', (d) => remove(d, ['jobs', 'test', 'needs'], 'remove')],
  ['move-step-up-blank-separated', 'comments.yml', (d) => move(d, ['jobs', 'build', 'steps'], 2, 0)],
  ['move-step-down-keeps-kept-block', 'shapes.yml', (d) => move(d, ['jobs', 'blocks', 'steps'], 0, 2)],
  [
    'set-tab-block',
    'shapes.yml',
    (d) => set(d, ['jobs', 'blocks', 'steps', 1, 'run'], 'first\n\tindented by a tab\nlast\n'),
  ],
  ['set-folded-if', 'shapes.yml', (d) => set(d, ['jobs', 'blocks', 'if'], "github.event_name == 'push'")],
  [
    'set-expanded-item-key',
    'shapes.yml',
    (d) => set(d, ['jobs', 'expanded', 'steps', 0, 'name'], 'Still expanded'),
  ],
  ['set-empty-item', 'shapes.yml', (d) => set(d, ['jobs', 'empty', 'steps', 0], { run: 'echo filled' })],
  ['markers-insert', 'markers.yml', (d) => insert(d, ['jobs', 'only', 'steps'], 1, { run: 'echo after' })],
  // Anchors.
  ['dealias-scalar', 'shared.yml', (d) => dealias(d, ['jobs', 'test', 'runs-on'])],
  ['dealias-map', 'shared.yml', (d) => dealias(d, ['jobs', 'again'])],
  ['dealias-step', 'shared.yml', (d) => dealias(d, ['jobs', 'test', 'steps', 0])],
  ['dealias-anchor-job', 'shared.yml', (d) => dealiasAnchor(d, 'job')],
  ['dealias-anchor-runner', 'shared.yml', (d) => dealiasAnchor(d, 'runner')],
  // Test files.
  [
    'test-file-append-case',
    'ci.test.yml',
    (d) =>
      insert(d, ['cases'], 2, {
        name: 'a tag',
        when: { event: 'push', tag: 'v1' },
        then: { build: 'skipped' },
      }),
  ],
  ['test-file-flow-when', 'ci.test.yml', (d) => set(d, ['cases', 0, 'when', 'branch'], 'release')],
  ['test-file-flow-when-add', 'ci.test.yml', (d) => set(d, ['cases', 0, 'when', 'actor'], 'octocat')],
  // References and line endings.
  ['replace-at', 'comments.yml', (d) => replaceAt(d, at(d, 'needs: build', 7, 5), 'build', 'compile')],
  ['convert-to-crlf', 'events.yml', (d) => convertEol(d, '\r\n')],
];

/** "Change only here": copy the anchor into its uses, then the op, as one transaction (C3 runs the fix this way). */
function onlyHere(doc: WorkflowDocument, path: (string | number)[], value: string): EditPlan<TextEdit[]> {
  const refused = set(doc, path, value);
  if (refused.ok || refused.fixes[0]?.kind !== 'ops') throw new Error('expected a shared-anchor refusal');
  const op = refused.fixes[0].ops[0]!;
  if (op.op !== 'dealiasAnchor') throw new Error('expected dealiasAnchor');
  const fix = dealiasAnchor(doc, op.anchor);
  if (!fix.ok) return fix;
  const next = fix.documents[PATH]!;
  const retried = set(next, path, value);
  if (!retried.ok) return retried;
  return { ...retried, value: [{ from: 0, to: doc.text.length, insert: retried.documents[PATH]!.text }] };
}

function at(doc: WorkflowDocument, needle: string, offset: number, length: number) {
  const from = doc.text.indexOf(needle) + offset;
  return { from, to: from + length };
}

describe('primitive goldens', () => {
  it.each(cases)('%s', async (name, file, run) => {
    const text = fixture(file);
    const plan = run(open(text));
    if (!plan.ok) throw new Error(`${plan.reason}: ${plan.message}`);
    const out = applyEdits(text, plan.value).text;
    expect(out).toBe(plan.documents[PATH]!.text);
    await expect(out).toMatchFileSnapshot(`golden/primitives/${name}.yml`);
    expect(coreErrors(out)).toEqual([]);
    // The same op on the file with CRLF and a byte order mark gives the same text with CRLF and the mark.
    const variant = run(open(`${BOM}${crlf(text)}`));
    if (!variant.ok) throw new Error(`CRLF: ${variant.reason}: ${variant.message}`);
    expect(applyEdits(`${BOM}${crlf(text)}`, variant.value).text).toBe(`${BOM}${crlf(out)}`);
  });

  it('touches only the splices it reports: undoing them gives the bytes back', () => {
    for (const [, file, run] of cases) {
      const text = fixture(file);
      const plan = run(open(text));
      if (!plan.ok) continue;
      const { text: out, inverse } = applyEdits(text, plan.value);
      expect(applyEdits(out, inverse).text).toBe(text);
    }
  });

  it('keeps the value when it copies anchors or converts line endings', () => {
    const doc = open(fixture('shared.yml'));
    for (const plan of [dealias(doc, ['jobs', 'again']), dealiasAnchor(doc, 'job'), convertEol(doc, '\r\n')])
      expect(plan.ok && valueOf(plan.documents[PATH]!)).toEqual(valueOf(doc));
  });

  it('writes nothing for a value that is already there', () => {
    const doc = open(fixture('events.yml'));
    expect(set(doc, ['jobs', 'build', 'timeout-minutes'], 30)).toMatchObject({ ok: true, value: [] });
    expect(move(doc, ['jobs', 'build', 'steps'], 1, 1)).toMatchObject({ ok: true, value: [] });
    expect(renameKey(doc, ['jobs', 'build'], 'build')).toMatchObject({ ok: true, value: [] });
  });

  it('reports what it set or added, for the selection', () => {
    const doc = open(fixture('events.yml'));
    expect(set(doc, ['jobs', 'build', 'if'], 'x', { order: JOB })).toMatchObject({
      select: { file: PATH, path: ['jobs', 'build', 'if'] },
      label: "Added build's `if`",
    });
    expect(insert(doc, ['jobs', 'build', 'steps'], 0, { run: 'x' })).toMatchObject({
      select: { path: ['jobs', 'build', 'steps', 0] },
    });
    expect(move(doc, ['jobs', 'build', 'steps'], 0, 2)).toMatchObject({
      select: { path: ['jobs', 'build', 'steps', 2] },
      label: "Moved build's step 1",
    });
  });
});

function coreErrors(text: string): string[] {
  const project = loadProject({ root: '.', fs: memoryFileSystem({ [PATH]: text }), validateSchema: false });
  return (project.workflows.get(PATH)?.parseErrors ?? []).map((e) => e.message);
}
