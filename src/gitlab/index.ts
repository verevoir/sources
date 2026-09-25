// @verevoir/sources/gitlab — GitLab adapter
//
// Implements the SourceAdapter contract over GitLab's REST v4 API using
// native fetch. No SDK dependency — the same shape as the GitHub adapter:
// one place for headers + error mapping, reads, atomic multi-file commits
// via the commits API, branch + fork primitives, merge-request opens.
//
// Hosts: gitlab.com, plus exactly the hosts an operator lists in `GITLAB_HOSTS`
// (comma-separated) for self-hosted instances. There is deliberately no
// "looks like GitLab" heuristic: the API base is derived from the repo URL's own
// origin, so any host that routes here is a host the token is sent to — a
// `gitlab.*` pattern would hand GITLAB_TOKEN to `gitlab.com.evil.io` on a
// prompt-injected URL. HTTPS only, for the same reason. The adapter enforces
// this itself — a URL off the list is refused before any request — so a caller
// that skips `isGitlabUrl` cannot leak the token either.
//
// Auth: `env.token` is a GitLab PAT / project / group access token, sent as
// `Authorization: Bearer` (which fetch strips on a cross-origin redirect — a
// custom `PRIVATE-TOKEN` header would be forwarded). Every request, including
// pagination links, is pinned to the repo URL's origin. Scopes: `read_api` for
// reads; `api` for writes, forks and merge requests. An empty token is allowed —
// public projects read anonymously — and a refusal then names GITLAB_TOKEN. One
// GITLAB_TOKEN serves every routed host, so a process whose projects span
// instances sends each the same token; give such projects separate configs.

import {
  SourceApiError,
  type SourceAdapter,
  type SourceEnv,
  type ReadFileResult,
  type DirEntry,
  type TreeEntry,
  type RepoTree,
} from '../index.js';

/** Page cap for a recursive tree walk (100 entries/page). Past it the tree is
 * returned with `truncated: true`, as GitHub's tree API does at its own cap. */
const MAX_TREE_PAGES = 500;
/** Wall-clock budget for one tree walk; past it the walk stops `truncated`
 * rather than paging (and rate-limit waiting) indefinitely. */
const TREE_WALK_BUDGET_MS = 120_000;
/** Per-request ceiling, so a hung connection cannot stall a tool call. */
const REQUEST_TIMEOUT_MS = 30_000;
/** How long `ensureFork` waits for GitLab's asynchronous fork import. */
const FORK_READY_TIMEOUT_MS = 60_000;
const FORK_POLL_INTERVAL_MS = 1_000;
/** 429 handling: retries, and the ceiling on any one wait. */
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_MAX_WAIT_MS = 30_000;
/** Concurrent existence probes in `commitFiles` (matches the warm default). */
const PROBE_CONCURRENCY = 8;
/** How long a project's default branch is remembered. Reads without a ref
 * (every file of a grep / find_symbol warm) would otherwise double their API
 * calls on the lookup, which matters against GitLab's rate limits. */
const DEFAULT_BRANCH_TTL_MS = 60_000;

/** Hosts routed to GitLab: gitlab.com plus `GITLAB_HOSTS`, comma-separated
 * hostnames (e.g. `gitlab.example.com,code.client.io`). */
