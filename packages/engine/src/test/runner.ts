import type { ProjectIndex, WorkflowDecl } from '@ciatlas/core';
import type { z } from 'zod';
import type { AssumeEntry } from '../mocks/schema';
import { canonicalize } from '../plan/canonicalize';
import { closest, unitPaths } from '../plan/select';
import type { Json, RunPlan, WorkflowPlan } from '../plan/types';
import { simulate } from '../planner';
import type { LoadedProject } from '../remotes/state';
import { parseScenario, ScenarioError, type ScenarioInput, ScenarioInputSchema } from '../scenario';
import { type AssertContext, assertThen, type Failure } from './assert';
import { type ParsedYaml, parseYaml, type TextPos } from './positions';
import {
  type Given,
  type TestCase,
  type TestFile,
  TestFileSchema,
  type When,
  workflowPathOf,
} from './schema';

/**
 * The route-test runner, pure: test files in, results out. Discovery, file reads, the snapshot files, reports and
 * the process exit code belong to the host (the CLI, the Action, the app's worker).
 */

export interface Snapshot {
  schemaVersion: 1;
  cases: Record<string, Json>;
}

/** Where snapshots live: files beside the tests in the CLI, memory in the app. */
export interface SnapshotStore {
  read(testFile: string): Snapshot | undefined;
  write(testFile: string, snapshot: Snapshot): void;
}

export interface RunOptions {
  /** Write every executed snapshot and prune the rest (`-u`). */
  update?: boolean;
  /** Never write a snapshot, fail on a missing one, reject `only` (`CI=true`). */
  ci?: boolean;
  /** Ignore `allowMaybe`; obsolete snapshots fail. */
  strict?: boolean;
  snapshotDetail?: 'steps' | 'legs';
  snapshots?: SnapshotStore;
  /** Run only the cases whose name contains the text. */
  filter?: string;
  /** The `cli` mock layer. */
  cli?: AssumeEntry[];
}

export type Status = 'passed' | 'failed' | 'invalid' | 'skipped';

export interface CaseResult {
  name: string;
  status: Status;
  failures: Failure[];
  /** Accepted maybes, snapshots written: what passed with a remark. */
  notes: string[];
  /** Why the case was skipped. */
  reason?: string;
  plan?: RunPlan;
}

export interface FileResult {
  path: string;
  workflow?: string;
  status: Status;
  /** Problems with the file itself (T0xx, T1xx, T201, T104). */
  failures: Failure[];
  notes: string[];
  cases: CaseResult[];
}

export interface RunResult {
  files: FileResult[];
  summary: { passed: number; failed: number; invalid: number; skipped: number };
  exitCode: 0 | 1 | 2;
}

export interface TestInput {
  path: string;
  text: string;
}

export function runTests(project: LoadedProject, files: TestInput[], options: RunOptions = {}): RunResult {
  const results = files.length ? files.map((f) => runFile(project, f, options)) : [noFiles()];
  const summary = { passed: 0, failed: 0, invalid: 0, skipped: 0 };
  for (const file of results) for (const c of file.cases) summary[c.status]++;
  const anyInvalid = results.some(
    (f) => f.status === 'invalid' || f.cases.some((c) => c.status === 'invalid'),
  );
  const anyFailed = results.some((f) => f.status === 'failed' || f.cases.some((c) => c.status === 'failed'));
  return { files: results, summary, exitCode: anyInvalid ? 2 : anyFailed ? 1 : 0 };
}

/** One case on its own, as the app's panel runs it (no file positions, no snapshot). */
export function runCase(
  project: LoadedProject,
  file: { workflow: string; given?: Given },
  testCase: TestCase,
  options: RunOptions = {},
): CaseResult {
  const workflowPath = workflowPathOf(file.workflow);
  const decl = project.index.project.workflows.get(workflowPath);
  if (!decl) {
    const headline = `T201 workflow: no ${workflowPath} in the project (workflows: ${workflowNames(project.index)})`;
    return {
      name: testCase.name,
      status: 'invalid',
      failures: [invalid('T201', headline, { line: 1, col: 1 })],
      notes: [],
    };
  }
  const spec = { workflow: file.workflow, cases: [testCase], ...(file.given ? { given: file.given } : {}) };
  const noPos = (): TextPos => ({ line: 1, col: 1 });
  return runOne(
    { project, spec, decl, workflowPath, options, pos: noPos, hasOnly: false, snapshots: undefined },
    testCase,
    0,
  );
}

