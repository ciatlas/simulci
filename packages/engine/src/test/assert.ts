import type { JobDecl, ProjectIndex, StepDecl, WorkflowDecl } from '@ciatlas/core';
import { stringOf } from '../evaluate';
import type { PathStep } from '../paths';
import { type PathSegment, parseUnitPath } from '../paths';
import { type CheckVerdict, checksOf } from '../plan/checks';
import {
  type Selected,
  type Selection,
  SelectionError,
  selectNodes,
  type Unexpanded,
  unitPathOfId,
} from '../plan/select';
import type {
  Decision,
  Json,
  LegPlan,
  Loc,
  NodeId,
  Reason,
  Result,
  RunPlan,
  Tri,
  Value,
  WorkflowPlan,
} from '../plan/types';
import { becauseOf, decidingReason, formatReason, formatValue, reasonUnknowns } from '../render/reason';
import { checkTri, checkValue, resultValue } from './expect';
import type { TextPos } from './positions';
import {
  type Because,
  type ExpectResult,
  type ExpectValue,
  type RunEntry,
  type Then,
  triOf,
  type UnitAssertion,
} from './schema';

/** What a case's `then:` asserts against its plan, one failure per assertion that does not hold. */

export interface Failure {
  status: 'failed' | 'invalid';
  /** `T2xx`, `SC1xx`; absent on a plain failed assertion. */
  code?: string;
  headline: string;
  detail: string[];
  at: TextPos;
  /** The workflow line that decided, when the plan knows it. */
  workflowLoc?: Loc;
}

export interface AssertContext {
  plan: RunPlan;
  wf: WorkflowPlan;
  /** `ci.yml` */
  name: string;
  paths: Map<NodeId, string>;
  allowMaybe: boolean;
  index: ProjectIndex;
  decl: WorkflowDecl;
  /** The position of a key or value under `then`, by its YAML path. */
  pos: (path: readonly (string | number)[], which?: 'key' | 'value') => TextPos;
  notes: string[];
}

type Path = readonly (string | number)[];

export function assertThen(ctx: AssertContext, then: Then): Failure[] {
  const out: Failure[] = [];
  if (then.triggered !== undefined) out.push(...assertTriggered(ctx, then.triggered, ['triggered']));
  if (then.because !== undefined) out.push(...assertBecause(ctx, then.because, ['because']));
  for (const list of ['run', 'skip', 'maybe'] as const) {
    for (const [i, entry] of (then[list] ?? []).entries())
      out.push(...assertEntry(ctx, list, entry, [list, i]));
  }
  if (then.conclusion !== undefined) out.push(...assertConclusion(ctx, then.conclusion, ['conclusion']));
  if (then.checks !== undefined) out.push(...assertChecks(ctx, then.checks, ['checks']));
  if (then.unknowns !== undefined) out.push(...assertUnknowns(ctx, then.unknowns, ['unknowns']));
  for (const [path, unit] of Object.entries(then.units ?? {}))
    out.push(...assertUnit(ctx, path, unit, ['units', path]));
  return out;
}

// --- the workflow ----------------------------------------------------------------------------------------------------

function assertTriggered(ctx: AssertContext, want: boolean, path: Path): Failure[] {
  const got = ctx.wf.triggered.verdict;
  const wanted: Tri = want ? 'yes' : 'no';
  if (checkTri(wanted, got, ctx.allowMaybe)) {
    if (got === 'maybe') ctx.notes.push(`triggered: ${ctx.name} may be triggered, accepted (allowMaybe)`);
    return [];
  }
  const it = got === 'maybe' ? 'it may be (maybe)' : want ? 'it is not' : 'it is';
  const headline = `triggered: expected ${ctx.name} ${want ? 'to be triggered' : 'not to be triggered'}; ${it}`;
  return [failure(ctx, path, headline, explain(ctx, ctx.wf.triggered))];
}

