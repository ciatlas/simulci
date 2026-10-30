import { isRepoName, parseTargetText, type RepoTarget } from '../lib/repo-words';

/**
 * What the Open GitHub repository field takes (M4 synthesis § 5.5): `owner/repo` and `owner/repo@ref`, and a
 * github.com link to the repository, a tree, a file (`blob`) or a commit; the ref a link names is its first segment
 * after `tree/` or `blob/` (a branch with a `/` in its name reads as its first part; WG3's ref picker names it
 * whole). A pull request's link, and a link to another host, say why they do not open here.
 */
export type Parsed =
  | { ok: true; target: RepoTarget }
  /** No message: nothing to say yet (empty, or typed halfway). */
  | { ok: false; message?: string };

const PULL = 'simulci opens a pull request in a later version: open its repository at the branch for now.';
const GHES = 'GitHub Enterprise Server needs a self-hosted simulci.';

export function parseRepoInput(input: string): Parsed {
  const text = input.trim();
  if (text === '') return { ok: false };
  const named = parseTargetText(text);
  if (named) return { ok: true, target: named };
  const url = urlOf(text);
  if (!url) return { ok: false };
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return { ok: false, message: GHES };
  return fromPath(url.pathname.split('/').filter(Boolean).map(decodeURIComponent));
}

/** A link, with or without its scheme; nothing for what is not one. */
function urlOf(text: string): URL | undefined {
  if (!/^(?:https?:\/\/)?[\w.-]+\.[a-z]{2,}(?::\d+)?\//i.test(text)) return undefined;
  try {
    return new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return undefined;
  }
}

/** The target a github.com path names: `/owner/repo[.git]`, then `tree|blob/<ref>/…`, `commit/<sha>`, `pull/<n>`. */
function fromPath([owner = '', name = '', kind, ref]: string[]): Parsed {
  const repo = name.replace(/\.git$/, '');
  if (!isRepoName(owner, repo)) return { ok: false };
  if (kind === undefined) return { ok: true, target: { owner, repo } };
  if (kind === 'pull' || kind === 'pulls') return { ok: false, message: PULL };
  if ((kind === 'tree' || kind === 'blob' || kind === 'commit') && ref)
    return { ok: true, target: { owner, repo, ref } };
  return { ok: true, target: { owner, repo } };
}
