// @verevoir/sources/notion — Notion adapter
//
// Implements the SourceAdapter contract over Notion's API via the
// official @notionhq/client SDK. Two distinct backends consume this:
//
//   - A Notion workspace as a documentation tree. Pages are "files",
//     their child pages are "subdirectories", and the file content is
//     the page's blocks rendered to Markdown.
//   - Used alongside @verevoir/workflows/notion which exposes a
//     Notion database as a kanban-shaped workflow source.
//
// Auth: SourceEnv.token carries a Notion integration token (an
// `ntn_...` secret created at https://www.notion.so/profile/integrations
// and shared with the relevant workspace pages / databases). The
// `forkOrg` field is ignored — Notion has no fork primitive.
//
// `sourceUrl` is a Notion page URL or raw page ID (with or without
// dashes). The page it points to is the "root" of the source — the
// equivalent of a repo root. `path` is a slash-separated traversal
// through child pages, matched by title or its kebab-case slug.
// `path` of '', '/', or '.' resolves to the root page itself.
//
// `ref` is accepted-but-ignored — Notion has no branching concept.
//
// `version` (returned as `sha` from readFile, consumed by isFresh) is
// the page's `last_edited_time` ISO timestamp. Cheap freshness probe.
//
// Markdown body: read via the native `pages.retrieveMarkdown` and
// write via `pages.updateMarkdown` (`replace_content`) — the SDK's
// own block <-> Markdown conversion, rather than a hand-rolled one.
// readFile renders the page to Markdown; writeFile replaces the body
// from a Markdown string in a single call. Page-tree navigation
// (listFiles / getRepoTree / resolvePath) still walks child blocks
// directly via `blocks.children.list`.

import { Client, isFullPage, isFullBlock } from '@notionhq/client';
import type {
  BlockObjectResponse,
  PageObjectResponse,
  PartialBlockObjectResponse,
} from '@notionhq/client/build/src/api-endpoints.js';
import {
  SourceApiError,
  type SourceEnv,
  type ReadFileResult,
  type DirEntry,
  type RepoTree,
  type TreeEntry,
} from '../index.js';

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

// A Notion page ID is 32 hex chars. Notion accepts the ID with or
// without dashes; the API typically returns it dashed. We normalise
// to dashed form so equality comparisons across calls are reliable.
const ID_NO_DASH = /^[0-9a-f]{32}$/i;
const ID_DASHED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parses a Notion page URL or raw page ID into a normalised
 * dashed-form page ID. Accepts:
 *   - `https://www.notion.so/<workspace-slug>/<page-title>-<id>` (32-hex id in URL)
 *   - `https://www.notion.so/<page-title>-<id>` (no workspace)
 *   - `https://notion.so/<id>` (bare id)
 *   - `<32-hex>` (raw, no dashes)
 *   - `<8-4-4-4-12>` (raw, dashed)
 * Returns null on anything unparseable. */