function assertBecause(ctx: AssertContext, want: Because, path: Path): Failure[] {
  const decision = ctx.wf.triggered;
  if (decision.verdict === 'yes') {
    const headline = `because: ${ctx.name} is triggered; nothing decided against it, so there is no reason to compare with '${want}'`;
    return [failure(ctx, path, headline, explain(ctx, decision))];
  }
  if (decision.verdict === 'maybe' && !ctx.allowMaybe) {
    return [
      failure(
        ctx,
        path,
        `because: expected ${ctx.name} not to be triggered; it may be (maybe)`,
        explain(ctx, decision),
      ),
    ];
  }
  const reason = decidingReason(decision.chain, decision.verdict);
  if (reason && reasonMatches(reason, want)) return [];
  const got = reason ? `${becauseOf(reason)} — ${formatReason(reason)}` : 'nothing';
  const headline = `because: expected ${ctx.name} to be skipped because of ${want}; it is because of ${got}`;
  return [failure(ctx, path, headline, explain(ctx, decision))];
}

function assertConclusion(ctx: AssertContext, want: ExpectResult, path: Path): Failure[] {
  if (ctx.wf.triggered.verdict === 'no') {
    const reason = decidingReason(ctx.wf.triggered.chain, 'no');
    const why = reason ? ` (${formatReason(reason)})` : '';
    return [
      failure(
        ctx,
        path,
        `conclusion: ${ctx.name} is not triggered${why}, so there is no run to conclude`,
        [],
      ),
    ];
  }
  const check = checkValue(want, resultValue(ctx.wf.conclusion));
  if (check.ok) return [];
  const jobs = ctx.wf.jobs.map((j) => `${j.jobId} ${formatValue(resultValue(j.result))}`).join(' · ');
  const headline = `conclusion: expected the run of ${ctx.name} to conclude ${describeExpect(want)}; it ${check.actual}`;
  return [failure(ctx, path, headline, [`jobs: ${jobs}`])];
}

function assertChecks(
  ctx: AssertContext,
  want: string[] | Record<string, ExpectResult>,
  path: Path,
): Failure[] {
  const checks = checksOf(ctx.plan).filter((c) => under(ctx.wf.id, c.node));
  const wanted = Array.isArray(want) ? want : Object.keys(want);
  const out = checkNames(ctx, checks, wanted, path);
  if (!Array.isArray(want)) out.push(...checkResults(ctx, checks, want, path));
  return out;
}

function checkNames(ctx: AssertContext, checks: CheckVerdict[], wanted: string[], path: Path): Failure[] {
  const names = checks.map((c) => c.name);
  const missing = multisetMinus(wanted, names);
  const unexpected = multisetMinus(names, wanted);
  if (!missing.length && !unexpected.length) return [];
  const detail = [
    `missing: ${missing.length ? quote(missing) : '(none)'}`,
    `unexpected: ${unexpected.length ? quote(unexpected) : '(none)'}`,
  ];
  const uncertain = checks.filter((c) => !c.certain).map((c) => c.name);
  if (uncertain.length) detail.push(`names only the run knows exactly: ${quote(uncertain)}`);
  const headline = `checks: expected ${ctx.name} to report ${quote(wanted)}; it reports ${quote(names)}`;
  return [failure(ctx, path, headline, detail)];
}

function checkResults(
  ctx: AssertContext,
  checks: CheckVerdict[],
  want: Record<string, ExpectResult>,
  path: Path,
): Failure[] {
  const out: Failure[] = [];
  for (const [name, expect] of Object.entries(want)) {
    const check = checks.find((c) => c.name === name);
    if (!check) continue;
    const result = checkValue(expect, resultValue(check.result));
    if (result.ok) continue;
    const headline = `checks: expected check '${name}' to conclude ${describeExpect(expect)}; it ${result.actual}`;
    out.push(failure(ctx, [...path, name], headline, []));
  }
  return out;
}

