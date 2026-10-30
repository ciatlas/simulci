import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  type Annotation,
  annotationsOf,
  type AssumeEntry,
  type LoadedProject,
  loadFiles,
  MocksError,
  type RemotesMode,
  type RunOptions,
  type RunPlan,
  type RunResult,
  renderJUnit,
  renderMarkdownReport,
  renderMermaid,
  renderText,
  renderTextReport,
  runTests,
  type ScenarioInput,
  simulate,
} from '@simulci/engine';
import {
  AssumeError,
  discoverTests,
  diskSnapshotStore,
  misplacedTests,
  parseAssume,
  readTests,
  readWorkflowFiles,
  TESTS_DIR,
  TestsError,
} from '@simulci/node';
import { parse } from 'yaml';
import {
  effectiveMode,
  failureLines,
  inThisRepository,
  printable,
  printableAnnotation,
  type RemotesSetup,
  readRemotes,
  remotesMode,
  withLockfiles,
} from './remotes';

/**
 * The action, over what the runner gives it: inputs, outputs, annotations, the job summary, the log. `test` runs the
 * route tests of the checkout as `simulci test --ci` would and fails the step when they do; `plan` prints the plan
 * for a scenario and puts it in the job summary.
 */

export interface Ports {
  /** An input, trimmed; empty when not set. */
  input(name: string): string;
  setOutput(name: string, value: string | number): void;
  annotate(annotation: Annotation): void;
  summary(markdown: string): Promise<void>;
  log(text: string): void;
  warn(message: string): void;
  /** Marks the step failed with the message; the action still finishes what it was doing. */
  fail(message: string): void;
  workspace: string;
  /** The runner's variables: `GITHUB_EVENT_NAME`, `GITHUB_REPOSITORY`, `GITHUB_API_URL`. */
  env: Record<string, string | undefined>;
  /** What reads GitHub; by default `globalThis.fetch`. */
  fetch?: RemotesSetup['fetch'];
}

const OUTPUTS = ['passed', 'failed', 'invalid', 'skipped'] as const;

export async function run(runner: Ports): Promise<void> {
  const ports = shown(runner);
  for (const name of OUTPUTS) ports.setOutput(name, 0);
  ports.setOutput('exit-code', 2);
  ports.setOutput('triggered', '');
  const mode = ports.input('mode') || 'test';
  if (mode !== 'test' && mode !== 'plan') {
    ports.fail(`mode must be test or plan, not '${mode}'`);
    return;
  }
  const dir = ports.input('working-directory') || '.';
  const root = resolve(ports.workspace, dir);
  const workflows = readWorkflowFiles(root);
  if (Object.keys(workflows).length === 0) {
    ports.fail(`no workflows under ${dir}/.github/workflows`);
    return;
  }
  let assume: AssumeEntry[];
  try {
    assume = parseAssume(lines(ports.input('assume')));
  } catch (e) {
    if (!(e instanceof AssumeError)) throw e;
    ports.fail(e.message);
    return;
  }
  const remotes = remotesMode(ports.input('remotes'), mode === 'test');
  if (typeof remotes !== 'string') {
    ports.fail(remotes.error);
    return;
  }
  const repository = ports.env.GITHUB_REPOSITORY || undefined;
  const ctx: Context = { ports, root, dir, workflows, assume, remotes, repository };
  if (mode === 'plan') await plan(ctx);
  else await test(ctx);
}

interface Context {
  ports: Ports;
  root: string;
  dir: string;
  workflows: Record<string, string>;
  assume: AssumeEntry[];
  remotes: RemotesMode;
  repository: string | undefined;
}

/** GitHub shows ten annotations of a kind per step: past five unread remotes, the log has them all. */
const UNREAD_SHOWN = 5;

function shownUnread(lines: string[]): string[] {
  if (lines.length <= UNREAD_SHOWN) return lines;
  const rest = lines.length - (UNREAD_SHOWN - 1);
  return [
    ...lines.slice(0, UNREAD_SHOWN - 1),
    `${rest} more remotes not read or lockfiles not used: see the log`,
  ];
}