function noFiles(): FileResult {
  const headline = 'T000 no test files: expected .github/simulci/tests/**/*.test.yml';
  return {
    path: '',
    status: 'invalid',
    failures: [invalid('T000', headline, { line: 1, col: 1 })],
    notes: [],
    cases: [],
  };
}

interface FileContext {
  project: LoadedProject;
  spec: TestFile;
  decl: WorkflowDecl;
  workflowPath: string;
  options: RunOptions;
  pos: (path: readonly (string | number)[], which?: 'key' | 'value') => TextPos;
  hasOnly: boolean;
  snapshots: SnapshotState | undefined;
}

interface SnapshotState {
  stored: Snapshot | undefined;
  next: Record<string, Json>;
  executed: Set<string>;
}

function runFile(project: LoadedProject, file: TestInput, options: RunOptions): FileResult {
  const result: FileResult = { path: file.path, status: 'passed', failures: [], notes: [], cases: [] };
  const parsed = parseYaml(file.text);
  const spec = readSpec(parsed, result);
  if (!spec) return result;
  const workflowPath = workflowPathOf(spec.workflow);
  result.workflow = workflowPath;
  const decl = project.index.project.workflows.get(workflowPath);
  if (!decl) return noWorkflow(project, spec, workflowPath, parsed, result);
  const hasOnly = spec.cases.some((c) => c.only);
  if (hasOnly && options.ci) {
    const i = spec.cases.findIndex((c) => c.only);
    const headline = 'T104 only left in a test file (CI=true runs every case)';
    result.failures.push(invalid('T104', headline, parsed.posOf(['cases', i, 'only'], 'key')));
  }
  const snapshots = snapshotState(file.path, spec, options);
  const ctx: FileContext = {
    project,
    spec,
    decl,
    workflowPath,
    options,
    pos: parsed.posOf,
    hasOnly,
    snapshots,
  };
  result.cases = spec.cases.map((c, i) => runOne(ctx, c, i));
  if (snapshots) finishSnapshots(file.path, spec, snapshots, options, result);
  result.status = fileStatus(result);
  return result;
}

/**
 * What a test file fails on before any case runs, without the project: its YAML (T001), its schema (T002, T1xx) and
 * its duplicate case names (T103), each as `runTests` reports it, with its position; none when it would go on to run
 * its cases. The app checks the route tests it holds with it, since they never join the project it simulates.
 */
export function testFileFailures(text: string): Failure[] {
  const result: FileResult = { path: '', status: 'passed', failures: [], notes: [], cases: [] };
  readSpec(parseYaml(text), result);
  return result.failures;
}

/** The file's spec, or nothing with the YAML (T001), schema (T002, T1xx) or duplicate-name (T103) failures recorded. */
function readSpec(parsed: ParsedYaml, result: FileResult): TestFile | undefined {
  if (parsed.errors.length) {
    result.failures = parsed.errors.map((e) => invalid('T001', `T001 ${e.message}`, e.pos));
    result.status = 'invalid';
    return undefined;
  }
  const raw: unknown = parsed.doc.toJS();
  const checked = TestFileSchema.safeParse(raw);
  const duplicates = duplicateNames(raw, parsed);
  if (checked.success && !duplicates.length) return checked.data;
  const issues = checked.success ? [] : checked.error.issues;
  result.failures = [
    ...issues.filter((i) => !noise(i, issues)).map((issue) => invalidIssue(issue, parsed)),
    ...duplicates,
  ];
  result.status = 'invalid';
  return undefined;
}