function assertUnknowns(ctx: AssertContext, want: string[], path: Path): Failure[] {
  const reaching = ctx.plan.unknowns.filter(
    (u) =>
      under(ctx.wf.id, u.id) || under(ctx.wf.id, u.producer) || u.affects.some((a) => under(ctx.wf.id, a)),
  );
  const got = reaching.map((u) => unitPathOfId(u.id, ctx.paths));
  const missing = multisetMinus(want, got);
  const unexpected = multisetMinus(got, want);
  if (!missing.length && !unexpected.length) return [];
  const headline =
    want.length === 0
      ? `unknowns: expected none; ${got.length} remain: ${quote(got)}`
      : `unknowns: expected ${quote(want)}; the plan has ${got.length ? quote(got) : '(none)'}`;
  const detail = reaching.map((u) => {
    const affects = u.affects.map((a) => unitPathOfId(a, ctx.paths));
    const pin = u.pin
      ? `pin: ${u.pin.layer}: ${JSON.stringify(u.pin.fragment)}`
      : `no pin: ${u.gap ?? 'only the run knows it'}`;
    return `? ${unitPathOfId(u.id, ctx.paths)}${affects.length ? ` · affects ${affects.join(', ')}` : ''} · ${pin}`;
  });
  return [failure(ctx, path, headline, detail)];
}

// --- run / skip / maybe entries --------------------------------------------------------------------------------------

function assertEntry(
  ctx: AssertContext,
  list: 'run' | 'skip' | 'maybe',
  entry: RunEntry,
  path: Path,
): Failure[] {
  const [unit, because] = typeof entry === 'string' ? [entry, undefined] : Object.entries(entry)[0]!;
  const want: Tri = list === 'run' ? 'yes' : list === 'skip' ? 'no' : 'maybe';
  const key = `${list}[${path[1]}]`;
  const selection = select(ctx, unit, path);
  if (!selection.ok) return [selection.failure];
  const out: Failure[] = [];
  if (selection.value.unexpanded)
    out.push(...unexpandedVerdict(ctx, key, unit, want, because, selection.value, path));
  for (const node of selection.value.nodes) {
    out.push(...assertVerdict(ctx, key, node, want, path));
    if (because !== undefined) out.push(...assertNodeBecause(ctx, key, node, because, path));
  }
  return out;
}

function unexpandedVerdict(
  ctx: AssertContext,
  key: string,
  unit: string,
  want: Tri,
  because: Because | undefined,
  selection: Selection,
  path: Path,
): Failure[] {
  const u = selection.unexpanded!;
  if (want === 'no' && (because === undefined || because === 'parent')) return [];
  const detail = [`${boundaryText(ctx, u)}, so '${unit}' is not in the plan`];
  if (u.reason === 'no-steps') {
    return [
      failure(ctx, path, `${key}: '${unit}' is a step, and the plan was made without steps`, detail, 'T205'),
    ];
  }
  const verb =
    want === 'yes' ? 'to run' : want === 'maybe' ? 'to maybe run' : `to skip because of ${because}`;
  return [failure(ctx, path, `${key}: expected ${unit} ${verb}; it is not planned`, detail)];
}

function boundaryText(ctx: AssertContext, u: Unexpanded): string {
  switch (u.reason) {
    case 'untriggered':
      return `${ctx.name} is not triggered`;
    case 'skipped':
      return `'${u.path}' skips`;
    case 'not-loaded':
      return `the workflow '${u.path}' calls is not in the project`;
    case 'not-fetched':
      return `the remote workflow '${u.path}' calls (${u.remote!.ref}) is not fetched`;
    case 'fetch-failed':
      return `the remote workflow '${u.path}' calls (${u.remote!.ref}) could not be read (${u.remote!.failure})`;
    case 'limit':
      return `the remote workflow '${u.path}' calls (${u.remote!.ref}) is past the limit on remote files read`;
    case 'invalid':
      return `the remote workflow '${u.path}' calls (${u.remote!.ref}) does not parse`;
    default:
      return 'the plan has no steps (detail: legs)';
  }
}

