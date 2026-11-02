import type {
  Loc,
  NodeId,
  RemoteFailureKind,
  RemotePinned,
  RemoteUse,
  RunPlan,
  WorkflowPlan,
} from '@simulci/engine';

/**
 * How the page words a remote workflow or action (M4 synthesis § 5.4), from the plan alone: `RunPlan.remotes` and
 * `WorkflowPlan.remote`. A ref read at two commits (a pinned and a live read) is two rows of one `ref`, so a row is
 * found by the node that uses it, never by its ref alone.
 */

/** A `uses:` of another repository, in parts: `octo/ship/.github/workflows/deploy.yml@v1`, `octo/act@v2`. */
export interface RemoteName {
  owner: string;
  repo: string;
  /** The file or directory inside the repository; absent for an action at its root. */
  path?: string;
  ref: string;
}

/** The parts of a remote `uses:`; undefined for a local, docker or malformed one. */
export function remoteName(uses: string): RemoteName | undefined {
  const at = uses.lastIndexOf('@');
  if (at <= 0 || uses.startsWith('./') || uses.startsWith('docker://')) return undefined;
  const [owner, repo, ...rest] = uses.slice(0, at).split('/');
  if (!owner || !repo) return undefined;
  const name: RemoteName = { owner, repo, ref: uses.slice(at + 1) };
  if (rest.length > 0) name.path = rest.join('/');
  return name;
}

/** `octo/ship · deploy.yml @ v1`: the repository, the file's name and the ref, as the canvas heads a remote. */
export function remoteTitle(uses: string): string {
  const name = remoteName(uses);
  if (!name) return uses;
  const file = name.path?.split('/').at(-1);
  return `${name.owner}/${name.repo}${file === undefined ? '' : ` · ${file}`} @ ${name.ref}`;
}

export const shortSha = (sha: string): string => sha.slice(0, 7);

/** The plan's row of the remote a leg calls or a step uses, by the node that uses it. */
export function remoteAt(plan: RunPlan, node: NodeId): RemoteUse | undefined {
  return plan.remotes?.find((r) => r.at.includes(node));
}

/** Where a remote's commit came from, as a sentence (synthesis § 2.5's table). */
export function pinnedWords(pinned: RemotePinned | undefined, ref: string): string {
  if (pinned === 'actions-lock') return 'Pinned by actions.lock.';
  if (pinned === 'lockfile') return 'Pinned by remotes.lock.yml.';
  if (pinned === 'sha-ref') return 'Pinned by its ref, a commit SHA.';
  if (pinned === 'parent') return 'Read at the commit of the file that calls it.';
  return `Read at ${remoteName(ref)?.ref ?? ref} today; the tag can move.`;
}

/** Why a remote was not read, in words; and whether trying again may help. */
export function failureWords(failure: RemoteFailureKind | undefined): { words: string; retry: boolean } {
  switch (failure) {
    case 'access':
    case 'not-found':
      return { words: 'not found, or private (sign in on a simulci server)', retry: false };
    case 'rate-limit':
      return { words: 'GitHub’s rate limit is used up for now', retry: true };
    case 'token':
      return { words: 'GitHub refused the token', retry: false };
    case 'too-large':
      return { words: 'the file is too large to read', retry: false };
    case 'digest':
      return { words: 'its bytes are not the ones remotes.lock.yml records', retry: false };
    case 'unreachable':
    case 'timeout':
    case 'server':
      return { words: 'GitHub did not answer', retry: true };
    default:
      return { words: 'GitHub could not read it', retry: true };
  }
}

/** What a stub says of a callee the plan could not simulate, and the one thing a click can do about it. */
export interface RemoteStub {
  /** `octo/ship · deploy.yml @ v1`. */
  title: string;
  state: Exclude<RemoteUse['state'], 'simulated'>;
  /** `not fetched`, `not read`, … : what follows the title. */
  status: string;
  /** The sentence under it. */
  words: string;
  /** Fetch (the author has not let the page read remotes) or Retry (a read that may answer now). */
  action?: 'fetch' | 'retry';
  /** The row's ref, which Retry reads again. */
  ref: string;
}

/**
 * The stub of a call whose callee is not planned: not fetched, not read (with the kind), past a cap, or a file that
 * does not parse. Fetch is offered on any not fetched one; whether the page may ask GitHub is the button's to say.
 */
export function remoteStub(row: RemoteUse): RemoteStub | undefined {
  if (row.state === 'simulated') return undefined;
  const base = { title: remoteTitle(row.ref), state: row.state, ref: row.ref };
  if (row.state === 'not-fetched')
    return { ...base, status: 'not fetched', words: 'Its jobs and outputs are unknown.', action: 'fetch' };
  if (row.state === 'failed') {
    const why = failureWords(row.failure);
    return {
      ...base,
      status: 'not read',
      words: `${capital(why.words)}.`,
      ...(why.retry ? { action: 'retry' } : {}),
    };
  }
  if (row.state === 'limit')
    return { ...base, status: 'not read', words: 'Past the limit on how many remote files a run reads.' };
  return { ...base, status: 'not simulated', words: 'Its file does not parse; the Problems tab says where.' };
}

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** `https://github.com/octo/ship/blob/<sha>/<path>#L<n>`: a line of a remote's file at the commit it was read at. */
export function blobUrl(name: RemoteName, sha: string, line?: number, host = 'github.com'): string {
  const path = name.path ?? 'action.yml';
  return `https://${host}/${name.owner}/${name.repo}/blob/${sha}/${path}${line === undefined ? '' : `#L${line}`}`;
}

/**
 * Where a place in a remote's file opens on GitHub: at the commit of the remote workflow around `near` when it is that
 * file, else at the one commit the plan read the ref at. Undefined for a project file, and for a ref read at two
 * commits with nothing to tell them apart.
 */
export function remoteHref(
  plan: RunPlan,
  loc: Pick<Loc, 'file' | 'line'>,
  near?: readonly WorkflowPlan[],
): string | undefined {
  const name = remoteName(loc.file);
  if (!name || isProjectPath(loc.file)) return undefined;
  const own = near?.find((wf) => wf.remote?.ref === loc.file)?.remote?.sha;
  const rows = (plan.remotes ?? []).filter((r) => r.ref === loc.file && r.sha !== undefined);
  const shas = new Set(rows.map((r) => r.sha));
  const sha = own ?? (shas.size === 1 ? rows[0]!.sha : undefined);
  if (sha === undefined) return undefined;
  const host = rows.find((r) => r.sha === sha)?.host;
  return blobUrl(name, sha, loc.line, host);
}

/** A path the project holds: every one starts at its root's `.github/` (or is an `action.yml` beside it). */
const isProjectPath = (file: string): boolean => file.startsWith('.github/') || !file.includes('@');

/** The remote workflows around a node, innermost first: what its places inside a remote's file are read at. */
export function remoteScopes(plan: RunPlan, node: NodeId): WorkflowPlan[] {
  const out: WorkflowPlan[] = [];
  const visit = (wf: WorkflowPlan): boolean => {
    const inside = node === wf.id || node.startsWith(`${wf.id}#`) || node.startsWith(`${wf.id}>`);
    if (!inside) return false;
    for (const job of wf.jobs) for (const leg of job.legs) if (leg.call && visit(leg.call)) break;
    if (wf.remote) out.push(wf);
    return true;
  };
  for (const wf of plan.workflows) if (wf.depth === 0) visit(wf);
  return out;
}
