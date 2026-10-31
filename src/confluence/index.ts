// @verevoir/sources/confluence — Confluence Cloud adapter (READ-ONLY)
//
// Implements the read half of the SourceAdapter contract over Confluence
// Cloud's REST v2 API using native fetch — the same shape as the
// GitHub/GitLab adapters (one place for headers + error mapping), no SDK
// dependency. There is deliberately no write half: this module exports only
// readFile, listFiles, getRepoTree, isFresh and getDefaultBranch. Confluence
// has no git-shaped branch/commit/fork/PR model to hang writeFile,
// commitFiles, ensureBranch, ensureFork or openPullRequest off — unlike the
// Notion adapter, which implements all ten and throws/no-ops for the ones
// that genuinely don't apply, this adapter does not pretend to a write half
// it does not have, so there is no `SourceAdapter`-typed aggregate export
// here (that interface requires the write methods).
//
// Addressing: `repoUrl` names the SITE and SPACE —
// `https://<site>.atlassian.net/wiki/spaces/<SPACEKEY>`. `path` is a
// slash-separated chain of page IDs (e.g. `123/456/789`), never titles —
// titles are mutable and not unique within a space; IDs are permanent. The
// chain conveys the hierarchy for listing/tree-walking; a direct read or
// freshness check only needs the LAST id, since a Confluence page id is
// globally resolvable on its own. '' / '.' / '/' addresses the space itself:
// a directory with no body of its own — readFile and isFresh on it fail /
// read as stale; listFiles and getRepoTree walk from it as the root.
//
// Auth: Atlassian Cloud basic auth. `SourceEnv.token` carries
// "<email>:<api_token>" (an Atlassian API token created at
// https://id.atlassian.com/manage-profile/security/api-tokens), sent as
// `Authorization: Basic <base64(email:api_token)>`. The token is NEVER
// logged and never interpolated into a thrown error message — only the
// response status and the server's own response body text appear there.
//
// Hosts: every real Confluence Cloud space lives on `*.atlassian.net` — so,
// unlike GitLab's self-hosted allow-list, the host check here is not an
// operator setting but a fixed fact about Cloud. A URL off that host (a
// lookalike domain, or plain http) is refused before any request, so the
// token is never sent anywhere else — even on a prompt-injected `repoUrl`.
//
// `ref` is accepted-but-ignored, like Notion — Confluence pages have no
// branch concept. `getDefaultBranch` returns 'live' for the same reason.

import {
  SourceApiError,
  type SourceEnv,
  type ReadFileResult,
  type DirEntry,
  type TreeEntry,
  type RepoTree,
} from '../index.js';
import { storageToMarkdown } from './storage-to-markdown.js';

const REQUEST_TIMEOUT_MS = 30_000;
/** 429 handling: retries, and the ceiling on any one wait. */
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_MAX_WAIT_MS = 30_000;
/** Page cap + wall-clock budget for following `_links.next`, so a huge or
 * looping space cannot hang a caller forever — mirrors the GitLab adapter's
 * tree walk. */
const MAX_LIST_PAGES = 500;
const LIST_BUDGET_MS = 120_000;
/** Cap on `getRepoTree`'s walk; past it the tree reports `truncated: true`,
 * matching the Notion adapter's own cap. */
const DEFAULT_TREE_CAP = 5000;

/** Parses `https://<site>.atlassian.net/wiki/spaces/<SPACEKEY>[...]` into
 * the site origin + space key. Rejects anything else — this is also the
 * check that stops the token being sent somewhere a prompt-injected URL
 * might point it. */
export function parseConfluenceSpaceUrl(input: string): { site: string; spaceKey: string } {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new SourceApiError(`Cannot parse Confluence space URL: ${input}`);
  }
  const host = u.hostname.toLowerCase();
  const m = u.pathname.match(/^\/wiki\/spaces\/([^/]+)/);
  if (u.protocol !== 'https:' || !host.endsWith('.atlassian.net') || !m) {
    throw new SourceApiError(
      `Not a Confluence Cloud space URL (need https://<site>.atlassian.net/wiki/spaces/<KEY>): ${input}`
    );
  }
  return { site: `${u.protocol}//${u.host}`, spaceKey: decodeURIComponent(m[1]) };
}

/** Builds `Authorization: Basic ...` from `email:api_token`. Throws, naming
 * the expected shape, rather than sending a header Confluence would answer
 * with an opaque 401 — but never echoes the token itself. */
function authHeader(env: SourceEnv): string {
  if (!env.token || !env.token.includes(':')) {
    throw new SourceApiError(
      'Confluence token must be "<email>:<api_token>" in SourceEnv.token — see https://id.atlassian.com/manage-profile/security/api-tokens'
    );
  }
  return `Basic ${Buffer.from(env.token, 'utf8').toString('base64')}`;
}

/** Milliseconds to wait before retrying a 429: `Retry-After` (seconds or an
 * HTTP-date) when given, else exponential backoff; jittered so concurrent
 * callers do not retry in lockstep, and capped. */
