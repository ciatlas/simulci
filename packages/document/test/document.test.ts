import { loadProject, memoryFileSystem } from '@ciatlas/core';
import * as fc from 'fast-check';
import { parseDocument } from 'yaml';
import { describe, expect, it, vi } from 'vitest';

import { WorkflowDocument, type OpenOptions, type Refusal } from '@simulci/document';
import { invalidYaml } from '../src/refusal';
import { BOM, corpus, fixture } from './corpus';
import { runs } from './runs';

// The corpus-wide checks run over every file and its CRLF variants; under coverage they take seconds.
vi.setConfig({ testTimeout: 60_000 });

const PATH = '.github/workflows/ci.yml';
const open = (text: string, more: Partial<OpenOptions> = {}) =>
  WorkflowDocument.open(text, { path: PATH, kind: 'workflow', ...more });
const refusalOf = (doc: WorkflowDocument): Refusal | undefined =>
  doc.status.editable ? undefined : doc.status.refusal;

/** YAML-shaped noise: indicators, indentation, breaks, quotes and markers, so the parser meets every error path. */
const noise = fc.string({
  unit: fc.constantFrom(
    'a',
    'b',
    ' ',
    '  ',
    '\t',
    '\n',
    '\r\n',
    '\r',
    ':',
    '- ',
    '#',
    '&a',
    '*a',
    '[',
    ']',
    '{',
    '}',
    ',',
    '"',
    "'",
    '|',
    '>',
    '%YAML 1.1\n',
    '---\n',
    '...\n',
    '? ',
    '!',
    '<<: ',
  ),
  maxLength: 60,
});

describe('WorkflowDocument.open', () => {
  it('reads an ordinary workflow as editable', () => {
    const doc = open(fixture('comments.yml'));
    expect(doc.status).toEqual({ editable: true });
    expect(doc.errors).toEqual([]);
    expect(doc.documents).toBe(1);
    expect(doc.path).toBe(PATH);
    expect(doc.kind).toBe('workflow');
  });

  it('never throws, and every read answers on any text', () => {
    fc.assert(
      fc.property(noise, fc.nat(), (text, at) => {
        const doc = open(text);
        const cursor = doc.pathAt(at % (text.length + 1));
        doc.jobs();
        for (const path of [cursor, [], ['jobs'], ['on', 0], ['a', 'b']]) {
          doc.get(path);
          doc.spanOf(path);
          doc.lineOf(path);
        }
      }),
      { numRuns: runs(500) },
    );
  });

  it('applies edits into a new document, parsed with the same options', () => {
    const doc = open('on: push\n', { generated: 'DO NOT EDIT', unlocked: true });
    const next = doc.apply([{ from: 4, to: 8, insert: 'pull_request' }]);
    expect(next.text).toBe('on: pull_request\n');
    expect(next.get(['on'])?.value).toBe('pull_request');
    expect(next.status).toEqual({ editable: true });
    expect(doc.text).toBe('on: push\n');
  });

  it('supports one document with a leading --- and a trailing ...', () => {
    const doc = open(fixture('markers.yml'));
    expect(doc.status).toEqual({ editable: true });
    expect(doc.jobs().map((j) => j.id)).toEqual(['only']);
    expect(open('...\n# only a comment\n').status).toEqual({ editable: true });
    expect(open('').status).toEqual({ editable: true });
  });
});

describe('parse parity with core', () => {
  /** What core reports for a workflow's text: its yaml parse errors, first line of the message, at their Loc. */
  function coreErrors(text: string): { message: string; line: number; column: number }[] {
    const project = loadProject({ root: '.', fs: memoryFileSystem({ [PATH]: text }), validateSchema: false });
    const errors = project.workflows.get(PATH)?.parseErrors ?? [];
    return errors
      .filter((e) => !e.message.includes('possible alias bomb'))
      .map((e) => ({ message: e.message, line: e.loc.line, column: e.loc.column }));
  }

  function ours(doc: WorkflowDocument) {
    return doc.errors.map((e) => {
      const { line, column } = doc.tree.lines.position(e.from);
      return { message: e.message.split('\n')[0]!, line, column };
    });
  }

  it('reports exactly the errors core reports, over the corpus', () => {
    for (const { name, text } of corpus()) {
      if (text.startsWith(BOM)) continue;
      expect(ours(open(text)), name).toEqual(coreErrors(text));
    }
  });

  it('reports exactly the errors and warnings of core’s parseDocument call, on any text', () => {
    fc.assert(
      fc.property(noise, (text) => {
        const doc = open(text);
        const want = parseDocument(text, { prettyErrors: false, strict: false });
        const shape = (e: { pos: [number, number]; code: string; message: string }) => ({
          from: e.pos[0],
          to: e.pos[1],
          code: e.code,
          message: e.message,
        });
        expect(doc.errors).toEqual(want.errors.map(shape));
        expect(doc.warnings).toEqual(want.warnings.map(shape));
      }),
      { numRuns: runs(1000) },
    );
  });

  it('accepts a comment right after a quoted scalar, as GitHub and core do', () => {
    expect(open('name: "x"# c\non: push\n').errors).toEqual([]);
    expect(coreErrors('name: "x"# c\non: push\n')).toEqual([]);
  });

  it('agrees with core on what is broken, so the hold and the lock agree', () => {
    fc.assert(
      fc.property(noise, (text) => {
        const locked = refusalOf(open(text))?.reason;
        const broken = coreErrors(text).length > 0;
        expect(locked === 'invalid-yaml' || locked === 'duplicate-key' || locked === 'multi-document').toBe(
          broken,
        );
      }),
      { numRuns: runs(300) },
    );
  });
});

