import type { PullFacts } from '../state/store';
import type { RepoClient } from './client';
import { type RepoInfo, repoPath } from './repo';

/**
 * A pull request of a public repository (M4 synthesis § 5.8): `GET …/pulls/{n}` for its head commit, its base and head
 * branches and how many files it changes, then `GET …/pulls/{n}/files`, one request per 100 files, for the files
 * themselves. The head commit is read through the base repository, a fork's too: GitHub keeps every pull request's
 * head there (`refs/pull/{n}/head`), so its trees and blobs answer even once the fork is gone (probed 2026-11-02).
 * GitHub lists at most 3,000 files (docs.github.com/en/rest/pulls/pulls#list-pull-requests-files): past that the
 * files are not asked for, and the changed files stay unknown rather than cut short.
 */

/** The most files GitHub lists of a pull request. */
export const LISTED_FILES = 3000;

const PAGE = 100;

interface PullBody {
  number: number;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { ref: string; repo: { full_name: string } };
  changed_files: number;
}

interface FileBody {
  filename: string;
  /** `added`, `removed`, `modified`, `renamed`, `copied`, `changed` or `unchanged`. */
  status: string;
  previous_filename?: string;
}

type Changed = NonNullable<PullFacts['changed']>[number];

/** The pull request's head commit, lower-case, and what the scenario takes from it but the files. */
export async function pullOf(
  client: RepoClient,
  info: RepoInfo,
  number: number,
): Promise<{ sha: string; pull: PullFacts }> {
  const found = await client.api.json<PullBody>(`${repoPath(info.owner, info.repo)}/pulls/${number}`);
  if (!found) throw new Error(`${info.owner}/${info.repo} has no pull request #${number}.`);
  const { head, base, changed_files } = found.body;
  const fork = head.repo?.full_name.toLowerCase() !== base.repo.full_name.toLowerCase();
  return {
    sha: head.sha.toLowerCase(),
    pull: { number, base: base.ref, head: head.ref, fork, files: changed_files },
  };
}

/** The files it changes, as the scenario takes them; nothing (and no request) past what GitHub lists. */
export async function changedOf(
  client: RepoClient,
  info: RepoInfo,
  pull: PullFacts,
): Promise<Changed[] | undefined> {
  if (pull.files > LISTED_FILES) return undefined;
  const changed: Changed[] = [];
  for (let page = 1; page <= Math.ceil(pull.files / PAGE); page++) {
    const path = `${repoPath(info.owner, info.repo)}/pulls/${pull.number}/files?per_page=${PAGE}&page=${page}`;
    const found = await client.api.json<FileBody[]>(path);
    if (!found) throw new Error(`GitHub did not list the files of #${pull.number}`);
    changed.push(...found.body.map(changeOf));
    if (found.body.length < PAGE) break;
  }
  return changed;
}

/** A file as the scenario writes it: a modified one by its path alone. A copy is a file added. */
function changeOf(f: FileBody): Changed {
  if (f.status === 'added' || f.status === 'copied') return { path: f.filename, status: 'added' };
  if (f.status === 'removed') return { path: f.filename, status: 'removed' };
  if (f.status === 'renamed' && f.previous_filename)
    return { path: f.filename, status: 'renamed', from: f.previous_filename };
  return f.filename;
}
