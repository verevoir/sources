// @verevoir/sources — contract module
//
// A `SourceAdapter` is a thin client over a remote file source. Today
// only the GitHub adapter ships (`@verevoir/sources/github`); GitLab,
// Bitbucket, S3, plain-git, zip implementations follow under the same
// contract.
//
// Adapters expose individual functions taking `(env, ...args)` rather
// than a class. The env carries the auth token + the org we fork into
// on permissions failure. Subpaths are imported on demand so consumers
// only pay for the implementations they use.
//
// Read-only sources implement the read half (readFile, listFiles,
// getRepoTree, getDefaultBranch) and skip the write half. Write-capable
// sources implement everything.

/** Auth + config shared across calls to a source adapter. */
export interface SourceEnv {
  /** Bearer token. Per-adapter semantics: GitHub PAT / GH App
   * installation token; GitLab PAT; etc. */
  token: string;
  /** Org or namespace the adapter forks into on permissions failure
   * during a write. Not all sources need it (read-only adapters
   * ignore). */
  forkOrg: string;
}

export class SourceApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly detail?: string
  ) {
    super(message);
    this.name = 'SourceApiError';
  }
}

/** A single read-file response: text content + the source's content
 * identifier (sha for git-based sources; etag/version for object
 * stores). The identifier is opaque to callers and used by update
 * paths that need a "prior version" handle. */
export interface ReadFileResult {
  content: string;
  sha: string;
}

/** Directory listing entry. */
export interface DirEntry {
  name: string;
  type: 'file' | 'dir' | 'submodule' | 'symlink';
  path: string;
  sha: string;
}

/** Tree entry — `type` is git-flavoured (blob = file, tree = dir).
 * Read-only sources may emit only blob entries. */
export interface TreeEntry {
  path: string;
  type: 'blob' | 'tree';
  /** Byte size — only present for blobs. */
  size?: number;
  sha: string;
}

export interface RepoTree {
  entries: TreeEntry[];
  /** Indicates the tree response exceeded the source's per-call cap
   * and was truncated. Callers wanting completeness fall back to
   * per-directory `listFiles` calls. */
  truncated: boolean;
}

/** The full SourceAdapter contract. An adapter is the set of these
 * functions for a single source kind. Each subpath export
 * (`@verevoir/sources/github`, etc.) re-exports a matching set. */
export interface SourceAdapter {
  readFile(env: SourceEnv, repoUrl: string, path: string, ref?: string): Promise<ReadFileResult>;
  listFiles(env: SourceEnv, repoUrl: string, prefix: string, ref?: string): Promise<DirEntry[]>;
  getRepoTree(env: SourceEnv, repoUrl: string, ref?: string): Promise<RepoTree>;
  writeFile(
    env: SourceEnv,
    repoUrl: string,
    path: string,
    content: string,
    branch: string,
    commitMessage: string
  ): Promise<void>;
  ensureBranch(env: SourceEnv, repoUrl: string, branch: string): Promise<void>;
  ensureFork(env: SourceEnv, upstreamUrl: string): Promise<string>;
  openPullRequest(
    env: SourceEnv,
    targetUrl: string,
    head: string,
    base: string,
    title: string,
    body: string
  ): Promise<string>;
  getDefaultBranch(env: SourceEnv, repoUrl: string): Promise<string>;
}

/** Build a `SourceEnv` from process environment variables.
 * Returns null when `GITHUB_TOKEN` is unset — callers handle that
 * explicitly. Naming intentionally references GitHub-shaped env vars
 * for back-compat; non-GitHub adapters expect callers to construct
 * the env themselves. */
export function envFromProcessEnv(
  options: { tokenVar?: string; forkOrgVar?: string; defaultForkOrg?: string } = {}
): SourceEnv | null {
  const tokenVar = options.tokenVar ?? 'GITHUB_TOKEN';
  const forkOrgVar = options.forkOrgVar ?? 'SOURCE_FORK_ORG';
  const defaultForkOrg = options.defaultForkOrg ?? 'verevoir';
  const token = process.env[tokenVar] ?? '';
  if (!token) return null;
  return { token, forkOrg: process.env[forkOrgVar] ?? defaultForkOrg };
}
