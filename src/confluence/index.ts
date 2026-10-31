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
// Every pagination link (`_links.next`) is re-checked against that same
// origin on every hop, and a link this adapter cannot even PARSE as a URL
// is refused by name rather than throwing a raw, unnamed TypeError.
//
// Response bodies are size-bounded (`confCall`'s `readBounded`): refused via
// `Content-Length` when the server declares one past the cap, and via a
// running byte count AS the body streams in otherwise — so neither an
// honest nor a dishonest/missing `Content-Length` can make this adapter
// buffer an unbounded response into memory.
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
/** Page cap + wall-clock budget for following `_links.next` — scoped to a
 * single TOP-LEVEL operation (one `listFiles` call, or the whole
 * `getRepoTree` walk), not to one `confPages` call within it. A
 * `PageBudget` is created once per top-level call and threaded down through
 * every `listRootPages` / `listChildPages` / `confPages` call it makes, so
 * a deep or wide space cannot hang a caller forever by spreading its cost
 * across many per-node fetches that would otherwise each get a fresh
 * budget of their own. */
const MAX_LIST_PAGES = 500;
const LIST_BUDGET_MS = 120_000;
/** Cap on `getRepoTree`'s walk; past it the tree reports `truncated: true`,
 * matching the Notion adapter's own cap. */
const DEFAULT_TREE_CAP = 5000;
/** Cap on a single HTTP response body this adapter will buffer, enforced by
 * `readBounded` below — generous for any real Confluence API response, but
 * bounded so a malicious or malfunctioning response of unbounded size
 * cannot exhaust memory. */
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
/** Cap on the response body read when it is only being used for a
 * truncated (300-char) error detail — no reason to stream megabytes just
 * to keep the first few hundred characters. */
const MAX_ERROR_DETAIL_BYTES = 65_536;

/** A page-fetch budget shared across every `confPages` call within one
 * top-level operation. Mutated in place as pages are spent. */
interface PageBudget {
  deadline: number;
  pagesUsed: number;
}

function newPageBudget(): PageBudget {
  return { deadline: Date.now() + LIST_BUDGET_MS, pagesUsed: 0 };
}

function budgetExhausted(budget: PageBudget): boolean {
  return budget.pagesUsed >= MAX_LIST_PAGES || Date.now() > budget.deadline;
}

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
    // A numeric value is delay-seconds; a negative one is invalid and falls
    // back to backoff. Only a non-numeric value is an HTTP-date — Date.parse
    // would otherwise read "-5" as the year 2001 and retry at once. Mirrors
    // src/gitlab/index.ts's retryDelay exactly.
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

interface Envelope<T> {
  results?: T[];
  _links?: { next?: string };
}

/** Reads a `Response` body, refusing anything past `capBytes` rather than
 * buffering an unbounded body into memory first. Checked TWICE: via
 * `Content-Length` when the server supplies one (cheap — refuses before
 * reading a single byte), AND by counting bytes AS they arrive (a missing
 * or dishonest `Content-Length` cannot bypass the cap by under-reporting
 * or omitting it). */
async function readBounded(res: Response, path: string, capBytes: number): Promise<string> {
  const declared = res.headers.get('content-length');
  if (declared && Number(declared) > capBytes) {
    throw new SourceApiError(
      `GET ${path}: response too large (${declared} bytes, cap ${capBytes})`
    );
  }
  if (!res.body) {
    const text = await res.text();
    if (text.length > capBytes) {
      throw new SourceApiError(`GET ${path}: response too large (cap ${capBytes} bytes)`);
    }
    return text;
  }
  const reader = res.body.getReader();
  let received = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      received += value.byteLength;
      if (received > capBytes) {
        await reader.cancel().catch(() => {});
        throw new SourceApiError(`GET ${path}: response too large (cap ${capBytes} bytes)`);
      }
      chunks.push(value);
    }
  }
  const combined = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    combined.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder('utf-8').decode(combined);
}

/** One place for headers + status mapping. `path` is relative to `site`
 * (e.g. `/wiki/api/v2/...`) or an absolute URL (a `_links.next` page) that
 * must share `site`'s origin — the token is never sent anywhere else. A
 * `_links.next` value this adapter cannot even parse as a URL (Confluence
 * is trusted, but a pagination link is still external input) is refused by
 * name, not left to throw a raw, unnamed TypeError out of `new URL(...)`. */
async function confCall<T>(env: SourceEnv, site: string, path: string): Promise<T> {
  const url = /^https?:\/\//i.test(path) ? path : `${site}${path}`;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    throw new SourceApiError(
      `Confluence returned an unparseable pagination link: ${path.slice(0, 200)}`
    );
  }
  if (origin !== new URL(site).origin) {
    throw new SourceApiError(`Refusing cross-origin Confluence request to ${origin}`);
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
    const detail = await readBounded(res, path, MAX_ERROR_DETAIL_BYTES)
      .then((t) => t.slice(0, 300))
      .catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw new SourceApiError(
        `Confluence auth failed (${res.status}): check the token is "email:api_token" and has access to this space`,
        res.status,
        detail
      );
    }
    if (res.status === 404) {
      throw new SourceApiError('not_found', 404, detail);
    }
    throw new SourceApiError(`GET ${path}: ${res.status}`, res.status, detail);
  }
  const text = await readBounded(res, path, MAX_RESPONSE_BYTES);
  return JSON.parse(text) as T;
}

/** Follows `_links.next` (origin-pinned by `confCall`) until it runs out, or
 * the SHARED page cap / time budget does — `budget` is one `PageBudget` for
 * the whole top-level operation, not a fresh one per call. */