describe('status', () => {
  it('locks a file that does not parse, at the line of its first error', () => {
    const refusal = refusalOf(open('on: push\njobs:\n  a: 1\n b: 2\n'));
    expect(refusal).toMatchObject({ reason: 'invalid-yaml', file: PATH, line: 4 });
    expect(refusal?.message).toBe(
      'ci.yml does not parse at line 4 (bad indentation). Fix it in the YAML pane; the graph shows the last version that parsed.',
    );
    expect(refusal?.fixes).toEqual([
      { kind: 'reveal', label: 'Show line 4', line: 4 },
      { kind: 'undo', label: 'Undo the last change' },
    ]);
  });

  it('says what is wrong in the author’s words, else in yaml’s', () => {
    expect(refusalOf(open('on:\n\tpush:\n'))?.message).toContain('(a tab used as indentation)');
    expect(refusalOf(open('name: a: b\n'))?.message).toContain('(a `: ` inside a value, which needs quotes)');
    expect(refusalOf(open('name: "x\n'))?.message).toContain('(a missing character)');
    expect(invalidYaml(PATH, 3, 'SOMETHING_NEW', 'Something new went wrong.').message).toContain(
      'at line 3 (something new went wrong)',
    );
  });

  it('names both lines of a duplicate key', () => {
    const refusal = refusalOf(open('on: push\njobs:\n  build:\n    if: a\n    runs-on: x\n    if: b\n'));
    expect(refusal).toMatchObject({
      reason: 'duplicate-key',
      line: 6,
      at: ['jobs', 'build', 'if'],
      message: 'jobs.build has two `if:` keys (lines 4 and 6); GitHub rejects the file.',
    });
    expect(refusalOf(open('on: push\non: pull_request\n'))?.message).toBe(
      'ci.yml has two `on:` keys (lines 1 and 2); GitHub rejects the file.',
    );
  });

  it('locks a file with more than one document', () => {
    const refusal = refusalOf(open('on: push\n---\njobs: {}\n'));
    expect(refusal).toMatchObject({
      reason: 'multi-document',
      line: 2,
      message: 'ci.yml holds two YAML documents (`---` on line 2); GitHub reads only the first.',
      fixes: [{ kind: 'reveal', label: 'Show line 2', line: 2 }],
    });
    expect(open('a: 1\n---\nb: 2\n---\nc: 3\n').documents).toBe(3);
  });

  it('locks a file with a directive, which changes how YAML reads it', () => {
    const refusal = refusalOf(open('%YAML 1.1\n---\non: push\n'));
    expect(refusal).toMatchObject({
      reason: 'directive',
      line: 1,
      message: 'ci.yml starts with a `%YAML 1.1` directive; edit it in the YAML pane.',
    });
    expect(refusalOf(open('%TAG ! tag:example.com,2026:\n---\non: push\n'))?.reason).toBe('directive');
  });

  it('locks a generated file until it is unlocked', () => {
    const text = '# This file is generated. DO NOT EDIT.\non: push\n';
    const refusal = refusalOf(open(text, { generated: 'DO NOT EDIT' }));
    expect(refusal).toMatchObject({
      reason: 'generated',
      line: 1,
      message: "ci.yml says 'DO NOT EDIT' on line 1: it is generated, and your edits would be overwritten.",
      fixes: [{ kind: 'unlock', label: 'Edit anyway' }],
    });
    expect(open(text, { generated: 'DO NOT EDIT', unlocked: true }).status).toEqual({ editable: true });
    const lock = refusalOf(
      open('on: push\n', { path: '.github/workflows/ci.lock.yml', generated: '.lock.yml' }),
    );
    expect(lock?.message).toBe(
      'ci.lock.yml is generated (its name ends in .lock.yml), and your edits would be overwritten.',
    );
    expect(refusalOf(open('on: push\n', { generated: '@generated' }))?.message).toBe(
      "ci.yml is marked generated ('@generated'), and your edits would be overwritten.",
    );
  });

  it('locks a file over 512 kB without parsing it', () => {
    const text = `on: push\n${'# filler\n'.repeat(60_000)}`;
    const doc = open(text);
    expect(refusalOf(doc)).toMatchObject({
      reason: 'too-large',
      message: 'ci.yml is 527 kB; edit files this large in the YAML pane.',
    });
    expect(doc.tree.doc).toBeUndefined();
    expect(doc.get(['on'])).toBeUndefined();
    expect(doc.pathAt(0)).toEqual([]);
    expect(doc.spanOf([])).toBeUndefined();
    expect(doc.jobs()).toEqual([]);
    expect(doc.style.eol).toBe('\n');
  });

  it('counts the limit in UTF-8 bytes', () => {
    expect(open('é'.repeat(100), { maxBytes: 200 }).status).toEqual({ editable: true });
    expect(refusalOf(open('é'.repeat(101), { maxBytes: 200 }))?.reason).toBe('too-large');
    expect(refusalOf(open('😀'.repeat(51), { maxBytes: 200 }))?.reason).toBe('too-large');
    expect(open('😀'.repeat(50), { maxBytes: 200 }).status).toEqual({ editable: true });
    expect(refusalOf(open('a'.repeat(201), { maxBytes: 200 }))?.reason).toBe('too-large');
  });

  it('puts a generated lock before a broken one, and a broken one before a second document', () => {
    expect(refusalOf(open('# DO NOT EDIT\na: [\n', { generated: 'DO NOT EDIT' }))?.reason).toBe('generated');
    expect(refusalOf(open('a: [\n---\nb: 1\n'))?.reason).toBe('invalid-yaml');
  });
});
