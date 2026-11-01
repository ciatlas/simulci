import type { GitHubSource, Source } from '../state/store';

/**
 * What the page says of a GitHub source (M4 synthesis § 5.5, § 5.7): its name, its commit, and how its edits leave it
 * (it is read-only to GitHub): a patch named for the repository and the commit, which starts with a line naming them
 * (`git apply` reads nothing before the first `diff --git`), and the commands that apply it in a checkout. Any other
 * source's patch is `simulci-changes.patch`, with no such line.
 */

/** A repository and the ref to read; no ref reads its default branch. */
export interface RepoTarget {
  owner: string;
  repo: string;
  ref?: string;
}

/** `octo/ship@main`, or `octo/ship` for its default branch: the URL's `gh` (M4 synthesis § 5.5). */
export const targetText = (t: RepoTarget): string =>
  `${t.owner}/${t.repo}${t.ref === undefined ? '' : `@${t.ref}`}`;

const OWNER = /^[A-Za-z\d](?:[A-Za-z\d-]{0,38})$/;
const REPO = /^[\w.-]{1,100}$/;

/** Whether a name can be a GitHub account's, and one a repository's (not `.` or `..`). */
export const isRepoName = (owner: string, repo: string): boolean =>
  OWNER.test(owner) && REPO.test(repo) && repo !== '.' && repo !== '..';

/** The target `octo/ship@main` or `octo/ship` names, or nothing. */
export function parseTargetText(text: string): RepoTarget | undefined {
  const m = /^([^/@\s]+)\/([^/@\s]+)(?:@(\S+))?$/.exec(text);
  if (!m || !isRepoName(m[1]!, m[2]!)) return undefined;
  return m[3] === undefined ? { owner: m[1]!, repo: m[2]! } : { owner: m[1]!, repo: m[2]!, ref: m[3] };
}

/**
 * Whether a source is the repository a target names, at its ref: the owner and the name in any letter case, no ref
 * standing for the default branch.
 */
export const isTarget = (source: Source, t: RepoTarget): boolean =>
  source.kind === 'github' &&
  source.owner.toLowerCase() === t.owner.toLowerCase() &&
  source.repo.toLowerCase() === t.repo.toLowerCase() &&
  sameRef(source.ref, t.ref ?? source.defaultBranch);

/** Two refs alike: a full SHA in any letter case (a source keeps it in lower case), any other name exactly. */
const sameRef = (a: string, b: string): boolean =>
  a === b || (/^[0-9a-f]{40}$/i.test(a) && a.toLowerCase() === b.toLowerCase());

/** The patch of a source with no repository to name. */
export const PATCH_NAME = 'simulci-changes.patch';

export const shortSha = (sha: string): string => sha.slice(0, 7);

/** `octo/ship`. */
export const repoName = (source: Pick<GitHubSource, 'owner' | 'repo'>): string =>
  `${source.owner}/${source.repo}`;

/** `octo/ship @ main (3f2a9c1)`, or `octo/ship @ 3f2a9c1` when the ref is the commit: the status line's name of it. */
export const repoAt = (source: GitHubSource): string =>
  source.ref === source.sha
    ? `${repoName(source)} @ ${shortSha(source.sha)}`
    : `${repoName(source)} @ ${source.ref} (${shortSha(source.sha)})`;

/** `octo-ship-3f2a9c1.patch`, or `simulci-changes.patch`. */
export const patchName = (source: Source): string =>
  source.kind === 'github' ? `${source.owner}-${source.repo}-${shortSha(source.sha)}.patch` : PATCH_NAME;

/** `simulci: changes against octo/ship@3f2a9c1 (main)`, the patch's first line, for a GitHub source only. */
export const patchPreamble = (source: Source): string | undefined =>
  source.kind === 'github'
    ? `simulci: changes against ${repoName(source)}@${shortSha(source.sha)} (${source.ref})`
    : undefined;

/** The commands that put a GitHub source's patch on a branch at its commit, in a checkout of the repository. */
export const applyCommands = (source: GitHubSource): string =>
  `git fetch origin && git switch -c simulci-edits ${shortSha(source.sha)} && git apply ${patchName(source)}`;

/** The note the first edit of a GitHub source gets: where its edits can go. */
export const githubNote = (source: GitHubSource): string =>
  `Read from ${repoName(source)} at ${shortSha(source.sha)}. Download a patch and apply it in your checkout.`;
