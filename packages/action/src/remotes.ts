import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Annotation,
  type Loc,
  type LoadedProject,
  REMOTES_LOCK_FILE,
  type RemoteFailureInput,
  type RemotesMode,
  type RunPlan,
  type RunResult,
  type StepPlan,
  type WorkflowPlan,
} from '@simulci/engine';
import { githubComFallback, loadRemotes, type RemotesHost, type RemotesLoad } from '@simulci/node';

/**
 * The remote workflows and actions the checkout uses, read with the `token` input, and what the action shows of
 * them: a remote's strings are another repository's text, so they are escaped before the log, an annotation or the
 * job summary, and an annotation inside a remote file moves to the `uses:` line in this repository that reaches it.
 */

/**
 * Events whose runs hold the base repository's token while a pull request may have chosen the workflows: the pull
 * request would pick which repositories the token reads, and the plan would show what it read. On these nothing is read
 * at all, not even locked commits (the lockfile holds no bodies, so `lock` reads the network too). `issue_comment` is
 * here because anyone can comment on a public repository's pull request, and such runs often check its head out.
 */
const UNTRUSTED_EVENTS = new Set(['pull_request_target', 'workflow_run', 'issue_comment']);

const MODES = new Set<string>(['off', 'lock', 'fetch']);

const ACTIONS_LOCK_FILE = '.github/workflows/actions.lock';

/** What the action reads GitHub with, from its inputs and the runner's environment. */
export interface RemotesSetup {
  mode: RemotesMode;
  token: string;
  apiUrl: string;
  githubComToken: string;
  env: Record<string, string | undefined>;
  fetch?: RemotesHost['fetch'];
}

/** The `remotes` input checked: the mode, or why it is refused. `fetch` in test mode would let a moving tag decide. */
export function remotesMode(value: string, test: boolean): RemotesMode | { error: string } {
  const mode = (value || 'lock') as RemotesMode;
  if (!MODES.has(mode)) return { error: `remotes must be off, lock or fetch, not '${printable(value)}'` };
  if (test && mode === 'fetch')
    return {
      error:
        'remotes: fetch resolves refs live, so a test could pass today and fail when a tag moves; pin them with `simulci remotes update` and use lock',
    };
  return mode;
}

/** `off` on an untrusted event, with a warning saying why; the mode asked for otherwise. */
export function effectiveMode(
  setup: Pick<RemotesSetup, 'mode' | 'env'> & { warn(message: string): void },
): RemotesMode {
  const event = setup.env.GITHUB_EVENT_NAME ?? '';
  if (setup.mode === 'off' || !UNTRUSTED_EVENTS.has(event)) return setup.mode;
  setup.warn(
    `remotes: off on ${event}: the run holds this repository's token while a pull request chose the workflows, so no remote workflow or action is read, and calls they lock show as not fetched. Run route tests on pull_request.`,
  );
  return 'off';
}

/** The remotes the checkout's workflows reach, read as `mode` says, with the token sent only to `api-url`. */
export function readRemotes(
  root: string,
  workflows: Record<string, string>,
  setup: RemotesSetup & { log(line: string): void },
): Promise<RemotesLoad> {
  const apiUrl = apiUrlOf(setup);
  // The token is the input's and no other: an empty one reads anonymously, never with a token from the environment.
  const api = { apiUrl, ...(setup.token ? { token: setup.token } : {}) };
  const fallback = setup.githubComToken
    ? githubComFallback({ GITHUB_COM_TOKEN: setup.githubComToken }, apiUrl)
    : undefined;
  return loadRemotes(root, workflows, {
    mode: setup.mode,
    api,
    ...(fallback ? { fallback } : {}),
    ...(setup.fetch ? { fetch: setup.fetch } : {}),
    log: (line) => setup.log(`remotes: ${printable(line)}`),
  });
}

/** The API remotes are read from: `api-url`, else the runner's. */
const apiUrlOf = (setup: Pick<RemotesSetup, 'apiUrl' | 'env'>): string =>
  setup.apiUrl || setup.env.GITHUB_API_URL || 'https://api.github.com';

/** Why the token cannot go to `api-url`: over `http:` it would cross the network in the clear. */
export function insecureApi(setup: Pick<RemotesSetup, 'apiUrl' | 'env' | 'token'>): string | undefined {
  const apiUrl = apiUrlOf(setup);
  if (!setup.token || apiUrl.toLowerCase().startsWith('https://')) return undefined;
  return `api-url must be https:// when a token is set, not '${printable(apiUrl)}'`;
}

/** The engine's files: the workflows and actions, and the lockfiles that pin their remotes. */
export function withLockfiles(root: string, workflows: Record<string, string>): Record<string, string> {
  const files = { ...workflows };
  for (const path of [REMOTES_LOCK_FILE, ACTIONS_LOCK_FILE]) {
    const abs = join(root, path);
    if (existsSync(abs)) files[path] = readFileSync(abs, 'utf8');
  }
  return files;
}

/** One line per remote that was not read; `access` says which token to pass. */
export function failureLines(failed: readonly RemoteFailureInput[]): string[] {
  return failed.map((f) => {
    const ref = printable(f.ref);
    const repo = printable(f.ref.split('@')[0]!.split('/').slice(0, 2).join('/'));
    const advice = `GITHUB_TOKEN reads only this repository and public ones. Pass a token that can read ${repo} as \`token\` (actions/create-github-app-token, or a fine-grained token).`;
    if (f.failure === 'access') return `${ref}: not read (access). ${advice}`;
    const said = `${ref}: not read (${f.failure}): ${printable(f.message)}`;
    // GitHub answers 404 for a private repository the token cannot see.
    return f.failure === 'not-found' ? `${said}. If ${repo} is private: ${advice}` : said;
  });
}

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