async function confPages<T>(
  env: SourceEnv,
  site: string,
  first: string,
  budget: PageBudget
): Promise<T[]> {
  const items: T[] = [];
  let next: string | undefined = first;
  while (next) {
    if (budgetExhausted(budget)) break;
    budget.pagesUsed++;
    const data: Envelope<T> = await confCall<Envelope<T>>(env, site, next);
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

/** Validates the `version.number` shape the Confluence API guarantees,
 * raising a SourceApiError naming what was malformed rather than letting a
 * malformed-but-200 response crash every caller with a raw TypeError. */
function pageVersionNumber(page: ConfPage, context: string): number {
  const n = page?.version?.number;
  if (typeof n !== 'number') {
    throw new SourceApiError(
      `Confluence ${context}: malformed page response (missing version.number)`
    );
  }
  return n;
}

async function resolveSpaceId(env: SourceEnv, site: string, spaceKey: string): Promise<string> {
  const data = await confCall<{ results?: { id: string }[] }>(
    env,
    site,
    `/wiki/api/v2/spaces?keys=${encodeURIComponent(spaceKey)}`
  );
  if (!Array.isArray(data.results)) {
    throw new SourceApiError(
      `Confluence space lookup for "${spaceKey}": malformed response (missing results array)`
    );
  }
  const id = data.results[0]?.id;
  if (!id) throw new SourceApiError(`Confluence space not found: ${spaceKey}`, 404);
  return id;
}

function listRootPages(
  env: SourceEnv,
  site: string,
  spaceId: string,
  budget: PageBudget
): Promise<ConfPage[]> {
  return confPages<ConfPage>(
    env,
    site,
    `/wiki/api/v2/spaces/${encodeURIComponent(spaceId)}/pages?limit=100`,
    budget
  );
}

function listChildPages(
  env: SourceEnv,
  site: string,
  pageId: string,
  budget: PageBudget
): Promise<ConfPage[]> {
  return confPages<ConfPage>(
    env,
    site,
    `/wiki/api/v2/pages/${encodeURIComponent(pageId)}/children?limit=100`,
    budget
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
  return { kind: 'found', content, sha: String(pageVersionNumber(page, 'readFile')) };
}

/** Lists the immediate children of `prefix` — root-level pages of the space
 * when `prefix` is empty, else the children of the last page id in the
 * chain. Every entry is surfaced as `dir`: any page may itself have
 * children, so (as the Notion adapter does, for the same reason) a leaf vs.
 * branch distinction is not drawn at listing time. Each child's own `path`
 * is the FULL `prefix` chain plus the child id — e.g. a `prefix` of
 * `100/200` returns children at `100/200/300`, not `200/300` — matching
 * `getRepoTree`'s full-chain contract and the fs/Notion adapters' own
 * `prefix ? \`${prefix}/${child}\` : child` pattern, not just the immediate
 * parent id used below to decide which API call to make. */
export async function listFiles(
  env: SourceEnv,
  repoUrl: string,
  prefix: string,
  ref?: string
): Promise<DirEntry[]> {
  void ref;
  const { site, spaceKey } = parseConfluenceSpaceUrl(repoUrl);
  const parentId = lastPageId(prefix);
  const normalizedPrefix = prefix.trim().replace(/^\/+|\/+$/g, '');
  const budget = newPageBudget();
  const children =
    parentId === null
      ? await listRootPages(env, site, await resolveSpaceId(env, site, spaceKey), budget)
      : await listChildPages(env, site, parentId, budget);
  return children.map((c) => ({
    name: c.title,
    type: 'dir' as const,
    path: parentId === null ? c.id : `${normalizedPrefix}/${c.id}`,
    sha: String(pageVersionNumber(c, 'listFiles')),
  }));
}

/** Walks the whole page tree under the space, breadth-first, capped at
 * `DEFAULT_TREE_CAP` entries OR the shared `PageBudget` for the whole walk
 * (reported `truncated: true` past either). Every page is a `blob` entry —
 * matching the Notion adapter's RepoTree shape, where the git-flavoured
 * `tree` type is reserved for a non-page container (Notion's child
 * databases; Confluence has none, so this adapter never emits one). */
export async function getRepoTree(
  env: SourceEnv,
  repoUrl: string,
  ref?: string
): Promise<RepoTree> {
  void ref;
  const { site, spaceKey } = parseConfluenceSpaceUrl(repoUrl);
  const spaceId = await resolveSpaceId(env, site, spaceKey);
  const budget = newPageBudget();
  const entries: TreeEntry[] = [];
  let truncated = false;
  const queue: Array<{ id: string | null; path: string }> = [{ id: null, path: '' }];
  while (queue.length > 0) {
    if (entries.length >= DEFAULT_TREE_CAP || budgetExhausted(budget)) {
      truncated = true;
      break;
    }
    const node = queue.shift()!;
    const children =
      node.id === null
        ? await listRootPages(env, site, spaceId, budget)
        : await listChildPages(env, site, node.id, budget);
    for (const child of children) {
      if (entries.length >= DEFAULT_TREE_CAP) {
        truncated = true;
        break;
      }
      const childPath = node.path ? `${node.path}/${child.id}` : child.id;
      entries.push({
        path: childPath,
        type: 'blob',
        sha: String(pageVersionNumber(child, 'getRepoTree')),
      });
      queue.push({ id: child.id, path: childPath });
    }
    if (budgetExhausted(budget)) {
      truncated = true;
      break;
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
    return String(pageVersionNumber(page, 'isFresh')) === version;
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