function gitlabHosts(): string[] {
  const extra = (process.env.GITLAB_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return ['gitlab.com', 'www.gitlab.com', ...extra];
}

/** True when `url` is an https URL on gitlab.com or a host in `GITLAB_HOSTS`. */
export function isGitlabUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && gitlabHosts().includes(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Parses a GitLab project URL into its API base and full project path.
 * Accepts nested groups (`https://gitlab.com/group/sub/project`), a `.git`
 * suffix, a trailing slash, and a `/-/…` UI suffix (`/-/tree/main`). Legacy UI
 * paths without the `/-/` separator are indistinguishable from nested groups
 * and are not stripped — pass the project URL itself. */
export function parseGitlabProjectUrl(input: string): { apiBase: string; projectPath: string } {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new SourceApiError(`Cannot parse GitLab project URL: ${input}`);
  }
  const projectPath = u.pathname
    .split('/-/')[0]
    .replace(/\.git$/, '')
    .replace(/^\/+|\/+$/g, '');
  if (!projectPath.includes('/')) {
    throw new SourceApiError(
      `Cannot parse GitLab project URL (need <namespace>/<project>): ${input}`
    );
  }
  const host = u.hostname.toLowerCase() === 'www.gitlab.com' ? 'gitlab.com' : u.host;
  return { apiBase: `${u.protocol}//${host}/api/v4`, projectPath };
}

function project(url: string): { apiBase: string; projectPath: string; id: string } {
  if (!isGitlabUrl(url)) {
    throw new SourceApiError(
      `Not a GitLab URL this adapter will send credentials to: ${url} — ` +
        'https on gitlab.com or a host listed in GITLAB_HOSTS'
    );
  }
  const p = parseGitlabProjectUrl(url);
  return { ...p, id: encodeURIComponent(p.projectPath) };
}

/** Milliseconds to wait before retrying a 429: `Retry-After` (seconds or an
 * HTTP-date) when given, else exponential backoff; jittered so concurrent
 * callers do not retry in lockstep, and capped. */
function retryDelay(res: Response, attempt: number): number {
  const header = res.headers.get('retry-after');
  let wait = 2 ** attempt * 1000;
  if (header) {
    // A numeric value is delay-seconds; a negative one is invalid and falls
    // back to backoff. Only a non-numeric value is an HTTP-date — Date.parse
    // would otherwise read "-5" as the year 2001 and retry at once.
    if (/^\s*-?\d+(\.\d+)?\s*$/.test(header)) {
      const secs = Number(header);
      if (secs >= 0) wait = secs * 1000;
    } else {
      const date = Date.parse(header);
      if (!Number.isNaN(date)) wait = Math.max(0, date - Date.now());
    }
  }
  return Math.min(wait + Math.random() * 250, RATE_LIMIT_MAX_WAIT_MS);
}

/** Internal: one place for headers + error mapping. `path` is relative to
 * `apiBase`, or an absolute URL (a pagination link) that must share its
 * origin — the token is never sent anywhere else. Returns the parsed body and
 * the raw response (for pagination / header-only reads). */
async function glCall<T>(
  env: SourceEnv,
  apiBase: string,
  method: string,
  path: string,
  body?: unknown
): Promise<{ data: T; res: Response }> {
  const url = /^https?:\/\//i.test(path) ? path : `${apiBase}${path}`;
  if (new URL(url).origin !== new URL(apiBase).origin) {
    throw new SourceApiError(`Refusing cross-origin GitLab request to ${new URL(url).origin}`);
  }
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (env.token) headers.Authorization = `Bearer ${env.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  const where = url.slice(apiBase.length) || url;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if ((err as Error)?.name === 'TimeoutError') {
        throw new SourceApiError(`${method} ${where}: timed out after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw err;
    }
    if (res.status !== 429 || attempt >= RATE_LIMIT_RETRIES) break;
    await new Promise((r) => setTimeout(r, retryDelay(res, attempt)));
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // GitLab answers an anonymous request for a private project with 404, not
    // 401 — so without a token, name the credential on every refusal.
    const hint =
      !env.token && (res.status === 401 || res.status === 403 || res.status === 404)
        ? ' (no GITLAB_TOKEN set — private projects and all writes need one)'
        : '';
    if (res.status === 404) throw new SourceApiError(`not_found${hint}`, 404, detail.slice(0, 300));
    throw new SourceApiError(
      `${method} ${where}: ${res.status}${hint}`,
      res.status,
      detail.slice(0, 300)
    );
  }
  if (res.status === 204 || method === 'HEAD') return { data: undefined as T, res };
  return { data: (await res.json()) as T, res };
}