function noWorkflow(
  project: LoadedProject,
  spec: TestFile,
  workflowPath: string,
  parsed: ParsedYaml,
  result: FileResult,
): FileResult {
  const headline = `T201 workflow: no ${workflowPath} in the project (workflows: ${workflowNames(project.index)})`;
  result.failures = [invalid('T201', headline, parsed.posOf(['workflow']))];
  result.cases = spec.cases.map((c) => ({ name: c.name, status: 'invalid', failures: [], notes: [] }));
  result.status = 'invalid';
  return result;
}

function fileStatus(result: FileResult): Status {
  if (result.failures.some((f) => f.status === 'invalid')) return 'invalid';
  if (result.failures.length) return 'failed';
  return worst(result.cases.map((c) => c.status));
}

function runOne(ctx: FileContext, c: TestCase, i: number): CaseResult {
  const out: CaseResult = { name: c.name, status: 'passed', failures: [], notes: [] };
  const skipped = skipReason(ctx, c);
  if (skipped !== undefined) return { ...out, status: 'skipped', reason: skipped };
  const planned = planCase(ctx, c, i);
  if ('failures' in planned) return { ...out, status: 'invalid', failures: planned.failures };
  const { plan, scenario } = planned;
  out.plan = plan;
  const wf = plan.workflows.find((w) => w.depth === 0 && w.path === ctx.workflowPath)!;
  if (c.then) out.failures.push(...assertThen(assertContext(ctx, plan, wf, c, i, out.notes), c.then));
  if (c.snapshot)
    out.failures.push(...snapshotCase(ctx, c, i, wf, snapshotPlan(ctx, c, plan, scenario), out.notes));
  out.status = statusOf(out.failures);
  return out;
}

/** The case's plan, or why there is none: a scenario the engine rejects (T202), an engine error (T203), mock errors. */
function planCase(
  ctx: FileContext,
  c: TestCase,
  i: number,
): { plan: RunPlan; scenario: ScenarioInput } | { failures: Failure[] } {
  const scenario = mergeScenario(ctx.spec.given, c.when);
  try {
    parseScenario(scenario);
  } catch (e) {
    if (!(e instanceof ScenarioError)) throw e;
    return {
      failures: [invalid('T202', `T202 cases.${i}.when: ${e.message}`, ctx.pos(['cases', i, 'when'], 'key'))],
    };
  }
  let plan: RunPlan;
  try {
    plan = simulate({ project: ctx.project, scenario, detail: 'steps', mocks: layersOf(ctx, c) });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      failures: [
        invalid('T203', `T203 cases.${i}: the engine threw: ${message}`, ctx.pos(['cases', i], 'key')),
      ],
    };
  }
  const failures = plan.diagnostics
    .filter((d) => d.severity === 'error')
    .map((d) => invalid(d.code, `${d.code} ${d.message}`, ctx.pos(mockPath(d.mock, i), 'value')));
  return failures.length ? { failures } : { plan, scenario };
}

