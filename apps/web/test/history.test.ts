import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type Context,
  close,
  emptyHistory,
  grouped,
  type History,
  MAX_ENTRIES,
  MAX_UNITS,
  PAUSE_MS,
  type Refusal,
  redo,
  redoLabel,
  type Step,
  stampOf,
  type Texts,
  transact,
  typed,
  undo,
  undoLabel,
} from '../src/state/history';
import { runs } from './runs';

const CI = '.github/workflows/ci.yml';
const RELEASE = '.github/workflows/release.yml';
const at = (ms: number): Context => ({ at: ms, selection: { focus: CI } });

/** The texts after a step, `null` removing a file, as the store commits them. */
function applied(texts: Texts, changes: Step['changes']): Record<string, string> {
  const next: Record<string, string> = { ...texts };
  for (const [path, text] of Object.entries(changes)) {
    if (text === null) delete next[path];
    else next[path] = text;
  }
  return next;
}

function ok(result: Step | Refusal | undefined): Step {
  if (result === undefined || 'refused' in result) throw new Error(`refused: ${JSON.stringify(result)}`);
  return result;
}

/** A tiny editor over the reducer: what the store does, without the store. */
function editor(initial: Record<string, string>) {
  let texts: Record<string, string> = { ...initial };
  let h: History = emptyHistory();
  const step = (result: Step | Refusal | undefined): Step | Refusal | undefined => {
    if (result && !('refused' in result)) {
      texts = applied(texts, result.changes);
      h = result.history;
    }
    return result;
  };
  return {
    get texts() {
      return texts;
    },
    get h() {
      return h;
    },
    type: (path: string, from: number, to: number, insert: string, ms: number, alone?: 'paste') =>
      step(typed(h, texts, path, [{ from, to, insert }], at(ms), alone)),
    tx: (files: Parameters<typeof transact>[2]['files'], ms = 0) =>
      step(transact(h, texts, { label: 'Op', origin: 'op', files }, at(ms))),
    field: (key: string, files: Parameters<typeof transact>[2]['files'], ms = 0) =>
      step(grouped(h, texts, key, { label: `Field ${key}`, origin: 'field', files }, at(ms))),
    close: () => {
      h = close(h);
    },
    undo: () => step(undo(h, texts)),
    redo: () => step(redo(h, texts)),
    /** Undoes, or redoes, until nothing is left; a refusal fails the test. */
    all: (what: 'undo' | 'redo') => {
      for (;;) {
        const result = what === 'undo' ? step(undo(h, texts)) : step(redo(h, texts));
        if (result === undefined) return;
        if ('refused' in result) throw new Error(`${what} refused: ${result.path}`);
      }
    },
    /** Something outside the history changed a file. */
    tamper: (path: string, text: string) => {
      texts = { ...texts, [path]: text };
    },
  };
}