/** The engine's files and remotes, read as the `remotes` input says (`off` on an untrusted event). */
async function loadInputs(ctx: Context) {
  const { ports } = ctx;
  const mode = effectiveMode({ mode: ctx.remotes, env: ports.env, warn: (m) => ports.warn(m) });
  const load = await readRemotes(ctx.root, ctx.workflows, {
    mode,
    token: ports.input('token'),
    apiUrl: ports.input('api-url'),
    githubComToken: ports.input('github-com-token'),
    env: ports.env,
    ...(ports.fetch ? { fetch: ports.fetch } : {}),
    log: (l) => ports.log(l),
  });
  const failed = failureLines(load.remotes.failed ?? []);
  const lockErrors = load.lockErrors.map((e) => `not used: ${e}`);
  const unread = [...failed, ...lockErrors];
  const read = load.remotes.sources.length;
  if (read + failed.length > 0) ports.log(`remotes: ${mode}, ${read} read, ${failed.length} not read\n`);
  if (unread.length > UNREAD_SHOWN) ports.log(`${unread.join('\n')}\n`);
  return { files: withLockfiles(ctx.root, ctx.workflows), mode, remotes: load.remotes, unread };
}

async function test(ctx: Context): Promise<void> {
  const { ports, root } = ctx;
  const named = lines(ports.input('files')).map((f) => resolve(root, f));
  const files = discoverTests(root, named);
  const misplaced = misplacedTests(files);
  if (misplaced.length) {
    ports.fail(
      `T000 ${misplaced.join(', ')}: a test file under .github/workflows would be run by GitHub; put it under ${TESTS_DIR}`,
    );
    return;
  }
  const inputs = await loadInputs(ctx);
  let project: LoadedProject;
  let result: RunResult;
  try {
    project = loadFiles(inputs.files, {
      ...(ctx.repository ? { repository: ctx.repository } : {}),
      remotes: inputs.remotes,
      mode: inputs.mode,
    });
    result = runTests(project, readTests(root, files), testOptions(ctx));
  } catch (e) {
    if (!(e instanceof MocksError || e instanceof TestsError)) throw e;
    ports.fail(e.message);
    return;
  }
  await reportTests(ctx, inThisRepository(result, project));
  for (const name of OUTPUTS) ports.setOutput(name, result.summary[name]);
  // A locked remote that cannot be read never gives a verdict: as `simulci test`, exit 2.
  const exitCode = inputs.unread.length ? 2 : result.exitCode;
  ports.setOutput('exit-code', exitCode);
  for (const line of shownUnread(inputs.unread)) ports.fail(line);
  if (exitCode !== 0) {
    const s = result.summary;
    ports.fail(
      `simulci test: ${s.failed} failed, ${s.invalid} invalid, ${s.passed} passed (exit ${exitCode})`,
    );
  }
}

/** As `simulci test --ci`: snapshots are never written, a missing one fails. */
function testOptions(ctx: Context): RunOptions {
  const options: RunOptions = {
    ci: true,
    strict: bool(ctx.ports, 'strict'),
    snapshots: diskSnapshotStore(ctx.root),
  };
  const filter = ctx.ports.input('filter');
  if (filter) options.filter = filter;
  if (ctx.assume.length) options.cli = ctx.assume;
  return options;
}

/** The log, the annotations, the job summary and the JUnit file. */
async function reportTests(ctx: Context, result: RunResult): Promise<void> {
  const { ports } = ctx;
  ports.log(renderTextReport(result));
  if (bool(ports, 'annotations', true))
    for (const a of annotationsOf(result)) ports.annotate(inWorkspace(ctx, a));
  if (bool(ports, 'summary', true)) {
    await ports.summary(renderMarkdownReport(result, { title: ports.input('title') || 'simulci test' }));
  }
  const junit = ports.input('junit');
  if (junit) writeReport(ctx, junit, renderJUnit(result));
}

