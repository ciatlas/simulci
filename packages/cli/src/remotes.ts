import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ACTIONS_LOCK_FILE,
  apiHost,
  detectRepository,
  type FetchLike,
  GITHUB_COM_API,
  type GitHubApi,
  type UnitDecl,
  type UsesRef,
} from '@ciatlas/core';
import {
  type LoadedProject,
  type LoadOptions,
  type LockIssue,
  type LockUseInput,
  loadFiles,
  lockIssues,
  pinContextOf,
  REMOTES_LOCK_FILE,
  type RemoteFailureInput,
  type RemotesMode,
  remoteRefOf,
  runningWorkflows,
} from '@simulci/engine';
import {
  type GitHubAccess,
  githubAccess,
  githubComFallback,
  loadRemotes,
  type RemotesLoad,
  readRemotesLockAt,
  readWorkflowFiles,
  updateRemotesLock,
} from '@simulci/node';
import { type ArgsDef, defineCommand } from 'citty';
import { exitCodeOf, FlagError, oneOf, processIo, readArgs, spoken } from './args';

/**
 * Remote workflows and actions for `plan` and `test` (the flags, the token, the read), and `simulci remotes update` and
 * `check`. In `lock` mode, the default, only pinned commits are read, so the same checkout, `remotes.lock.yml` and
 * `actions.lock` always give the same plans; `test` exits 2 rather than plan a call it could not read.
 */

export const REMOTE_MODES = ['off', 'lock', 'fetch'] as const satisfies readonly RemotesMode[];

/** The flags `plan` and `test` share. */
export const REMOTE_ARGS = {
  remotes: {
    type: 'string',
    description: `How remote workflows and actions are read: ${spoken(REMOTE_MODES)}`,
    default: 'lock',
  },
  offline: {
    type: 'boolean',
    description: 'Read remotes only from the cache, never the network (default when SIMULCI_OFFLINE=1)',
  },
  'api-url': {
    type: 'string',
    description: 'The GitHub API (default: GITHUB_API_URL, else https://api.github.com)',
  },
  repository: {
    type: 'string',
    description: "The checkout's owner/name (default: GITHUB_REPOSITORY, else the origin remote)",
  },
  'github-com': {
    type: 'boolean',
    description:
      'On GitHub Enterprise Server, read what it lacks from github.com (with GITHUB_COM_TOKEN, if set)',
    default: false,
  },
} satisfies ArgsDef;

/** The remote flags, by their camelCase names. */
export interface RemoteArgs {
  /** `lock` when left out. */
  remotes?: RemotesMode;
  offline?: boolean;
  apiUrl?: string;
  repository?: string;
  githubCom?: boolean;
}

/** What reading remotes needs from its host: where to report, the environment, and in tests a fake network. */
export interface RemotesIo {
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  /** By default the global `fetch`. */
  fetch?: FetchLike;
  /** The GitHub CLI's token for a host; by default `gh auth token --hostname <host>`. */
  gh?: (host: string) => string | undefined;
  /** Every token read is added here, so the process's writes can leave it out. */
  secrets?: string[];
}

/** `--remotes`, checked. */
export const remotesMode = (value: unknown): RemotesMode => oneOf('remotes', value, REMOTE_MODES);

/** A checkout's workflow files, read for remotes and loaded with them: with the lockfiles, when it has them. */
export interface Remotes {
  /** The workflows and actions, `remotes.lock.yml` and `actions.lock`: what `loadFiles` takes. */
  files: Record<string, string>;
  options: LoadOptions;
  /** What was read, unless the mode is `off`. */
  read?: RemotesLoad;
  access?: Access;
}

interface Access {
  api: GitHubAccess;
  fallback?: GitHubApi;
}

/**
 * The remotes a checkout's workflows reach, read once as `--remotes` says, and the options to load the checkout with.
 * A `FlagError` when `--api-url` or `--repository` (or the variable each defaults to) is not one.
 */
export async function readRemotes(
  root: string,
  workflows: Record<string, string>,
  a: RemoteArgs,
  io: RemotesIo,
): Promise<Remotes> {
  const mode = a.remotes ?? 'lock';
  const files = withLockfiles(root, workflows);
  const repository = repositoryOf(a.repository, root, io.env);
  const options: LoadOptions = { ...(repository === undefined ? {} : { repository }), mode };
  if (mode === 'off') return { files, options };
  const access = accessOf(a, io);
  const read = await loadRemotes(root, files, {
    mode,
    offline: a.offline ?? io.env.SIMULCI_OFFLINE === '1',
    ...access,
    ...(io.fetch ? { fetch: io.fetch } : {}),
    log: (line) => io.stderr(`remotes: ${line}\n`),
  });
  return { files, options: { ...options, remotes: read.remotes }, read, access };
}