describe('the edit history', () => {
  it('commits a transaction over several files at once, and undoes and redoes it whole', () => {
    const e = editor({ [CI]: 'on: push\n', [RELEASE]: 'on: release\n' });
    ok(
      e.tx([
        { path: CI, edits: [{ from: 4, to: 8, insert: '[push]' }] },
        { path: RELEASE, edits: [{ from: 0, to: 0, insert: '# r\n' }] },
      ]),
    );
    expect(e.texts).toEqual({ [CI]: 'on: [push]\n', [RELEASE]: '# r\non: release\n' });
    expect(e.h.past).toHaveLength(1);
    expect(e.h.past[0]).toMatchObject({
      id: 1,
      label: 'Op',
      origin: 'op',
      selection: { before: { focus: CI } },
    });
    expect(e.h.lastOrigin).toBe('op');
    ok(e.undo());
    expect(e.texts).toEqual({ [CI]: 'on: push\n', [RELEASE]: 'on: release\n' });
    expect(e.h).toMatchObject({ past: [], lastOrigin: 'undo' });
    expect(e.h.future).toHaveLength(1);
    ok(e.redo());
    expect(e.texts).toEqual({ [CI]: 'on: [push]\n', [RELEASE]: '# r\non: release\n' });
    expect(e.h).toMatchObject({ future: [], lastOrigin: 'redo' });
  });

  it('applies none of a transaction when one file refuses, and refuses edits planned against older text', () => {
    const e = editor({ [CI]: 'on: push\n', [RELEASE]: 'on: release\n' });
    const before = e.h;
    expect(
      e.tx([
        { path: CI, edits: [{ from: 0, to: 0, insert: '# a\n' }] },
        { path: RELEASE, edits: [{ from: 50, to: 60, insert: 'x' }] },
      ]),
    ).toEqual({ refused: 'range', path: RELEASE });
    expect(
      e.tx([
        { path: CI, edits: [{ from: 0, to: 0, insert: '# a\n' }] },
        { path: RELEASE, edits: [], expect: stampOf('on: push\n') },
      ]),
    ).toEqual({ refused: 'stale', path: RELEASE });
    expect(e.tx([{ path: 'gone.yml', edits: [] }])).toEqual({ refused: 'missing', path: 'gone.yml' });
    expect(e.tx([{ path: CI, edits: [], create: true }])).toEqual({ refused: 'exists', path: CI });
    expect(e.texts).toEqual({ [CI]: 'on: push\n', [RELEASE]: 'on: release\n' });
    expect(e.h).toBe(before);
    // The text the edits were planned against: they go through.
    ok(e.tx([{ path: CI, edits: [{ from: 0, to: 0, insert: '#\n' }], expect: stampOf('on: push\n') }]));
    expect(e.texts[CI]).toBe('#\non: push\n');
  });

  it('leaves no entry for edits that change nothing, and refuses one file twice in a transaction', () => {
    const e = editor({ [CI]: 'on: push\n' });
    ok(e.tx([{ path: CI, edits: [{ from: 4, to: 8, insert: 'push' }] }]));
    expect(e.h.past).toEqual([]);
    expect(() =>
      e.tx([
        { path: CI, edits: [] },
        { path: CI, edits: [] },
      ]),
    ).toThrow(/twice/);
  });

  it('creates and removes files, and undoes either', () => {
    const e = editor({ [CI]: 'on: push\n' });
    const TEST = '.github/simulci/tests/ci.test.yml';
    ok(e.tx([{ path: TEST, edits: [{ from: 0, to: 0, insert: 'cases: []\n' }], create: true }]));
    expect(e.texts[TEST]).toBe('cases: []\n');
    ok(e.tx([{ path: CI, edits: [], remove: true }]));
    expect(e.texts).toEqual({ [TEST]: 'cases: []\n' });
    ok(e.undo());
    expect(e.texts).toEqual({ [CI]: 'on: push\n', [TEST]: 'cases: []\n' });
    ok(e.undo());
    expect(e.texts).toEqual({ [CI]: 'on: push\n' });
    ok(e.redo());
    ok(e.redo());
    expect(e.texts).toEqual({ [TEST]: 'cases: []\n' });
  });

  it('groups keys typed one after another into one entry with one region edit', () => {
    const e = editor({ [CI]: 'on: push\n' });
    ok(e.type(CI, 8, 8, ' ', 0));
    ok(e.type(CI, 9, 9, '#', 100));
    ok(e.type(CI, 10, 10, 'x', 200));
    // A backspace touches where the last key ended: still the same group.
    ok(e.type(CI, 10, 11, '', 300));
    expect(e.texts[CI]).toBe('on: push #\n');
    expect(e.h.past).toEqual([]);
    expect(e.h.group).toMatchObject({
      key: `pane:${CI}`,
      label: 'Typed in ci.yml',
      before: { [CI]: 'on: push\n' },
    });
    expect(undoLabel(e.h)).toBe('Typed in ci.yml');
    e.close();
    expect(e.h.group).toBeUndefined();
    expect(e.h.past).toHaveLength(1);
    expect(e.h.past[0]!.files).toEqual([
      {
        path: CI,
        edits: [{ from: 8, to: 8, insert: ' #' }],
        inverse: [{ from: 8, to: 10, insert: '' }],
        before: stampOf('on: push\n'),
        after: stampOf('on: push #\n'),
      },
    ]);
    ok(e.undo());
    expect(e.texts[CI]).toBe('on: push\n');
  });

  it('closes a group on a pause, a cursor jump, a line break, a paste, another file and any transaction', () => {
    const e = editor({ [CI]: 'abc\n', [RELEASE]: 'xyz\n' });
    ok(e.type(CI, 3, 3, 'd', 0));
    ok(e.type(CI, 4, 4, 'e', PAUSE_MS + 1)); // a pause
    ok(e.type(CI, 0, 0, '>', PAUSE_MS + 2)); // a jump to the start
    ok(e.type(CI, 1, 1, '\n', PAUSE_MS + 3)); // a line break joins the group, then closes it
    expect(e.h.group).toBeUndefined();
    ok(e.type(CI, 2, 2, 'f', PAUSE_MS + 4));
    ok(e.type(CI, 3, 3, 'PASTED', PAUSE_MS + 5, 'paste')); // its own entry
    ok(e.type(RELEASE, 0, 0, '#', PAUSE_MS + 6));
    ok(e.type(CI, 0, 0, '!', PAUSE_MS + 7)); // another file
    ok(e.tx([{ path: RELEASE, edits: [{ from: 0, to: 0, insert: '%' }] }], PAUSE_MS + 8));
    expect(e.h.past.map((t) => t.label)).toEqual([
      'Typed in ci.yml',
      'Typed in ci.yml',
      'Typed in ci.yml',
      'Typed in ci.yml',
      'Pasted into ci.yml',
      'Typed in release.yml',
      'Typed in ci.yml',
      'Op',
    ]);
    expect(e.texts).toEqual({ [CI]: '!>\nfPASTEDabcde\n', [RELEASE]: '%#xyz\n' });
    e.all('undo');
    expect(e.texts).toEqual({ [CI]: 'abc\n', [RELEASE]: 'xyz\n' });
  });

  it('closes a group into what it typed: a change made outside the history while it is open stops its undo', () => {
    const e = editor({ [CI]: 'abc' });
    ok(e.type(CI, 3, 3, 'd', 0));
    e.tamper(CI, 'XYZabcd');
    e.close();
    expect(e.h.past[0]!.files[0]!.edits).toEqual([{ from: 3, to: 3, insert: 'd' }]);
    expect(e.undo()).toEqual({ refused: 'desync', path: CI });
    expect(e.texts[CI]).toBe('XYZabcd');
    // A key after such a change does not continue the group either.
    const f = editor({ [CI]: 'abc' });
    ok(f.type(CI, 3, 3, 'd', 0));
    f.tamper(CI, 'abcd!');
    ok(f.type(CI, 5, 5, 'e', 10));
    expect(f.h.past.map((t) => t.files[0]!.edits)).toEqual([[{ from: 3, to: 3, insert: 'd' }]]);
  });

  it('closes a group on a pause of exactly 300 ms, and names an action by its directory', () => {
    const SETUP = '.github/actions/setup/action.yml';
    const e = editor({ [SETUP]: 'name: x\n' });
    ok(e.type(SETUP, 0, 0, 'a', 0));
    ok(e.type(SETUP, 1, 1, 'b', PAUSE_MS));
    expect(e.h.past.map((t) => t.label)).toEqual(['Typed in setup/action.yml']);
  });

  it('drops a group typed back to its text, and undo then undoes the entry before it', () => {
    const e = editor({ [CI]: 'abc' });
    ok(e.tx([{ path: CI, edits: [{ from: 0, to: 0, insert: '>' }] }]));
    ok(e.type(CI, 4, 4, 'd', 1000));
    ok(e.type(CI, 4, 5, '', 1100));
    expect(undoLabel(e.h)).toBe('Op');
    ok(e.undo());
    expect(e.texts[CI]).toBe('abc');
    expect(e.h.past).toEqual([]);
  });

  it('clears the redo stack with any new edit, typing included', () => {
    const e = editor({ [CI]: 'abc' });
    ok(e.tx([{ path: CI, edits: [{ from: 0, to: 0, insert: '>' }] }]));
    ok(e.undo());
    expect(redoLabel(e.h)).toBe('Op');
    ok(e.type(CI, 3, 3, 'd', 0));
    expect(e.h.future).toEqual([]);
    expect(redoLabel(e.h)).toBeUndefined();
    expect(e.redo()).toBeUndefined();
  });

  it('refuses an undo or a redo when a file is not the text the history left, and writes nothing', () => {
    const e = editor({ [CI]: 'abc', [RELEASE]: 'xyz' });
    ok(
      e.tx([
        { path: CI, edits: [{ from: 0, to: 0, insert: '1' }] },
        { path: RELEASE, edits: [{ from: 0, to: 0, insert: '2' }] },
      ]),
    );
    e.tamper(RELEASE, '2xyz!');
    // Never half undone: the file that still matches is not undone either.
    expect(e.undo()).toEqual({ refused: 'desync', path: RELEASE });
    expect(e.texts).toEqual({ [CI]: '1abc', [RELEASE]: '2xyz!' });
    e.tamper(RELEASE, '2xyz');
    ok(e.undo());
    e.tamper(CI, 'abc?');
    expect(e.redo()).toEqual({ refused: 'desync', path: CI });
    expect(e.texts).toEqual({ [CI]: 'abc?', [RELEASE]: 'xyz' });
  });

  it('keeps the entries under 16 MB of edit text, the oldest dropped first', () => {
    const e = editor({ [CI]: '' });
    const big = 'x'.repeat(MAX_UNITS / 2 + 1);
    ok(e.tx([{ path: CI, edits: [{ from: 0, to: 0, insert: big }] }]));
    ok(e.tx([{ path: CI, edits: [{ from: 0, to: 0, insert: big }] }]));
    expect(e.h.past.map((t) => t.id)).toEqual([2]);
    ok(e.tx([{ path: CI, edits: [{ from: 0, to: 0, insert: 'small' }] }]));
    expect(e.h.past.map((t) => t.id)).toEqual([2, 3]);
  });

  it('groups the commits of a field’s visit under its key into one entry, with the label of the first', () => {
    const e = editor({ [CI]: 'name: a\nrun: x\n' });
    ok(
      e.field('name', [
        { path: CI, edits: [{ from: 6, to: 7, insert: 'ab' }], expect: stampOf('name: a\nrun: x\n') },
      ]),
    );
    ok(e.field('name', [{ path: CI, edits: [{ from: 8, to: 8, insert: 'c' }] }], 5000));
    expect(e.h.past).toHaveLength(0);
    expect(undoLabel(e.h)).toBe('Field name');
    expect(e.texts[CI]).toBe('name: abc\nrun: x\n');
    // Another field's commit closes the first visit; so does any transaction.
    ok(e.field('run', [{ path: CI, edits: [{ from: 15, to: 16, insert: 'y' }] }]));
    expect(e.h.past.map((t) => t.label)).toEqual(['Field name']);
    ok(e.tx([{ path: CI, edits: [{ from: 0, to: 0, insert: '#\n' }] }]));
    expect(e.h.past.map((t) => [t.label, t.origin])).toEqual([
      ['Field name', 'field'],
      ['Field run', 'field'],
      ['Op', 'op'],
    ]);
    e.all('undo');
    expect(e.texts[CI]).toBe('name: a\nrun: x\n');
    e.all('redo');
    expect(e.texts[CI]).toBe('#\nname: abc\nrun: y\n');
  });

  it('refuses a field commit planned against older text, leaves the history alone for one that changes nothing, and never groups a created file', () => {
    const e = editor({ [CI]: 'a\n' });
    expect(
      e.field('k', [{ path: CI, edits: [{ from: 0, to: 1, insert: 'b' }], expect: stampOf('x\n') }]),
    ).toEqual({
      refused: 'stale',
      path: CI,
    });
    ok(e.field('k', [{ path: CI, edits: [{ from: 0, to: 1, insert: 'b' }] }]));
    const before = e.h;
    ok(e.field('k', [{ path: CI, edits: [{ from: 0, to: 1, insert: 'b' }] }]));
    expect(e.h).toBe(before);
    ok(e.field('k', [{ path: RELEASE, edits: [{ from: 0, to: 0, insert: 'on: push\n' }], create: true }]));
    expect(e.h.group).toBeUndefined();
    expect(e.h.past.map((t) => t.label)).toEqual(['Field k', 'Field k']);
    e.all('undo');
    expect(e.texts).toEqual({ [CI]: 'a\n' });
  });

  it('keeps at most the last 500 entries', () => {
    const e = editor({ [CI]: '' });
    for (let i = 0; i < MAX_ENTRIES + 5; i++)
      ok(e.tx([{ path: CI, edits: [{ from: 0, to: 0, insert: 'x' }] }], i));
    expect(e.h.past).toHaveLength(MAX_ENTRIES);
    expect(e.h.past[0]!.id).toBe(6);
    expect(e.h.next).toBe(MAX_ENTRIES + 6);
  });
});