/**
 * The run with each failure's workflow line in this repository: a line inside a remote file moves to the `uses:` that
 * reaches it (the calling job's, or the step's for a remote action), and one the plan cannot place is dropped, so no
 * annotation names another repository's file.
 */
export function inThisRepository(result: RunResult, project: LoadedProject): RunResult {
  const local = new Set(Object.keys(project.files));
  const uses = usesLines(project);
  const files = result.files.map((file) => ({
    ...file,
    cases: file.cases.map((c) => {
      const anchors = c.plan ? remoteAnchors(c.plan, uses, local) : new Map<string, Loc>();
      const failures = c.failures.map((f) => {
        if (!f.workflowLoc || local.has(f.workflowLoc.file)) return f;
        const { workflowLoc, ...rest } = f;
        const anchor = anchors.get(workflowLoc.file);
        return anchor ? { ...rest, workflowLoc: anchor } : rest;
      });
      return { ...c, failures };
    }),
  }));
  return { ...result, files };
}

/** An annotation's title and message as printable text (a remote's names reach both). */
export function printableAnnotation(a: Annotation): Annotation {
  return { ...a, title: printable(a.title), message: printable(a.message) };
}

const keyOf = (loc: Pick<Loc, 'file' | 'line' | 'column'>): string => `${loc.file}:${loc.line}:${loc.column}`;

/** The `uses:` line of every local job and step, by where the job or step is declared. */
function usesLines(project: LoadedProject): Map<string, Loc> {
  const lines = new Map<string, Loc>();
  const add = (decl: { loc: Loc; uses?: { loc: Loc } | undefined }) => {
    if (decl.uses) lines.set(keyOf(decl.loc), at(decl.uses.loc));
  };
  for (const unit of project.index.units()) {
    if (unit.kind === 'workflow')
      for (const job of Object.values(unit.jobs)) {
        add(job);
        for (const step of job.steps) add(step);
      }
    else for (const step of unit.steps ?? []) add(step);
  }
  return lines;
}

const at = (loc: Loc): Loc => ({ file: loc.file, line: loc.line, column: loc.column });

/**
 * Every file the plan shows inside a remote, mapped to the local `uses:` line that reaches it: the outermost one, so a
 * remote called from a remote still lands in this repository. The first caller wins when two reach the same file.
 */
function remoteAnchors(plan: RunPlan, uses: Map<string, Loc>, local: Set<string>): Map<string, Loc> {
  const anchors = new Map<string, Loc>();
  const remoteSteps = new Set(
    (plan.remotes ?? []).filter((r) => r.kind === 'action' && r.state === 'simulated').flatMap((r) => r.at),
  );
  const anchorOf = (loc: Loc | undefined): Loc | undefined => loc && (uses.get(keyOf(loc)) ?? loc);
  const note = (node: unknown, anchor: Loc) => {
    for (const file of filesIn(node)) if (!local.has(file) && !anchors.has(file)) anchors.set(file, anchor);
  };
  const step = (s: StepPlan) => {
    if (!s.composite) return;
    const anchor = remoteSteps.has(s.id) ? anchorOf(s.loc) : undefined;
    if (anchor) note(s.composite, anchor);
    else for (const inner of s.composite.steps) step(inner);
  };
  const workflow = (wf: WorkflowPlan, anchor: Loc | undefined) => {
    if (anchor) return note(wf, anchor);
    for (const job of wf.jobs)
      for (const leg of job.legs) {
        for (const s of leg.steps ?? []) step(s);
        if (leg.call) workflow(leg.call, leg.call.remote ? anchorOf(job.loc) : undefined);
      }
  };
  for (const wf of plan.workflows) workflow(wf, undefined);
  return anchors;
}

/** The `file` of every location under a node of the plan. */
function filesIn(node: unknown, out = new Set<string>()): Set<string> {
  if (!node || typeof node !== 'object') return out;
  const o = node as Record<string, unknown>;
  if (typeof o.file === 'string' && typeof o.line === 'number') out.add(o.file);
  for (const value of Object.values(o)) filesIn(value, out);
  return out;
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/**
 * Text as it may be shown, in a log, a summary or an XML report: control characters other than tab and newline (an ESC
 * starts a terminal sequence, a CR rewrites a line), the Unicode controls that reorder or break lines, and what XML
 * refuses (U+FFFE, U+FFFF, a lone surrogate), written as `\uXXXX`.
 */
export function printable(s: string): string {
  let out = '';
  for (const c of s) {
    const code = c.codePointAt(0)!;
    out += unprintable(code) ? `\\u${code.toString(16).padStart(4, '0')}` : c;
  }
  return out;
}

/** The code points shown escaped, as inclusive ranges. */
const UNPRINTABLE: readonly (readonly [number, number])[] = [
  [0x00, 0x08],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
  [0x61c, 0x61c],
  [0x200e, 0x200f],
  [0x2028, 0x202e],
  [0x2066, 0x2069],
  [0xd800, 0xdfff],
  [0xfffe, 0xffff],
];

const unprintable = (code: number): boolean => UNPRINTABLE.some(([from, to]) => code >= from && code <= to);