/** The `rel="next"` target of a Link header, if any. */
function nextLink(res: Response): string | null {
  const link = res.headers.get('link');
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

/** Every page of a list endpoint, following `rel="next"` (origin-pinned by
 * `glCall`) until the page cap or the time budget runs out. */
async function glPages<T>(
  env: SourceEnv,
  apiBase: string,
  first: string,
  maxPages = MAX_TREE_PAGES,
  budgetMs = TREE_WALK_BUDGET_MS
): Promise<{ items: T[]; truncated: boolean }> {
  const deadline = Date.now() + budgetMs;
  const items: T[] = [];
  let next: string | null = first;
  for (let pages = 0; next; pages++) {
    if (pages >= maxPages || Date.now() > deadline) return { items, truncated: true };
    const { data, res }: { data: T[]; res: Response } = await glCall<T[]>(
      env,
      apiBase,
      'GET',
      next
    );
    items.push(...data);
    next = nextLink(res);
  }
  return { items, truncated: false };
}

function filePath(path: string): string {
  return encodeURIComponent(path.replace(/^\/+/, ''));
}

const defaultBranches = new Map<string, { branch: string; at: number }>();

/** Forget remembered default branches (tests; or after renaming one). */
export function resetGitlabCaches(): void {
  defaultBranches.clear();
}

/** GET /projects/:id → default_branch, remembered per project for
 * `DEFAULT_BRANCH_TTL_MS`. */
export async function getDefaultBranch(env: SourceEnv, repoUrl: string): Promise<string> {
  const { apiBase, id } = project(repoUrl);
  const key = `${apiBase}/${id}`;
  const hit = defaultBranches.get(key);
  if (hit && Date.now() - hit.at < DEFAULT_BRANCH_TTL_MS) return hit.branch;
  const { data } = await glCall<{ default_branch?: string }>(
    env,
    apiBase,
    'GET',
    `/projects/${id}`
  );
  const branch = data.default_branch ?? 'main';
  defaultBranches.set(key, { branch, at: Date.now() });
  return branch;
}

/** GET /projects/:id/repository/files/:path?ref=… — UTF-8 content + blob sha.
 * GitLab requires a ref, so an absent or EMPTY one resolves to the default
 * branch — `''` means "current" across this package (it is the cache key an
 * unqualified read warms under), so it must not reach GitLab as `ref=`. */
export async function readFile(
  env: SourceEnv,
  repoUrl: string,
  path: string,
  ref?: string
): Promise<ReadFileResult> {
  const { apiBase, id } = project(repoUrl);
  const r = ref || (await getDefaultBranch(env, repoUrl));
  const { data } = await glCall<{ content?: string; encoding?: string; blob_id?: string }>(
    env,
    apiBase,
    'GET',
    `/projects/${id}/repository/files/${filePath(path)}?ref=${encodeURIComponent(r)}`
  );
  const raw = data.content ?? '';
  const content = data.encoding === 'base64' ? Buffer.from(raw, 'base64').toString('utf8') : raw;
  return { content, sha: data.blob_id ?? '' };
}

type GlTreeItem = {
  id: string;
  name: string;
  type: 'blob' | 'tree' | 'commit';
  path: string;
  mode: string;
};

function walkTree(
  env: SourceEnv,
  repoUrl: string,
  prefix: string,
  recursive: boolean,
  ref?: string
): Promise<{ items: GlTreeItem[]; truncated: boolean }> {
  const { apiBase, id } = project(repoUrl);
  const params = new URLSearchParams({ per_page: '100', pagination: 'keyset' });
  if (prefix) params.set('path', prefix);
  if (ref) params.set('ref', ref);
  if (recursive) params.set('recursive', 'true');
  return glPages<GlTreeItem>(env, apiBase, `/projects/${id}/repository/tree?${params}`);
}

/** GET /projects/:id/repository/tree?path=… — one directory's entries. GitLab
 * may answer a file path with an empty list rather than an error, so an empty
 * non-root listing is surfaced as not-a-directory to match the contract. */
export async function listFiles(
  env: SourceEnv,
  repoUrl: string,
  prefix: string,
  ref?: string
): Promise<DirEntry[]> {
  const dir = prefix.replace(/^\/+|\/+$/g, '');
  const { items, truncated } = await walkTree(env, repoUrl, dir, false, ref);
  if (truncated) {
    throw new SourceApiError(`${dir || '/'} has too many entries to list in one call`);
  }
  if (items.length === 0 && dir) {
    throw new SourceApiError(`${dir} is not a directory (or is empty / missing)`, 404);
  }
  return items.map((e) => ({
    name: e.name,
    type:
      e.type === 'tree'
        ? 'dir'
        : e.type === 'commit'
          ? 'submodule'
          : e.mode === '120000'
            ? 'symlink'
            : 'file',
    path: e.path,
    sha: e.id,
  }));
}

/** The whole tree at `ref`, via the recursive tree endpoint with keyset
 * pagination. GitLab's tree API carries no blob sizes, so `size` is omitted. */
export async function getRepoTree(
  env: SourceEnv,
  repoUrl: string,
  ref?: string
): Promise<RepoTree> {
  const { items, truncated } = await walkTree(env, repoUrl, '', true, ref);
  const entries: TreeEntry[] = [];
  for (const e of items) {
    if (e.type !== 'blob' && e.type !== 'tree') continue;
    entries.push({ path: e.path, type: e.type, sha: e.id });
  }
  return { entries, truncated };
}

/** HEAD on the files endpoint — GitLab answers with the blob id in
 * `X-Gitlab-Blob-Id` and no body, so freshness costs no content download. */
export async function isFresh(
  env: SourceEnv,
  repoUrl: string,
  path: string,
  version: string,
  ref?: string
): Promise<boolean> {
  const current = await blobIdAt(env, repoUrl, path, ref || (await getDefaultBranch(env, repoUrl)));
  return current === version;
}

/** The blob id of `path` at `ref`, or null when the path does not resolve. */
async function blobIdAt(
  env: SourceEnv,
  repoUrl: string,
  path: string,
  ref: string
): Promise<string | null> {
  const { apiBase, id } = project(repoUrl);
  try {
    const { res } = await glCall<void>(
      env,
      apiBase,
      'HEAD',
      `/projects/${id}/repository/files/${filePath(path)}?ref=${encodeURIComponent(ref)}`
    );
    return res.headers.get('x-gitlab-blob-id');
  } catch (err) {
    if (err instanceof SourceApiError && err.status === 404) return null;
    throw err;
  }
}

/** Ensure `branch` exists — a no-op if present, else created off the default
 * branch's tip. */
export async function ensureBranch(env: SourceEnv, repoUrl: string, branch: string): Promise<void> {
  const { apiBase, id } = project(repoUrl);
  try {
    await glCall(
      env,
      apiBase,
      'GET',
      `/projects/${id}/repository/branches/${encodeURIComponent(branch)}`
    );
    return;
  } catch (err) {
    if (!(err instanceof SourceApiError) || err.status !== 404) throw err;
  }
  const ref = await getDefaultBranch(env, repoUrl);
  const q = new URLSearchParams({ branch, ref });
  await glCall(env, apiBase, 'POST', `/projects/${id}/repository/branches?${q}`);
}

/** Map `items` through `fn` with at most `limit` in flight, preserving order. */
async function mapBounded<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** POST /projects/:id/repository/commits — every file in ONE commit. GitLab's
 * commits API applies all actions or none, so this is atomic like GitHub's
 * Git Data path. Each file is a `create` or `update` by whether it already
 * exists on the branch (probed with bounded concurrency). */
export async function commitFiles(
  env: SourceEnv,
  repoUrl: string,
  branch: string,
  files: { path: string; content: string }[],
  commitMessage: string
): Promise<void> {
  if (files.length === 0) {
    throw new SourceApiError('commitFiles: files array must not be empty');
  }
  const { apiBase, id } = project(repoUrl);
  await ensureBranch(env, repoUrl, branch);
  const actions = await mapBounded(files, PROBE_CONCURRENCY, async (f) => ({
    action: (await blobIdAt(env, repoUrl, f.path, branch)) === null ? 'create' : 'update',
    file_path: f.path.replace(/^\/+/, ''),
    content: Buffer.from(f.content, 'utf8').toString('base64'),
    encoding: 'base64',
  }));
  await glCall(env, apiBase, 'POST', `/projects/${id}/repository/commits`, {
    branch,
    commit_message: commitMessage,
    actions,
  });
}

/** Single-file write — a one-file `commitFiles`. */
export function writeFile(
  env: SourceEnv,
  repoUrl: string,
  path: string,
  content: string,
  branch: string,
  commitMessage: string
): Promise<void> {
  return commitFiles(env, repoUrl, branch, [{ path, content }], commitMessage);
}

type GlProject = {
  id: number;
  web_url: string;
  path: string;
  import_status?: string;
  namespace?: { full_path?: string };
  forked_from_project?: { id: number };
};

/** An existing fork of `upstream` in namespace `ns`. Tried first at the path a
 * fork would take (`<ns>/<upstream path>`), accepted only if GitLab records it
 * as forked from the upstream — so a same-named unrelated project is never
 * adopted. Falls back to the upstream's fork list (a renamed fork). Neither
 * lookup filters on `owned`, which GitLab reads as Owner access: a Maintainer
 * of the fork group must still find the fork on a re-run. */
async function findFork(
  env: SourceEnv,
  apiBase: string,
  upstream: GlProject,
  ns: string
): Promise<GlProject | undefined> {
  try {
    const { data } = await glCall<GlProject>(
      env,
      apiBase,
      'GET',
      `/projects/${encodeURIComponent(`${ns}/${upstream.path}`)}`
    );
    if (data.forked_from_project?.id === upstream.id) return data;
  } catch (err) {
    if (!(err instanceof SourceApiError) || err.status !== 404) throw err;
  }
  const { items } = await glPages<GlProject>(
    env,
    apiBase,
    `/projects/${upstream.id}/forks?per_page=100`,
    20
  );
  return items.find((p) => p.namespace?.full_path?.toLowerCase() === ns.toLowerCase());
}

/** Fork into `env.forkOrg` (a group / namespace path), or into the token
 * owner's personal namespace when it is empty. Idempotent: an existing fork of
 * the upstream in that namespace is returned. Waits for GitLab's asynchronous
 * fork import to finish, so the returned working URL is immediately writable.
 * Returns the fork's web URL. */
export async function ensureFork(env: SourceEnv, upstreamUrl: string): Promise<string> {
  const { apiBase, id } = project(upstreamUrl);
  let fork: GlProject;
  try {
    ({ data: fork } = await glCall<GlProject>(
      env,
      apiBase,
      'POST',
      `/projects/${id}/fork`,
      env.forkOrg ? { namespace_path: env.forkOrg } : {}
    ));
  } catch (err) {
    // 409, or 400 "has already been taken" → a project already sits at the
    // fork's path. Only a genuine fork of this upstream is accepted.
    const taken =
      err instanceof SourceApiError &&
      (err.status === 409 || (err.status === 400 && /taken|already/i.test(err.detail ?? '')));
    if (!taken) throw err;
    const ns =
      env.forkOrg ||
      (await glCall<{ username: string }>(env, apiBase, 'GET', '/user')).data.username;
    const { data: upstream } = await glCall<GlProject>(env, apiBase, 'GET', `/projects/${id}`);
    const existing = await findFork(env, apiBase, upstream, ns);
    if (!existing) throw err;
    fork = existing;
  }
  const deadline = Date.now() + FORK_READY_TIMEOUT_MS;
  while (fork.import_status && fork.import_status !== 'finished' && fork.import_status !== 'none') {
    if (fork.import_status === 'failed') {
      throw new SourceApiError(`GitLab fork import failed for ${fork.web_url}`);
    }
    if (Date.now() > deadline) {
      throw new SourceApiError(
        `GitLab fork import still '${fork.import_status}' for ${fork.web_url}`
      );
    }
    await new Promise((r) => setTimeout(r, FORK_POLL_INTERVAL_MS));
    ({ data: fork } = await glCall<GlProject>(env, apiBase, 'GET', `/projects/${fork.id}`));
  }
  return fork.web_url;
}

/** Open a merge request against `targetUrl`. `head` is `<branch>` for a
 * same-project MR, or `<fork project path>:<branch>` when the branch lives on a
 * fork on the same instance (git refnames cannot contain `:`, so the last `:`
 * splits it). If an open MR already exists from that source project + branch
 * into `base`, its URL is returned instead. Returns the MR's web URL. */
export async function openPullRequest(
  env: SourceEnv,
  targetUrl: string,
  head: string,
  base: string,
  title: string,
  body: string
): Promise<string> {
  const target = project(targetUrl);
  const split = head.lastIndexOf(':');
  const sourceId = split === -1 ? target.id : encodeURIComponent(head.slice(0, split));
  const sourceBranch = split === -1 ? head : head.slice(split + 1);
  const { data: targetProject } = await glCall<GlProject>(
    env,
    target.apiBase,
    'GET',
    `/projects/${target.id}`
  );
  try {
    const { data } = await glCall<{ web_url?: string }>(
      env,
      target.apiBase,
      'POST',
      `/projects/${sourceId}/merge_requests`,
      {
        source_branch: sourceBranch,
        target_branch: base,
        target_project_id: targetProject.id,
        title,
        description: body,
      }
    );
    if (!data.web_url) throw new SourceApiError('MR-create response missing web_url');
    return data.web_url;
  } catch (err) {
    if (!(err instanceof SourceApiError) || err.status !== 409) throw err;
    // MRs belong to their TARGET project, so the existing one is listed there
    // and matched on the source project (the fork, for a cross-project MR).
    const sourceProjectId =
      sourceId === target.id
        ? targetProject.id
        : (await glCall<GlProject>(env, target.apiBase, 'GET', `/projects/${sourceId}`)).data.id;
    const q = new URLSearchParams({
      source_branch: sourceBranch,
      target_branch: base,
      state: 'opened',
    });
    const { data: open } = await glCall<{ web_url: string; source_project_id: number }[]>(
      env,
      target.apiBase,
      'GET',
      `/projects/${target.id}/merge_requests?${q}`
    );
    const mine = open.find((mr) => mr.source_project_id === sourceProjectId);
    if (mine?.web_url) return mine.web_url;
    throw err;
  }
}

/** Aggregate export matching the `SourceAdapter` contract. */
export const gitlab: SourceAdapter = {
  readFile,
  listFiles,
  getRepoTree,
  isFresh,
  writeFile,
  commitFiles,
  ensureBranch,
  ensureFork,
  openPullRequest,
  getDefaultBranch,
};
