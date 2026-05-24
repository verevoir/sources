// @verevoir/sources/github — GitHub adapter
//
// Implements the SourceAdapter contract over GitHub's REST + Git Data
// APIs using native fetch. No SDK dependency — fetch is enough for
// what we do (reads, single-file writes via the Contents API, branch
// + fork primitives, PR opens).
//
// Auth: every call needs an env with a bearer token (GitHub PAT or
// App-installation token). Permissions required for full coverage:
// contents read+write, workflows (if touching .github/workflows/*),
// pull-requests write. Read-only callers can skip the write permissions.
//
// What this is NOT: a general-purpose Octokit replacement. Functions
// here cover the SourceAdapter shape (read, list, tree, write, branch,
// fork, PR open).

import {
  SourceApiError,
  type SourceEnv,
  type ReadFileResult,
  type DirEntry,
  type RepoTree,
  type TreeEntry,
} from '../index.js';

const GH_API = 'https://api.github.com';
const GH_API_VERSION = '2022-11-28';

interface RepoCoords {
  owner: string;
  repo: string;
}

/** Parses a GitHub repo identifier into owner + repo. Accepts:
 * - `https://github.com/<owner>/<repo>` (with or without `.git` / trailing slash)
 * - `git@github.com:<owner>/<repo>`
 * - `<owner>/<repo>` shorthand. */
