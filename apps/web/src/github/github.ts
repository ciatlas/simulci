import { apiHost } from '@ciatlas/core/remote-fetch';
import type { Walked } from '../input/limits';
import { readHostConfig } from '../app/config';
import type { GitHubSource } from '../state/store';
import { type GitHubCache, openGitHubCache } from './cache';
import { createRepoClient, failureSentence, rateSentence, type RepoClient } from './client';
import { commitOf, readAt, repoInfo, type RepoInfo, type RepoTarget } from './repo';

/**
 * The `github-*` chunk's door (M4 synthesis § 5.5, § 5.11), named so the build names the chunk after it: what the
 * page's sources (`input/sources.ts`) call, through `github/load.ts`, to open a public repository or fetch it again. Every request leaves from here, from the page, never from
 * a worker, and only to the host's anonymous API (`/config.js`'s `apiUrl`, github.com's by default).
 */

export type { RepoTarget } from './repo';

export interface ReadOptions {
  signal?: AbortSignal;
  /** Files read so far of the files to read. */
  onProgress?: (done: number, total: number) => void;
}

/** A repository read: the source it is, its files as a walk gives them, and what it cost. */
export interface RepoRead {
  source: GitHubSource;
  walked: Walked;
  requests: number;
  /** "41 of 60 requests left this hour", once GitHub said so. */
  rate?: string;
}

/** Why a read failed, in the page's words, with what it cost. */
export class ReadFailure extends Error {
  constructor(
    message: string,
    readonly requests: number,
  ) {
    super(message);
  }
}

let cache: GitHubCache | undefined;

function contextOf(options: ReadOptions): { client: RepoClient; host: string; cache: GitHubCache } {
  const { apiUrl } = readHostConfig();
  cache ??= openGitHubCache();
  return {
    client: createRepoClient({ apiUrl, ...(options.signal ? { signal: options.signal } : {}) }),
    host: apiHost(apiUrl),
    cache,
  };
}

/** `work`, its failures said in the page's words; a cancelled read rejects with the signal's reason. */
async function reading<T>(client: RepoClient, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (signal?.aborted) throw signal.reason;
    throw new ReadFailure(failureSentence(e, client.api.rateLimit()), client.requests());
  }
}

const sourceOf = (info: RepoInfo, host: string, ref: string, sha: string): GitHubSource => ({
  kind: 'github',
  host,
  owner: info.owner,
  repo: info.repo,
  ref,
  sha,
  defaultBranch: info.defaultBranch,
  private: info.private,
  readAt: Date.now(),
});

/** The repository, a ref of it (its default branch when none is named), and its files at that ref's commit. */
export async function readRepository(target: RepoTarget, options: ReadOptions = {}): Promise<RepoRead> {
  const { client, host, cache: c } = contextOf(options);
  return reading(
    client,
    async () => {
      const info = await repoInfo(client, target);
      const ref = target.ref ?? info.defaultBranch;
      const sha = await commitOf(client, info, ref);
      const walked = await readAt({ client, cache: c, host, ...pick(options) }, info, sha);
      return { source: sourceOf(info, host, ref, sha), walked, requests: client.requests(), ...rate(client) };
    },
    options.signal,
  );
}

/** The source's ref again: nothing more when it has not moved (one request), else its files at the new commit. */
export async function fetchAgain(
  source: GitHubSource,
  options: ReadOptions = {},
): Promise<{ moved: false; requests: number } | ({ moved: true } & RepoRead)> {
  const { client, host, cache: c } = contextOf(options);
  return reading(
    client,
    async () => {
      const info: RepoInfo = {
        owner: source.owner,
        repo: source.repo,
        defaultBranch: source.defaultBranch,
        private: source.private,
      };
      const sha = await commitOf(client, info, source.ref);
      if (sha === source.sha) return { moved: false as const, requests: client.requests() };
      const walked = await readAt({ client, cache: c, host, ...pick(options) }, info, sha);
      const next = {
        ...sourceOf(info, host, source.ref, sha),
        ...(source.pull === undefined ? {} : { pull: source.pull }),
      };
      return { moved: true as const, source: next, walked, requests: client.requests(), ...rate(client) };
    },
    options.signal,
  );
}

const pick = (options: ReadOptions) => (options.onProgress ? { onProgress: options.onProgress } : {});

const rate = (client: RepoClient): { rate?: string } => {
  const sentence = rateSentence(client.api.rateLimit());
  return sentence === undefined ? {} : { rate: sentence };
};
