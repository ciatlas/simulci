import { isProjectFile, isReadFile } from '../input/filter';
import { LIMITS, type Skipped, type Walked } from '../input/limits';
import { decodeExact } from '../input/read';
import type { RepoTarget } from '../lib/repo-words';
import { type GitHubCache, objectKey } from './cache';
import type { RepoClient } from './client';

/**
 * A public repository's workflow files, read at a commit through GitHub's REST API (M4 synthesis § 5.5): the
 * repository (its default branch, whether it is private), the ref's commit, the root tree (not recursive: a monorepo's
 * size does not matter), the `.github` tree recursively, then each file the page keeps that the cache does not hold,
 * eight at a time. The filter and the limits run on the trees, before any file is read. Cold, that is 4 + N requests;
 * with the trees and files cached, 2. What was read from a repository seen public is kept in the cache.
 */

export type { RepoTarget } from '../lib/repo-words';

/** What `GET /repos/{owner}/{repo}` says of a repository, its names as GitHub spells them. */
export interface RepoInfo {
  owner: string;
  repo: string;
  defaultBranch: string;
  private: boolean;
}

/** What reading a repository at a commit needs. */
export interface ReadContext {
  client: RepoClient;
  cache: GitHubCache;
  /** The GitHub host the API serves, for the cache's keys. */
  host: string;
  /** Files read so far of the files to read, as each one comes. */
  onProgress?: (done: number, total: number) => void;
}

interface RepoBody {
  name: string;
  full_name: string;
  owner: { login: string };
  default_branch: string;
  /** Taken as private unless GitHub says `false`. */
  private?: boolean;
}

interface TreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

interface TreeBody {
  sha: string;
  truncated: boolean;
  tree: TreeEntry[];
}

/** A file of the repository to read: its path, its blob, its size as the tree says it. */
interface Wanted {
  path: string;
  sha: string;
  size: number;
}

