import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ACTIONS_LOCK_FILE,
  apiHost,
  detectRepository,
  type FetchLike,
  GITHUB_COM_API,
  type GitHubApi,
  remoteKey,
  type UnitDecl,
  type UsesRef,
} from '@ciatlas/core';
import {
  type LoadedProject,
  type LoadOptions,
  type LockUseInput,
  loadFiles,
  lockIssues,
  pinContextOf,
  REMOTES_LOCK_FILE,
  remotesNeeded,
  type RemoteFailureInput,
  type RemotesLock,
  type RemotesMode,
  remoteRefOf,
  runningWorkflows,
} from '@simulci/engine';
import {
  type GitHubAccess,
  githubAccess,
  githubComFallback,
  type LockUpdate,
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

const REMOTE_MODES = ['off', 'lock', 'fetch'] as const satisfies readonly RemotesMode[];

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
  /** Lockfile entries the checkout reaches that the last `update` could not read: their calls stay open. */
  unreadable: string[];
  /** Why a lockfile the run depends on could not be used. */
  lockErrors: string[];
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
  detect = true,
): Promise<Remotes> {
  const mode = a.remotes ?? 'lock';
  const files = withLockfiles(root, workflows);
  const repository = detect ? repositoryOf(a.repository, root, io.env) : checkedRepository(a.repository);
  const options: LoadOptions = { ...(repository === undefined ? {} : { repository }), mode };
  if (mode === 'off') return { files, options, unreadable: [], lockErrors: [] };
  const local = loadFiles(files, { mode });
  const offline = a.offline ?? io.env.SIMULCI_OFFLINE === '1';
  const { read, access } = await load(root, files, local, { ...a, mode, offline }, io);
  return {
    files,
    options: { ...options, remotes: read.remotes },
    read,
    access,
    unreadable: read.lock
      ? reachedUnreadable(read.lock, lockUses(local, read.lock), read.remotes.failed)
      : [],
    lockErrors: usedLockErrors(read.lockErrors, local),
  };
}

/** The `unreadable` entries of the lockfile that the checkout's uses reach and this run did not read again, sorted. */
function reachedUnreadable(
  lock: RemotesLock,
  uses: LockUseInput[],
  failed: readonly RemoteFailureInput[] = [],
): string[] {
  const unused = new Set(
    lockIssues(lock, uses)
      .filter((i) => i.code === 'remote-lock-unused')
      .map((i) => i.ref),
  );
  // A ref pinned without the lockfile (a full SHA, actions.lock) was asked for again: its failure says it already.
  const asked = new Set(failed.map((f) => remoteKey(f.ref)));
  return Object.keys(lock.unreadable ?? {})
    .filter((key) => !unused.has(key) && !asked.has(remoteKey(key)))
    .sort();
}

/**
 * The lockfile errors that matter: `remotes.lock.yml`'s always, `actions.lock`'s only when the checkout uses a remote
 * action it could pin. GitHub's format is in preview, and a version this reader does not know must not stop a
 * repository that pins nothing with it.
 */
function usedLockErrors(errors: readonly string[], local: LoadedProject): string[] {
  const actions = lockUses(local).some((u) => u.kind === 'action');
  return errors.filter((e) => actions || !e.startsWith(`${ACTIONS_LOCK_FILE}:`));
}

/**
 * The remotes `files` reach, read as `mode` says. The GitHub CLI is asked for a token only when something is to be read:
 * not offline, and not when nothing is pinned (`lock`) or used (`fetch`).
 */
async function load(
  root: string,
  files: Record<string, string>,
  local: LoadedProject,
  a: Pick<RemoteArgs, 'apiUrl' | 'githubCom'> & { mode: Exclude<RemotesMode, 'off'>; offline: boolean },
  io: RemotesIo,
): Promise<{ read: RemotesLoad; access: Access }> {
  const reads = !a.offline && remotesNeeded(local, a.mode).length > 0;
  const access = accessOf(a, reads ? io : { ...io, gh: () => undefined });
  const read = await loadRemotes(root, files, {
    mode: a.mode,
    offline: a.offline,
    ...access,
    ...(io.fetch ? { fetch: io.fetch } : {}),
    log: (line) => io.stderr(`remotes: ${line}\n`),
  });
  return { read, access };
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
  if (given !== undefined) return checkedRepository(given);
  const repository = detectRepository(root, env);
  if (repository === undefined || REPOSITORY.test(repository)) return repository;
  throw new FlagError(`GITHUB_REPOSITORY takes owner/name, not '${repository}'`);
}

