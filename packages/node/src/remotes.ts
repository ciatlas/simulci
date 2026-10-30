import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ACTIONS_LOCK_FILE,
  type ActionsLock,
  actionsLockCommit,
  apiHost,
  createParseContext,
  type FetchLike,
  fetchRemoteClosure,
  GITHUB_COM_API,
  type GitHubApi,
  memoryRemoteCache,
  parseActionFile,
  parseWorkflowFile,
  type Project,
  type ProjectIndex,
  readActionsLock,
  RemoteFetchError,
  type RemoteFetchOptions,
  type RemotePin as CorePin,
  type RemoteRef,
  type RemoteSource,
  type RemoteSourceCache,
  remoteKey,
  remoteRefsOf,
  type UnitDecl,
} from '@ciatlas/core';
import {
  loadFiles,
  type PinIssue,
  parseRemotesLock,
  pinFor,
  type RemoteFailureInput,
  type RemoteInputs,
  type RemotePinned,
  REMOTES_LOCK_FILE,
  type RemotesLock,
  type RemotesLockEntry,
  type RemotesMode,
  serializeRemotesLock,
} from '@simulci/engine';

/**
 * The remote workflows and actions a checkout uses, read for the engine (`RemoteInputs`): each pinned by § 2.5's
 * precedence (a full-SHA ref, the running workflow's `actions.lock`, a `./`'s parent, `remotes.lock.yml`, live),
 * fetched through core with an injected `fetch`, and checked against the lockfile's digest. In `lock` mode (the
 * default) nothing is resolved, so the same checkout, lockfile and `actions.lock` always read the same files.
 */

/** How a host reads remotes: the mode, the GitHub API and its token, and what does the I/O. */
export interface RemotesHost {
  mode: RemotesMode;
  /** Read only the cache: an uncached body is unreadable (`unreachable`), and nothing is resolved. */
  offline?: boolean;
  /** The token goes only to this API's origin, and into no message. */
  api: GitHubApi;
  /** github.com's API for what a GHES lacks (opt-in): with its own token or none, never `api.token`. */
  fallback?: GitHubApi;
  /** By default `globalThis.fetch`. */
  fetch?: FetchLike;
  /** Content-addressed; by default a new in-memory cache per call. Pass one to share it across calls. */
  cache?: RemoteSourceCache;
  signal?: AbortSignal;
  /** Retries and unreadable lockfiles, as lines; never a token. */
  log?: (line: string) => void;
}

/** What `loadRemotes` read: the engine's input, and what the lockfiles said on the way. */
export interface RemotesLoad {
  remotes: RemoteInputs;
  /** `remotes.lock.yml`, when the checkout has a usable one. */
  lock?: RemotesLock;
  /** Why `remotes.lock.yml` or `actions.lock` was not used. */
  lockErrors: string[];
  /** The pins' issues, once each, sorted: not locked, resolved live, a pin the lockfile disagrees with. */
  issues: PinIssue[];
}

