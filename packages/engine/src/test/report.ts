import type { Failure } from './assert';
import type { CaseResult, FileResult, RunResult, Status } from './runner';

/** The three renderings of a run: text for the terminal, workflow commands for annotations, JUnit for CI systems. */

const MARK = { passed: '✓', failed: '✗', invalid: '!', skipped: '-' } as const;

export function renderTextReport(result: RunResult): string {
  const lines: string[] = [];
  for (const file of result.files) {
    lines.push(`${file.path}${file.workflow ? ` → ${file.workflow.replace(/^.*\//, '')}` : ''}`);
    for (const f of file.failures) lines.push(...failureLines(f, '  '));
    for (const note of file.notes) lines.push(`  · ${note}`);
    for (const c of file.cases) lines.push(...caseLines(c));
  }
  const s = result.summary;
  lines.push(
    '',
    `${s.passed} passed · ${s.failed} failed · ${s.invalid} invalid · ${s.skipped} skipped · exit ${result.exitCode}`,
  );
  return `${lines.join('\n')}\n`;
}

function caseLines(c: CaseResult): string[] {
  const reason = c.status === 'skipped' && c.reason ? ` (${c.reason})` : '';
  const lines = [`  ${MARK[c.status]} ${c.name}${reason}`];
  for (const f of c.failures) lines.push(...failureLines(f, '      '));
  for (const note of c.notes) lines.push(`      · ${note}`);
  return lines;
}

function failureLines(f: Failure, pad: string): string[] {
  const lines = [`${pad}${f.headline}`, ...f.detail.map((d) => `${pad}    ${d}`)];
  if (f.at.line > 0) lines.push(`${pad}  at ${f.at.line}:${f.at.col}`);
  return lines;
}

const ANNOTATION_CAP = 9;

/** One annotation: an error on the assertion's own token, or a notice on the workflow line that decided. */
export interface Annotation {
  level: 'error' | 'notice';
  file: string;
  line: number;
  col: number;
  title: string;
  message: string;
}

/** Every annotation of a run, errors first, uncapped. */
export function annotationsOf(result: RunResult): Annotation[] {
  const errors: Annotation[] = [];
  const notices: Annotation[] = [];
  for (const file of result.files) {
    for (const f of file.failures) errors.push(annotation(file.path, f, `simulci: ${file.path}`));
    for (const c of file.cases) {
      for (const f of c.failures) {
        errors.push(annotation(file.path, f, `simulci: ${c.name}`));
        if (f.workflowLoc) {
          const loc = f.workflowLoc;
          const message = `${f.headline} (test: ${file.path}:${f.at.line})`;
          notices.push({
            level: 'notice',
            file: loc.file,
            line: loc.line,
            col: loc.column,
            title: 'simulci: decided here',
            message,
          });
        }
      }
    }
  }
  return [...errors, ...notices];
}

function annotation(file: string, f: Failure, title: string): Annotation {
  return {
    level: 'error',
    file,
    line: f.at.line,
    col: f.at.col,
    title,
    message: [f.headline, ...f.detail].join('\n'),
  };
}

/** `::error` on the assertion's own line, `::notice` on the workflow line that decided; at most ten per severity. */
export function renderAnnotations(result: RunResult): string[] {
  const all = annotationsOf(result);
  const lines = (level: Annotation['level']) =>
    all
      .filter((a) => a.level === level)
      .map(
        (a) =>
          `::${a.level} file=${prop(a.file)},line=${a.line},col=${a.col},title=${prop(a.title)}::${msg(a.message)}`,
      );
  return [...capped(lines('error'), 'error'), ...capped(lines('notice'), 'notice')];
}

function capped(items: string[], kind: string): string[] {
  if (items.length <= ANNOTATION_CAP + 1) return items;
  const rest = items.length - ANNOTATION_CAP;
  return [
    ...items.slice(0, ANNOTATION_CAP),
    `::${kind}::${rest} more ${kind === 'error' ? 'failures' : 'notices'} not shown; see the log`,
  ];
}

/** As actions/toolkit escapes: `%`, CR and LF in messages; also `:` and `,` in properties. */
const msg = (s: string): string => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const prop = (s: string): string => msg(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

const EMOJI: Record<Status, string> = { passed: '✅', failed: '❌', invalid: '⚠️', skipped: '⏭️' };

/** The run as Markdown for a job summary or a pull request comment: a table of cases, then each failure in full. */
export function renderMarkdownReport(
  result: RunResult,
  opts: { title?: string; maxFailures?: number } = {},
): string {
  const s = result.summary;
  const lines = [
    `## ${opts.title ?? 'simulci test'}: ${s.passed} passed · ${s.failed} failed · ${s.invalid} invalid · ${s.skipped} skipped`,
    '',
    '| | Case | File |',
    '|---|---|---|',
  ];
  for (const file of result.files) {
    if (file.failures.length)
      lines.push(`| ${EMOJI.invalid} | ${md(file.failures[0]!.headline)} | ${md(file.path)} |`);
    for (const c of file.cases)
      lines.push(
        `| ${EMOJI[c.status]} | ${md(c.name)}${c.reason ? ` (${md(c.reason)})` : ''} | ${md(file.path)} |`,
      );
  }
  const failed = result.files.flatMap((file) => [
    ...file.failures.map((f) => ({ name: file.path, file: file.path, failures: [f] })),
    ...file.cases
      .filter((c) => c.failures.length)
      .map((c) => ({ name: c.name, file: file.path, failures: c.failures })),
  ]);
  const max = opts.maxFailures ?? 50;
  for (const item of failed.slice(0, max)) {
    const body = item.failures.flatMap((f) => [...failureLines(f, ''), '']);
    const fence = fenceFor(body.join('\n'));
    lines.push(
      '',
      `<details><summary>${EMOJI.failed} ${inline(item.name)} — ${inline(item.failures[0]!.headline)}</summary>`,
      '',
      fence,
      ...body,
      fence,
      '',
      '</details>',
    );
  }
  if (failed.length > max) lines.push('', `${failed.length - max} more failed cases are in the log.`);
  return `${lines.join('\n')}\n`;
}

/**
 * A table cell: tags and entities escaped, then every character with inline meaning (`\\`, `|`, emphasis, code, and
 * the brackets of links and images), newlines flattened. Names reach it from other repositories' workflows.
 */
const md = (s: string): string =>
  html(s)
    .replace(/[\\|`*_~[\]!]/g, '\\$&')
    .replace(/\r?\n|\r/g, ' ');
/** A code fence no line of `text` can close: longer than any run of backticks in it. */
const fenceFor = (text: string): string =>
  '`'.repeat(Math.max(3, 1 + Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))));
/** Text inside the raw HTML of a summary line: tags and entities escaped, newlines flattened. */
const inline = (s: string): string => html(s).replace(/\r?\n|\r/g, ' ');
const html = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderJUnit(result: RunResult): string {
  const suites = result.files.map(suite);
  const totals = count(
    result.files.flatMap((f) => f.cases),
    result.files,
  );
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="simulci" tests="${totals.tests}" failures="${totals.failures}" errors="${totals.errors}" skipped="${totals.skipped}">`,
    ...suites,
    '</testsuites>',
  ];
  return `${lines.join('\n')}\n`;
}

function suite(file: FileResult): string {
  const t = count(file.cases, [file]);
  const lines = [
    `  <testsuite name="${xml(file.path)}" tests="${t.tests}" failures="${t.failures}" errors="${t.errors}" skipped="${t.skipped}" time="0">`,
  ];
  if (file.failures.length) {
    lines.push(`    <testcase classname="${xml(file.path)}" name="(file)" time="0">`);
    for (const f of file.failures)
      lines.push(
        `      <error type="${xml(f.code ?? 'invalid')}" message="${xml(f.headline)}">${xml(body(f))}</error>`,
      );
    lines.push('    </testcase>');
  }
  for (const c of file.cases) lines.push(...testcase(file, c));
  lines.push('  </testsuite>');
  return lines.join('\n');
}

function testcase(file: FileResult, c: CaseResult): string[] {
  const open = `    <testcase classname="${xml(file.path)}" name="${xml(c.name)}" time="0">`;
  if (c.status === 'passed') return [`${open}</testcase>`];
  return [open, ...caseBody(file, c), '    </testcase>'];
}

function caseBody(file: FileResult, c: CaseResult): string[] {
  if (c.status === 'skipped') return [`      <skipped message="${xml(c.reason ?? 'skipped')}"/>`];
  if (c.status === 'invalid') return errorLines(c.failures.length ? c.failures : file.failures);
  const [first, ...rest] = c.failures;
  const message = `${first!.headline}${rest.length ? ` (+${rest.length} more)` : ''}`;
  return [
    `      <failure type="assertion" message="${xml(message)}">${xml(c.failures.map(body).join('\n\n'))}</failure>`,
  ];
}

const errorLines = (failures: Failure[]): string[] =>
  failures.map(
    (f) =>
      `      <error type="${xml(f.code ?? 'invalid')}" message="${xml(f.headline)}">${xml(body(f))}</error>`,
  );

const body = (f: Failure): string => [f.headline, ...f.detail, `at ${f.at.line}:${f.at.col}`].join('\n');

function count(
  cases: CaseResult[],
  files: FileResult[],
): { tests: number; failures: number; errors: number; skipped: number } {
  const fileErrors = files.filter((f) => f.failures.length).length;
  return {
    tests: cases.length + fileErrors,
    failures: cases.filter((c) => c.status === 'failed').length,
    errors: cases.filter((c) => c.status === 'invalid').length + fileErrors,
    skipped: cases.filter((c) => c.status === 'skipped').length,
  };
}

const xml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