export function parseNotionPageUrl(input: string): { pageId: string } | null {
  const trimmed = input.trim().replace(/\?.*$/, '').replace(/#.*$/, '').replace(/\/$/, '');
  if (ID_DASHED.test(trimmed)) return { pageId: trimmed.toLowerCase() };
  if (ID_NO_DASH.test(trimmed)) return { pageId: dashifyId(trimmed.toLowerCase()) };
  const urlMatch = trimmed.match(/notion\.so\/(?:[^/?#]+\/)?(?:.*-)?([0-9a-f]{32})/i);
  if (urlMatch) return { pageId: dashifyId(urlMatch[1].toLowerCase()) };
  return null;
}

function dashifyId(id: string): string {
  if (id.includes('-')) return id;
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

function client(env: SourceEnv): Client {
  if (!env.token) {
    throw new SourceApiError(
      'Notion integration token not set (env.token is empty; set NOTION_API_KEY)'
    );
  }
  return new Client({ auth: env.token });
}

async function rootPageId(rootUrl: string): Promise<string> {
  const parsed = parseNotionPageUrl(rootUrl);
  if (!parsed) {
    throw new SourceApiError(`Cannot parse Notion page URL: ${rootUrl}`);
  }
  return parsed.pageId;
}

// Notion API errors carry `code` + `status`. Map the ones we care
// about; other failures fall through as the SDK's NotionClientError
// with our wrapper preserving `status`.
function mapError(err: unknown, context: string): SourceApiError {
  const anyErr = err as { code?: string; status?: number; message?: string };
  if (anyErr?.code === 'object_not_found' || anyErr?.status === 404) {
    return new SourceApiError('not_found', 404);
  }
  return new SourceApiError(`Notion ${context}: ${anyErr?.message ?? String(err)}`, anyErr?.status);
}

// ---------------------------------------------------------------------------
// Tree traversal (page → child pages via blocks API)
// ---------------------------------------------------------------------------

interface ChildEntry {
  id: string;
  title: string;
  /** Either a regular sub-page or a child database. The adapter
   * surfaces sub-pages as `file` / `dir`-like entries; child
   * databases are surfaced as `submodule` to make the distinction
   * explicit (the workflow adapter knows what to do with them). */
  kind: 'page' | 'database';
  lastEditedTime: string;
}

async function listChildren(c: Client, parentId: string): Promise<ChildEntry[]> {
  const out: ChildEntry[] = [];
  let cursor: string | undefined;
  try {
    do {
      const resp = await c.blocks.children.list({
        block_id: parentId,
        start_cursor: cursor,
        page_size: 100,
      });
      for (const block of resp.results as Array<BlockObjectResponse | PartialBlockObjectResponse>) {
        if (!isFullBlock(block)) continue;
        if (block.type === 'child_page') {
          out.push({
            id: block.id,
            title: block.child_page.title,
            kind: 'page',
            lastEditedTime: block.last_edited_time,
          });
        } else if (block.type === 'child_database') {
          out.push({
            id: block.id,
            title: block.child_database.title,
            kind: 'database',
            lastEditedTime: block.last_edited_time,
          });
        }
      }
      cursor = resp.has_more ? (resp.next_cursor ?? undefined) : undefined;
    } while (cursor);
  } catch (err) {
    throw mapError(err, `listChildren(${parentId})`);
  }
  return out;
}

/** Resolves a `path` (slash-separated, each segment a title or its
 * kebab-slug) against a root page ID. Returns the resolved page ID
 * or throws 404 if any segment doesn't resolve. Empty / '.' / '/'
 * path resolves to the root itself. */
async function resolvePath(c: Client, rootId: string, path: string): Promise<string> {
  const normalised = path.trim();
  if (normalised === '' || normalised === '.' || normalised === '/') return rootId;
  const segments = normalised.replace(/^\/+|\/+$/g, '').split('/');
  let currentId = rootId;
  for (const seg of segments) {
    const children = await listChildren(c, currentId);
    const match = children.find(
      (child) => child.title === seg || slugify(child.title) === slugify(seg)
    );
    if (!match) {
      throw new SourceApiError(`Path not found: "${seg}" not found under page ${currentId}`, 404);
    }
    currentId = match.id;
  }
  return currentId;
}

/** Lowercase + non-alphanumeric → '-'. Matches the de-facto Notion
 * URL slug shape so URLs and human-typed paths both work. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Like resolvePath, but UPSERTS: a segment that doesn't resolve is created
 * as a child page titled by the segment, and traversal continues — so a write
 * to a not-yet-existing path creates the page (and any missing parents) rather
 * than 404ing. Idempotent: an existing page matches by title or slug, so a
 * repeat write updates in place. The segment text becomes the page title. */
async function resolveOrCreatePath(c: Client, rootId: string, path: string): Promise<string> {
  const normalised = path.trim();
  if (normalised === '' || normalised === '.' || normalised === '/') return rootId;
  const segments = normalised.replace(/^\/+|\/+$/g, '').split('/');
  let currentId = rootId;
  for (const seg of segments) {
    const children = await listChildren(c, currentId);
    const match = children.find(
      (child) => child.title === seg || slugify(child.title) === slugify(seg)
    );
    if (match) {
      currentId = match.id;
      continue;
    }
    try {
      const created = await c.pages.create({
        parent: { type: 'page_id', page_id: currentId },
        properties: { title: { title: [{ text: { content: seg } }] } },
      });
      currentId = created.id;
    } catch (err) {
      throw mapError(err, `createPage("${seg}" under ${currentId})`);
    }
  }
  return currentId;
}

// ---------------------------------------------------------------------------
// SourceAdapter methods
// ---------------------------------------------------------------------------

/** Read the page at `path` (relative to the root page identified
 * by `rootUrl`) as Markdown. Returns the page's `last_edited_time`
 * as `sha` for use as a freshness handle. Throws 404 when the path
 * doesn't resolve. */
export async function readFile(
  env: SourceEnv,
  rootUrl: string,
  path: string,
  ref?: string
): Promise<ReadFileResult> {
  void ref;
  const c = client(env);
  const rootId = await rootPageId(rootUrl);
  const pageId = await resolvePath(c, rootId, path);
  try {
    const page = await c.pages.retrieve({ page_id: pageId });
    const lastEditedTime = isFullPage(page as PageObjectResponse)
      ? (page as PageObjectResponse).last_edited_time
      : '';
    let content = '';
    try {
      content = (await c.pages.retrieveMarkdown({ page_id: pageId })).markdown ?? '';
    } catch (bodyErr) {
      // A page with no body content can 404 the body endpoint; the
      // page itself exists (pages.retrieve succeeded), so treat that
      // as an empty body rather than failing the read.
      const e = bodyErr as { code?: string; status?: number };
      if (e?.code !== 'object_not_found' && e?.status !== 404) throw bodyErr;
    }
    return { content, sha: lastEditedTime };
  } catch (err) {
    throw mapError(err, `readFile(${pageId})`);
  }
}

/** List the immediate child pages + databases of the page at
 * `prefix`. Pages and databases are returned as `file` and `submodule`
 * entries respectively; the distinction tells consumers which adapter
 * to talk to next (workflow adapter for databases). */
export async function listFiles(
  env: SourceEnv,
  rootUrl: string,
  prefix: string,
  ref?: string
): Promise<DirEntry[]> {
  void ref;
  const c = client(env);
  const rootId = await rootPageId(rootUrl);
  const parentId = await resolvePath(c, rootId, prefix);
  const children = await listChildren(c, parentId);
  return children.map((child) => ({
    name: child.title,
    type: child.kind === 'page' ? ('dir' as const) : ('submodule' as const),
    path: prefix ? `${prefix}/${slugify(child.title)}` : slugify(child.title),
    sha: child.lastEditedTime,
  }));
}

/** Walk the page tree under `rootUrl` and return every reachable
 * sub-page as a tree entry. Databases are surfaced as `tree` entries
 * (the "directory" of a database is its rows) but not recursed into
 * — workflow operations against a DB go through the workflow adapter.
 *
 * The walk is breadth-first and capped at `DEFAULT_TREE_CAP` entries
 * to bound payload; deeper trees report `truncated: true`. */
const DEFAULT_TREE_CAP = 5000;

export async function getRepoTree(
  env: SourceEnv,
  rootUrl: string,
  ref?: string
): Promise<RepoTree> {
  void ref;
  const c = client(env);
  const rootId = await rootPageId(rootUrl);
  const entries: TreeEntry[] = [];
  let truncated = false;
  const queue: Array<{ id: string; path: string }> = [{ id: rootId, path: '' }];
  while (queue.length > 0) {
    if (entries.length >= DEFAULT_TREE_CAP) {
      truncated = true;
      break;
    }
    const node = queue.shift()!;
    let children: ChildEntry[];
    try {
      children = await listChildren(c, node.id);
    } catch {
      continue;
    }
    for (const child of children) {
      if (entries.length >= DEFAULT_TREE_CAP) {
        truncated = true;
        break;
      }
      const childPath = node.path ? `${node.path}/${slugify(child.title)}` : slugify(child.title);
      entries.push({
        path: childPath,
        type: child.kind === 'page' ? 'blob' : 'tree',
        sha: child.lastEditedTime,
      });
      if (child.kind === 'page') {
        queue.push({ id: child.id, path: childPath });
      }
    }
  }
  return { entries, truncated };
}

/** Returns true when the page's current `last_edited_time` matches
 * the held `version`. False on drift or 404 (page removed / no longer
 * resolvable from the root). One API call: `pages.retrieve`. */
export async function isFresh(
  env: SourceEnv,
  rootUrl: string,
  path: string,
  version: string,
  ref?: string
): Promise<boolean> {
  void ref;
  const c = client(env);
  const rootId = await rootPageId(rootUrl);
  try {
    const pageId = await resolvePath(c, rootId, path);
    const page = await c.pages.retrieve({ page_id: pageId });
    if (!isFullPage(page as PageObjectResponse)) return false;
    return (page as PageObjectResponse).last_edited_time === version;
  } catch (err) {
    if (err instanceof SourceApiError && err.status === 404) return false;
    throw err;
  }
}

/** Replace the page body with the Markdown via the native
 * `pages.updateMarkdown` (`replace_content`) — one call, no
 * hand-rolled block conversion. `allow_deleting_content` lets an
 * empty body clear the page.
 *
 * `branch` and `commitMessage` are ignored — Notion has no branch /
 * commit primitives. */
export async function writeFile(
  env: SourceEnv,
  rootUrl: string,
  path: string,
  content: string,
  branch: string,
  commitMessage: string
): Promise<void> {
  void branch;
  void commitMessage;
  const c = client(env);
  const rootId = await rootPageId(rootUrl);
  // Upsert: create the page (and any missing parents) if the path doesn't
  // resolve yet, rather than 404ing — so writeFile can create new pages.
  const pageId = await resolveOrCreatePath(c, rootId, path);
  try {
    await c.pages.updateMarkdown({
      page_id: pageId,
      type: 'replace_content',
      replace_content: { new_str: content, allow_deleting_content: true },
    });
  } catch (err) {
    throw mapError(err, `writeFile(${pageId})`);
  }
}

/** No-op. Notion has no branch concept. */
export async function ensureBranch(env: SourceEnv, rootUrl: string, branch: string): Promise<void> {
  void env;
  void rootUrl;
  void branch;
}

/** Not applicable to Notion — throws. Notion has no fork primitive
 * at the API level. Workspace-level duplication (manually copying a
 * page into another workspace) isn't something the adapter
 * automates. */
export async function ensureFork(env: SourceEnv, upstreamUrl: string): Promise<string> {
  void env;
  throw new SourceApiError(`Fork is not supported for the Notion source: ${upstreamUrl}`, 501);
}

/** Not applicable to Notion — throws. */
export async function openPullRequest(
  env: SourceEnv,
  targetUrl: string,
  head: string,
  base: string,
  title: string,
  body: string
): Promise<string> {
  void env;
  void head;
  void base;
  void title;
  void body;
  throw new SourceApiError(
    `Pull requests are not supported for the Notion source: ${targetUrl}`,
    501
  );
}

/** Returns 'live' as a stable sentinel. Notion has no branch /
 * default-branch concept; callers that branch on default-branch-name
 * stay correct without special-casing the adapter. */
export async function getDefaultBranch(env: SourceEnv, rootUrl: string): Promise<string> {
  void env;
  void rootUrl;
  return 'live';
}

/** Aggregate export — pass `notion` to code that accepts a generic
 * SourceAdapter. */
export const notion = {
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