async function plan(ctx: Context): Promise<void> {
  const { ports } = ctx;
  const text = ports.input('scenario');
  if (!text) {
    ports.fail('scenario is required in plan mode: a YAML mapping such as { event: push, branch: main }');
    return;
  }
  const inputs = await loadInputs(ctx);
  for (const line of shownUnread(inputs.unread)) ports.warn(line);
  let result: RunPlan;
  try {
    const scenario = parse(text) as ScenarioInput;
    // The scenario's own `repository` wins: it may plan the workflows as another repository runs them.
    const repository = scenario?.repository === undefined ? ctx.repository : undefined;
    result = simulate({
      files: inputs.files,
      scenario,
      mocks: { cli: ctx.assume },
      ...(repository ? { repository } : {}),
      remotes: inputs.remotes,
      remotesMode: inputs.mode,
    });
  } catch (e) {
    if (!(e instanceof Error)) throw e;
    ports.fail(`scenario: ${e.message}`);
    return;
  }
  ports.log(renderPlan(result, ports.input('format') || 'text'));
  if (bool(ports, 'summary', true))
    await ports.summary(planSummary(result, ports.input('title') || 'simulci plan'));
  ports.setOutput('triggered', result.workflows.filter((w) => w.triggered.verdict !== 'no').length);
  ports.setOutput('exit-code', 0);
}

function renderPlan(result: RunPlan, format: string): string {
  if (format === 'json') return `${JSON.stringify(result, null, 2)}\n`;
  return format === 'mermaid' ? renderMermaid(result) : renderText(result);
}

/** The plan as text, then the graph (GitHub renders Mermaid in job summaries). */
function planSummary(result: RunPlan, title: string): string {
  const text = renderText(result).trimEnd();
  const graph = renderMermaid(result).trimEnd();
  return [`## ${title}: ${result.scenario.id}`, '', fenced(text), '', fenced(graph, 'mermaid'), ''].join(
    '\n',
  );
}

/** A code block no line of the text can close: its fence is longer than any run of backticks in it. */
function fenced(text: string, info = ''): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((ticks) => ticks.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${text}\n${fence}`;
}

/**
 * Log text that cannot run a workflow command: the log shows other repositories' text, and between `stop-commands`
 * and its one-time token the runner reads no line as one (`::error`, `::add-mask`, `##[group]`, …).
 */
export const withoutCommands = (text: string, resume: string): string =>
  `::stop-commands::${resume}\n${text.replace(/\n$/, '')}\n::${resume}::`;

/**
 * The ports with every text a remote can reach made printable: the log, warnings, failures, annotations and the job
 * summary. (The log's lines are also kept from being read as workflow commands; see `index.ts`.)
 */
function shown(ports: Ports): Ports {
  return {
    ...ports,
    log: (text) => ports.log(printable(text)),
    warn: (message) => ports.warn(printable(message)),
    fail: (message) => ports.fail(printable(message)),
    annotate: (a) => ports.annotate(printableAnnotation(a)),
    summary: (markdown) => ports.summary(printable(markdown)),
  };
}

/** Annotation paths are relative to the repository root; the tests' are relative to working-directory. */
function inWorkspace(ctx: Context, a: Annotation): Annotation {
  if (isAbsolute(a.file)) return a;
  const file = relative(ctx.ports.workspace, resolve(ctx.root, a.file)).split(sep).join('/');
  return { ...a, file };
}

/** Writes a report under the workspace; a path that escapes it is refused. */
function writeReport(ctx: Context, path: string, content: string): void {
  const file = resolve(ctx.ports.workspace, path);
  if (!insideWorkspace(ctx.ports.workspace, file)) {
    ctx.ports.fail(`${path} is outside the workspace; reports are written under it`);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  ctx.ports.setOutput('junit', file);
}

/** By real paths, so a symbolic link in the checkout cannot point the report elsewhere. */
function insideWorkspace(workspace: string, file: string): boolean {
  let dir = file;
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  const base = realpathSync.native(workspace);
  const target = realpathSync.native(dir);
  return target === base || target.startsWith(`${base}${sep}`);
}

const lines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

function bool(ports: Ports, name: string, fallback = false): boolean {
  const v = ports.input(name).toLowerCase();
  if (v === '') return fallback;
  return v === 'true';
}