export function parseGithubRepoUrl(input: string): RepoCoords | null {
  const trimmed = input
    .trim()
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
  const httpsMatch = trimmed.match(/^https?:\/\/github\.com\/([^/?#]+)\/([^/?#]+)/i);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }
  const plainMatch = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (plainMatch) {
    return { owner: plainMatch[1], repo: plainMatch[2] };
  }
  return null;
}

function coords(url: string): RepoCoords {
  const c = parseGithubRepoUrl(url);
  if (!c) {
    throw new SourceApiError(`Cannot parse GitHub repo URL: ${url}`);
  }
  return c;
}

/** Internal: one place for headers + error mapping. */
async function ghCall<T>(
  env: SourceEnv,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: Record<string, unknown>
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': GH_API_VERSION,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${GH_API}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) {
    throw new SourceApiError('not_found', 404);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new SourceApiError(`${method} ${path}: ${res.status}`, res.status, detail.slice(0, 300));
  }
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

/** GET /repos/{owner}/{repo} → default_branch. Used by writes that
 * need to branch off the upstream default when the objective branch
 * doesn't exist yet, and by `openPullRequest` for the PR's base. */
export async function getDefaultBranch(env: SourceEnv, repoUrl: string): Promise<string> {
  const { owner, repo } = coords(repoUrl);
  const data = await ghCall<{ default_branch?: string }>(env, 'GET', `/repos/${owner}/${repo}`);
  return data.default_branch ?? 'main';
}

/** GET /repos/{owner}/{repo}/contents/{path}?ref={branch}.
 * Returns the file's UTF-8 content + sha. Throws `SourceApiError`
 * with status=404 when the file or branch doesn't exist; the caller
 * can fall back (e.g. to the default branch) on that signal. */
export async function readFile(
  env: SourceEnv,
  repoUrl: string,
  path: string,
  ref?: string
): Promise<ReadFileResult> {
  const { owner, repo } = coords(repoUrl);
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const data = await ghCall<{
    type?: string;
    content?: string;
    sha?: string;
  }>(env, 'GET', `/repos/${owner}/${repo}/contents/${path}${query}`);
  if (Array.isArray(data)) {
    throw new SourceApiError(`${path} is a directory, not a file`);
  }
  if (data.type !== 'file') {
    throw new SourceApiError(`${path} is type=${data.type}, not a file`);
  }
  const content = Buffer.from(data.content ?? '', 'base64').toString('utf8');
  return { content, sha: data.sha ?? '' };
}

/** GET /repos/{owner}/{repo}/contents/{prefix}?ref={branch}.
 * Returns the directory's entries. Throws when `prefix` resolves to
 * a file. */
export async function listFiles(
  env: SourceEnv,
  repoUrl: string,
  prefix: string,
  ref?: string
): Promise<DirEntry[]> {
  const { owner, repo } = coords(repoUrl);
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const data = await ghCall<unknown>(
    env,
    'GET',
    `/repos/${owner}/${repo}/contents/${prefix}${query}`
  );
  if (!Array.isArray(data)) {
    throw new SourceApiError(`${prefix} is not a directory`);
  }
  return (data as Array<Record<string, unknown>>).map((e) => ({
    name: e.name as string,
    type: (e.type as DirEntry['type']) ?? 'file',
    path: e.path as string,
    sha: e.sha as string,
  }));
}

/** Fetches the whole repo tree at `ref` (default branch when
 * omitted) in one shot. Two API calls under the hood: branch →
 * tree SHA, then `git/trees/{sha}?recursive=1`. */
export async function getRepoTree(
  env: SourceEnv,
  repoUrl: string,
  ref?: string
): Promise<RepoTree> {
  const { owner, repo } = coords(repoUrl);
  const branch = ref ?? (await getDefaultBranch(env, repoUrl));
  const branchData = await ghCall<{
    commit?: { commit?: { tree?: { sha?: string } } };
  }>(env, 'GET', `/repos/${owner}/${repo}/branches/${branch}`);
  const treeSha = branchData.commit?.commit?.tree?.sha;
  if (!treeSha) {
    throw new SourceApiError(`Could not resolve tree SHA for ${owner}/${repo}@${branch}`);
  }
  const tree = await ghCall<{
    tree?: Array<{ path?: string; type?: string; size?: number; sha?: string }>;
    truncated?: boolean;
  }>(env, 'GET', `/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`);
  const entries: TreeEntry[] = [];
  for (const e of tree.tree ?? []) {
    if (!e.path || !e.sha) continue;
    if (e.type !== 'blob' && e.type !== 'tree') continue;
    entries.push({
      path: e.path,
      type: e.type,
      size: e.size,
      sha: e.sha,
    });
  }
  return { entries, truncated: tree.truncated ?? false };
}

/** Returns true when the cached `version` (blob sha) is still the
 * current blob sha for `(path, ref)`; false when GitHub has moved
 * on (different sha) or the path no longer resolves (404). v0 does
 * the cheap thing operationally — one Contents API GET, sha compare
 * — wasting the base64 content download. Cheaper protocol variants
 * (ETag `If-None-Match`, `Accept: application/vnd.github.object`,
 * tree walks) can replace this when profiling shows it matters. */
export async function isFresh(
  env: SourceEnv,
  repoUrl: string,
  path: string,
  version: string,
  ref?: string
): Promise<boolean> {
  try {
    const current = await readFile(env, repoUrl, path, ref);
    return current.sha === version;
  } catch (err) {
    if (err instanceof SourceApiError && err.status === 404) return false;
    throw err;
  }
}

/** Ensure the named branch exists on the repo. No-op if already
 * present; otherwise creates the branch off the repo's default
 * branch's tip. */
export async function ensureBranch(env: SourceEnv, repoUrl: string, branch: string): Promise<void> {
  const { owner, repo } = coords(repoUrl);
  try {
    await ghCall(env, 'GET', `/repos/${owner}/${repo}/git/refs/heads/${branch}`);
    return;
  } catch (err) {
    if (!(err instanceof SourceApiError) || err.status !== 404) throw err;
  }
  const defaultBranch = await getDefaultBranch(env, repoUrl);
  const defaultRef = await ghCall<{ object?: { sha?: string } }>(
    env,
    'GET',
    `/repos/${owner}/${repo}/git/refs/heads/${defaultBranch}`
  );
  const sha = defaultRef.object?.sha;
  if (!sha) {
    throw new SourceApiError(
      `Could not resolve default-branch SHA for ${owner}/${repo}@${defaultBranch}`
    );
  }
  await ghCall(env, 'POST', `/repos/${owner}/${repo}/git/refs`, {
    ref: `refs/heads/${branch}`,
    sha,
  });
}

/** PUT /repos/{owner}/{repo}/contents/{path} — creates or updates
 * a single file on the named branch, committing in the process.
 * If the file already exists on the branch, the previous blob sha
 * is fetched first and included so GitHub treats this as an update
 * rather than rejecting with 422. */
export async function writeFile(
  env: SourceEnv,
  repoUrl: string,
  path: string,
  content: string,
  branch: string,
  commitMessage: string
): Promise<void> {
  const { owner, repo } = coords(repoUrl);
  await ensureBranch(env, repoUrl, branch);
  let priorSha: string | undefined;
  try {
    const existing = await readFile(env, repoUrl, path, branch);
    priorSha = existing.sha;
  } catch (err) {
    if (!(err instanceof SourceApiError) || err.status !== 404) throw err;
  }
  await ghCall(env, 'PUT', `/repos/${owner}/${repo}/contents/${path}`, {
    message: commitMessage,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch,
    ...(priorSha ? { sha: priorSha } : {}),
  });
}

/** POST /repos/{owner}/{repo}/forks. Returns the fork's clone URL.
 * Idempotent — GitHub returns the existing fork's URL if one is
 * already present in `env.forkOrg`. */
export async function ensureFork(env: SourceEnv, upstreamUrl: string): Promise<string> {
  const { owner, repo } = coords(upstreamUrl);
  const data = await ghCall<{ clone_url?: string; html_url?: string }>(
    env,
    'POST',
    `/repos/${owner}/${repo}/forks`,
    { organization: env.forkOrg }
  );
  const url = data.clone_url ?? data.html_url;
  if (!url) {
    throw new SourceApiError(`Fork response missing clone_url/html_url for ${owner}/${repo}`);
  }
  return url;
}

/** POST /repos/{owner}/{repo}/pulls. `head` is `<owner>:<branch>`
 * when the branch lives on a fork, just `<branch>` when same-repo.
 * Returns the PR's html_url. */
export async function openPullRequest(
  env: SourceEnv,
  targetUrl: string,
  head: string,
  base: string,
  title: string,
  body: string
): Promise<string> {
  const { owner, repo } = coords(targetUrl);
  const data = await ghCall<{ html_url?: string }>(env, 'POST', `/repos/${owner}/${repo}/pulls`, {
    title,
    body,
    head,
    base,
  });
  if (!data.html_url) {
    throw new SourceApiError(`PR-create response missing html_url`);
  }
  return data.html_url;
}

/** Aggregate export matching the `SourceAdapter` contract from the
 * root package. Lets a caller pass `github` to code that accepts a
 * generic adapter. */
export const github = {
  readFile,
  listFiles,
  getRepoTree,
  isFresh,
  writeFile,
  ensureBranch,
  ensureFork,
  openPullRequest,
  getDefaultBranch,
};
