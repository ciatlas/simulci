import {
  ACTIONS_LOCK_FILE,
  actionsLockCommit,
  type ActionsLock,
  loadProject,
  memoryFileSystem,
  parseRemoteRef,
  ProjectIndex,
  type RemoteRef,
  readActionsLock,
  remoteKey,
  remoteRefOfUses,
  type UnitDecl,
  type UsesRef,
} from '@ciatlas/core';
import type { WorkflowSettings } from '../settings';
import {
  type PinIssue,
  parseRemotesLock,
  pinFor,
  REMOTES_LOCK_FILE,
  type RemoteFailureInput,
  type RemoteInputs,
  type RemoteKind,
  type RemotePinned,
  type RemoteSourceInput,
  type RemotesLock,
  type RemotesMode,
} from './lock';

/**
 * What a project knows of the remote workflows and actions it uses: the files a host read (by `remoteKey` of their
 * ref), the refs it could not read, and those past its caps. Every other remote ref is not fetched.
 */

export interface LoadOptions {
  /** `owner/name`, for `uses:` references to this repository. */
  repository?: string;
  /** The remote files a host read, and what it could not read. */
  remotes?: RemoteInputs;
  /**
   * How the host read remotes, for the lockfile's diagnostics (`remote-not-locked`, `remote-unpinned`,
   * `remote-pin-mismatch`): `lock` when `remotes` is given, else `off`.
   */
  mode?: RemotesMode;
}

export interface RemotesState {
  mode: RemotesMode;
  /** By `remoteKey` of the ref. */
  sources: Map<string, RemoteSourceInput>;
  failed: Map<string, RemoteFailureInput>;
  limited: Set<string>;
  /** `remotes.lock.yml` and `actions.lock` among the files, when they are there and read. */
  lock?: RemotesLock;
  actionsLock?: ActionsLock;
}

/** A project loaded once, to simulate many scenarios against (the app, the test runner, the lab). */
export interface LoadedProject {
  index: ProjectIndex;
  files: Record<string, string>;
  /** Run settings per workflow path, read on first use. */
  settings: Map<string, WorkflowSettings>;
  remotes: RemotesState;
}

/** By code unit, not locale, so every host loads in the same order. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Sources in one order whatever order a host read them in: site ids are numbered in load order. */
const sortSources = (sources: readonly RemoteSourceInput[]): RemoteSourceInput[] =>
  sources
    .map((s) => ({ s, key: remoteKey(s.ref) }))
    .sort((a, b) => byCodeUnit(a.key, b.key) || byCodeUnit(a.s.ref, b.s.ref) || byCodeUnit(a.s.sha, b.s.sha))
    .map(({ s }) => s);

/**
 * Loads the workflows and local actions of a repository snapshot (files by repository-relative path), with the remote
 * files a host read as external units. A string is the `repository`.
 */
export function loadFiles(files: Record<string, string>, opts: string | LoadOptions = {}): LoadedProject {
  const o: LoadOptions = typeof opts === 'string' ? { repository: opts } : opts;
  const sources = sortSources(o.remotes?.sources ?? []);
  const project = loadProject({
    root: '.',
    fs: memoryFileSystem(files),
    ...(o.repository === undefined ? {} : { repository: o.repository }),
    validateSchema: false,
    ...(sources.length
      ? { remotes: sources.map((s) => ({ ref: s.ref, kind: s.kind, text: s.text, sha: s.sha })) }
      : {}),
  });
  return {
    index: new ProjectIndex(project),
    files,
    settings: new Map(),
    remotes: remotesState(files, o, sources),
  };
}

function remotesState(
  files: Record<string, string>,
  o: LoadOptions,
  sources: RemoteSourceInput[],
): RemotesState {
  return {
    mode: o.mode ?? (o.remotes ? 'lock' : 'off'),
    sources: new Map(sources.map((s) => [remoteKey(s.ref), s])),
    failed: new Map((o.remotes?.failed ?? []).map((f) => [remoteKey(f.ref), f])),
    limited: new Set((o.remotes?.limited ?? []).map(remoteKey)),
    ...locksOf(files),
  };
}

/** The lockfiles among the files, those that read; one that does not is as none (`simulci remotes check` says why). */
function locksOf(files: Record<string, string>): Pick<RemotesState, 'lock' | 'actionsLock'> {
  const lockText = files[REMOTES_LOCK_FILE];
  const lock = lockText === undefined ? undefined : parseRemotesLock(lockText);
  const actionsText = files[ACTIONS_LOCK_FILE];
  const actions = actionsText === undefined ? undefined : readActionsLock(actionsText);
  return {
    ...(lock && 'lock' in lock ? { lock: lock.lock } : {}),
    ...(actions?.lock ? { actionsLock: actions.lock } : {}),
  };
}

const kindOfUses = (uses: UsesRef): RemoteKind => (uses.kind.endsWith('workflow') ? 'workflow' : 'action');

/**
 * The remote ref a `uses:` names where it is written (core's `remoteRefOfUses`), and in a unit of this repository a
 * full ref to this repository too: GitHub runs it at its ref, never the working copy (lab R10).
 */
export function remoteRefOf(unit: UnitDecl, uses: UsesRef): RemoteRef | undefined {
  if (!unit.external && uses.sameRepoRef !== undefined) return parseRemoteRef(uses.raw, kindOfUses(uses));
  return remoteRefOfUses(unit, uses);
}