function assertVerdict(ctx: AssertContext, key: string, node: Selected, want: Tri, path: Path): Failure[] {
  const decision = decisionOf(node);
  const got = decision.verdict;
  if (checkTri(want, got, ctx.allowMaybe)) {
    if (got === 'maybe' && want !== 'maybe')
      ctx.notes.push(`${key}: ${node.path} is maybe, accepted (allowMaybe)`);
    return [];
  }
  const verb = want === 'yes' ? 'to run' : want === 'no' ? 'to skip' : 'to maybe run';
  const it = got === 'yes' ? 'it runs' : got === 'no' ? 'it skips' : 'it may run (maybe)';
  return [
    failure(
      ctx,
      path,
      `${key}: expected ${node.path} ${verb}; ${it}`,
      explain(ctx, decision),
      undefined,
      decisionLoc(decision),
    ),
  ];
}

function assertNodeBecause(
  ctx: AssertContext,
  key: string,
  node: Selected,
  want: Because,
  path: Path,
): Failure[] {
  const decision = decisionOf(node);
  if (decision.verdict === 'yes') {
    const headline = `${key}: ${node.path} runs; nothing decided against it, so there is no reason to compare with '${want}'`;
    return [failure(ctx, path, headline, explain(ctx, decision))];
  }
  const reason = decidingReason(decision.chain, decision.verdict);
  if (reason && reasonMatches(reason, want)) return [];
  const does = decision.verdict === 'no' ? 'it does' : 'it may';
  const got = reason ? `${becauseOf(reason)} — ${formatReason(reason)}` : 'nothing';
  const headline = `${key}: expected ${node.path} to skip because of ${want}; ${does} because of ${got}`;
  return [failure(ctx, path, headline, explain(ctx, decision), undefined, decisionLoc(decision))];
}

// --- units -----------------------------------------------------------------------------------------------------------

function assertUnit(ctx: AssertContext, unit: string, want: UnitAssertion, path: Path): Failure[] {
  const selection = select(ctx, unit, path);
  if (!selection.ok) return [selection.failure];
  const out: Failure[] = [];
  const key = `units.${unit}`;
  if (selection.value.unexpanded) out.push(...unexpandedUnit(ctx, unit, want, selection.value, path));
  for (const node of selection.value.nodes) {
    if (want.runs !== undefined)
      out.push(...assertVerdict(ctx, `${key}.runs`, node, triOf(want.runs), [...path, 'runs']));
    if (want.because !== undefined)
      out.push(...assertNodeBecause(ctx, `${key}.because`, node, want.because, [...path, 'because']));
    out.push(...assertUnitFields(ctx, node, want, key, path));
  }
  return out;
}

/** A unit the plan did not expand: `runs: no` and `because: parent` hold by inheritance, anything else cannot. */
function unexpandedUnit(
  ctx: AssertContext,
  unit: string,
  want: UnitAssertion,
  selection: Selection,
  path: Path,
): Failure[] {
  const wanted = want.runs === undefined ? undefined : triOf(want.runs);
  const fields = Object.keys(want).filter((k) => k !== 'runs' && k !== 'because');
  const asksMore =
    (wanted !== undefined && wanted !== 'no') ||
    fields.length > 0 ||
    (want.because !== undefined && want.because !== 'parent');
  if (!asksMore) return [];
  return unexpandedVerdict(ctx, `units.${unit}`, unit, wanted ?? 'yes', want.because, selection, path);
}

function assertUnitFields(
  ctx: AssertContext,
  node: Selected,
  want: UnitAssertion,
  key: string,
  path: Path,
): Failure[] {
  const out = [
    ...assertResultFields(ctx, node, want, key, path),
    ...assertRecordFields(ctx, node, want, key, path),
  ];
  if (want.environment !== undefined)
    out.push(...assertEnvironment(ctx, node, want.environment, key, [...path, 'environment']));
  if (want.check !== undefined) out.push(...assertCheck(ctx, node, want.check, key, [...path, 'check']));
  return out;
}

