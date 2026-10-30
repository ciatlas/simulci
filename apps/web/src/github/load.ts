import { fetchOnce } from '../lib/lazy';

/**
 * The GitHub source's chunk (`github/github.ts`, `github-*`, M4 synthesis § 5.11), fetched the first time a repository
 * is opened or fetched again. The page holds this loader and nothing else of it; the chunk's own requests go to
 * GitHub's API, which the CSP's `connect-src` allows.
 */
export const loadGitHub = fetchOnce(() => import('./github'));

export type GitHubChunk = Awaited<ReturnType<typeof loadGitHub>>;
