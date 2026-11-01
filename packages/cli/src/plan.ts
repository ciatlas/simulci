import { resolve } from 'node:path';
import {
  type AssumeEntry,
  fileFromPlan,
  MocksError,
  parseScenario,
  type RunPlan,
  renderMermaid,
  renderText,
  ScenarioError,
  type ScenarioInput,
  simulate,
} from '@simulci/engine';
import { type ArgsDef, defineCommand } from 'citty';
import { AssumeError, readWorkflowFiles } from '@simulci/node';
import { assumeOf, exitCodeOf, oneOf, processIo, readArgs, spoken, values, withoutCommands } from './args';
import {
  failureLines,
  readRemotes,
  REMOTE_ARGS,
  type RemoteArgs,
  type RemotesIo,
  remotesMode,
} from './remotes';

const FORMATS = ['text', 'json', 'mermaid'] as const;
const DETAILS = ['steps', 'legs'] as const;
const AS_TEST = ['jobs', 'steps'] as const;

/** The `simulci plan` arguments: as citty parses them, by their camelCase names, with each choice checked. */
export interface PlanArgs extends RemoteArgs {
  dir: string;
  event: string;
  action?: string;
  ref?: string;
  branch?: string;
  tag?: string;
  base?: string;
  head?: string;
  changed?: string | string[];
  input?: string | string[];
  var?: string | string[];
  secret?: string | string[];
  actor?: string;
  fork?: boolean;
  message?: string;
  format: (typeof FORMATS)[number];
  detail: (typeof DETAILS)[number];
  assume?: string | string[];
  assumeFile?: string;
  /** Print the plan as a test case instead: `jobs` (also a bare `--as-test`) or `steps`. */
  asTest?: (typeof AS_TEST)[number];
  /** The workflow the test case is about (default: the first triggered one). */
  workflow?: string;
}

/** Builds the scenario from the arguments: `key=value` lists become records, repeated flags become arrays. */
export function scenarioFromArgs(args: PlanArgs): ScenarioInput {
  const s: ScenarioInput = { event: args.event };
  for (const key of ['action', 'ref', 'branch', 'tag', 'base', 'head', 'message'] as const) {
    const v = args[key];
    if (v !== undefined && v !== '') s[key] = v;
  }
  const changed = list(args.changed);
  if (changed.length) s.changed = changed;
  const inputs = pairs(list(args.input));
  if (Object.keys(inputs).length)
    s.inputs = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, typed(v)]));
  const vars = pairs(list(args.var));
  if (Object.keys(vars).length) s.vars = vars;
  const secrets = list(args.secret);
  if (secrets.length) s.secrets = secrets;
  if (args.actor !== undefined || args.fork) {
    s.actor = {};
    if (args.actor !== undefined) s.actor.login = args.actor;
    if (args.fork) s.actor.fork = true;
  }
  return s;
}

const list = (v: string | string[] | undefined): string[] =>
  values(v)
    .flatMap((x) => x.split(','))
    .map((x) => x.trim())
    .filter(Boolean);

function pairs(items: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of items) {
    const eq = item.indexOf('=');
    if (eq === -1) out[item] = '';
    else out[item.slice(0, eq)] = item.slice(eq + 1);
  }
  return out;
}

/** `true`, `false` and numbers as the typed values a dispatch input holds; anything else stays a string. */
function typed(v: string): string | boolean | number {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v;
}

export function render(plan: RunPlan, format: PlanArgs['format']): string {
  if (format === 'json') return `${JSON.stringify(plan, null, 2)}\n`;
  if (format === 'mermaid') return renderMermaid(plan);
  return renderText(plan);
}

const PLAN_ARGS = {
  dir: { type: 'string', description: 'The repository checkout', default: '.' },
  event: {
    type: 'string',
    description: 'The event (push, pull_request, workflow_dispatch, …)',
    default: 'push',
  },
  action: { type: 'string', description: 'The activity type (opened, labeled, …)' },
  ref: { type: 'string', description: 'The git ref (refs/heads/main, or a branch name)' },
  branch: { type: 'string', description: 'The branch (refs/heads/<branch>)' },
  tag: { type: 'string', description: 'The tag (refs/tags/<tag>)' },
  base: { type: 'string', description: 'The base branch of a pull request' },
  head: { type: 'string', description: 'The head branch of a pull request' },
  changed: { type: 'string', description: 'Changed files, comma-separated or repeated' },
  input: { type: 'string', description: 'A workflow_dispatch input, name=value (repeatable)' },
  var: { type: 'string', description: 'A variable, NAME=value (repeatable)' },
  secret: { type: 'string', description: 'A secret that exists, by name (repeatable)' },
  actor: { type: 'string', description: 'The actor login' },
  fork: { type: 'boolean', description: 'The pull request comes from a fork', default: false },
  message: { type: 'string', description: 'The head commit message' },
  format: { type: 'string', description: spoken(FORMATS), default: 'text' },
  detail: { type: 'string', description: spoken(DETAILS), default: 'steps' },
  assume: {
    type: 'string',
    description: 'A mock: build.unit=failure, build.unit.outputs.sha=abc (repeatable)',
  },
  'assume-file': { type: 'string', description: 'A YAML list of mocks' },
  'as-test': {
    type: 'string',
    description: 'Print a test case instead of the plan: jobs (also a bare --as-test) or steps',
  },
  workflow: { type: 'string', description: 'With --as-test: the workflow the case is about' },
  ...REMOTE_ARGS,
} satisfies ArgsDef;

