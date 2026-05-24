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
// Markdown ↔ blocks: this file ships its own minimal converter
// covering the block types we care about for project-record content:
// paragraphs, headings (1-3), bulleted + numbered list items, code
// blocks (with language), blockquote, divider. Other block types are
// preserved on read in a best-effort way (rendered as a text dump
// with a comment marker); writes that include unsupported block
// shapes round-trip as paragraphs. Document content created by
// humans in Notion with rich features may not round-trip losslessly
// through a write — this adapter targets aigency-generated content
// (ADRs, intent docs, tech-stack notes) where the supported subset
// is sufficient.

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

// ---------------------------------------------------------------------------
// Block ↔ Markdown — minimal converter for the subset we use
// ---------------------------------------------------------------------------

/** Fetch every block child of a page (transparent pagination). */
async function fetchAllBlocks(c: Client, pageId: string): Promise<BlockObjectResponse[]> {
  const all: BlockObjectResponse[] = [];
  let cursor: string | undefined;
  do {
    const resp = await c.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const block of resp.results as Array<BlockObjectResponse | PartialBlockObjectResponse>) {
      if (isFullBlock(block)) all.push(block);
    }
    cursor = resp.has_more ? (resp.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return all;
}

/** Render an array of rich-text spans to a Markdown inline string.
 * Supports bold / italic / code / strikethrough / link annotations. */
function richTextToMarkdown(
  spans: Array<{
    type: 'text';
    text: { content: string; link: { url: string } | null };
    annotations: {
      bold: boolean;
      italic: boolean;
      strikethrough: boolean;
      code: boolean;
      underline: boolean;
      color: string;
    };
    plain_text: string;
    href: string | null;
  }>
): string {
  return spans
    .map((span) => {
      let s = span.plain_text;
      const ann = span.annotations;
      if (ann.code) s = `\`${s}\``;
      if (ann.bold) s = `**${s}**`;
      if (ann.italic) s = `_${s}_`;
      if (ann.strikethrough) s = `~~${s}~~`;
      if (span.href) s = `[${s}](${span.href})`;
      return s;
    })
    .join('');
}

/** Top-level block → Markdown line(s). Returns the rendered string
 * (no trailing newlines beyond what the block needs). Unsupported
 * block types fall back to a `<!-- notion:<type> -->` marker so the
 * reader sees that something was there. */
function blockToMarkdown(block: BlockObjectResponse): string {
  switch (block.type) {
    case 'paragraph':
      return richTextToMarkdown(block.paragraph.rich_text as never);
    case 'heading_1':
      return `# ${richTextToMarkdown(block.heading_1.rich_text as never)}`;
    case 'heading_2':
      return `## ${richTextToMarkdown(block.heading_2.rich_text as never)}`;
    case 'heading_3':
      return `### ${richTextToMarkdown(block.heading_3.rich_text as never)}`;
    case 'bulleted_list_item':
      return `- ${richTextToMarkdown(block.bulleted_list_item.rich_text as never)}`;
    case 'numbered_list_item':
      return `1. ${richTextToMarkdown(block.numbered_list_item.rich_text as never)}`;
    case 'quote':
      return `> ${richTextToMarkdown(block.quote.rich_text as never)}`;
    case 'code': {
      const lang = block.code.language;
      const body = richTextToMarkdown(block.code.rich_text as never);
      return ['```' + lang, body, '```'].join('\n');
    }
    case 'divider':
      return '---';
    case 'child_page':
      // Child pages appear inline in the parent's block list. Render
      // as a link-style reference so the reader knows the page is a
      // child; readFile on the child returns its actual content.
      return `<!-- notion:child_page id=${block.id} title="${block.child_page.title}" -->`;
    case 'child_database':
      return `<!-- notion:child_database id=${block.id} title="${block.child_database.title}" -->`;
    default:
      return `<!-- notion:${block.type} (unsupported on read) -->`;
  }
}

function blocksToMarkdown(blocks: BlockObjectResponse[]): string {
  if (blocks.length === 0) return '';
  return blocks.map(blockToMarkdown).join('\n\n') + '\n';
}

// ---------------------------------------------------------------------------
// Markdown → blocks — minimal converter for writeFile
// ---------------------------------------------------------------------------

type BlockCreate = Parameters<Client['blocks']['children']['append']>[0]['children'][number];

/** Plain text → a single rich_text span. We don't parse inline
 * Markdown (no bold/italic/links) — the round-trip preserves
 * literal text so authors can edit in Notion. Full inline parsing
 * is a future addition if/when consumers need it. */
function plainRichText(text: string): { type: 'text'; text: { content: string } }[] {
  if (!text) return [];
  return [{ type: 'text', text: { content: text } }];
}

/** Convert a Markdown string into an array of Notion block-create
 * objects suitable for `blocks.children.append`. Supports the same
 * block types as the read side: headings (1-3), paragraphs, bulleted
 * and numbered lists, code fences (with language), blockquote,
 * `---` divider. Unrecognised lines become paragraphs.
 *
 * Limitations (v0):
 *   - No inline formatting (bold/italic/link/inline-code parsing).
 *     Literal Markdown syntax round-trips as-is in the page.
 *   - No nested lists. Indented list items become top-level items.
 *   - No tables (Notion's table blocks have a different shape).
 *   - No images / files / embeds.
 *
 * The intent is round-tripping aigency-generated Markdown (ADRs,
 * intent docs, tech-stack notes); human-edited Notion content with
 * rich features should not be writeFile'd through this adapter. */
export function markdownToBlocks(markdown: string): BlockCreate[] {
  const lines = markdown.split('\n');
  const blocks: BlockCreate[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Skip blank lines between blocks.
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Fenced code block.
    const codeFence = line.match(/^```(.*)$/);
    if (codeFence) {
      const lang = codeFence[1].trim() || 'plain text';
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        body.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // consume closing fence
      blocks.push({
        type: 'code',
        code: {
          rich_text: plainRichText(body.join('\n')),
          language: normaliseLanguage(lang),
        },
      });
      continue;
    }

    // Headings.
    const h1 = line.match(/^# (.*)$/);
    if (h1) {
      blocks.push({
        type: 'heading_1',
        heading_1: { rich_text: plainRichText(h1[1]) },
      });
      i++;
      continue;
    }
    const h2 = line.match(/^## (.*)$/);
    if (h2) {
      blocks.push({
        type: 'heading_2',
        heading_2: { rich_text: plainRichText(h2[1]) },
      });
      i++;
      continue;
    }
    const h3 = line.match(/^### (.*)$/);
    if (h3) {
      blocks.push({
        type: 'heading_3',
        heading_3: { rich_text: plainRichText(h3[1]) },
      });
      i++;
      continue;
    }

    // Divider.
    if (line.match(/^---+\s*$/)) {
      blocks.push({ type: 'divider', divider: {} });
      i++;
      continue;
    }

    // Bulleted list item.
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      blocks.push({
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: plainRichText(bullet[1]) },
      });
      i++;
      continue;
    }

    // Numbered list item.
    const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (numbered) {
      blocks.push({
        type: 'numbered_list_item',
        numbered_list_item: { rich_text: plainRichText(numbered[1]) },
      });
      i++;
      continue;
    }

    // Blockquote (run of lines starting with > collapse into one
    // quote block).
    if (line.startsWith('> ')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith('> ')) {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      blocks.push({
        type: 'quote',
        quote: { rich_text: plainRichText(quoteLines.join('\n')) },
      });
      continue;
    }

    // Default: paragraph. A paragraph is a run of consecutive
    // non-blank lines that don't match any other block start.
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].match(/^#+ /) &&
      !lines[i].match(/^```/) &&
      !lines[i].match(/^---+\s*$/) &&
      !lines[i].match(/^\s*[-*+]\s+/) &&
      !lines[i].match(/^\s*\d+\.\s+/) &&
      !lines[i].startsWith('> ')
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push({
        type: 'paragraph',
        paragraph: { rich_text: plainRichText(paraLines.join('\n')) },
      });
    }
  }
  return blocks;
}

