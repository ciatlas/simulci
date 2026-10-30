import { lazy } from 'react';
import { readHostConfig } from '../app/config';
import { fetchOnce } from '../lib/lazy';

/**
 * The GitHub source's chunk (`github/github.ts`, `github-*`, M4 synthesis § 5.11), fetched the first time a repository
 * is opened or fetched again. The page holds this loader and nothing else of it; the chunk's own requests go to
 * GitHub's API, which the CSP's `connect-src` allows.
 */
export const loadGitHub = fetchOnce(() => import('./github'));

export type GitHubChunk = Awaited<ReturnType<typeof loadGitHub>>;

/** The Open GitHub repository dialog, from the chunk. */
export const OpenRepoDialog = lazy(() => loadGitHub().then((m) => ({ default: m.OpenRepo })));

/**
 * Whether the page offers the GitHub source: on github.com only, until a server signs in (WS). A static host reading a
 * GitHub Enterprise Server allows no request (`connect-src 'none'`, M4 synthesis § 4.5); folders and pastes still work.
 */
export const offersGitHub = (config = readHostConfig()): boolean => config.githubUrl === 'https://github.com';