/** `remotes.lock.yml` of a checkout: none when there is no such file, else the lockfile or why it cannot be used. */
export function readRemotesLockAt(root: string): { lock?: RemotesLock; error?: string } {
  let text: string;
  try {
    text = readFileSync(join(root, REMOTES_LOCK_FILE), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    return { error: `${REMOTES_LOCK_FILE}: ${(e as Error).message}` };
  }
  const read = parseRemotesLock(text);
  return 'lock' in read ? { lock: read.lock } : { error: `${REMOTES_LOCK_FILE}: ${read.error}` };
}

/**
 * The remotes `files` (a checkout's workflow and action files, as `readWorkflowFiles` gives them) reach, read as the
 * mode says. `off` reads nothing. `lock` reads only pinned bodies (rows 1–4) and resolves nothing, so with a warm cache
 * it makes no request; a locked body it cannot read, or whose digest differs, is in `remotes.failed`. `fetch` also
 * resolves what nothing pins. Without a lockfile, `lock` reads rows 1–3 only.
 */
export async function loadRemotes(
  root: string,
  files: Record<string, string>,
  host: RemotesHost,
): Promise<RemotesLoad> {
  if (host.mode === 'off') return { remotes: { sources: [] }, lockErrors: [], issues: [] };
  const read = readRemotesLockAt(root);
  const lockErrors = read.error === undefined ? [] : [printable(read.error)];
  for (const error of lockErrors) host.log?.(`not used: ${error}`);
  const run = await closureOf(root, files, host, { mode: host.mode, lock: read.lock, lockErrors });
  return {
    remotes: inputsOf(run, host),
    ...(read.lock ? { lock: read.lock } : {}),
    lockErrors,
    issues: [...run.issues.values()].sort((a, b) => compare(a.message, b.message)),
  };
}

/** What `updateRemotesLock` wrote: the lockfile, and how it moved. */
export interface LockUpdate {
  lock: RemotesLock;
  /** The lockfile's text, as written. */
  text: string;
  /** False when the file already had these bytes. */
  written: boolean;
  /** Entry keys, sorted. */
  added: string[];
  removed: string[];
  changed: { ref: string; from: string; to: string }[];
  /** What could not be read: an entry that had a value keeps it, else it is listed under `unreadable`. */
  failed: RemoteFailureInput[];
  /** Refs past the depth or unit cap, not locked. */
  limited: string[];
  issues: PinIssue[];
}

/**
 * `simulci remotes update`: resolves every ref the checkout reaches (rows 1–3, then live; never the old lockfile),
 * reads each body, and writes `remotes.lock.yml` in canonical form. An entry whose ref cannot be read keeps its old
 * value. Running it again with nothing moved writes the same bytes.
 */
export async function updateRemotesLock(
  root: string,
  files: Record<string, string>,
  host: Omit<RemotesHost, 'mode'>,
): Promise<LockUpdate> {
  const old = readRemotesLockAt(root);
  if (old.error !== undefined) host.log?.(`replaced: ${printable(old.error)}`);
  const run = await closureOf(root, files, { ...host, mode: 'fetch' }, { mode: 'fetch', lockErrors: [] });
  const inputs = inputsOf(run, host);
  const lock = lockOf(run, old.lock, inputs);
  const text = serializeRemotesLock(lock);
  const written = readOr(join(root, REMOTES_LOCK_FILE)) !== text;
  if (written) writeLockfile(root, text);
  return {
    lock,
    text,
    written,
    ...diffOf(old.lock, lock),
    failed: inputs.failed ?? [],
    limited: inputs.limited ?? [],
    // Every moving ref is resolved live here: that is the point, not an issue.
    issues: [...run.issues.values()]
      .filter((i) => i.code !== 'remote-unpinned')
      .sort((a, b) => compare(a.message, b.message)),
  };
}

/**
 * Writes the lockfile without following a link: a checkout may commit `.github`, `.github/simulci` or the lockfile as a
 * symbolic link to a file outside it, which a plain write would overwrite. The text goes to a new file beside it, then
 * replaces the lockfile's own directory entry.
 */
function writeLockfile(root: string, text: string): void {
  const path = join(root, REMOTES_LOCK_FILE);
  const parts = REMOTES_LOCK_FILE.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const at = join(root, ...parts.slice(0, i));
    if (lstatOrUndefined(at)?.isSymbolicLink())
      throw new Error(`${parts.slice(0, i).join('/')} is a symbolic link: not writing ${REMOTES_LOCK_FILE}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, text, { flag: 'wx' });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function lstatOrUndefined(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/** A GitHub API and its token, and where the token came from (never the token itself, in any message). */
export interface GitHubAccess extends GitHubApi {
  tokenFrom?: 'option' | TokenVariable | 'gh';
}

type TokenVariable = 'GH_TOKEN' | 'GITHUB_TOKEN' | 'GH_ENTERPRISE_TOKEN' | 'GITHUB_ENTERPRISE_TOKEN';

/** The GitHub CLI's token for a host, or undefined; never printed. */
function ghAuthToken(host: string): string | undefined {
  const r = spawnSync('gh', ['auth', 'token', '--hostname', host], { encoding: 'utf8', timeout: 10_000 });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
}

/**
 * The variables whose token may go to `apiUrl`, as the GitHub CLI reads them: `GH_TOKEN` and `GITHUB_TOKEN` are
 * github.com's (and GHE.com's); a GitHub Enterprise Server's are `GH_ENTERPRISE_TOKEN` and `GITHUB_ENTERPRISE_TOKEN`,
 * and `GITHUB_TOKEN` too when `apiUrl` is the runner's own `GITHUB_API_URL`. So a github.com token never goes to
 * another host because a URL option named one.
 */
function tokenVariables(env: NodeJS.ProcessEnv, apiUrl: string): TokenVariable[] {
  const host = apiHost(apiUrl);
  if (host === 'github.com' || host.endsWith('.ghe.com')) return ['GH_TOKEN', 'GITHUB_TOKEN'];
  const runner = env.GITHUB_API_URL !== undefined && sameUrl(env.GITHUB_API_URL, apiUrl);
  return ['GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', ...(runner ? (['GITHUB_TOKEN'] as const) : [])];
}

const sameUrl = (a: string, b: string) => withoutTrailingSlashes(a) === withoutTrailingSlashes(b);

/** A loop, not `/\/+$/`: a regex anchored after a repeat backtracks quadratically on a long run of `/` (CodeQL). */
function withoutTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end--;
  return url.slice(0, end);
}

/**
 * The API at `apiUrl` and its token: `given`, else the first set of the variables for its host (`GH_TOKEN`, then
 * `GITHUB_TOKEN`, for github.com; see `tokenVariables`), else the GitHub CLI's for the API's host (`gh auth token
 * --hostname`), else none (public repositories only).
 */
export function githubAccess(
  env: NodeJS.ProcessEnv,
  apiUrl: string,
  given?: string,
  gh: (host: string) => string | undefined = ghAuthToken,
): GitHubAccess {
  if (given) return { apiUrl, token: given, tokenFrom: 'option' };
  for (const name of tokenVariables(env, apiUrl)) {
    const token = env[name];
    if (token) return { apiUrl, token, tokenFrom: name };
  }
  const token = gh(apiHost(apiUrl));
  return token ? { apiUrl, token, tokenFrom: 'gh' } : { apiUrl };
}

/** github.com's API, for a GHES's runs that fall back to it: with `GITHUB_COM_TOKEN` or anonymously; none on github.com. */
export function githubComFallback(env: NodeJS.ProcessEnv, apiUrl: string): GitHubApi | undefined {
  if (apiHost(apiUrl) === apiHost(GITHUB_COM_API)) return undefined;
  const token = env.GITHUB_COM_TOKEN;
  return { apiUrl: GITHUB_COM_API, ...(token ? { token } : {}) };
}

// ---------------------------------------------------------------------------
// The closure
// ---------------------------------------------------------------------------

/** Where each commit came from: the pins given, by `remoteKey@sha`, and every ref's kind, by `remoteKey`. */
interface Run {
  project: Project;
  sources: RemoteSource[];
  failed: { ref: string; kind: RemoteFetchError['kind']; error: string }[];
  limited: string[];
  pinned: Map<string, RemotePinned>;
  kinds: Map<string, RemoteRef['kind']>;
  issues: Map<string, PinIssue>;
}

interface Pinning {
  mode: RemotesMode;
  lock?: RemotesLock | undefined;
  lockErrors: string[];
}

async function closureOf(
  root: string,
  files: Record<string, string>,
  host: RemotesHost,
  pinning: Pinning,
): Promise<Run> {
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => compare(a, b)));
  // Without the repository: GitHub runs a full ref to the checkout's own repository (`me/app/x.yml@main`) at that ref,
  // not the working copy (lab R10), and core reads it as a remote only when it does not know the repository.
  const { index } = loadFiles(sorted);
  const actionsLock = readActionsLockOf(root, files, pinning.lockErrors, host.log);
  const run: Run = {
    project: index.project,
    sources: [],
    failed: [],
    limited: [],
    pinned: new Map(),
    kinds: new Map(),
    issues: new Map(),
  };
  const local = localActionsLock(index, actionsLock);
  const pin = (r: RemoteRef, parent?: RemoteSource): CorePin | undefined => {
    run.kinds.set(remoteKey(r.raw), r.kind);
    const p = pinFor(r, {
      mode: pinning.mode,
      ...(pinning.lock ? { lock: pinning.lock } : {}),
      ...pinContext(r, parent, local),
    });
    if (p.issue) run.issues.set(`${p.issue.code} ${p.issue.message}`, p.issue);
    if (!('sha' in p)) return undefined;
    const at = `${remoteKey(r.raw)}@${p.sha}`;
    const before = run.pinned.get(at);
    if (before === undefined || RANK[p.pinned] < RANK[before]) run.pinned.set(at, p.pinned);
    const digest = lockedDigest(pinning.lock, r.raw, p.sha);
    return { sha: p.sha, ...(digest === undefined ? {} : { digest }) };
  };
  const closure = await fetchRemoteClosure(index.project, pin, {
    ...fetchOptions(host),
    resolveUnpinned: pinning.mode === 'fetch',
  });
  return { ...run, ...closure };
}

/** The table's order: when two pins give one commit, the one that comes first names it. */
const RANK: Record<RemotePinned, number> = {
  'sha-ref': 1,
  'actions-lock': 2,
  parent: 3,
  lockfile: 4,
  resolved: 5,
};

/** A ref inside a remote body: never the caller's `actions.lock`; a `./` (or `$/`) there is at its parent's commit. */
function pinContext(
  r: RemoteRef,
  parent: RemoteSource | undefined,
  local: Map<string, string>,
): { inRemote?: true; parentSha?: string; actionsLock?: string } {
  if (!parent) {
    const commit = r.kind === 'action' ? local.get(remoteKey(r.raw)) : undefined;
    return commit === undefined ? {} : { actionsLock: commit };
  }
  const own =
    r.ref.toLowerCase() === parent.sha &&
    r.owner.toLowerCase() === parent.ref.owner.toLowerCase() &&
    r.repo.toLowerCase() === parent.ref.repo.toLowerCase();
  return own ? { inRemote: true, parentSha: parent.sha } : { inRemote: true };
}

/** The lockfile's digest for `raw`, when its entry records the commit about to be read. */
function lockedDigest(lock: RemotesLock | undefined, raw: string, sha: string): string | undefined {
  const entry = entryOf(lock, raw);
  return entry?.sha === sha ? entry.digest : undefined;
}

/** A lockfile entry by the exact key, else by `remoteKey` (as the engine's `pinFor` looks it up). */
function entryOf(lock: RemotesLock | undefined, raw: string): RemotesLockEntry | undefined {
  if (!lock) return undefined;
  if (Object.hasOwn(lock.remotes, raw)) return lock.remotes[raw];
  const key = remoteKey(raw);
  const found = Object.keys(lock.remotes).find((k) => remoteKey(k) === key);
  return found === undefined ? undefined : lock.remotes[found];
}

/** Core's options for a run: the APIs, the fetch, the cache; offline, every API is unreachable from the start. */
function fetchOptions(host: RemotesHost): RemoteFetchOptions {
  const secrets = tokensOf(host);
  const offline = host.offline ? offlineHosts(host) : undefined;
  return {
    api: host.api,
    ...(host.fallback ? { fallback: host.fallback } : {}),
    ...(offline ? { unreachableHosts: offline, fetch: refuse } : host.fetch ? { fetch: host.fetch } : {}),
    cache: host.cache ?? memoryRemoteCache(),
    ...(host.signal ? { signal: host.signal } : {}),
    userAgent: 'simulci',
    onRetry: ({ host: at, attempt, attempts, why, waitMs }) =>
      host.log?.(redact(`${at}: trying again (${attempt}/${attempts}) in ${waitMs} ms: ${why}`, secrets)),
  };
}

const OFFLINE = 'offline: only the cache is read';

const refuse: FetchLike = () => Promise.reject(new Error(OFFLINE));

/** Each API's URL host, marked unreachable before any request, so an offline read fails at once and asks nothing. */
function offlineHosts(host: RemotesHost): Map<string, RemoteFetchError> {
  const down = new Map<string, RemoteFetchError>();
  for (const api of [host.api, ...(host.fallback ? [host.fallback] : [])]) {
    const gitHost = api.host ?? apiHost(api.apiUrl);
    const error = new RemoteFetchError(`${gitHost} not asked (${OFFLINE})`, 'unreachable', gitHost);
    down.set(new URL(api.apiUrl).host, error);
  }
  return down;
}

// ---------------------------------------------------------------------------
// actions.lock
// ---------------------------------------------------------------------------

/** The checkout's `actions.lock`: from `files` when a host passes it, else from disk; none when absent or unusable. */
function readActionsLockOf(
  root: string,
  files: Record<string, string>,
  errors: string[],
  log: RemotesHost['log'],
): ActionsLock | undefined {
  let text = files[ACTIONS_LOCK_FILE];
  try {
    text ??= readFileSync(join(root, ACTIONS_LOCK_FILE), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return unused(`${ACTIONS_LOCK_FILE}: ${(e as Error).message}`, errors, log);
  }
  const read = readActionsLock(text);
  return read.lock ?? unused(`${ACTIONS_LOCK_FILE}: ${read.error}`, errors, log);
}

function unused(error: string, errors: string[], log: RemotesHost['log']): undefined {
  errors.push(printable(error));
  log?.(`not used: ${printable(error)}`);
  return undefined;
}

/**
 * The `actions.lock` commit of each remote action the checkout's own files use, by `remoteKey`. A pin applies under the
 * running file's own path: a workflow's (a local reusable workflow is its own running file), and for a local action,
 * each workflow that runs it. The lock has one commit per key, so every running file that pins a ref pins it alike; the
 * engine reads one body per ref, so a running file the lock does not cover reads that body too.
 */
function localActionsLock(index: ProjectIndex, lock: ActionsLock | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!lock) return out;
  for (const [unit, running] of runningFiles(index))
    for (const r of remoteRefsOf(index.project, [unit])) {
      const commit = [...running]
        .map((path) => actionsLockCommit(lock, path, r))
        .find((c) => c !== undefined);
      if (commit !== undefined) out.set(remoteKey(r.raw), commit);
    }
  return out;
}

/** Each local unit and the workflow paths that run it: a workflow its own; an action, every workflow reaching it. */
function runningFiles(index: ProjectIndex): Map<UnitDecl, Set<string>> {
  const out = new Map<UnitDecl, Set<string>>();
  for (const wf of index.project.workflows.values()) {
    out.set(wf, new Set([wf.path]));
    const queue = Object.values(wf.jobs).flatMap((j) => j.steps);
    for (let step = queue.shift(); step !== undefined; step = queue.shift()) {
      const action = index.actionOf(step);
      if (!action) continue;
      const seen = out.get(action) ?? new Set();
      if (!seen.has(wf.path)) queue.push(...action.steps);
      out.set(action, seen.add(wf.path));
    }
  }
  for (const action of index.project.actions.values()) if (!out.has(action)) out.set(action, new Set());
  return out;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** Core's closure as the engine takes it; every message without the tokens. */
function inputsOf(run: Run, host: Pick<RemotesHost, 'api' | 'fallback'>): RemoteInputs {
  const runHost = (host.api.host ?? apiHost(host.api.apiUrl)).toLowerCase();
  const secrets = tokensOf(host);
  const failed = run.failed.map((f): RemoteFailureInput => ({
    ref: f.ref,
    kind: run.kinds.get(remoteKey(f.ref)) ?? 'workflow',
    failure: f.kind,
    message: redact(f.error, secrets),
  }));
  return {
    sources: run.sources.map((s) => ({
      ref: s.ref.raw,
      kind: s.ref.kind,
      sha: s.sha,
      text: s.text,
      pinned: pinnedOf(run, s),
      ...(s.host.toLowerCase() === runHost ? {} : { host: s.host }),
    })),
    ...(failed.length ? { failed } : {}),
    ...(run.limited.length ? { limited: run.limited } : {}),
  };
}

/** The pin that gave a source's commit; none means the closure took the ref's own SHA, or resolved it. */
function pinnedOf(run: Run, s: RemoteSource): RemotePinned {
  return (
    run.pinned.get(`${remoteKey(s.ref.raw)}@${s.sha}`) ??
    (/^[0-9a-f]{40}$/i.test(s.ref.ref) ? 'sha-ref' : 'resolved')
  );
}

/**
 * The new lockfile: an entry per source read (the latest pin rule wins when one ref was read at two commits), keyed as
 * the old lockfile spelled it; a ref that failed keeps its old entry, else is `unreadable`.
 */
function lockOf(run: Run, old: RemotesLock | undefined, inputs: RemoteInputs): RemotesLock {
  const remotes: Record<string, RemotesLockEntry> = {};
  const rank = new Map<string, number>();
  inputs.sources.forEach((input, i) => {
    const source = run.sources[i]!;
    const key = keyFor(old, input.ref);
    if ((rank.get(key) ?? 0) > RANK[input.pinned]) return;
    rank.set(key, RANK[input.pinned]);
    remotes[key] = {
      sha: input.sha,
      kind: input.kind,
      file: source.file,
      digest: source.digest,
      ...(input.host === undefined ? {} : { host: input.host }),
      calls: callsOf(run.project, source),
    };
  });
  const unreadable: NonNullable<RemotesLock['unreadable']> = {};
  for (const f of inputs.failed ?? []) {
    const key = keyFor(old, f.ref);
    if (remotes[key]) continue;
    const kept = entryOf(old, f.ref);
    if (kept) keepWithCalls(old!, remotes, key, kept);
    else unreadable[key] = f.failure;
  }
  return { version: 1, remotes, ...(Object.keys(unreadable).length ? { unreadable } : {}) };
}

/**
 * An old entry kept because its ref could not be read, and the old entries it reaches through `calls` that this update
 * did not read either: nothing below a ref that failed was read, so a passing failure must not drop them.
 */
function keepWithCalls(
  old: RemotesLock,
  remotes: Record<string, RemotesLockEntry>,
  key: string,
  kept: RemotesLockEntry,
): void {
  remotes[key] = kept;
  const queue = [...(kept.calls ?? [])];
  for (let ref = queue.shift(); ref !== undefined; ref = queue.shift()) {
    const below = entryOf(old, ref);
    const at = keyFor(old, ref);
    if (!below || remotes[at]) continue;
    remotes[at] = below;
    queue.push(...(below.calls ?? []));
  }
}

/** The old lockfile's spelling of a ref's key, so an update that moves nothing keeps every key. */
function keyFor(old: RemotesLock | undefined, raw: string): string {
  const key = remoteKey(raw);
  const all = [...Object.keys(old?.remotes ?? {}), ...Object.keys(old?.unreadable ?? {})];
  return all.find((k) => k === raw) ?? all.find((k) => remoteKey(k) === key) ?? raw;
}

/** The remote refs inside a source's file, resolved as the closure resolves them (a `./` at the source's commit). */
function callsOf(project: Project, { ref: r, sha, text }: RemoteSource): string[] {
  const ctx = createParseContext(`${r.owner}/${r.repo}`);
  const unit =
    r.kind === 'workflow' ? parseWorkflowFile(r.raw, text, ctx) : parseActionFile(r.raw, r.raw, text, ctx);
  const origin = { owner: r.owner, repo: r.repo, path: r.path, ref: r.ref, sha };
  return remoteRefsOf(project, [{ ...unit, external: true, origin }]).map((c) => c.raw);
}

function diffOf(
  old: RemotesLock | undefined,
  lock: RemotesLock,
): Pick<LockUpdate, 'added' | 'removed' | 'changed'> {
  const before = old?.remotes ?? {};
  const keys = Object.keys(lock.remotes).sort(compare);
  const added = keys.filter((k) => !Object.hasOwn(before, k));
  const removed = Object.keys(before)
    .filter((k) => !Object.hasOwn(lock.remotes, k))
    .sort(compare);
  const changed = keys
    .filter((k) => Object.hasOwn(before, k))
    .map((k) => ({ ref: k, from: before[k]!, to: lock.remotes[k]! }))
    .filter(({ from, to }) => from.sha !== to.sha || from.digest !== to.digest || from.host !== to.host)
    .map(({ ref, from, to }) => ({ ref, from: from.sha, to: to.sha }));
  return { added, removed, changed };
}

// ---------------------------------------------------------------------------

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function readOr(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

const tokensOf = (host: Pick<RemotesHost, 'api' | 'fallback'>): string[] =>
  [host.api.token, host.fallback?.token].filter((t): t is string => !!t);

/** Text without any of the run's tokens. */
/** Text without any of the run's tokens (the longest first, so one inside another leaves nothing), on one line. */
const redact = (text: string, tokens: string[]): string =>
  printable(
    [...tokens].sort((a, b) => b.length - a.length).reduce((out, t) => out.split(t).join('***'), text),
  );

/**
 * Control characters escaped: refs, lockfile keys and server text reach messages and log lines, where a newline could
 * start a workflow command (`::error::`) in the Action, and an escape sequence could rewrite a terminal.
 */
function printable(text: string): string {
  let out = '';
  for (const c of text) {
    const code = c.charCodeAt(0);
    out += code < 0x20 || (code >= 0x7f && code < 0xa0) ? `\\u${code.toString(16).padStart(4, '0')}` : c;
  }
  return out;
}
