import { isRepoName, parseTargetText, type RepoTarget } from '../lib/repo-words';

/**
 * What the Open GitHub repository field takes (M4 synthesis § 5.5): `owner/repo` and `owner/repo@ref`, and a
 * github.com link to the repository, a tree, a file (`blob`) or a commit. The ref a link names is its first segment
 * after `tree/` or `blob/`; the segments from there on are kept too, since a branch may have a `/` in its name, and
 * Open resolves them whole against the branches and tags (`refs.ts` `wholeRef`). A pull request's link, and a link to
 * another host, say why they do not open here.
 */
export type Parsed =
  /** `segments`: a `tree/` or `blob/` link's path from its ref on, when it goes past the ref. */
  | { ok: true; target: RepoTarget; segments?: string[] }
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
  const segments = url.pathname.split('/').filter(Boolean).map(decoded);
  return segments.includes(undefined) ? { ok: false } : fromPath(segments as string[]);
}

/** A path segment decoded; nothing for a malformed escape (`%zz`), which `decodeURIComponent` throws on. */
function decoded(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
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
function fromPath([owner = '', name = '', kind, ref, ...rest]: string[]): Parsed {
  const repo = name.replace(/\.git$/, '');
  if (!isRepoName(owner, repo)) return { ok: false };
  if (kind === 'pull' || kind === 'pulls') return { ok: false, message: PULL };
  return { ok: true, ...atRef({ owner, repo }, kind, ref, rest) };
}

/** A link's ref: a commit's SHA, a tree's or a file's first segment with the path from it on; else none. */
function atRef(
  target: RepoTarget,
  kind: string | undefined,
  ref: string | undefined,
  rest: string[],
): { target: RepoTarget; segments?: string[] } {
  if (!ref) return { target };
  if (kind === 'commit') return { target: { ...target, ref } };
  if (kind !== 'tree' && kind !== 'blob') return { target };
  return { target: { ...target, ref }, ...(rest.length ? { segments: [ref, ...rest] } : {}) };
}
