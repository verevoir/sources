// @verevoir/sources/trello — Trello board adapter
//
// Implements the SourceAdapter contract over Trello's REST API using
// native fetch. The "repo" concept maps to a Board; lists are dirs;
// cards are files. No branching — ensureBranch is a no-op, fork/PR
// throw 501.
//
// Item-ID conventions (the `path` parameter):
//   <cardId>          — the card's description (markdown). readFile
//                       returns `.desc`; writeFile updates it.
//   <cardId>/comments — the card's comment thread. readFile renders
//                       all comments as markdown; writeFile posts a
//                       new comment (does NOT replace).
//   ''                — when used as `listFiles` prefix, returns the
//                       board's lists (dir-shaped).
//   <listId>          — when used as `listFiles` prefix, returns cards
//                       in that list.
//
// Auth: Trello needs an API key + a user OAuth token. Pack both into
// `SourceEnv.token` as "<apiKey>:<apiToken>". Split on the FIRST `:` so
// tokens that themselves contain `:` are handled correctly.

import {
  SourceApiError,
  type SourceEnv,
  type ReadFileResult,
  type DirEntry,
  type RepoTree,
  type TreeEntry,
} from '../index.js';

const TRELLO_API = 'https://api.trello.com/1';

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/** Build a SourceEnv from TRELLO_API_KEY + TRELLO_API_TOKEN process env vars.
 * Returns null when either var is missing. */
export function envFromTrelloProcessEnv(): SourceEnv | null {
  const key = process.env.TRELLO_API_KEY ?? '';
  const token = process.env.TRELLO_API_TOKEN ?? '';
  if (!key || !token) return null;
  return { token: `${key}:${token}`, forkOrg: '' };
}

/** Split `env.token` into apiKey + apiToken. Throws if the format is wrong. */
function parseTrelloAuth(env: SourceEnv): { apiKey: string; apiToken: string } {
  const idx = env.token.indexOf(':');
  if (idx < 1) {
    throw new SourceApiError('Trello env.token must be "<apiKey>:<apiToken>"');
  }
  return { apiKey: env.token.slice(0, idx), apiToken: env.token.slice(idx + 1) };
}

// Export for tests.
export { parseTrelloAuth };

// ---------------------------------------------------------------------------
// URL parser
// ---------------------------------------------------------------------------

/** Accepts `https://trello.com/b/<boardId>` or
 * `https://trello.com/b/<boardId>/<slug>`. Returns null on mismatch. */