/** A text of lines that end the way `eol` says. */
const textOf = (lines: string[], eol: '\n' | '\r\n'): string => lines.map((l) => l + eol).join('');

const line = fc.string({ unit: fc.constantFrom('a', 'b', ' ', ':', '-', 'é', '😀'), maxLength: 12 });
const insert = fc.string({ unit: fc.constantFrom('x', ' ', '\n', '\r\n', 'é', '😀', '#'), maxLength: 6 });

type Action =
  | { kind: 'type'; file: 0 | 1; pos: number; del: number; insert: string; dt: number; paste: boolean }
  | { kind: 'tx'; edits: [number, number, string][] }
  | { kind: 'field'; key: 'a' | 'b'; file: 0 | 1; edit: [number, number, string] }
  | { kind: 'close' | 'undo' | 'redo' };

const action: fc.Arbitrary<Action> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constant('type' as const),
      file: fc.constantFrom(0 as const, 1 as const),
      pos: fc.nat(),
      del: fc.nat({ max: 3 }),
      insert,
      dt: fc.constantFrom(0, 50, 200, PAUSE_MS + 1),
      paste: fc.boolean(),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('tx' as const),
      edits: fc.array(fc.tuple(fc.nat(), fc.nat({ max: 4 }), insert), { minLength: 2, maxLength: 2 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('field' as const),
      key: fc.constantFrom('a' as const, 'b' as const),
      file: fc.constantFrom(0 as const, 1 as const),
      edit: fc.tuple(fc.nat(), fc.nat({ max: 4 }), insert),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constantFrom('close' as const, 'undo' as const, 'redo' as const) }),
  },
);