const RESULT_FIELDS = ['outcome', 'conclusion', 'result'] as const;
const RECORD_FIELDS = ['with', 'inputs', 'env', 'outputs'] as const;

function assertResultFields(
  ctx: AssertContext,
  node: Selected,
  want: UnitAssertion,
  key: string,
  path: Path,
): Failure[] {
  const out: Failure[] = [];
  for (const field of RESULT_FIELDS) {
    const expect = want[field];
    if (expect === undefined) continue;
    const read = readResult(node, field);
    if ('error' in read) {
      out.push(failure(ctx, [...path, field], `${key}.${field}: ${read.error}`, [], 'T206'));
      continue;
    }
    for (const [where, value] of read.values)
      out.push(...compareResult(ctx, `${key}.${field}`, field, where, expect, value, [...path, field]));
  }
  return out;
}

function assertRecordFields(
  ctx: AssertContext,
  node: Selected,
  want: UnitAssertion,
  key: string,
  path: Path,
): Failure[] {
  const out: Failure[] = [];
  for (const field of RECORD_FIELDS) {
    const expects = want[field];
    if (!expects) continue;
    const read = readRecords(node, field);
    if ('error' in read) {
      out.push(failure(ctx, [...path, field], `${key}.${field}: ${read.error}`, [], 'T206'));
      continue;
    }
    for (const [name, expect] of Object.entries(expects))
      out.push(...compareRecord(ctx, key, field, name, expect, read.values, path));
  }
  return out;
}

function compareRecord(
  ctx: AssertContext,
  key: string,
  field: string,
  name: string,
  expect: ExpectValue,
  values: [string, Record<string, Value<Json>>][],
  path: Path,
): Failure[] {
  const out: Failure[] = [];
  for (const [where, record] of values) {
    const value = record[name];
    const check = checkValue(expect, value ?? { known: true, value: '' }, value === undefined);
    if (check.ok) continue;
    const headline = `${key}.${field}.${name}: expected ${describeField(field, where)} ${describeExpect(expect)}; it ${check.actual}`;
    out.push(failure(ctx, [...path, field, name], headline, pinLines(ctx, value)));
  }
  return out;
}

function compareResult(
  ctx: AssertContext,
  key: string,
  field: string,
  where: string,
  expect: ExpectResult,
  value: Value<Result>,
  path: Path,
): Failure[] {
  const check = checkValue(expect, resultValue(value));
  if (check.ok) return [];
  const headline = `${key}: expected ${resultClaim(field, where)} ${describeExpect(expect)}; it ${check.actual}`;
  return [failure(ctx, path, headline, pinLines(ctx, value))];
}

/** `needs.b.result =`, `the check of a to conclude`, `a.f.outcome =`. */
function resultClaim(field: string, where: string): string {
  if (field === 'result') return `needs.${where.replace(/\[.*$/, '').replace(/^.*\//, '')}.result =`;
  if (field === 'conclusion' && !where.includes('.')) return `the check of ${where} to conclude`;
  return `${where}.${field} =`;
}

function assertEnvironment(
  ctx: AssertContext,
  node: Selected,
  expect: ExpectValue,
  key: string,
  path: Path,
): Failure[] {
  if (node.kind === 'step')
    return [failure(ctx, path, `${key}.environment: environment belongs to a job or a leg`, [], 'T206')];
  const out: Failure[] = [];
  for (const leg of legsOf(node)) {
    const where = legPath(node, leg);
    if (!leg.environment) {
      out.push(
        failure(
          ctx,
          path,
          `${key}.environment: expected ${where} to target ${describeExpect(expect)}; it has no environment`,
          [],
        ),
      );
      continue;
    }
    const check = checkValue(expect, leg.environment);
    if (!check.ok)
      out.push(
        failure(
          ctx,
          path,
          `${key}.environment: expected ${where} to target ${describeExpect(expect)}; it ${check.actual}`,
          pinLines(ctx, leg.environment),
        ),
      );
  }
  return out;
}