/** The workflow files with `remotes.lock.yml` and `actions.lock` beside them, which the engine reads its pins from. */
function withLockfiles(root: string, workflows: Record<string, string>): Record<string, string> {
  const files = { ...workflows };
  for (const path of [REMOTES_LOCK_FILE, ACTIONS_LOCK_FILE]) {
    const text = readOr(join(root, path));
    if (text !== undefined) files[path] = text;
  }
  return files;
}

function readOr(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

const REPOSITORY = /^[^/\s]+\/[^/\s]+$/;

/** `--repository`, else `GITHUB_REPOSITORY`, else the `origin` remote's (core's `detectRepository`); none on another host. */
function repositoryOf(
  given: string | undefined,
  root: string,
  env: Record<string, string | undefined>,
): string | undefined {
  const repository = given ?? detectRepository(root, env);
  if (repository === undefined || REPOSITORY.test(repository)) return repository;
  const from = given === undefined ? 'GITHUB_REPOSITORY' : '--repository';
  throw new FlagError(`${from} takes owner/name, not '${repository}'`);
}

/** The API, its token (`GH_TOKEN`, `GITHUB_TOKEN`, then `gh`; N1's `githubAccess`), and github.com's when asked. */
function accessOf(a: Pick<RemoteArgs, 'apiUrl' | 'githubCom'>, io: RemotesIo): Access {
  const apiUrl = apiUrlOf(a.apiUrl, io.env);
  const env = io.env as NodeJS.ProcessEnv;
  const api = githubAccess(env, apiUrl, undefined, io.gh);
  const fallback = a.githubCom ? githubComFallback(env, apiUrl) : undefined;
  for (const token of [api.token, fallback?.token]) if (token) io.secrets?.push(token);
  return { api, ...(fallback ? { fallback } : {}) };
}

function apiUrlOf(given: string | undefined, env: Record<string, string | undefined>): string {
  const url = given ?? (env.GITHUB_API_URL || GITHUB_COM_API);
  if (URL.canParse(url) && /^https?:$/.test(new URL(url).protocol)) return url;
  const from = given === undefined ? 'GITHUB_API_URL' : '--api-url';
  throw new FlagError(`${from} takes an http or https URL, not '${url}'`);
}

/** How the API was read: its host and where the token came from, never the token. */
export function accessLine({ api, fallback }: Access): string {
  const from =
    api.tokenFrom === undefined ? 'anonymously' : `with the token from ${tokenSource(api.tokenFrom)}`;
  const also = fallback
    ? `, and github.com ${fallback.token ? 'with the token from GITHUB_COM_TOKEN' : 'anonymously'}`
    : '';
  return `${apiHost(api.apiUrl)} was read ${from}${also}`;
}

const tokenSource = (from: NonNullable<GitHubAccess['tokenFrom']>): string =>
  from === 'gh' ? '`gh auth token`' : from === 'option' ? 'the command line' : from;

/** One line per remote that could not be read: its ref and the host's message (which names no token). */
export const failureLines = (failed: readonly RemoteFailureInput[]): string[] =>
  failed.map((f) => `remotes: ${f.ref}: ${f.message}\n`);

/**
 * Why `test` cannot run as pinned: a remote it could not read (a pinned body, or one whose digest differs), or a
 * lockfile it could not use. Either would leave a call open that GitHub runs, and so change a verdict.
 */
export function unpinnable(r: Remotes): string | undefined {
  const failed = r.read?.remotes.failed ?? [];
  const lockErrors = r.read?.lockErrors ?? [];
  if (!failed.length && !lockErrors.length) return undefined;
  const what = [
    ...(failed.length ? [`${failed.length} remote${failed.length === 1 ? '' : 's'} could not be read`] : []),
    ...(lockErrors.length ? ['a lockfile could not be used'] : []),
  ].join(' and ');
  return `${what}, so the tests would not run as pinned. ${remedy(r, failed)}, or test without remotes (--remotes off).\n`;
}

function remedy(r: Remotes, failed: readonly RemoteFailureInput[]): string {
  if (failed.some((f) => f.failure === 'access' || f.failure === 'not-found'))
    return `${accessLine(r.access!)}: set GH_TOKEN to a token that can read them`;
  if (failed.every((f) => f.failure === 'digest')) return 'Run `simulci remotes update`';
  return failed.length ? 'Try again once the API answers' : 'Run `simulci remotes update`';
}

// ---------------------------------------------------------------------------
// simulci remotes
// ---------------------------------------------------------------------------

const UPDATE_ARGS = {
  dir: { type: 'string', description: 'The repository checkout', default: '.' },
  'api-url': REMOTE_ARGS['api-url'],
  'github-com': REMOTE_ARGS['github-com'],
} satisfies ArgsDef;

const CHECK_ARGS = {
  dir: UPDATE_ARGS.dir,
  offline: {
    type: 'boolean',
    description: 'Check the lockfile only, not the files it pins (default when SIMULCI_OFFLINE=1)',
  },
  'api-url': REMOTE_ARGS['api-url'],
  'github-com': REMOTE_ARGS['github-com'],
} satisfies ArgsDef;

export interface UpdateArgs {
  dir: string;
  apiUrl?: string;
  githubCom?: boolean;
}

export interface CheckArgs extends UpdateArgs {
  offline?: boolean;
}

/** A command's output, and its fake network in tests. */
export interface RemotesCommandIo extends RemotesIo {
  stdout: (text: string) => void;
}

/**
 * `simulci remotes update`: resolves every remote the checkout reaches, reads each file, and writes
 * `remotes.lock.yml`. Prints what moved. Exits 1 when a remote could not be read (its old entry, if any, is kept), 2
 * when it cannot run.
 */
export async function runRemotesUpdate(a: UpdateArgs, io: RemotesCommandIo): Promise<number> {
  const root = resolve(a.dir);
  const workflows = readWorkflowFiles(root);
  if (Object.keys(workflows).length === 0) {
    io.stderr(`no workflows under ${a.dir}/.github/workflows\n`);
    return 2;
  }
  const access = accessOf(a, io);
  const up = await updateRemotesLock(root, withLockfiles(root, workflows), {
    ...access,
    ...(io.fetch ? { fetch: io.fetch } : {}),
    log: (line) => io.stderr(`remotes: ${line}\n`),
  });
  const moved = up.added.length + up.changed.length + up.removed.length;
  io.stdout(
    `${REMOTES_LOCK_FILE}: ${moved ? `${up.added.length} added, ${up.changed.length} changed, ${up.removed.length} removed` : 'up to date'}\n`,
  );
  for (const ref of up.added) io.stdout(`  + ${ref} → ${up.lock.remotes[ref]!.sha.slice(0, 7)}\n`);
  for (const c of up.changed) io.stdout(`  ~ ${c.ref} ${c.from.slice(0, 7)} → ${c.to.slice(0, 7)}\n`);
  for (const ref of up.removed) io.stdout(`  - ${ref}\n`);
  for (const ref of up.limited) io.stdout(`  past a limit, not locked: ${ref}\n`);
  if (!up.failed.length) return 0;
  for (const line of failureLines(up.failed)) io.stderr(line);
  io.stderr(`${accessLine(access)}; a remote not read keeps its entry, or is listed under unreadable\n`);
  return 1;
}

/**
 * `simulci remotes check`: whether `remotes.lock.yml` is current (every remote the checkout reaches has an entry, no
 * entry is unused, none disagrees with `actions.lock` or a full-SHA ref) and, unless offline, whether each file it pins
 * still has its digest. Exits 0 when it is, 1 when it is not, 2 when it cannot tell (a file it could not read).
 */
export async function runRemotesCheck(a: CheckArgs, io: RemotesCommandIo): Promise<number> {
  const root = resolve(a.dir);
  const workflows = readWorkflowFiles(root);
  if (Object.keys(workflows).length === 0) {
    io.stderr(`no workflows under ${a.dir}/.github/workflows\n`);
    return 2;
  }
  const files = withLockfiles(root, workflows);
  const uses = lockUses(loadFiles(files, { mode: 'lock' }));
  const { lock, error } = readRemotesLockAt(root);
  if (error !== undefined) {
    io.stdout(`${error}\nRun \`simulci remotes update\` to write it again.\n`);
    return 1;
  }
  if (!lock) {
    io.stdout(
      uses.length
        ? `no ${REMOTES_LOCK_FILE}: run \`simulci remotes update\` to pin ${uses.length === 1 ? 'the remote' : 'the remotes'} this checkout uses\n`
        : 'no remotes, and no lockfile\n',
    );
    return uses.length ? 1 : 0;
  }
  const issues = lockIssues(lock, uses);
  for (const issue of issues) io.stdout(`${where(files[REMOTES_LOCK_FILE]!, issue)}: ${issue.message}\n`);
  const offline = a.offline ?? io.env.SIMULCI_OFFLINE === '1';
  const bodies = await checkBodies(root, files, { ...a, offline }, io);
  if (issues.length || bodies === 'mismatch') {
    io.stdout('Run `simulci remotes update` to bring the lockfile up to date.\n');
    return 1;
  }
  if (bodies === 'unread') return 2;
  const count = Object.keys(lock.remotes).length;
  io.stdout(
    `${REMOTES_LOCK_FILE}: ${count} remote${count === 1 ? '' : 's'}, up to date${offline ? ' (files not checked: offline)' : ''}\n`,
  );
  return 0;
}

/**
 * Reads each pinned file as `test` would (`lock` mode) and checks its digest: `mismatch` when one differs, `unread`
 * when one could not be read. Offline, a file not in the cache is not checked.
 */
async function checkBodies(
  root: string,
  files: Record<string, string>,
  a: CheckArgs,
  io: RemotesCommandIo,
): Promise<'ok' | 'mismatch' | 'unread'> {
  const access = accessOf(a, io);
  const read = await loadRemotes(root, files, {
    mode: 'lock',
    offline: a.offline ?? false,
    ...access,
    ...(io.fetch ? { fetch: io.fetch } : {}),
    log: (line) => io.stderr(`remotes: ${line}\n`),
  });
  const failed = (read.remotes.failed ?? []).filter((f) => !(a.offline && f.failure === 'unreachable'));
  const mismatched = failed.filter((f) => f.failure === 'digest');
  for (const f of mismatched) io.stdout(`${REMOTES_LOCK_FILE}: ${f.ref}: ${f.message}\n`);
  if (mismatched.length) return 'mismatch';
  if (!failed.length) return 'ok';
  for (const line of failureLines(failed)) io.stderr(line);
  io.stderr(`${accessLine(access)}: the files above could not be checked\n`);
  return 'unread';
}

/** `remotes.lock.yml:<line>` of the issue's entry, or the file alone for a ref it has no entry for. */
function where(text: string, issue: LockIssue): string {
  const lines = text.split('\n');
  const quoted = [issue.ref, JSON.stringify(issue.ref), `'${issue.ref.replaceAll("'", "''")}'`];
  const at = lines.findIndex((l) => quoted.some((k) => l === `  ${k}:` || l.startsWith(`  ${k}: `)));
  return at === -1 ? REMOTES_LOCK_FILE : `${REMOTES_LOCK_FILE}:${at + 1}`;
}

/**
 * Each remote ref the checkout's own workflows and actions name, once per workflow that runs it, with the commit that
 * workflow's `actions.lock` pins it to; once without a workflow for an action no workflow runs. Loaded without the
 * repository, as `update` reads them: a full ref to this repository is a remote too (lab R10).
 */
function lockUses(loaded: LoadedProject): LockUseInput[] {
  const project = loaded.index.project;
  const out: LockUseInput[] = [];
  for (const unit of [...project.workflows.values(), ...project.actions.values()]) {
    const running = runningWorkflows(loaded, unit);
    for (const uses of usesOf(unit)) {
      const ref = remoteRefOf(unit, uses);
      if (!ref) continue;
      if (!running.length) out.push({ ref: ref.raw, kind: ref.kind });
      for (const workflow of running) {
        const { actionsLock } = pinContextOf(loaded, unit, uses, ref, [workflow]);
        out.push({ ref: ref.raw, kind: ref.kind, workflow, ...(actionsLock ? { actionsLock } : {}) });
      }
    }
  }
  return out;
}

/** The `uses:` of a unit: its jobs' and its steps'. */
function usesOf(unit: UnitDecl): UsesRef[] {
  const users: { uses?: UsesRef }[] =
    unit.kind === 'action'
      ? unit.steps
      : Object.values(unit.jobs).flatMap((j) => ([j] as { uses?: UsesRef }[]).concat(j.steps));
  return users.flatMap((u) => (u.uses ? [u.uses] : []));
}

export const remotesCommand = defineCommand({
  meta: { name: 'remotes', description: 'Pin the remote workflows and actions this repository uses' },
  subCommands: {
    update: defineCommand({
      meta: { name: 'update', description: `Resolve every remote and write ${REMOTES_LOCK_FILE}` },
      args: UPDATE_ARGS,
      async run({ rawArgs }) {
        const io = processIo();
        process.exitCode = await exitCodeOf(
          () => runRemotesUpdate(readArgs(rawArgs, UPDATE_ARGS, {}) as unknown as UpdateArgs, io),
          io,
        );
      },
    }),
    check: defineCommand({
      meta: { name: 'check', description: `Check that ${REMOTES_LOCK_FILE} is up to date` },
      args: CHECK_ARGS,
      async run({ rawArgs }) {
        const io = processIo();
        process.exitCode = await exitCodeOf(
          () => runRemotesCheck(readArgs(rawArgs, CHECK_ARGS, {}) as unknown as CheckArgs, io),
          io,
        );
      },
    }),
  },
});
