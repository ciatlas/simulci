import { isRepoName, parseTargetText, type RepoTarget } from '../lib/repo-words';

/**
 * What the Open GitHub repository field takes (M4 synthesis § 5.5): `owner/repo`, `owner/repo@ref` and
 * `owner/repo#42`, and a github.com link to the repository, a tree, a file (`blob`), a commit or a pull request. The
 * ref a link names is its first segment after `tree/` or `blob/`; the segments from there on are kept too, since a
 * branch may have a `/` in its name, and Open resolves them whole against the branches and tags (`refs.ts`
 * `wholeRef`). A pull request opens at its head commit (§ 5.8). A link to another host says why it does not open here.
 */
export type Parsed =
  /**
   * `segments`: a `tree/` or `blob/` link's path from its ref on, when it goes past the ref. `pull`: the pull request a
   * `pull/<n>` link names; its target has no ref.
   */
  | { ok: true; target: RepoTarget; segments?: string[]; pull?: number }
  /** No message: nothing to say yet (empty, or typed halfway). */
  | { ok: false; message?: string };

const GHES = 'GitHub Enterprise Server needs a self-hosted simulci.';

export function parseRepoInput(input: string): Parsed {
  const text = input.trim();
  if (text === '') return { ok: false };
  const named = parseTargetText(text);
  if (named) return { ok: true, target: named };
  const pull = /^([^/@#\s]+)\/([^/@#\s]+)#(\d+)$/.exec(text);
  if (pull && isRepoName(pull[1]!, pull[2]!)) return pullTarget({ owner: pull[1]!, repo: pull[2]! }, pull[3]);
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
  if (kind === 'pull' || kind === 'pulls') return pullTarget({ owner, repo }, ref);
  return { ok: true, ...atRef({ owner, repo }, kind, ref, rest) };
}

/** A pull request's link: `pull/<n>`, and any of its tabs (`/files`, `/commits`). */
function pullTarget(target: RepoTarget, number: string | undefined): Parsed {
  if (!number || !/^[1-9]\d{0,9}$/.test(number)) return { ok: false };
  return { ok: true, target, pull: Number(number) };
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