// Notion's code block requires a specific language enum. Map common
// aliases; fall back to 'plain text' for unknowns.
function normaliseLanguage(input: string): NotionCodeLanguage {
  const supported = new Set<NotionCodeLanguage>([
    'abap',
    'arduino',
    'bash',
    'basic',
    'c',
    'clojure',
    'coffeescript',
    'c++',
    'c#',
    'css',
    'dart',
    'diff',
    'docker',
    'elixir',
    'elm',
    'erlang',
    'flow',
    'fortran',
    'f#',
    'gherkin',
    'glsl',
    'go',
    'graphql',
    'groovy',
    'haskell',
    'html',
    'java',
    'javascript',
    'json',
    'julia',
    'kotlin',
    'latex',
    'less',
    'lisp',
    'livescript',
    'lua',
    'makefile',
    'markdown',
    'markup',
    'matlab',
    'mermaid',
    'nix',
    'objective-c',
    'ocaml',
    'pascal',
    'perl',
    'php',
    'plain text',
    'powershell',
    'prolog',
    'protobuf',
    'python',
    'r',
    'reason',
    'ruby',
    'rust',
    'sass',
    'scala',
    'scheme',
    'scss',
    'shell',
    'sql',
    'swift',
    'typescript',
    'vb.net',
    'verilog',
    'vhdl',
    'visual basic',
    'webassembly',
    'xml',
    'yaml',
  ]);
  const lower = input.toLowerCase().trim();
  const aliases: Record<string, NotionCodeLanguage> = {
    js: 'javascript',
    ts: 'typescript',
    py: 'python',
    rb: 'ruby',
    sh: 'shell',
    yml: 'yaml',
    md: 'markdown',
    'c++': 'c++',
    cpp: 'c++',
    cs: 'c#',
    fs: 'f#',
    text: 'plain text',
    '': 'plain text',
  };
  if (aliases[lower]) return aliases[lower];
  if (supported.has(lower as NotionCodeLanguage)) return lower as NotionCodeLanguage;
  return 'plain text';
}