function assertCheck(
  ctx: AssertContext,
  node: Selected,
  expect: string | string[],
  key: string,
  path: Path,
): Failure[] {
  if (node.kind === 'step')
    return [failure(ctx, path, `${key}.check: check belongs to a job or a leg`, [], 'T206')];
  const wanted = Array.isArray(expect) ? expect : [expect];
  const names =
    node.kind === 'job'
      ? checksOf(ctx.plan)
          .filter((c) => under(node.job.id, c.node))
          .map((c) => c.name)
      : node.leg!.check
        ? [node.leg!.check.name]
        : [];
  if (!multisetMinus(wanted, names).length && !multisetMinus(names, wanted).length) return [];
  return [
    failure(
      ctx,
      path,
      `${key}.check: expected ${node.path} to report ${quote(wanted)}; it reports ${names.length ? quote(names) : '(none)'}`,
      [],
    ),
  ];
}

// --- reading nodes ---------------------------------------------------------------------------------------------------

type Read<T> = { values: [string, T][] } | { error: string };

function readResult(node: Selected, field: 'outcome' | 'conclusion' | 'result'): Read<Value<Result>> {
  const where = node.path;
  if (node.kind === 'step') {
    if (field === 'result')
      return {
        error:
          'result is not a field of a step; a step has outcome (before continue-on-error) and conclusion (after)',
      };
    return { values: [[where, node.step![field]]] };
  }
  if (field === 'outcome')
    return {
      error:
        'outcome is not a field of a job; a job or leg has conclusion (its check run) and result (what needs.<id>.result reads)',
    };
  if (node.kind === 'leg') return { values: [[where, node.leg!.result]] };
  if (field === 'result') return { values: [[where, node.job.result]] };
  return { values: node.job.legs.map((l) => [legPath(node, l), l.result]) };
}

const legsOf = (node: Selected): LegPlan[] =>
  node.kind === 'job' ? node.job.legs : node.kind === 'leg' ? [node.leg!] : [];
const legPath = (node: Selected, leg: LegPlan): string =>
  node.kind === 'job' && leg.legKey !== '' ? `${node.path}[${leg.legKey}]` : node.path;

function readRecords(
  node: Selected,
  field: 'with' | 'inputs' | 'env' | 'outputs',
): Read<Record<string, Value<Json>>> {
  switch (field) {
    case 'with':
      return readWith(node);
    case 'inputs':
      return readInputs(node);
    case 'env':
      return readEnv(node);
    default:
      return {
        values: [
          [
            node.path,
            node.kind === 'step'
              ? node.step!.outputs
              : node.kind === 'leg'
                ? node.leg!.outputs
                : node.job.outputs,
          ],
        ],
      };
  }
}

function readWith(node: Selected): Read<Record<string, Value<Json>>> {
  if (node.kind === 'step') return { values: [[node.path, node.step!.with]] };
  if (node.job.with) return { values: [[node.path, node.job.with]] };
  return { error: 'with belongs to a step or to a job that calls a reusable workflow' };
}

const NO_INPUTS =
  'inputs belongs to a job that calls a reusable workflow, or to a step that uses a composite action';

function readInputs(node: Selected): Read<Record<string, Value<Json>>> {
  if (node.kind === 'step')
    return node.step!.composite
      ? { values: [[node.path, node.step!.composite.inputs]] }
      : { error: NO_INPUTS };
  if (!node.job.uses) return { error: NO_INPUTS };
  return { values: legsOf(node).map((l) => [legPath(node, l), l.call?.inputs ?? {}]) };
}