/** Whether `uses:` names its remote through the unit's own repository (`./`, `$/`) rather than as written. */
export const namedByOrigin = (unit: UnitDecl, uses: UsesRef): boolean =>
  unit.external === true && (uses.kind === 'local-workflow' || uses.kind === 'local-action');

/** Where a remote stands for a plan: read (and parsed or not), not read, past a cap, or never fetched. */
export type RemoteStateKind = 'simulated' | 'invalid' | 'failed' | 'limit' | 'not-fetched';

export interface RemoteLookup {
  key: string;
  state: RemoteStateKind;
  source?: RemoteSourceInput;
  unit?: UnitDecl;
  failure?: RemoteFailureInput;
}

/** A remote ref's state in a loaded project. */
export function lookupRemote(loaded: LoadedProject, ref: RemoteRef): RemoteLookup {
  const key = remoteKey(ref.raw);
  const { sources, failed, limited } = loaded.remotes;
  const unit = loaded.index.project.external?.get(key);
  const source = sources.get(key);
  if (unit && source) return { key, state: unit.parseErrors.length ? 'invalid' : 'simulated', source, unit };
  const failure = failed.get(key);
  if (failure) return { key, state: 'failed', failure };
  return { key, state: limited.has(key) ? 'limit' : 'not-fetched' };
}

/** The pin context of a remote `uses:` in `unit`: the caller's `actions.lock` only for an action its own workflow runs. */
export function pinContextOf(loaded: LoadedProject, unit: UnitDecl, uses: UsesRef, ref: RemoteRef) {
  const { mode, lock, actionsLock } = loaded.remotes;
  const local = !unit.external && unit.kind === 'workflow';
  const lockCommit =
    local && ref.kind === 'action' ? actionsLockCommit(actionsLock, unit.path, ref) : undefined;
  const parentSha = namedByOrigin(unit, uses) ? unit.origin?.sha : undefined;
  return {
    mode,
    ...(lock ? { lock } : {}),
    ...(lockCommit === undefined ? {} : { actionsLock: lockCommit }),
    ...(unit.external ? { inRemote: true } : {}),
    ...(parentSha === undefined ? {} : { parentSha }),
  };
}

export interface NeededRemote {
  /** The ref to read: as written, or `owner/repo/path@<parent sha>` for a `./` inside a remote unit. */
  ref: string;
  kind: RemoteKind;
  /** 1 for the project's own refs, one more per remote unit in between. */
  depth: number;
  /** The commit to read it at; without one, the host resolves the ref live (`fetch` mode). */
  pin?: { sha: string; pinned: Exclude<RemotePinned, 'resolved'> };
  issue?: PinIssue;
}

/** How deep a host follows remotes: the project's own refs are at depth 1 (core's `maxDepth`). */
const MAX_REMOTE_DEPTH = 10;

/**
 * The remote refs to read next: those the project and the remote units already read use, that are neither read, nor
 * failed, nor past a cap, at depth 10 or less, each with its pin (`pinFor` over the lockfile and `actions.lock`). In
 * `lock` mode only pinned refs are read; `fetch` adds the rest, resolved live; `off` reads nothing. Sorted by ref.
 */
export function remotesNeeded(loaded: LoadedProject, mode: RemotesMode): NeededRemote[] {
  if (mode === 'off') return [];
  const project = loaded.index.project;
  const seen = new Set<string>();
  const out: NeededRemote[] = [];
  let level: UnitDecl[] = [...project.workflows.values(), ...project.actions.values()];
  for (let depth = 1; depth <= MAX_REMOTE_DEPTH && level.length; depth++)
    level = neededAt(loaded, mode, { depth, level, seen, out });
  return out.sort((a, b) => byCodeUnit(a.ref, b.ref));
}

/** One level of `remotesNeeded`: the refs its units use, each once; returns the remote units read, to go on with. */
function neededAt(
  loaded: LoadedProject,
  mode: RemotesMode,
  at: { depth: number; level: UnitDecl[]; seen: Set<string>; out: NeededRemote[] },
): UnitDecl[] {
  const next: UnitDecl[] = [];
  for (const { unit, uses, ref } of refsOf(at.level)) {
    const found = lookupRemote(loaded, ref);
    if (at.seen.has(found.key)) continue;
    at.seen.add(found.key);
    if (found.state === 'simulated') next.push(found.unit!);
    if (found.state !== 'not-fetched') continue;
    const need = needed(ref, at.depth, pinFor(ref, { ...pinContextOf(loaded, unit, uses, ref), mode }));
    if (need) at.out.push(need);
  }
  return next;
}

function* refsOf(units: UnitDecl[]): Generator<{ unit: UnitDecl; uses: UsesRef; ref: RemoteRef }> {
  for (const unit of units) {
    const users =
      unit.kind === 'action'
        ? unit.steps
        : Object.values(unit.jobs).flatMap((j) => [j as { uses?: UsesRef }].concat(j.steps));
    for (const { uses } of users) {
      const ref = uses && remoteRefOf(unit, uses);
      if (uses && ref) yield { unit, uses, ref };
    }
  }
}

function needed(ref: RemoteRef, depth: number, pin: ReturnType<typeof pinFor>): NeededRemote | undefined {
  const need: NeededRemote = { ref: ref.raw, kind: ref.kind, depth };
  if (pin.issue) need.issue = pin.issue;
  if (pin.pinned === 'resolved') return need;
  if (pin.pinned === undefined) return undefined;
  need.pin = { sha: pin.sha, pinned: pin.pinned };
  return need;
}
