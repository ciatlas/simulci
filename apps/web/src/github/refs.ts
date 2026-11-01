import type { RepoTarget } from '../lib/repo-words';
import type { RepoClient } from './client';
import { repoPath } from './repo';

/**
 * The refs the ref picker offers (M4 synthesis § 5.6): a repository's branches and tags, from `GET …/branches` and
 * `GET …/tags`, 100 a page and at most `MAX_PAGES` pages each, read only once the picker's list opens. What Open reads
 * is the ref typed or picked: a full SHA as a commit, a name as GitHub resolves it, and a name that is both a branch
 * and a tag as the one picked (`refs/heads/…` or `refs/tags/…`, which `GET …/commits/{ref}` takes too, probed
 * 2026-10-30). A name git would refuse is refused before a request is spent on it.
 *
 * On a server, signed in, open pull requests join them from `GET …/pulls` (Pull requests: read, D7): a third kind
 * beside these two, listed the same way (WS).
 */

export type RefKind = 'branch' | 'tag';

/** A branch or a tag, and the commit it points at as GitHub listed it. */
export interface Ref {
  name: string;
  kind: RefKind;
  sha: string;
}

/** A list GitHub gave, and whether it holds more than the pages read. */
export interface RefList {
  refs: Ref[];
  more: boolean;
}

export interface RefLists {
  branches: RefList;
  tags: RefList;
}

/** As many as GitHub gives a page. */
const PER_PAGE = 100;

/** Pages read of each list at most: 200 branches and 200 tags cost 4 of an anonymous hour's 60 requests. */
export const MAX_PAGES = 2;

const PATHS: Record<RefKind, string> = { branch: 'branches', tag: 'tags' };

interface RefBody {
  name: string;
  commit: { sha: string };
}

/** Whether a `Link` header names a next page. */
const hasNext = (link: string | null): boolean => link !== null && /<[^>]*>;\s*rel="next"/.test(link);

/** A repository's branches or tags, in GitHub's order, page by page until the last one or `pages`. */
export async function listRefs(
  client: RepoClient,
  { owner, repo }: RepoTarget,
  kind: RefKind,
  pages = MAX_PAGES,
): Promise<RefList> {
  const refs: Ref[] = [];
  for (let page = 1; page <= pages; page++) {
    const path = `${repoPath(owner, repo)}/${PATHS[kind]}?per_page=${PER_PAGE}&page=${page}`;
    const found = await client.api.json<RefBody[]>(path);
    if (!found || !Array.isArray(found.body))
      throw new Error(`GitHub did not list the ${PATHS[kind]} of ${owner}/${repo}`);
    for (const r of found.body) refs.push({ name: r.name, kind, sha: r.commit.sha });
    if (!hasNext(found.headers.get('link'))) return { refs, more: false };
  }
  return { refs, more: true };
}

/** A commit's full SHA: 40 hexadecimal digits, in either case. */
export const isFullSha = (ref: string): boolean => /^[0-9a-f]{40}$/i.test(ref);

/** Characters no ref name holds (`git check-ref-format`): white space, `~ ^ : ? * [ \`, and the controls. */
const REFUSED = /[\s~^:?*[\\]|\p{Cc}/u;

/** Why a ref name cannot name a branch, tag or commit, as git's rules for one say; nothing when it can. */
export function refProblem(ref: string): string | undefined {
  const bad =
    REFUSED.test(ref) ||
    ref === '@' ||
    ref.includes('..') ||
    ref.includes('@{') ||
    ref.includes('//') ||
    /^\/|\/$|\.$|\.lock(?:\/|$)|(?:^|\/)\./.test(ref);
  return bad ? `“${ref}” cannot be the name of a branch, tag or commit.` : undefined;
}

/** What Open reads for the picker's text: nothing for the default branch, or a ref; or why the text is none. */
export type RefChoice = { ok: true; ref?: string } | { ok: false; message: string };

/**
 * The ref Open reads: the text trimmed (empty reads the default branch), a full SHA in lower case, and a name that is
 * both a branch and a tag qualified as the kind picked, so GitHub reads the one the author chose.
 */
export function refChoice(text: string, picked?: Ref, lists?: RefLists): RefChoice {
  const ref = text.trim();
  if (ref === '') return { ok: true };
  if (isFullSha(ref)) return { ok: true, ref: ref.toLowerCase() };
  const message = refProblem(ref);
  if (message) return { ok: false, message };
  if (picked?.name !== ref || !lists || !isBoth(lists, ref)) return { ok: true, ref };
  return { ok: true, ref: `refs/${picked.kind === 'branch' ? 'heads' : 'tags'}/${ref}` };
}

/** The target at a ref, or at its default branch for none. */
export const atRefOf = ({ owner, repo }: RepoTarget, ref: string | undefined): RepoTarget =>
  ref === undefined ? { owner, repo } : { owner, repo, ref };

const isBoth = (lists: RefLists, name: string): boolean =>
  lists.branches.refs.some((r) => r.name === name) && lists.tags.refs.some((r) => r.name === name);

/**
 * The ref a github.com link names, whole: `tree/feature/x/.github` is at `feature/x` when that is a branch or a tag,
 * the longest name the segments start with. Nothing when none is listed.
 */
export function wholeRef(segments: readonly string[], lists: RefLists): string | undefined {
  const names = new Set([...lists.branches.refs, ...lists.tags.refs].map((r) => r.name));
  for (let n = segments.length; n > 0; n--) {
    const name = segments.slice(0, n).join('/');
    if (names.has(name)) return name;
  }
  return undefined;
}

/**
 * The picker's options for what is typed: the default branch first, the other branches, then the tags, each holding
 * the text in any letter case (all of them for no text).
 */
export function refOptions(lists: RefLists, text: string, defaultBranch?: string): Ref[] {
  const needle = text.trim().toLowerCase();
  const all = [...lists.branches.refs, ...lists.tags.refs];
  const first = all.findIndex((r) => r.kind === 'branch' && r.name === defaultBranch);
  const ordered = first < 0 ? all : [all[first]!, ...all.slice(0, first), ...all.slice(first + 1)];
  return needle === '' ? ordered : ordered.filter((r) => r.name.toLowerCase().includes(needle));
}

/**
 * The option a list opening shows as current: the one the field names exactly (the kind picked, when a branch and a
 * tag share the name), else none, so Enter leaves a typed ref as typed. -1 for none.
 */
export function highlighted(options: readonly Ref[], value: string, picked?: Ref): number {
  const kind = picked?.name === value ? picked.kind : undefined;
  return options.findIndex((r) => r.name === value && (kind === undefined || r.kind === kind));
}

/** The option an arrow key moves to from `at` (-1 for none), round the list's ends. */
export const stepped = (at: number, by: number, count: number): number =>
  at < 0 ? (by > 0 ? 0 : count - 1) : (at + by + count) % count;

/** What the picker says of its lists: nothing, or that GitHub holds more than it listed. */
export function moreNote(lists: RefLists): string | undefined {
  const more = [lists.branches.more && 'branches', lists.tags.more && 'tags'].filter(Boolean);
  if (more.length === 0) return undefined;
  return `GitHub has more ${more.join(' and ')} than the first ${PER_PAGE * MAX_PAGES} listed: type the name of another.`;
}