function readEnv(node: Selected): Read<Record<string, Value<Json>>> {
  if (node.kind === 'step') return { values: [[node.path, { ...node.leg!.env, ...node.step!.env }]] };
  return { values: legsOf(node).map((l) => [legPath(node, l), l.env]) };
}

function describeField(field: string, where: string): string {
  switch (field) {
    case 'with':
      return `${where} to be given`;
    case 'inputs':
      return `${where} to receive`;
    case 'env':
      return `env at ${where} to have`;
    default:
      return `${where} to output`;
  }
}

// --- selection and explanations -------------------------------------------------------------------------------------

type Selected2 = { ok: true; value: Selection } | { ok: false; failure: Failure };

function select(ctx: AssertContext, unit: string, path: Path): Selected2 {
  try {
    const value = selectNodes(ctx.plan, unit, ctx.wf.path);
    if (value.unexpanded) {
      const problem = declaredBelow(ctx, unit);
      if (problem)
        return { ok: false, failure: failure(ctx, path, `${keyOf(path)}: ${problem}`, [], 'T204') };
    }
    return { ok: true, value };
  } catch (e) {
    if (!(e instanceof SelectionError)) throw e;
    return { ok: false, failure: failure(ctx, path, `${keyOf(path)}: ${e.message}`, [], e.code) };
  }
}

const keyOf = (path: Path): string =>
  path.map((p, i) => (typeof p === 'number' ? `[${p}]` : i === 0 ? p : `.${p}`)).join('');

/** A name under an unexpanded boundary, checked against the project's declarations: a typo is still an error. */
function declaredBelow(ctx: AssertContext, unit: string): string | undefined {
  const { segments } = parseUnitPath(unit);
  let wf: WorkflowDecl | undefined = ctx.decl;
  for (const [i, seg] of segments.entries()) {
    if (!wf || seg.job === undefined) return undefined;
    const job = wf.jobs[seg.job];
    if (!job)
      return `no job '${seg.job}' in ${wf.path.replace(/^.*\//, '')} (jobs: ${Object.keys(wf.jobs).join(', ')})`;
    if (seg.step) return declaredStep(ctx, job, seg.step, segments.slice(i + 1), unit);
    if (i < segments.length - 1) wf = ctx.index.calleeOf(job);
  }
  return undefined;
}

function declaredStep(
  ctx: AssertContext,
  job: JobDecl,
  want: PathStep,
  rest: PathSegment[],
  unit: string,
): string | undefined {
  const step = findDecl(job.steps, want);
  if (!step) return `no step ${stepLabel(want)} in '${job.id}' (${job.steps.length} steps)`;
  return declaredInAction(ctx, step, rest, unit);
}

const findDecl = (steps: StepDecl[], want: PathStep): StepDecl | undefined =>
  want.id !== undefined ? steps.find((s) => s.id === want.id) : steps[want.index! - 1];
const stepLabel = (want: PathStep): string => (want.id !== undefined ? `'${want.id}'` : `#${want.index}`);

function declaredInAction(
  ctx: AssertContext,
  step: StepDecl,
  rest: PathSegment[],
  unit: string,
): string | undefined {
  const inner = rest[0]?.step;
  if (!inner) return undefined;
  const action = ctx.index.actionOf(step);
  if (!action) return undefined;
  return findDecl(action.steps, inner)
    ? undefined
    : `no step ${stepLabel(inner)} in the action ${action.path} of '${unit}'`;
}

function decisionOf(node: Selected): Decision {
  if (node.kind === 'job') return node.job.runs;
  if (node.kind === 'leg') return node.leg!.runs;
  return node.step!.runs;
}

function decisionLoc(decision: Decision): Loc | undefined {
  const reason = decidingReason(decision.chain, decision.verdict);
  return reason && 'loc' in reason ? reason.loc : undefined;
}

