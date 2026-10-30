import type { GitHubSource, Source } from '../state/store';

/**
 * What the page says of a GitHub source (M4 synthesis § 5.5, § 5.7): its name, its commit, and how its edits leave it
 * (it is read-only to GitHub): a patch named for the repository and the commit, which starts with a line naming them
 * (`git apply` reads nothing before the first `diff --git`), and the commands that apply it in a checkout. Any other
 * source's patch is `simulci-changes.patch`, with no such line.
 */

/** The patch of a source with no repository to name. */
export const PATCH_NAME = 'simulci-changes.patch';

export const shortSha = (sha: string): string => sha.slice(0, 7);

/** `octo/ship`. */
export const repoName = (source: Pick<GitHubSource, 'owner' | 'repo'>): string =>
  `${source.owner}/${source.repo}`;

/** `octo/ship @ main (3f2a9c1)`: the status line's name of a GitHub source. */
export const repoAt = (source: GitHubSource): string =>
  `${repoName(source)} @ ${source.ref} (${shortSha(source.sha)})`;

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
