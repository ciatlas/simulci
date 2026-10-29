import { describe, expect, it } from 'vitest';
import {
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
import { fixture } from './corpus';

// The byte-change and data-loss cases the adversarial review of the primitives found, each kept fixed here.

const PATH = '.github/workflows/ci.yml';
const open = (text: string) => WorkflowDocument.open(text, { path: PATH, kind: 'workflow' });

/** The text an edit leaves, or `refused: <reason>`. */
const result = (plan: EditPlan<TextEdit[]>): string =>
  plan.ok ? plan.documents[PATH]!.text : `refused: ${plan.reason}`;

const job = (body: string) => `on: push\njobs:\n  a:\n    runs-on: x\n${body}`;

describe('review regressions: values and comments', () => {
  it('patches a list by its values, so comments and quotes stay with them', () => {
    const doc = open(
      job('    needs:\n      - build # compiles\n      - lint # style only\n      - test # the slow one\n'),
    );
    expect(result(set(doc, ['jobs', 'a', 'needs'], ['build', 'test']))).toBe(
      job('    needs:\n      - build # compiles\n      - test # the slow one\n'),
    );
    const branches = open(
      "on:\n  push:\n    branches:\n      - main # protected\n      - 'release/**' # glob\n",
    );
    expect(result(set(branches, ['on', 'push', 'branches'], ['release/**', 'main']))).toBe(
      "on:\n  push:\n    branches:\n      - 'release/**' # glob\n      - main # protected\n",
    );
  });

  it("keeps an item's comment and a block header's comment when the value is written anew", () => {
    const empty = open('on:\n  push:\n    branches:\n      - # release goes here\n      - main\n');
    expect(result(set(empty, ['on', 'push', 'branches', 0], 'release'))).toBe(
      'on:\n  push:\n    branches:\n      - release # release goes here\n      - main\n',
    );
    const block = open(
      job(
        '    steps:\n      - uses: x/y@v1\n        with:\n          args: | # sorted\n            a\n            b\n',
      ),
    );
    expect(result(set(block, ['jobs', 'a', 'steps', 0, 'with', 'args'], ['a', 'b']))).toBe(
      job('    steps:\n      - uses: x/y@v1\n        with:\n          args: [a, b] # sorted\n'),
    );
  });

  it('writes a value on the line below its key as one after the key, leaving no blank line', () => {
    const doc = open(job('    if:\n      always()\n    needs:\n      build\n'));
    expect(result(set(doc, ['jobs', 'a', 'if'], null))).toBe(job('    if:\n    needs:\n      build\n'));
    expect(result(set(doc, ['jobs', 'a', 'needs'], ['build', 'test']))).toBe(
      job('    if:\n      always()\n    needs: [build, test]\n'),
    );
  });

  it('gives a comment touching a quoted token its space once the token is gone', () => {
    const doc = open(job('    timeout-minutes: "5"# minutes\n'));
    expect(result(set(doc, ['jobs', 'a', 'timeout-minutes'], 10))).toBe(
      job('    timeout-minutes: 10 # minutes\n'),
    );
    expect(result(set(doc, ['jobs', 'a', 'timeout-minutes'], { a: 1 }))).toBe(
      job('    timeout-minutes: # minutes\n      a: 1\n'),
    );
  });

  it('quotes what other YAML parsers read differently: a `<<` key, a line separator, a flow key', () => {
    const doc = open(job('    steps:\n      - uses: a/b@v1\n        with: {x: 1}\n'));
    expect(result(renameKey(doc, ['jobs', 'a', 'runs-on'], '<<'))).toContain("    '<<': x\n");
    expect(result(set(doc, ['name'], 'CI\u2028nightly'))).toContain('name: "CI\\u2028nightly"\n');
    expect(result(set(doc, ['jobs', 'a', 'steps', 0, 'with', 'a,b'], 'v'))).toContain(
      "with: {x: 1, 'a,b': v}\n",
    );
  });

  it('writes a comment with line breaks as several comment lines, and refuses one with no line to go on', () => {
    const doc = open(job('    needs: [b]\n    steps:\n      - run: echo\n'));
    const plan = insert(
      doc,
      ['jobs', 'a', 'steps'],
      1,
      { run: 'x' },
      { commentBefore: ['note\r      - run: injected', 'two\u2028lines'] },
    );
    expect(result(plan)).toBe(
      job(
        '    needs: [b]\n    steps:\n      - run: echo\n      # note\n      #       - run: injected\n      # two\n      # lines\n      - run: x\n',
      ),
    );
    expect(result(insert(doc, ['jobs', 'a', 'needs'], 1, 'c', { commentBefore: ['why'] }))).toBe(
      'refused: unsupported-shape',
    );
    expect(result(insert(doc, ['jobs', 'a', 'services'], 0, 'c', { commentBefore: ['why'] }))).toBe(
      'refused: unsupported-shape',
    );
  });

  it("uses the file's key offset for the map items of a new list", () => {
    const doc = open(
      'on: push\njobs:\n    build:\n        runs-on: x\n        steps:\n        -   uses: a@v1\n',
    );
    expect(
      result(set(doc, ['jobs', 'build', 'strategy'], { matrix: { include: [{ os: 'linux', node: 20 }] } })),
    ).toContain('                -   os: linux\n                    node: 20\n');
  });
});

describe('review regressions: lines and separators', () => {
  it('keeps the comments between an inline first key and the next key when the first key goes', () => {
    const doc = open(job('    steps:\n      - name: x\n      # about run\n        run: y\n'));
    expect(result(remove(doc, ['jobs', 'a', 'steps', 0, 'name']))).toBe(
      job('    steps:\n      -\n      # about run\n        run: y\n'),
    );
  });

  it("takes the last item's deeper comment with it when the list is emptied", () => {
    const doc = open(
      'on:\n  push:\n    branches:\n      - main\n        # main only for now\n  pull_request:\n',
    );
    expect(result(remove(doc, ['on', 'push', 'branches', 0]))).toBe(
      'on:\n  push:\n    branches:\n  pull_request:\n',
    );
  });

  it("keeps the comments in an emptied collection that are not its last item's", () => {
    // Found by the property test (seed -1817638724): emptying `jobs` rewrote all its lines, the comment too.
    const doc = open("on: push\njobs:\n    # nobody's\n  a:\n    runs-on: x\n  # nor this\n");
    expect(result(remove(doc, ['jobs', 'a', 'runs-on'], 'remove'))).toBe(
      "on: push\njobs:\n    # nobody's\n  # nor this\n",
    );
    expect(result(remove(doc, ['jobs', 'a'], 'null'))).toBe(
      "on: push\njobs:\n    # nobody's\n  # nor this\n",
    );
    const blank = open('on: push\njobs:\n\n  a:\n    runs-on: x\n\nenv:\n  A: 1\n');
    expect(result(remove(blank, ['jobs', 'a'], 'null'))).toBe('on: push\njobs:\n\nenv:\n  A: 1\n');
  });

  it('keeps no final line break where the file had none', () => {
    const doc = open('on: push\njobs:\n  b:\n    runs-on: x\n    steps:\n      - run: x');
    expect(result(remove(doc, ['jobs', 'b', 'steps', 0]))).toBe(
      'on: push\njobs:\n  b:\n    runs-on: x\n    steps:',
    );
    expect(result(set(doc, ['jobs', 'b', 'steps'], 'x'))).toBe(
      'on: push\njobs:\n  b:\n    runs-on: x\n    steps: x',
    );
  });

  it("does not count a kept block scalar's blank line as a separator", () => {
    const doc = open(job('    steps:\n      - run: |+\n          keep\n\n      - run: one\n'));
    expect(result(insert(doc, ['jobs', 'a', 'steps'], 2, { run: 'two' }))).toBe(
      job('    steps:\n      - run: |+\n          keep\n\n      - run: one\n      - run: two\n'),
    );
  });

  it("gives the first key the comments above it once a blank line parts them from the file's header", () => {
    const doc = open('# Licence.\n\n# Triggers.\non: push\njobs:\n  a:\n    runs-on: x\n');
    expect(result(set(doc, ['name'], 'CI', { order: ['name', 'on', 'jobs'] }))).toBe(
      '# Licence.\n\nname: CI\n# Triggers.\non: push\njobs:\n  a:\n    runs-on: x\n',
    );
  });

  it('moves the anchor or tag of a flow item with it', () => {
    const doc = open(job('    needs: [&n a, !!str 1, b]\n'));
    expect(result(remove(doc, ['jobs', 'a', 'needs', 0]))).toBe(job('    needs: [!!str 1, b]\n'));
    expect(result(insert(doc, ['jobs', 'a', 'needs'], 1, 'z'))).toBe(
      job('    needs: [&n a, z, !!str 1, b]\n'),
    );
  });

  it("refuses a move before an item on its parent's line or onto a comment a block scalar would take in", () => {
    const nested = open(
      job('    strategy:\n      matrix:\n        include:\n          - - a\n            - b\n'),
    );
    expect(result(move(nested, ['jobs', 'a', 'strategy', 'matrix', 'include', 0], 1, 0))).toBe(
      'refused: unsupported-shape',
    );
    const deep = open(
      job('    steps:\n      - run: |\n          one\n      - run: two\n\n          # - run: three\n'),
    );
    expect(result(move(deep, ['jobs', 'a', 'steps'], 0, 1))).toBe('refused: unsupported-shape');
  });
});

describe('review regressions: anchors', () => {
  const keyed = 'on: push\njobs:\n  &b build:\n    runs-on: x\n  test:\n    needs: *b\n    runs-on: x\n';

  it('renames a key whose anchor aliases use only with "Change all", the aliases following it', () => {
    expect(result(renameKey(open(keyed), ['jobs', 'build'], 'compile'))).toBe('refused: shared-anchor');
    expect(result(renameKey(open(keyed), ['jobs', 'build'], 'compile', { shared: 'all' }))).toBe(
      keyed.replace('&b build:', '&b compile:'),
    );
    expect(result(dealiasAnchor(open(keyed), 'b'))).toBe(
      keyed.replace('&b build', 'build').replace('*b', 'build'),
    );
  });

  it('applies a list edit once to each use under "Change all"', () => {
    const doc = open(
      'on: push\njobs:\n  a:\n    runs-on: x\n    steps: &s\n      - run: x\n  b:\n    runs-on: x\n    steps: *s\n',
    );
    expect(result(insert(doc, ['jobs', 'a', 'steps'], 1, { run: 'y' }, { shared: 'all' }))).toContain(
      '      - run: x\n      - run: y\n',
    );
  });

  it('refuses a value whose anchor is on a line of its own', () => {
    expect(result(set(open('a:\n  &s\n  - run: x\nb: *s\n'), ['a'], 'z', { shared: 'all' }))).toBe(
      'refused: unsupported-shape',
    );
  });

  it('refuses a text replacement that touches an anchor, an alias or a shared value', () => {
    const text = fixture('anchored-runs-on.yml');
    const doc = open(text);
    const at = (s: string) => ({ from: text.indexOf(s), to: text.indexOf(s) + s.length });
    expect(result(replaceAt(doc, at('&runner'), '&runner', '&os'))).toBe('refused: unsupported-shape');
    expect(result(replaceAt(doc, at('ubuntu-latest'), 'ubuntu-latest', 'windows-latest'))).toBe(
      'refused: shared-anchor',
    );
    expect(result(replaceAt(doc, at('make'), 'make', '&runner make'))).toBe('refused: internal');
  });

  it('refuses every edit of a file with an alias inside its own anchor, without throwing', () => {
    const doc = open('on: push\nenv: &e\n  A: 1\n  SELF: *e\njobs:\n  a:\n    runs-on: x\n');
    expect(result(set(doc, ['jobs', 'a', 'runs-on'], 'y'))).toBe('refused: anchor');
  });
});

describe('review regressions: what the ops review found in the primitives', () => {
  it('adds a key to `{}` and an item to `[]` by writing the collection anew', () => {
    const doc = open('on: push\njobs: {}\nenv: []\n');
    expect(result(set(doc, ['jobs', 'a'], { 'runs-on': 'x' }))).toBe(
      'on: push\njobs:\n  a:\n    runs-on: x\nenv: []\n',
    );
    expect(result(insert(doc, ['env'], 0, 'x'))).toBe('on: push\njobs: {}\nenv: [x]\n');
  });

  it('refuses an index that is not a whole number', () => {
    const doc = open(job('    steps:\n      - run: a\n'));
    expect(result(insert(doc, ['jobs', 'a', 'steps'], 0.5, { run: 'b' }))).toBe('refused: out-of-range');
    expect(result(insert(doc, ['jobs', 'a', 'steps'], Number.NaN, { run: 'b' }))).toBe(
      'refused: out-of-range',
    );
  });

  it('adds a missing map to every use under "Change all"', () => {
    const doc = open(fixture('shared.yml'));
    const all = set(doc, ['jobs', 'build', 'outputs', 'o'], 'v', { shared: 'all' });
    expect(result(all)).toContain('    outputs:\n      o: v\n');
  });

  it('adds a key to `{}` inside a flow collection in its braces, and refuses an empty value there', () => {
    const doc = open('on: push\njobs:\n  build: {runs-on: x, env: {}, outputs: ~, steps: [{run: a}]}\n');
    expect(result(set(doc, ['jobs', 'build', 'env', 'X'], '1'))).toContain("env: {X: '1'}");
    expect(result(set(doc, ['jobs', 'build', 'outputs', 'o'], 'v'))).toBe('refused: flow-shape');
  });
});