/** The chain as lines: `→` on the deciding clause, status and reads under an `if`, unknowns with pins for a maybe. */
export function explain(ctx: AssertContext, decision: Decision): string[] {
  const deciding = decidingReason(decision.chain, decision.verdict);
  const lines: string[] = [];
  for (const r of decision.chain) {
    const mark = r === deciding ? '→ ' : '  ';
    const where = r.kind === 'parent' ? ` (${nodeName(ctx, r.node)})` : '';
    lines.push(`${mark}${formatReason(r)}${where}`);
    if (r.kind === 'if') lines.push(...ifDetail(ctx, r));
    if ('loc' in r && r.loc) lines.push(`    at ${r.loc.file}:${r.loc.line}:${r.loc.column}`);
  }
  if (decision.verdict === 'maybe') {
    const ids = decision.chain.flatMap(reasonUnknowns);
    lines.push(...pinLines(ctx, { known: false, unknowns: [...new Set(ids)] }));
    lines.push('a maybe fails this assertion; pin the unknown, or set allowMaybe: true to accept it');
  }
  return lines;
}

function ifDetail(ctx: AssertContext, r: Reason & { kind: 'if' }): string[] {
  const lines: string[] = [];
  const written = r.expr === '' ? r.evaluated : r.expr;
  if (/\b(success|failure|cancelled|always)\(\)/.test(written)) {
    lines.push(`    ← status = ${formatValue(resultValue(r.status))}`);
  }
  for (const read of r.reads ?? []) {
    const from = read.from ? ` (from ${nodeName(ctx, read.from)})` : '';
    lines.push(`    ← ${read.ref} = ${formatValue(read.value)}${from}`);
  }
  return lines;
}

/** The unknowns a value depends on, each with what would pin it. */
function pinLines(ctx: AssertContext, value: Value<Json> | undefined): string[] {
  if (!value || value.known) return [];
  return value.unknowns.map((id) => {
    const u = ctx.plan.unknowns.find((x) => x.id === id);
    const pin = u?.pin
      ? `pin: ${u.pin.layer}: ${JSON.stringify(u.pin.fragment)}`
      : `no pin: ${u?.gap ?? 'only the run knows it'}`;
    return `? ${unitPathOfId(id, ctx.paths)} · ${pin}`;
  });
}

/** A node by its unit path; the workflow by its file name. */
const nodeName = (ctx: AssertContext, id: NodeId): string =>
  ctx.paths.get(id) ?? (id === ctx.wf.id ? ctx.name : id);

function reasonMatches(reason: Reason, want: Because): boolean {
  if (want === 'filter') return reason.kind === 'filter';
  return becauseOf(reason) === want;
}

function failure(
  ctx: AssertContext,
  path: Path,
  headline: string,
  detail: string[],
  code?: string,
  workflowLoc?: Loc,
): Failure {
  const f: Failure = {
    status: code ? 'invalid' : 'failed',
    headline,
    detail,
    at: ctx.pos(path, typeof path.at(-1) === 'number' ? 'value' : 'key'),
  };
  if (code) f.code = code;
  if (workflowLoc) f.workflowLoc = workflowLoc;
  return f;
}

const under = (root: NodeId, id: string | undefined): boolean =>
  id !== undefined &&
  (id === root ||
    id.startsWith(`${root}#`) ||
    id.startsWith(`${root}[`) ||
    id.startsWith(`${root}/`) ||
    id.startsWith(`${root}>`));

function multisetMinus(a: readonly string[], b: readonly string[]): string[] {
  const rest = [...b];
  return a.filter((x) => {
    const i = rest.indexOf(x);
    if (i === -1) return true;
    rest.splice(i, 1);
    return false;
  });
}

const quote = (items: readonly string[]): string => items.map((s) => `'${s}'`).join(', ');

function describeExpect(expect: ExpectValue): string {
  if (Array.isArray(expect)) return `one of ${quote(expect.map((e) => stringOf(e as Json)))}`;
  if (typeof expect === 'object')
    return 'unknown' in expect ? 'to stay unknown' : `to match /${expect.match}/`;
  return `'${stringOf(expect)}'`;
}
