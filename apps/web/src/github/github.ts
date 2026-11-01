/**
 * The `github-*` chunk's door (M4 synthesis § 5.5, § 5.11), named so the build names the chunk after it: what the page
 * reaches of the GitHub source, through `github/load.ts` alone.
 */
export { fetchAgain, readRepository } from './read';
export type { ReadOptions, RepoRead } from './read';
export type { RepoTarget } from './repo';
export { OpenRepo } from './OpenRepo';
export { readRemotes } from './remotes';