const repoPath = (owner: string, repo: string): string =>
  `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

/** The repository, or an error that says it is not one simulci can read. */
export async function repoInfo(client: RepoClient, { owner, repo }: RepoTarget): Promise<RepoInfo> {
  const found = await client.api.json<RepoBody>(repoPath(owner, repo));
  if (!found) throw new Error(`${owner}/${repo} is not a public repository on GitHub`);
  const body = found.body;
  return {
    owner: body.owner.login,
    repo: body.name,
    defaultBranch: body.default_branch,
    private: body.private !== false,
  };
}

/** The commit a ref points at now, lower-case. */
export async function commitOf(client: RepoClient, info: RepoInfo, ref: string): Promise<string> {
  const path = `${repoPath(info.owner, info.repo)}/commits/${encodeURIComponent(ref)}`;
  const bytes = await client.api.bytes(path, 'application/vnd.github.sha');
  const sha = bytes && new TextDecoder().decode(bytes).trim();
  if (!sha || !/^[0-9a-f]{40}$/i.test(sha))
    throw new Error(`${info.owner}/${info.repo} has no branch, tag or commit named ${ref}`);
  return sha.toLowerCase();
}

/** The files the page reads at a commit, by path (snapshots among them), what reading found, and what it left out. */
export async function readAt(ctx: ReadContext, info: RepoInfo, sha: string): Promise<Walked> {
  const at = `${info.owner}/${info.repo} at ${sha.slice(0, 7)}`;
  const { wanted, skipped } = await filesOf(ctx, info, sha, at);
  const walked: Walked = { files: {}, meta: {}, skipped };
  // Nothing to simulate: the source says so without reading a file.
  if (!wanted.some((w) => isProjectFile(w.path))) return walked;
  refuseOver(wanted, at);
  let done = 0;
  ctx.onProgress?.(0, wanted.length);
  await inPool(wanted, 8, async (w) => {
    const { text, meta } = decodeExact(await blobOf(ctx, info, w, at));
    walked.files[w.path] = text;
    walked.meta[w.path] = meta;
    ctx.onProgress?.(++done, wanted.length);
  });
  return walked;
}

/** The files the trees list that the page reads: a root `action.yml`, and what `.github` holds. */
async function filesOf(
  ctx: ReadContext,
  info: RepoInfo,
  sha: string,
  at: string,
): Promise<{ wanted: Wanted[]; skipped: Skipped[] }> {
  const wanted: Wanted[] = [];
  const skipped: Skipped[] = [];
  for (const e of await blobsOf(ctx, info, sha, at)) {
    // A symbolic link's blob is the path it points at, which a folder walk never reads either.
    if (e.mode === '120000' || !isReadFile(e.path)) continue;
    const size = e.size ?? 0;
    if (size > LIMITS.fileBytes) skipped.push({ path: e.path, bytes: size });
    else wanted.push({ path: e.path, sha: e.sha, size });
  }
  return { wanted: wanted.sort((a, b) => a.path.localeCompare(b.path)), skipped };
}

/** Every file of the root tree, and of `.github` at any depth, by its path in the repository. */
async function blobsOf(ctx: ReadContext, info: RepoInfo, sha: string, at: string): Promise<TreeEntry[]> {
  const root = await treeOf(ctx, info, sha, false, at);
  const entries = root.tree.filter((e) => e.type === 'blob');
  const github = root.tree.find((e) => e.path === '.github' && e.type === 'tree');
  if (!github) return entries;
  const tree = await treeOf(ctx, info, github.sha, true, at);
  if (tree.truncated)
    throw new Error("This repository's .github directory is too large to read (GitHub truncated its tree).");
  for (const e of tree.tree) if (e.type === 'blob') entries.push({ ...e, path: `.github/${e.path}` });
  return entries;
}

/** The limits of a source, judged by the sizes the tree gives, before a request is spent on a file. */
function refuseOver(wanted: readonly Wanted[], at: string): void {
  if (wanted.length > LIMITS.files)
    throw new Error(`${at} is too big: ${wanted.length} files; the page takes at most ${LIMITS.files}`);
  const total = wanted.reduce((n, w) => n + w.size, 0);
  if (total > LIMITS.totalBytes)
    throw new Error(`${at} is too big: its files are over ${LIMITS.totalBytes / 1024 / 1024} MB in all`);
}

/** A tree, from the cache or from GitHub (then kept, when the repository is public). */
async function treeOf(
  ctx: ReadContext,
  info: RepoInfo,
  sha: string,
  recursive: boolean,
  at: string,
): Promise<TreeBody> {
  const key = objectKey(ctx.host, recursive ? 'tree-r' : 'tree', sha);
  const cached = await ctx.cache.get(key);
  if (cached) {
    const tree = parseTree(cached);
    if (tree) return tree;
  }
  const path = `${repoPath(info.owner, info.repo)}/git/trees/${sha}${recursive ? '?recursive=1' : ''}`;
  const bytes = await ctx.client.api.bytes(path, 'application/vnd.github+json');
  const tree = bytes && parseTree(bytes);
  if (!tree) throw new Error(`GitHub did not give the files of ${at}`);
  if (!tree.truncated) await ctx.cache.set(key, bytes, !info.private);
  return tree;
}

function parseTree(bytes: Uint8Array): TreeBody | undefined {
  try {
    const tree = JSON.parse(new TextDecoder().decode(bytes)) as TreeBody;
    return Array.isArray(tree.tree) ? tree : undefined;
  } catch {
    return undefined;
  }
}

/** A file's bytes, from the cache or from GitHub as served (then kept, when the repository is public). */
async function blobOf(ctx: ReadContext, info: RepoInfo, w: Wanted, at: string): Promise<Uint8Array> {
  const key = objectKey(ctx.host, 'blob', w.sha);
  const cached = await ctx.cache.get(key);
  if (cached) return cached;
  const path = `${repoPath(info.owner, info.repo)}/git/blobs/${w.sha}`;
  const bytes = await ctx.client.api.bytes(path, 'application/vnd.github.raw+json');
  if (!bytes) throw new Error(`GitHub did not give ${w.path} of ${at}`);
  await ctx.cache.set(key, bytes, !info.private);
  return bytes;
}

/** `work` over every item, `size` at a time; the first failure stops what has not started and is thrown. */
async function inPool<T>(items: readonly T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  const lane = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const item = items[next++]!;
      try {
        await work(item);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, lane));
}