function retryDelay(res: Response, attempt: number): number {
  const header = res.headers.get('retry-after');
  let wait = 2 ** attempt * 1000;
  if (header) {
    if (/^\s*\d+(\.\d+)?\s*$/.test(header)) {
      wait = Number(header) * 1000;
    } else {
      const date = Date.parse(header);
      if (!Number.isNaN(date)) wait = Math.max(0, date - Date.now());
    }
  }
  return Math.min(wait + Math.random() * 250, RATE_LIMIT_MAX_WAIT_MS);
}

interface Envelope<T> {
  results?: T[];
  _links?: { next?: string };
}

/** One place for headers + status mapping. `path` is relative to `site`
 * (e.g. `/wiki/api/v2/...`) or an absolute URL (a `_links.next` page) that
 * must share `site`'s origin — the token is never sent anywhere else. */
async function confCall<T>(env: SourceEnv, site: string, path: string): Promise<T> {
  const url = /^https?:\/\//i.test(path) ? path : `${site}${path}`;
  if (new URL(url).origin !== new URL(site).origin) {
    throw new SourceApiError(`Refusing cross-origin Confluence request to ${new URL(url).origin}`);
  }
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: authHeader(env),
  };
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      if ((err as Error)?.name === 'TimeoutError') {
        throw new SourceApiError(`GET ${path}: timed out after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw err;
    }
    if (res.status !== 429 || attempt >= RATE_LIMIT_RETRIES) break;
    await new Promise((r) => setTimeout(r, retryDelay(res, attempt)));
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw new SourceApiError(
        `Confluence auth failed (${res.status}): check the token is "email:api_token" and has access to this space`,
        res.status,
        detail.slice(0, 300)
      );
    }
    if (res.status === 404) {
      throw new SourceApiError('not_found', 404, detail.slice(0, 300));
    }
    throw new SourceApiError(`GET ${path}: ${res.status}`, res.status, detail.slice(0, 300));
  }
  return (await res.json()) as T;
}

/** Follows `_links.next` (origin-pinned by `confCall`) until it runs out, or
 * the page cap / time budget does. */
async function confPages<T>(env: SourceEnv, site: string, first: string): Promise<T[]> {
  const deadline = Date.now() + LIST_BUDGET_MS;
  const items: T[] = [];
  let next: string | undefined = first;
  for (let pages = 0; next; pages++) {
    if (pages >= MAX_LIST_PAGES || Date.now() > deadline) break;
    const data = await confCall<Envelope<T>>(env, site, next);
    items.push(...(data.results ?? []));
    next = data._links?.next;
  }
  return items;
}

interface ConfPage {
  id: string;
  title: string;
  version: { number: number };
  body?: { storage?: { value: string } };
}

async function resolveSpaceId(env: SourceEnv, site: string, spaceKey: string): Promise<string> {
  const data = await confCall<{ results: { id: string }[] }>(
    env,
    site,
    `/wiki/api/v2/spaces?keys=${encodeURIComponent(spaceKey)}`
  );
  const id = data.results[0]?.id;
  if (!id) throw new SourceApiError(`Confluence space not found: ${spaceKey}`, 404);
  return id;
}

function listRootPages(env: SourceEnv, site: string, spaceId: string): Promise<ConfPage[]> {
  return confPages<ConfPage>(
    env,
    site,
    `/wiki/api/v2/spaces/${encodeURIComponent(spaceId)}/pages?limit=100`
  );
}

function listChildPages(env: SourceEnv, site: string, pageId: string): Promise<ConfPage[]> {
  return confPages<ConfPage>(
    env,
    site,
    `/wiki/api/v2/pages/${encodeURIComponent(pageId)}/children?limit=100`
  );
}

function getPage(
  env: SourceEnv,
  site: string,
  pageId: string,
  withBody: boolean
): Promise<ConfPage> {
  const q = withBody ? '?body-format=storage' : '';
  return confCall<ConfPage>(env, site, `/wiki/api/v2/pages/${encodeURIComponent(pageId)}${q}`);
}

/** Validates and extracts the last page id of a '/'-separated chain. `null`
 * for the root ('' / '.' / '/') — the space has no page id of its own.
 * Throws on any segment that is not a bare non-negative integer, since a
 * Confluence page id always is one and a title slipping in here would
 * silently 404 somewhere less legible than the point of entry. */
function lastPageId(path: string): string | null {
  const normalised = path.trim();
  if (normalised === '' || normalised === '.' || normalised === '/') return null;
  const segments = normalised.replace(/^\/+|\/+$/g, '').split('/');
  for (const seg of segments) {
    if (!/^[0-9]+$/.test(seg)) {
      throw new SourceApiError(`Confluence page id must be numeric, got "${seg}" in "${path}"`);
    }
  }
  return segments[segments.length - 1];
}

/** Reads the page at `path` as Markdown, converted from its storage-format
 * body. `sha` is `version.number` as a string — the cheap, monotonic
 * version handle Confluence itself hands back. Throws 404 on the space root
 * (no page id to read) or a page id that does not resolve. */
export async function readFile(
  env: SourceEnv,
  repoUrl: string,
  path: string,
  ref?: string
): Promise<ReadFileResult> {
  void ref;
  const { site } = parseConfluenceSpaceUrl(repoUrl);
  const pageId = lastPageId(path);
  if (pageId === null) {
    throw new SourceApiError('The space root has no content to read — address a page id', 404);
  }
  const page = await getPage(env, site, pageId, true);
  const content = storageToMarkdown(page.body?.storage?.value ?? '');
  return { kind: 'found', content, sha: String(page.version.number) };
}

/** Lists the immediate children of `prefix` — root-level pages of the space
 * when `prefix` is empty, else the children of the last page id in the
 * chain. Every entry is surfaced as `dir`: any page may itself have
 * children, so (as the Notion adapter does, for the same reason) a leaf vs.
 * branch distinction is not drawn at listing time. */
export async function listFiles(
  env: SourceEnv,
  repoUrl: string,
  prefix: string,
  ref?: string
): Promise<DirEntry[]> {
  void ref;
  const { site, spaceKey } = parseConfluenceSpaceUrl(repoUrl);
  const parentId = lastPageId(prefix);
  const children =
    parentId === null
      ? await listRootPages(env, site, await resolveSpaceId(env, site, spaceKey))
      : await listChildPages(env, site, parentId);
  return children.map((c) => ({
    name: c.title,
    type: 'dir' as const,
    path: parentId === null ? c.id : `${parentId}/${c.id}`,
    sha: String(c.version.number),
  }));
}

/** Walks the whole page tree under the space, breadth-first, capped at
 * `DEFAULT_TREE_CAP` entries (reported `truncated: true` past it). Every
 * page is a `blob` entry — matching the Notion adapter's RepoTree shape,
 * where the git-flavoured `tree` type is reserved for a non-page container
 * (Notion's child databases; Confluence has none, so this adapter never
 * emits one). */
export async function getRepoTree(
  env: SourceEnv,
  repoUrl: string,
  ref?: string
): Promise<RepoTree> {
  void ref;
  const { site, spaceKey } = parseConfluenceSpaceUrl(repoUrl);
  const spaceId = await resolveSpaceId(env, site, spaceKey);
  const entries: TreeEntry[] = [];
  let truncated = false;
  const queue: Array<{ id: string | null; path: string }> = [{ id: null, path: '' }];
  while (queue.length > 0) {
    if (entries.length >= DEFAULT_TREE_CAP) {
      truncated = true;
      break;
    }
    const node = queue.shift()!;
    const children =
      node.id === null
        ? await listRootPages(env, site, spaceId)
        : await listChildPages(env, site, node.id);
    for (const child of children) {
      if (entries.length >= DEFAULT_TREE_CAP) {
        truncated = true;
        break;
      }
      const childPath = node.path ? `${node.path}/${child.id}` : child.id;
      entries.push({ path: childPath, type: 'blob', sha: String(child.version.number) });
      queue.push({ id: child.id, path: childPath });
    }
  }
  return { entries, truncated };
}

/** One GET of the page WITHOUT its body, comparing `version.number` to the
 * held `version`. False on drift or when the page no longer resolves
 * (including the space root, which has no version of its own — queried
 * against nothing, it is never "fresh"). A non-404 failure is surfaced
 * rather than read as staleness. */
export async function isFresh(
  env: SourceEnv,
  repoUrl: string,
  path: string,
  version: string,
  ref?: string
): Promise<boolean> {
  void ref;
  const { site } = parseConfluenceSpaceUrl(repoUrl);
  const pageId = lastPageId(path);
  if (pageId === null) return false;
  try {
    const page = await getPage(env, site, pageId, false);
    return String(page.version.number) === version;
  } catch (err) {
    if (err instanceof SourceApiError && err.status === 404) return false;
    throw err;
  }
}

/** Returns 'live' as a stable sentinel, like the Notion adapter — Confluence
 * pages have no branch / default-branch concept. Still validates `repoUrl`,
 * so a caller that got the URL shape wrong finds out here rather than on the
 * next call that actually needs the site. */
export async function getDefaultBranch(env: SourceEnv, repoUrl: string): Promise<string> {
  void env;
  parseConfluenceSpaceUrl(repoUrl);
  return 'live';
}

/** Aggregate export of the read half this adapter implements. Deliberately
 * not typed as `SourceAdapter` — that interface also requires the write
 * methods (writeFile, commitFiles, ensureBranch, ensureFork,
 * openPullRequest), which this read-only adapter does not export at all. */
export const confluence = {
  readFile,
  listFiles,
  getRepoTree,
  isFresh,
  getDefaultBranch,
};