export function parseTrelloBoardUrl(input: string): { boardId: string } | null {
  const m = input.trim().match(/^https?:\/\/trello\.com\/b\/([^/?#/]+)/i);
  if (!m) return null;
  return { boardId: m[1] };
}

function boardId(url: string): string {
  const parsed = parseTrelloBoardUrl(url);
  if (!parsed) throw new SourceApiError(`Cannot parse Trello board URL: ${url}`);
  return parsed.boardId;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function trelloCall<T>(
  env: SourceEnv,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: Record<string, unknown>
): Promise<T> {
  const { apiKey, apiToken } = parseTrelloAuth(env);
  const qs = new URLSearchParams({ key: apiKey, token: apiToken });
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${TRELLO_API}${path}?${qs}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) throw new SourceApiError('not_found', 404);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new SourceApiError(`${method} ${path}: ${res.status}`, res.status, detail.slice(0, 300));
  }
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Trello API shapes (only the fields we use)
// ---------------------------------------------------------------------------

interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  idList: string;
  dateLastActivity: string;
}

interface TrelloList {
  id: string;
  name: string;
}

interface TrelloComment {
  data: { text: string };
  memberCreator: { fullName: string };
  date: string;
}

// ---------------------------------------------------------------------------
// Adapter functions
// ---------------------------------------------------------------------------

export async function readFile(
  env: SourceEnv,
  boardUrl: string,
  path: string,
  ref?: string
): Promise<ReadFileResult> {
  void ref;
  void boardId(boardUrl); // validate URL early; board context isn't needed for card calls

  if (path.endsWith('/comments')) {
    const cardId = path.slice(0, -'/comments'.length);
    const comments = await trelloCall<TrelloComment[]>(
      env,
      'GET',
      `/cards/${cardId}/actions?filter=commentCard&limit=50`
    );
    if (comments.length === 0) return { content: '', sha: '' };
    const blocks = comments.map(
      (c) => `## ${c.memberCreator.fullName} — ${c.date}\n\n${c.data.text}`
    );
    return {
      content: blocks.join('\n\n---\n\n'),
      sha: comments[0].date, // most-recent first (Trello default order)
    };
  }

  const card = await trelloCall<TrelloCard>(env, 'GET', `/cards/${path}`);
  return { content: card.desc ?? '', sha: card.dateLastActivity };
}

export async function listFiles(
  env: SourceEnv,
  boardUrl: string,
  prefix: string,
  ref?: string
): Promise<DirEntry[]> {
  void ref;
  const bid = boardId(boardUrl);

  if (prefix === '') {
    const lists = await trelloCall<TrelloList[]>(env, 'GET', `/boards/${bid}/lists`);
    return lists.map((l) => ({ name: l.name, type: 'dir' as const, path: l.id, sha: '' }));
  }

  // prefix is a listId — return cards in that list
  const cards = await trelloCall<TrelloCard[]>(env, 'GET', `/lists/${prefix}/cards`);
  return cards.map((c) => ({
    name: c.name,
    type: 'file' as const,
    path: c.id,
    sha: c.dateLastActivity,
  }));
}

export async function getRepoTree(
  env: SourceEnv,
  boardUrl: string,
  ref?: string
): Promise<RepoTree> {
  void ref;
  const bid = boardId(boardUrl);

  const [lists, cards] = await Promise.all([
    trelloCall<TrelloList[]>(env, 'GET', `/boards/${bid}/lists`),
    trelloCall<TrelloCard[]>(env, 'GET', `/boards/${bid}/cards`),
  ]);

  const entries: TreeEntry[] = [];
  for (const l of lists) {
    entries.push({ path: l.id, type: 'tree', sha: '' });
  }
  for (const c of cards) {
    entries.push({
      path: `${c.idList}/${c.id}`,
      type: 'blob',
      size: undefined,
      sha: c.dateLastActivity,
    });
  }

  return { entries, truncated: false };
}

export async function writeFile(
  env: SourceEnv,
  boardUrl: string,
  path: string,
  content: string,
  branch: string,
  commitMessage: string
): Promise<void> {
  void branch;
  void commitMessage;
  void boardId(boardUrl); // validate URL

  if (path.endsWith('/comments')) {
    const cardId = path.slice(0, -'/comments'.length);
    await trelloCall(env, 'POST', `/cards/${cardId}/actions/comments`, { text: content });
    return;
  }

  // Must be a bare cardId (no `/`)
  if (!path || path.includes('/')) {
    throw new SourceApiError(`Unsupported write path: ${path}`);
  }

  await trelloCall(env, 'PUT', `/cards/${path}`, { desc: content });
}

/** No-op — Trello has no branch concept. */
export async function ensureBranch(
  env: SourceEnv,
  boardUrl: string,
  branch: string
): Promise<void> {
  void env;
  void boardUrl;
  void branch;
}

export async function ensureFork(env: SourceEnv, upstreamUrl: string): Promise<string> {
  void env;
  throw new SourceApiError(`Fork is not supported for the Trello source: ${upstreamUrl}`, 501);
}

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
    `Pull requests are not supported for the Trello source: ${targetUrl}`,
    501
  );
}

/** Returns a stable sentinel — Trello boards have no branch concept. */
export async function getDefaultBranch(env: SourceEnv, boardUrl: string): Promise<string> {
  void env;
  void boardUrl;
  return 'board';
}

/** Aggregate export — pass `trello` to code that accepts a generic SourceAdapter. */
export const trello = {
  readFile,
  listFiles,
  getRepoTree,
  writeFile,
  ensureBranch,
  ensureFork,
  openPullRequest,
  getDefaultBranch,
};