export const planCommand = defineCommand({
  meta: { name: 'plan', description: 'Which jobs and steps run for a scenario, and why' },
  args: PLAN_ARGS,
  async run({ rawArgs }) {
    const io = processIo();
    process.exitCode = await exitCodeOf(async () => {
      const out = await planOutput(planArgs(rawArgs), io);
      (out.code ? io.stderr : io.stdout)(withoutCommands(out.text));
      return out.code;
    }, io);
  },
});

/**
 * The arguments of a `simulci plan` command line: every value of a repeated flag, and `jobs` for a bare `--as-test`.
 * A `FlagError` when `--format`, `--detail`, `--as-test` or `--remotes` is given a value it does not take.
 */
export function planArgs(rawArgs: readonly string[]): PlanArgs {
  const a = readArgs(rawArgs, PLAN_ARGS, {
    repeated: ['changed', 'input', 'var', 'secret', 'assume'],
    bare: { 'as-test': 'jobs' },
  });
  return {
    ...(a as unknown as PlanArgs),
    format: oneOf('format', a.format, FORMATS),
    detail: oneOf('detail', a.detail, DETAILS),
    remotes: remotesMode(a.remotes),
    // `--no-as-test` reads false: no test case.
    asTest: a.asTest === undefined || a.asTest === false ? undefined : oneOf('as-test', a.asTest, AS_TEST),
  };
}

/**
 * What `simulci plan` prints, and the exit code: 2, with the message, when it cannot. Remotes are read as `--remotes`
 * says; one that could not be read stays an open call, with the host's message on stderr.
 */
export async function planOutput(a: PlanArgs, io: RemotesIo): Promise<{ text: string; code: number }> {
  const files = readWorkflowFiles(a.dir);
  if (Object.keys(files).length === 0)
    return { text: `no workflows under ${a.dir}/.github/workflows\n`, code: 2 };
  const assume = mocksOf(a);
  if (typeof assume === 'string') return { text: assume, code: 2 };
  const scenario = scenarioFromArgs(a);
  try {
    parseScenario(scenario);
    const remotes = await readRemotes(resolve(a.dir), files, a, io);
    for (const line of failureLines(remotes.read?.remotes.failed ?? [])) io.stderr(line);
    const plan = simulate({
      files: remotes.files,
      scenario,
      detail: a.detail,
      mocks: { cli: assume },
      ...(remotes.options.repository === undefined ? {} : { repository: remotes.options.repository }),
      ...(remotes.options.remotes ? { remotes: remotes.options.remotes } : {}),
      ...(remotes.options.mode ? { remotesMode: remotes.options.mode } : {}),
    });
    if (a.asTest === undefined) return { text: render(plan, a.format), code: 0 };
    return asTest(plan, a, scenario, assume);
  } catch (e) {
    if (!(e instanceof MocksError || e instanceof ScenarioError)) throw e;
    return { text: `${e.message}\n`, code: 2 };
  }
}

/** The `--assume` entries, or the message to print when they do not parse. */
function mocksOf(a: PlanArgs): AssumeEntry[] | string {
  try {
    return assumeOf(a.assume, a.assumeFile);
  } catch (e) {
    if (!(e instanceof AssumeError)) throw e;
    return `${e.message}\n`;
  }
}

/** The plan as a test case about `--workflow`, else the first triggered workflow. */
function asTest(
  plan: RunPlan,
  a: PlanArgs,
  scenario: ScenarioInput,
  assume: AssumeEntry[],
): { text: string; code: number } {
  const first = plan.workflows.find((w) => w.triggered.verdict !== 'no') ?? plan.workflows[0];
  const workflow = a.workflow ?? first?.path;
  if (workflow === undefined) return { text: 'no workflow to write a test for\n', code: 2 };
  const path = workflow.startsWith('.github/workflows/') ? workflow : `.github/workflows/${workflow}`;
  if (!plan.workflows.some((w) => w.depth === 0 && w.path === path))
    return { text: `--workflow ${workflow}: no ${path} in the checkout\n`, code: 2 };
  return { text: fileFromPlan({ plan, workflow, scenario, assume, detail: a.asTest ?? 'jobs' }), code: 0 };
}