function assertContext(
  ctx: FileContext,
  plan: RunPlan,
  wf: WorkflowPlan,
  c: TestCase,
  i: number,
  notes: string[],
): AssertContext {
  const allowMaybe = ctx.options.strict ? false : (c.allowMaybe ?? ctx.spec.given?.allowMaybe ?? false);
  return {
    plan,
    wf,
    name: ctx.workflowPath.replace(/^.*\//, ''),
    paths: unitPaths(wf),
    allowMaybe,
    index: ctx.project.index,
    decl: ctx.decl,
    pos: (path, which) => ctx.pos(['cases', i, 'then', ...path], which),
    notes,
  };
}

/** The plan a snapshot records: the case's, or one made at leg detail when asked. */
function snapshotPlan(ctx: FileContext, c: TestCase, plan: RunPlan, scenario: ScenarioInput): RunPlan {
  const detail = c.snapshot === 'legs' ? 'legs' : (ctx.options.snapshotDetail ?? 'steps');
  return detail === 'legs'
    ? simulate({ project: ctx.project, scenario, detail: 'legs', mocks: layersOf(ctx, c) })
    : plan;
}

const statusOf = (failures: Failure[]): Status =>
  failures.some((f) => f.status === 'invalid') ? 'invalid' : failures.length ? 'failed' : 'passed';

function skipReason(ctx: FileContext, c: TestCase): string | undefined {
  if (c.skip) return typeof c.skip === 'string' ? c.skip : 'skip';
  if (ctx.hasOnly && !ctx.options.ci && !c.only) return 'only elsewhere';
  if (ctx.options.filter !== undefined && !c.name.includes(ctx.options.filter)) return 'filter';
  return undefined;
}

function layersOf(
  ctx: FileContext,
  c: TestCase,
): { given?: AssumeEntry[]; case?: AssumeEntry[]; cli?: AssumeEntry[] } {
  const layers: { given?: AssumeEntry[]; case?: AssumeEntry[]; cli?: AssumeEntry[] } = {};
  if (ctx.spec.given?.assume) layers.given = ctx.spec.given.assume;
  if (c.when.assume) layers.case = c.when.assume;
  if (ctx.options.cli) layers.cli = ctx.options.cli;
  return layers;
}

/** Where a mock ref (`assume[0]`, `given[1]`) is written in the file. */
function mockPath(ref: string | undefined, i: number): (string | number)[] {
  const m = ref === undefined ? null : /^(assume|given)\[(\d+)\]/.exec(ref);
  if (!m) return ['cases', i, 'when'];
  const j = Number(m[2]);
  return m[1] === 'given' ? ['given', 'assume', j] : ['cases', i, 'when', 'assume', j];
}

const SCENARIO_KEYS = Object.keys(ScenarioInputSchema.shape);
const REF_GROUP = ['ref', 'branch', 'tag'];
const MERGED = new Set(['inputs', 'vars', 'actor', 'workflow_run']);

/** The case's scenario over the file's: records merge key by key, the ref group is replaced whole, the rest replaced. */
export function mergeScenario(given: Given | undefined, when: When): ScenarioInput {
  const out: Record<string, unknown> = {};
  for (const key of SCENARIO_KEYS)
    if (given?.[key as keyof Given] !== undefined) out[key] = given[key as keyof Given];
  if (REF_GROUP.some((k) => when[k as keyof When] !== undefined)) for (const k of REF_GROUP) delete out[k];
  for (const key of SCENARIO_KEYS) {
    const value = when[key as keyof When];
    if (value === undefined) continue;
    const base = out[key];
    out[key] = MERGED.has(key) && isRecord(base) && isRecord(value) ? { ...base, ...value } : value;
  }
  return out as ScenarioInput;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// --- snapshots -------------------------------------------------------------------------------------------------------

function snapshotState(path: string, spec: TestFile, options: RunOptions): SnapshotState | undefined {
  if (!spec.cases.some((c) => c.snapshot)) return undefined;
  if (!options.snapshots) return undefined;
  return { stored: options.snapshots.read(path), next: {}, executed: new Set() };
}

function snapshotCase(
  ctx: FileContext,
  c: TestCase,
  i: number,
  wf: WorkflowPlan,
  plan: RunPlan,
  notes: string[],
): Failure[] {
  const at = ctx.pos(['cases', i, 'snapshot'], 'key');
  const state = ctx.snapshots;
  if (!state) return [invalid('T207', `T207 cases.${i}.snapshot: this host has no snapshot store`, at)];
  const content = canonicalize(
    { ...plan, workflows: plan.workflows.filter((w) => w.id === wf.id) },
    'snapshot',
  );
  state.executed.add(c.name);
  const stored = state.stored?.cases[c.name];
  if (ctx.options.update) {
    state.next[c.name] = content;
    notes.push(stored === undefined ? 'snapshot written' : 'snapshot updated');
    return [];
  }
  if (stored === undefined) {
    if (ctx.options.ci) {
      return [
        {
          status: 'failed',
          headline: `snapshot: no snapshot for '${c.name}' (CI=true never writes one; run simulci test -u and commit it)`,
          detail: [],
          at,
        },
      ];
    }
    state.next[c.name] = content;
    notes.push('snapshot written');
    return [];
  }
  const before = JSON.stringify(stored, null, 2).split('\n');
  const after = JSON.stringify(content, null, 2).split('\n');
  if (before.join('\n') === after.join('\n')) return [];
  const diff = lineDiff(before, after);
  const added = diff.filter((l) => l.startsWith('+')).length;
  const removed = diff.filter((l) => l.startsWith('-')).length;
  const headline = `snapshot: the plan of '${c.name}' changed, +${added}/-${removed} lines (run simulci test -u to accept)`;
  return [{ status: 'failed', headline, detail: diff, at }];
}

function finishSnapshots(
  path: string,
  spec: TestFile,
  state: SnapshotState,
  options: RunOptions,
  result: FileResult,
): void {
  const names = new Set(spec.cases.map((c) => c.name));
  const stored = state.stored?.cases ?? {};
  const obsolete = Object.keys(stored).filter((name) => !names.has(name));
  reportObsolete(obsolete, options, result);
  if (!Object.keys(state.next).length && !(options.update && obsolete.length)) return;
  const cases: Record<string, Json> = {};
  for (const name of Object.keys(stored)) if (names.has(name) || !options.update) cases[name] = stored[name]!;
  Object.assign(cases, state.next);
  const sorted = Object.fromEntries(
    Object.keys(cases)
      .sort()
      .map((k) => [k, cases[k]!]),
  );
  options.snapshots!.write(path, { schemaVersion: 1, cases: sorted });
}

/** Stored entries no case has any more: a remark, or a failure under `strict`. */
function reportObsolete(obsolete: string[], options: RunOptions, result: FileResult): void {
  for (const name of obsolete) {
    const line = `obsolete snapshot "${name}" (no such case; -u removes it)`;
    if (options.strict && !options.update) {
      result.failures.push({
        status: 'failed',
        headline: `snapshot: ${line}`,
        detail: [],
        at: { line: 1, col: 1 },
      });
    } else result.notes.push(line);
  }
}

const DIFF_CAP = 2000;

/** A unified line diff (`-` stored, `+` current, ` ` unchanged), or the two sides' sizes when they are too large. */
export function lineDiff(a: string[], b: string[]): string[] {
  if (a.length > DIFF_CAP || b.length > DIFF_CAP)
    return [`- ${a.length} lines stored`, `+ ${b.length} lines now`];
  const lcs = lcsTable(a, b);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push(`- ${a[i++]}`);
    else out.push(`+ ${b[j++]}`);
  }
  while (i < a.length) out.push(`- ${a[i++]}`);
  while (j < b.length) out.push(`+ ${b[j++]}`);
  return compact(out);
}

function lcsTable(a: string[], b: string[]): number[][] {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => 0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  return lcs;
}

/** Changed lines with two lines of context, `…` between hunks. */
function compact(lines: string[]): string[] {
  const keep = new Set<number>();
  lines.forEach((l, i) => {
    if (l.startsWith(' ')) return;
    for (let k = Math.max(0, i - 2); k <= Math.min(lines.length - 1, i + 2); k++) keep.add(k);
  });
  const out: string[] = [];
  let last = -1;
  for (const i of [...keep].sort((x, y) => x - y)) {
    if (last !== -1 && i !== last + 1) out.push('  …');
    out.push(lines[i]!);
    last = i;
  }
  return out;
}

// --- schema issues ---------------------------------------------------------------------------------------------------

const KEYS: Record<string, string[]> = {
  file: ['$schema', 'workflow', 'given', 'cases'],
  case: ['name', 'when', 'then', 'allowMaybe', 'snapshot', 'skip', 'only'],
  when: [...SCENARIO_KEYS, 'assume'],
  given: [...SCENARIO_KEYS, 'assume', 'allowMaybe', 'strictMocks'],
  then: ['triggered', 'because', 'run', 'skip', 'maybe', 'conclusion', 'checks', 'unknowns', 'units'],
  unit: [
    'runs',
    'because',
    'outcome',
    'conclusion',
    'result',
    'with',
    'inputs',
    'env',
    'outputs',
    'environment',
    'check',
  ],
};

function kindAt(path: readonly PropertyKey[]): keyof typeof KEYS | undefined {
  const last = path.at(-1);
  if (path.length === 0) return 'file';
  if (path.length === 2 && path[0] === 'cases') return 'case';
  if (last === 'when') return 'when';
  if (last === 'given') return 'given';
  if (last === 'then') return 'then';
  if (path.at(-2) === 'units') return 'unit';
  return undefined;
}

function invalidIssue(issue: z.core.$ZodIssue, parsed: ParsedYaml): Failure {
  const path = issue.path as (string | number)[];
  const coded = /^(T\d{3}) (.*)$/s.exec(issue.message);
  if (coded) return invalid(coded[1]!, `${coded[1]} ${dotted(path)}: ${coded[2]}`, parsed.posOf(path, 'key'));
  if (issue.code === 'unrecognized_keys') return unknownKey(issue.keys[0]!, path, parsed);
  if (path.at(-1) === 'because' && issue.code === 'invalid_value') return notAReason(issue, path, parsed);
  return invalid('T002', `T002 ${dotted(path)}: ${issue.message}`, parsed.posOf(path));
}

function unknownKey(key: string, path: (string | number)[], parsed: ParsedYaml): Failure {
  const kind = kindAt(path);
  const known = kind ? KEYS[kind]! : [];
  const near = closest(key, known);
  const what = kind === 'when' || kind === 'given' ? 'scenario keys are' : 'keys are';
  const hint = near ? `; did you mean '${near}'?` : known.length ? `; ${what} ${known.join(', ')}` : '';
  return invalid(
    'T002',
    `T002 ${dotted([...path, key])}: unknown key${hint}`,
    parsed.posOf([...path, key], 'key'),
  );
}

function notAReason(issue: z.core.$ZodIssue, path: (string | number)[], parsed: ParsedYaml): Failure {
  const options = (issue as { values?: unknown[] }).values ?? [];
  const value = String(parsed.doc.getIn(path));
  return invalid(
    'T002',
    `T002 ${dotted(path)}: '${value}' is not a reason; one of ${options.join(', ')}`,
    parsed.posOf(path),
  );
}

/** An object whose only keys were unknown also "asserts nothing": the unknown key is the problem to report. */
function noise(issue: z.core.$ZodIssue, all: z.core.$ZodIssue[]): boolean {
  if (!issue.message.startsWith('T102 ')) return false;
  const path = dotted(issue.path as (string | number)[]);
  return all.some((o) => o.code === 'unrecognized_keys' && dotted(o.path as (string | number)[]) === path);
}

/** T103: the same case name twice. */
function duplicateNames(raw: unknown, parsed: ParsedYaml): Failure[] {
  const cases = isRecord(raw) && Array.isArray(raw.cases) ? raw.cases : [];
  const seen = new Map<string, number>();
  const out: Failure[] = [];
  for (const [i, c] of cases.entries()) {
    const name = isRecord(c) && typeof c.name === 'string' ? c.name : undefined;
    if (name === undefined) continue;
    const first = seen.get(name);
    if (first === undefined) seen.set(name, i);
    else
      out.push(
        invalid(
          'T103',
          `T103 cases.${i}.name: duplicate case name '${name}' (first at cases[${first}])`,
          parsed.posOf(['cases', i, 'name'], 'key'),
        ),
      );
  }
  return out;
}

const dotted = (path: readonly (string | number)[]): string => path.join('.');

function invalid(code: string, headline: string, at: TextPos): Failure {
  return { status: 'invalid', code, headline, detail: [], at };
}

function worst(statuses: Status[]): Status {
  if (statuses.includes('invalid')) return 'invalid';
  if (statuses.includes('failed')) return 'failed';
  if (statuses.some((s) => s === 'passed')) return 'passed';
  return statuses.length ? 'skipped' : 'passed';
}

const workflowNames = (index: ProjectIndex): string =>
  [...index.project.workflows.keys()].map((p) => p.replace(/^.*\//, '')).join(', ');