function checkedRepository(given: string | undefined): string | undefined {
  if (given === undefined || REPOSITORY.test(given)) return given;
  throw new FlagError(`--repository takes owner/name, not '${given}'`);
}

/**
 * The API, its token (`GH_TOKEN`, `GITHUB_TOKEN`, then `gh`; N1's `githubAccess`), and github.com's when asked. A
 * runner's `GITHUB_TOKEN` belongs to its `GITHUB_API_URL`: it is not sent to another API `--api-url` names.
 */
function accessOf(a: Pick<RemoteArgs, 'apiUrl' | 'githubCom'>, io: RemotesIo): Access {
  const apiUrl = apiUrlOf(a.apiUrl, io.env);
  const runner = io.env.GITHUB_API_URL;
  // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- needed where Next.js's types make NODE_ENV required (the docs app type-checks this file)
  const env = { ...io.env } as NodeJS.ProcessEnv;
  if (runner && trimmed(runner) !== trimmed(apiUrl)) delete env.GITHUB_TOKEN;
  const api = githubAccess(env, apiUrl, undefined, io.gh);
  const fallback = a.githubCom ? githubComFallback(env, apiUrl) : undefined;
  for (const token of [api.token, fallback?.token]) if (token) io.secrets?.push(token);
  return { api, ...(fallback ? { fallback } : {}) };
}