/** An edit of `text` at a position the action names, clipped to the text and kept off a surrogate's halves. */
function editAt(text: string, pos: number, del: number, ins: string) {
  let from = pos % (text.length + 1);
  if (from > 0 && /[\uDC00-\uDFFF]/.test(text[from] ?? '')) from--;
  let to = Math.min(text.length, from + del);
  if (/[\uDC00-\uDFFF]/.test(text[to] ?? '')) to++;
  return { from, to, insert: ins };
}

const PATHS = [CI, RELEASE] as const;

/** One action on the editor, at `now`; nothing changes the texts outside the history, so nothing is refused. */
function play(e: ReturnType<typeof editor>, act: Action, now: number): void {
  if (act.kind === 'type') {
    const path = PATHS[act.file];
    const edit = editAt(e.texts[path]!, act.pos, act.del, act.insert);
    ok(e.type(path, edit.from, edit.to, edit.insert, now, act.paste ? 'paste' : undefined));
  } else if (act.kind === 'tx') {
    const files = PATHS.map((path, i) => {
      const [pos, del, ins] = act.edits[i]!;
      return { path, edits: [editAt(e.texts[path]!, pos, del, ins)] };
    });
    ok(e.tx(files));
  } else if (act.kind === 'field') {
    const path = PATHS[act.file];
    const [pos, del, ins] = act.edit;
    ok(e.field(act.key, [{ path, edits: [editAt(e.texts[path]!, pos, del, ins)] }]));
  } else if (act.kind === 'close') e.close();
  else {
    const result = act.kind === 'undo' ? e.undo() : e.redo();
    if (result && 'refused' in result) throw new Error(`refused ${act.kind}`);
  }
}

describe('the edit history, over random interleavings', () => {
  it('undone completely, gives back the bytes it started from, on LF and CRLF files', () => {
    fc.assert(
      fc.property(
        fc.array(line, { maxLength: 6 }),
        fc.array(line, { maxLength: 6 }),
        fc.constantFrom('\n' as const, '\r\n' as const),
        fc.array(action, { maxLength: 40 }),
        (a, b, eol, actions) => {
          const initial = { [CI]: textOf(a, eol), [RELEASE]: textOf(b, eol) };
          const e = editor(initial);
          let now = 0;
          for (const act of actions) {
            if (act.kind === 'type') now += act.dt;
            play(e, act, now);
          }
          e.close();
          const end = e.texts;
          const entries = e.h.past.length;
          e.all('undo');
          expect(e.texts).toEqual(initial);
          // Redone as far as it had come: the entries undone before the end stay undone.
          for (let i = 0; i < entries; i++) ok(e.redo());
          expect(e.texts).toEqual(end);
        },
      ),
      { numRuns: runs(200) },
    );
  });
});
