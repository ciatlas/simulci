/* oxlint-disable no-restricted-imports -- the worker is where the engine runs */
import {
  type AssumeEntry,
  type CaseResult,
  type FileResult,
  type LoadedProject,
  type Loc,
  mergeScenario,
  parseYaml,
  type RunPlan,
  runTests,
  type Snapshot,
  type SnapshotStore,
  type TestFile,
  TestFileSchema,
  testFileFailures,
} from '@simulci/engine';
import { snapshotPath } from '../lib/snapshot-path';
import { triggerLoc } from './derived';
import type { Outline, OutlineFile, TestedCase, TestedFile, TestedResponse, TestRequest } from './protocol';

/**
 * The route tests a load carries, as the Outline lists them (synthesis § 4.9): never loaded into the project, each
 * checked as `simulci test` checks a file before it runs a case (its YAML, its schema, its case names), the failures
 * at their lines in the CLI's words.
 */
function testFilesOf(tests: Readonly<Record<string, string>>): OutlineFile[] {
  return Object.entries(tests).map(([path, text]) => ({
    path,
    kind: 'test',
    errors: testFileFailures(text).map((f) => ({
      line: f.at.line,
      column: f.at.col,
      message: f.headline,
      source: 'test',
    })),
  }));
}

/** The Outline with the route tests among its files, all by path. */
export function withTests(outline: Outline, tests: Readonly<Record<string, string>> | undefined): Outline {
  if (!tests || Object.keys(tests).length === 0) return outline;
  const files = [...outline.files, ...testFilesOf(tests)].sort((a, b) => a.path.localeCompare(b.path));
  return { ...outline, files };
}

/**
 * The Tests tab's run (synthesis § 5.1): the route tests of a load, run by the engine's `runTests` as `simulci test`
 * runs them, against the load's snapshots, which nothing writes. Each case comes back without its plan but with what
 * the tab offers for it: its line in the test file, the workflow line that decided it, and its scenario and mocks.
 */

export interface TestInputs {
  loaded: LoadedProject;
  /** The project's Outline, where a workflow's `on:` lines are. */
  outline: Outline;
  tests: Readonly<Record<string, string>>;
  readonly: Readonly<Record<string, string>>;
}

/** What `simulci test` notes when it writes a missing snapshot; the page writes none. */
const WRITTEN = 'snapshot written';
export const NOT_WRITTEN = 'snapshot not written here';

/** Snapshots read from the load's read-only files, as `simulci test` reads them from disk; a write is dropped. */
export function readOnlySnapshots(files: Readonly<Record<string, string>>): SnapshotStore {
  return {
    read: (testFile) => {
      const path = snapshotPath(testFile);
      const text = files[path];
      if (text === undefined) return undefined;
      try {
        return JSON.parse(text) as Snapshot;
      } catch (e) {
        throw new Error(`${path} is not JSON: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
    },
    write: () => undefined,
  };
}

export function runRouteTests(
  inputs: TestInputs,
  request: TestRequest,
  project: number,
): Omit<TestedResponse, 'ms'> {
  const files = Object.keys(inputs.tests)
    .sort((a, b) => a.localeCompare(b))
    .map((path) => ({ path, text: inputs.tests[path]! }));
  const result = runTests(inputs.loaded, files, {
    ci: request.ci,
    snapshots: readOnlySnapshots(inputs.readonly),
    ...(request.filter === undefined ? {} : { filter: request.filter }),
  });
  return {
    id: request.id,
    type: 'tested',
    project,
    files: result.files.map((f) => testedFile(f, inputs.tests[f.path] ?? '', inputs)),
    summary: result.summary,
    exitCode: result.exitCode,
  };
}

function testedFile(file: FileResult, text: string, { loaded, outline }: TestInputs): TestedFile {
  // A case of a workflow the project lacks (T201) has no scenario to load.
  const known = file.workflow !== undefined && loaded.index.project.workflows.has(file.workflow);
  const spec = specOf(text, known);
  return {
    path: file.path,
    ...(file.workflow === undefined ? {} : { workflow: file.workflow }),
    status: file.status,
    failures: file.failures,
    notes: file.notes,
    cases: file.cases.map((c, i) => testedCase(c, i, spec, file.workflow, outline)),
  };
}

/**
 * The file's text, parsed, and its spec when the schema takes it and its workflow is known: the runner reported each
 * case in its order.
 */
function specOf(
  text: string,
  known: boolean,
): { posOf: ReturnType<typeof parseYaml>['posOf']; spec?: TestFile } {
  const parsed = parseYaml(text);
  const checked = parsed.errors.length || !known ? undefined : TestFileSchema.safeParse(parsed.doc.toJS());
  return { posOf: parsed.posOf, ...(checked?.success ? { spec: checked.data } : {}) };
}

function testedCase(
  c: CaseResult,
  i: number,
  { posOf, spec }: ReturnType<typeof specOf>,
  workflow: string | undefined,
  outline: Outline,
): TestedCase {
  const out: TestedCase = {
    name: c.name,
    status: c.status,
    failures: c.failures,
    notes: c.notes.map((n) => (n === WRITTEN ? NOT_WRITTEN : n)),
    line: posOf(['cases', i, 'name'], 'key').line,
  };
  if (c.reason !== undefined) out.reason = c.reason;
  const deciding = decidingLoc(c, workflow, outline);
  if (deciding) out.deciding = deciding;
  const testCase = spec?.cases[i];
  if (spec && testCase) {
    out.scenario = mergeScenario(spec.given, testCase.when);
    out.assume = [...(spec.given?.assume ?? []), ...(testCase.when.assume ?? [])] satisfies AssumeEntry[];
  }
  return out;
}

/** The workflow line that decided the case's first failure that has one, else the `on:` line that decided its run. */
function decidingLoc(c: CaseResult, workflow: string | undefined, outline: Outline): Loc | undefined {
  const failed = c.failures.find((f) => f.workflowLoc)?.workflowLoc;
  if (failed) return failed;
  const wf = workflowOf(c.plan, workflow);
  return wf && triggerLoc(wf, outline);
}

const workflowOf = (plan: RunPlan | undefined, workflow: string | undefined) =>
  workflow === undefined ? undefined : plan?.workflows.find((w) => w.depth === 0 && w.path === workflow);