/** A URL without its trailing slashes; a loop, as a regex anchored after a repeat backtracks on a long run of them. */
function trimmed(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end--;
  return url.slice(0, end);
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

const safeApi = (url: string): boolean => {
  if (!URL.canParse(url)) return false;
  const { protocol, hostname } = new URL(url);
  return protocol === 'https:' || (protocol === 'http:' && LOOPBACK.has(hostname));
};

/** `--api-url`, else `GITHUB_API_URL`, else github.com's: https, so a token never travels in clear, but on loopback. */
function apiUrlOf(given: string | undefined, env: Record<string, string | undefined>): string {
  const url = given ?? (env.GITHUB_API_URL || GITHUB_COM_API);
  if (safeApi(url)) return url;
  const from = given === undefined ? 'GITHUB_API_URL' : '--api-url';
  throw new FlagError(`${from} takes an https URL (http only on localhost), not '${url}'`);
}

/** How the API was read: its host and where the token came from, never the token. */
function accessLine({ api, fallback }: Access): string {
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
  const what = [
    ...(failed.length ? [`${counted(failed.length, 'remote')} could not be read`] : []),
    ...(r.unreadable.length
      ? [`${counted(r.unreadable.length, 'remote')} could not be read at the last update`]
      : []),
    ...(r.lockErrors.length
      ? [`${spoken(r.lockErrors.map((e) => e.split(':')[0]!))} could not be used`]
      : []),
  ];
  if (!what.length) return undefined;
  const remedies = [
    ...(failed.length ? [remedy(r, failed)] : []),
    ...(r.unreadable.length ? [`run \`simulci remotes update\` with a token that can read them`] : []),
    ...(r.lockErrors.length ? ['fix the lockfile'] : []),
  ];
  return `${what.join(' and ')}, so the tests would not run as pinned. ${upper(remedies.join('; '))}, or test without remotes (--remotes off).\n`;
}

/** The lines `test` prints for each remote it could not plan as pinned, before it exits 2 (a lockfile not used is logged). */
export const unpinnedLines = (r: Remotes): string[] => [
  ...failureLines(r.read?.remotes.failed ?? []),
  ...r.unreadable.map(
    (ref) =>
      `remotes: ${ref}: ${REMOTES_LOCK_FILE} records it as unreadable (${r.read!.lock!.unreadable![ref]})\n`,
  ),
];

const counted = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const upper = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function remedy(r: Remotes, failed: readonly RemoteFailureInput[]): string {
  if (failed.some((f) => f.failure === 'access' || f.failure === 'not-found'))
    return `set GH_TOKEN to a token that can read them (${accessLine(r.access!)})`;
  return failed.every((f) => f.failure === 'digest')
    ? 'run `simulci remotes update`'
    : 'try again once the API answers';
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
  const at = checkout(a.dir, io);
  if (!at) return 2;
  const { root, files } = at;
  const access = accessOf(a, io);
  const up = await updateRemotesLock(root, files, {
    ...access,
    ...(io.fetch ? { fetch: io.fetch } : {}),
    log: (line) => io.stderr(`remotes: ${line}\n`),
  });
  io.stdout(`${REMOTES_LOCK_FILE}: ${updateSummary(up)}\n`);
  for (const ref of up.added) io.stdout(`  + ${ref} → ${up.lock.remotes[ref]!.sha.slice(0, 7)}\n`);
  for (const c of up.changed) io.stdout(`  ~ ${c.ref} ${c.from.slice(0, 7)} → ${c.to.slice(0, 7)}\n`);
  for (const ref of up.removed) io.stdout(`  - ${ref}\n`);
  for (const ref of up.limited) io.stdout(`  past a limit, not locked: ${ref}\n`);
  if (!up.failed.length) return 0;
  for (const line of failureLines(up.failed)) io.stderr(line);
  io.stderr(`${accessLine(access)}; a remote not read keeps its entry, or is listed under unreadable\n`);
  return 1;
}

/** What `update` did to the lockfile: the entries it added, changed and removed, else whether it wrote it at all. */
function updateSummary(up: LockUpdate): string {
  const moved = up.added.length + up.changed.length + up.removed.length;
  if (moved) return `${up.added.length} added, ${up.changed.length} changed, ${up.removed.length} removed`;
  return up.written ? 'written (only the unreadable remotes changed)' : 'up to date';
}

/**
 * `simulci remotes check`: whether `remotes.lock.yml` is current (every remote the checkout reaches has an entry, no
 * entry is unused, none disagrees with `actions.lock` or a full-SHA ref) and, unless offline, whether each file it pins
 * still has its digest. Exits 0 when it is, 1 when it is not, 2 when it cannot tell (a file it could not read).
 */
export async function runRemotesCheck(a: CheckArgs, io: RemotesCommandIo): Promise<number> {
  const at = checkout(a.dir, io);
  if (!at) return 2;
  const { root, files } = at;
  const loaded = loadFiles(files, { mode: 'lock' });
  const { lock, error } = readRemotesLockAt(root);
  if (!lock) return noLockfile(error, lockUses(loaded).length, io);
  const offline = a.offline ?? io.env.SIMULCI_OFFLINE === '1';
  const { read, access } = await load(root, files, loaded, { ...a, mode: 'lock', offline }, io);
  const stale = staleLines(lock, loaded, read, files[REMOTES_LOCK_FILE]!);
  for (const line of stale) io.stdout(line);
  const bodies = bodyState(lock, read, { offline, access }, io);
  if (stale.length || bodies === 'mismatch') {
    io.stdout('Run `simulci remotes update` to bring the lockfile up to date.\n');
    return 1;
  }
  if (bodies === 'unread') return 2;
  const count = Object.keys(lock.remotes).length;
  const unchecked = offline ? ' (files not checked: offline)' : '';
  io.stdout(`${REMOTES_LOCK_FILE}: ${count} remote${count === 1 ? '' : 's'}, up to date${unchecked}\n`);
  return 0;
}

/**
 * What makes the lockfile stale, a line each: `lockIssues` (a ref past the depth or unit cap is never locked, so it is
 * not missing), and an `actions.lock` that cannot be used, whose pins `update` could not have followed.
 */
function staleLines(lock: RemotesLock, local: LoadedProject, read: RemotesLoad, text: string): string[] {
  const uses = lockUses(local, lock);
  const limited = new Set((read.remotes.limited ?? []).map(remoteKey));
  const issues = lockIssues(lock, uses).filter(
    (i) => !(i.code === 'remote-not-locked' && limited.has(remoteKey(i.ref))),
  );
  return [
    ...issues.map((issue) => `${where(text, issue.ref)}: ${issue.message}\n`),
    ...reachedUnreadable(lock, uses).map(
      (ref) =>
        `${where(text, ref)}: ${ref} could not be read at the last update (${lock.unreadable![ref]})\n`,
    ),
    ...usedLockErrors(read.lockErrors, local).map((error) => `${error}\n`),
  ];
}

/** `check` without a usable lockfile: 1 when it cannot be read, or the checkout uses remotes; 0 when it uses none. */
function noLockfile(error: string | undefined, uses: number, io: RemotesCommandIo): number {
  if (error !== undefined) io.stdout(`${error}\nRun \`simulci remotes update\` to write it again.\n`);
  else if (uses)
    io.stdout(
      `no ${REMOTES_LOCK_FILE}: run \`simulci remotes update\` to pin ${uses === 1 ? 'the remote' : 'the remotes'} this checkout uses\n`,
    );
  else io.stdout('no remotes, and no lockfile\n');
  return error !== undefined || uses ? 1 : 0;
}

/** The checkout's workflow files and lockfiles; none, with the reason on stderr, when it has no workflows. */
function checkout(dir: string, io: RemotesIo): { root: string; files: Record<string, string> } | undefined {
  const root = resolve(dir);
  const workflows = readWorkflowFiles(root);
  if (Object.keys(workflows).length) return { root, files: withLockfiles(root, workflows) };
  io.stderr(`no workflows under ${dir}/.github/workflows\n`);
  return undefined;
}

/**
 * Whether each pinned file read as `test` reads it (`lock` mode) has its digest: `mismatch` when one differs, `unread`
 * when one could not be read. A ref the lockfile records as unreadable is not asked for again, and offline, a file not
 * in the cache is not checked.
 */
function bodyState(
  lock: RemotesLock,
  read: RemotesLoad,
  how: { offline: boolean; access: Access },
  io: RemotesCommandIo,
): 'ok' | 'mismatch' | 'unread' {
  const unreadable = new Set(Object.keys(lock.unreadable ?? {}).map(remoteKey));
  const failed = (read.remotes.failed ?? []).filter(
    (f) => !(how.offline && f.failure === 'unreachable') && !unreadable.has(remoteKey(f.ref)),
  );
  const mismatched = failed.filter((f) => f.failure === 'digest');
  for (const f of mismatched) io.stdout(`${REMOTES_LOCK_FILE}: ${f.ref}: ${f.message}\n`);
  if (mismatched.length) return 'mismatch';
  if (!failed.length) return 'ok';
  for (const line of failureLines(failed)) io.stderr(line);
  io.stderr(`${accessLine(how.access)}: the files above could not be checked\n`);
  return 'unread';
}

/** `remotes.lock.yml:<line>` of the issue's entry, or the file alone for a ref it has no entry for. */
function where(text: string, ref: string): string {
  const lines = text.split('\n');
  const quoted = [ref, JSON.stringify(ref), `'${ref.replaceAll("'", "''")}'`];
  const at = lines.findIndex((l) => quoted.some((k) => l === `  ${k}:` || l.startsWith(`  ${k}: `)));
  return at === -1 ? REMOTES_LOCK_FILE : `${REMOTES_LOCK_FILE}:${at + 1}`;
}

/**
 * Each remote ref the checkout's own workflows and actions name, once per workflow that runs it, with the commit that
 * workflow's `actions.lock` pins it to; once without a workflow for an action no workflow runs. Loaded without the
 * repository, as `update` reads them: a full ref to this repository is a remote too (lab R10). An action that a locked
 * remote also uses is not compared with `actions.lock`: its entry is the remote's commit (`update` keeps the pin the
 * lockfile is for), and the checkout's own use is pinned by `actions.lock` whatever the entry says.
 */
function lockUses(loaded: LoadedProject, lock?: RemotesLock): LockUseInput[] {
  const project = loaded.index.project;
  const called = new Set(Object.values(lock?.remotes ?? {}).flatMap((e) => (e.calls ?? []).map(remoteKey)));
  return [...project.workflows.values(), ...project.actions.values()].flatMap((unit) => {
    const running = runningWorkflows(loaded, unit);
    return usesOf(unit).flatMap((uses) => {
      const ref = remoteRefOf(unit, uses);
      if (!ref) return [];
      if (!running.length) return [{ ref: ref.raw, kind: ref.kind }];
      const compared = !called.has(remoteKey(ref.raw));
      return running.map((workflow): LockUseInput => {
        const use: LockUseInput = { ref: ref.raw, kind: ref.kind, workflow };
        const { actionsLock } = pinContextOf(loaded, unit, uses, ref, [workflow]);
        if (actionsLock && compared) use.actionsLock = actionsLock;
        return use;
      });
    });
  });
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