type NotionCodeLanguage =
  | 'abap'
  | 'arduino'
  | 'bash'
  | 'basic'
  | 'c'
  | 'clojure'
  | 'coffeescript'
  | 'c++'
  | 'c#'
  | 'css'
  | 'dart'
  | 'diff'
  | 'docker'
  | 'elixir'
  | 'elm'
  | 'erlang'
  | 'flow'
  | 'fortran'
  | 'f#'
  | 'gherkin'
  | 'glsl'
  | 'go'
  | 'graphql'
  | 'groovy'
  | 'haskell'
  | 'html'
  | 'java'
  | 'javascript'
  | 'json'
  | 'julia'
  | 'kotlin'
  | 'latex'
  | 'less'
  | 'lisp'
  | 'livescript'
  | 'lua'
  | 'makefile'
  | 'markdown'
  | 'markup'
  | 'matlab'
  | 'mermaid'
  | 'nix'
  | 'objective-c'
  | 'ocaml'
  | 'pascal'
  | 'perl'
  | 'php'
  | 'plain text'
  | 'powershell'
  | 'prolog'
  | 'protobuf'
  | 'python'
  | 'r'
  | 'reason'
  | 'ruby'
  | 'rust'
  | 'sass'
  | 'scala'
  | 'scheme'
  | 'scss'
  | 'shell'
  | 'sql'
  | 'swift'
  | 'typescript'
  | 'vb.net'
  | 'verilog'
  | 'vhdl'
  | 'visual basic'
  | 'webassembly'
  | 'xml'
  | 'yaml';

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
    const blocks = await fetchAllBlocks(c, pageId);
    const content = blocksToMarkdown(blocks);
    const lastEditedTime = isFullPage(page as PageObjectResponse)
      ? (page as PageObjectResponse).last_edited_time
      : '';
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

/** Replace the page's children (block tree) with a fresh tree
 * converted from the Markdown body. Atomic-ish at v0: delete all
 * existing children, then append the new ones. Notion has no
 * transactional API surface here; a failure between delete and
 * append leaves the page empty until the next successful write.
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
  const pageId = await resolvePath(c, rootId, path);
  try {
    // Delete existing children (one API call per block; pagination
    // for read so we know what to delete).
    const existing = await fetchAllBlocks(c, pageId);
    for (const block of existing) {
      await c.blocks.delete({ block_id: block.id });
    }
    // Append the new block tree. Notion caps appends at 100 blocks
    // per call; chunk if needed.
    const newBlocks = markdownToBlocks(content);
    const chunkSize = 100;
    for (let i = 0; i < newBlocks.length; i += chunkSize) {
      await c.blocks.children.append({
        block_id: pageId,
        children: newBlocks.slice(i, i + chunkSize),
      });
    }
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
