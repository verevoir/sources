import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseTrelloBoardUrl,
  parseTrelloAuth,
  envFromTrelloProcessEnv,
  readFile,
  listFiles,
  getRepoTree,
  writeFile,
  ensureBranch,
  ensureFork,
  openPullRequest,
  getDefaultBranch,
  trello,
} from '../../src/trello/index.js';
import { SourceApiError, type SourceEnv } from '../../src/index.js';

const env: SourceEnv = { token: 'testkey:testtoken', forkOrg: '' };
const boardUrl = 'https://trello.com/b/abc123/my-board';
const boardId = 'abc123';

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    })
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// parseTrelloBoardUrl
// ---------------------------------------------------------------------------

describe('parseTrelloBoardUrl', () => {
  it('parses URL without slug', () => {
    expect(parseTrelloBoardUrl('https://trello.com/b/abc123')).toEqual({ boardId: 'abc123' });
  });

  it('parses URL with slug', () => {
    expect(parseTrelloBoardUrl('https://trello.com/b/abc123/my-board')).toEqual({
      boardId: 'abc123',
    });
  });

  it('returns null for non-Trello URL', () => {
    expect(parseTrelloBoardUrl('https://github.com/user/repo')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseTrelloBoardUrl('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseTrelloAuth
// ---------------------------------------------------------------------------

describe('parseTrelloAuth', () => {
  it('splits on the first colon', () => {
    const result = parseTrelloAuth({ token: 'mykey:mytoken:with:colons', forkOrg: '' });
    expect(result).toEqual({ apiKey: 'mykey', apiToken: 'mytoken:with:colons' });
  });

  it('throws SourceApiError when no colon present', () => {
    expect(() => parseTrelloAuth({ token: 'nokeytoken', forkOrg: '' })).toThrow(SourceApiError);
  });

  it('throws SourceApiError when key is empty (colon at position 0)', () => {
    expect(() => parseTrelloAuth({ token: ':justtoken', forkOrg: '' })).toThrow(SourceApiError);
  });
});

// ---------------------------------------------------------------------------
// envFromTrelloProcessEnv
// ---------------------------------------------------------------------------

describe('envFromTrelloProcessEnv', () => {
  it('returns env when both vars are set', () => {
    process.env.TRELLO_API_KEY = 'k';
    process.env.TRELLO_API_TOKEN = 't';
    const result = envFromTrelloProcessEnv();
    expect(result).toEqual({ token: 'k:t', forkOrg: '' });
    delete process.env.TRELLO_API_KEY;
    delete process.env.TRELLO_API_TOKEN;
  });

  it('returns null when key is missing', () => {
    delete process.env.TRELLO_API_KEY;
    process.env.TRELLO_API_TOKEN = 't';
    expect(envFromTrelloProcessEnv()).toBeNull();
    delete process.env.TRELLO_API_TOKEN;
  });
});

// ---------------------------------------------------------------------------
// readFile — card description
// ---------------------------------------------------------------------------

describe('readFile — card description', () => {
  it('returns card desc as content and dateLastActivity as sha', async () => {
    const card = {
      id: 'card1',
      name: 'My Card',
      desc: '# Hello',
      idList: 'list1',
      dateLastActivity: '2026-05-01T00:00:00.000Z',
    };
    mockFetch(200, card);
    const result = await readFile(env, boardUrl, 'card1');
    expect(result.content).toBe('# Hello');
    expect(result.sha).toBe('2026-05-01T00:00:00.000Z');
  });

  it('returns empty string when card has no description', async () => {
    mockFetch(200, { id: 'card1', name: 'C', desc: '', idList: 'l1', dateLastActivity: 'x' });
    const result = await readFile(env, boardUrl, 'card1');
    expect(result.content).toBe('');
  });

  it('throws SourceApiError with status 404 on 404 response', async () => {
    mockFetch(404, 'not found');
    await expect(readFile(env, boardUrl, 'missingcard')).rejects.toMatchObject({
      status: 404,
    });
  });
});

// ---------------------------------------------------------------------------
// readFile — comments
// ---------------------------------------------------------------------------

describe('readFile — comments', () => {
  it('renders comments as markdown blocks joined by ---', async () => {
    const comments = [
      {
        data: { text: 'First comment' },
        memberCreator: { fullName: 'Alice' },
        date: '2026-05-03T10:00:00.000Z',
      },
      {
        data: { text: 'Second comment' },
        memberCreator: { fullName: 'Bob' },
        date: '2026-05-02T10:00:00.000Z',
      },
    ];
    mockFetch(200, comments);
    const result = await readFile(env, boardUrl, 'card1/comments');
    expect(result.content).toContain('## Alice — 2026-05-03T10:00:00.000Z');
    expect(result.content).toContain('First comment');
    expect(result.content).toContain('---');
    expect(result.content).toContain('## Bob — 2026-05-02T10:00:00.000Z');
    // sha is the most-recent comment date (first in Trello's response)
    expect(result.sha).toBe('2026-05-03T10:00:00.000Z');
  });

  it('returns empty content and empty sha when there are no comments', async () => {
    mockFetch(200, []);
    const result = await readFile(env, boardUrl, 'card1/comments');
    expect(result.content).toBe('');
    expect(result.sha).toBe('');
  });
});

// ---------------------------------------------------------------------------
// listFiles
// ---------------------------------------------------------------------------

describe('listFiles', () => {
  it("returns lists as dir entries when prefix is ''", async () => {
    const lists = [
      { id: 'list1', name: 'To Do' },
      { id: 'list2', name: 'Done' },
    ];
    mockFetch(200, lists);
    const entries = await listFiles(env, boardUrl, '');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ name: 'To Do', type: 'dir', path: 'list1', sha: '' });
    expect(entries[1]).toEqual({ name: 'Done', type: 'dir', path: 'list2', sha: '' });
  });

  it('returns cards as file entries when prefix is a listId', async () => {
    const cards = [
      {
        id: 'card1',
        name: 'Fix bug',
        desc: '',
        idList: 'list1',
        dateLastActivity: '2026-05-01T00:00:00.000Z',
      },
      {
        id: 'card2',
        name: 'Add feature',
        desc: '',
        idList: 'list1',
        dateLastActivity: '2026-05-02T00:00:00.000Z',
      },
    ];
    mockFetch(200, cards);
    const entries = await listFiles(env, boardUrl, 'list1');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      name: 'Fix bug',
      type: 'file',
      path: 'card1',
      sha: '2026-05-01T00:00:00.000Z',
    });
  });
});

// ---------------------------------------------------------------------------
// getRepoTree
// ---------------------------------------------------------------------------

describe('getRepoTree', () => {
  it('returns list entries (tree) and card entries (blob) nested under listId', async () => {
    const lists = [{ id: 'list1', name: 'Backlog' }];
    const cards = [
      {
        id: 'cardA',
        name: 'Task',
        desc: '',
        idList: 'list1',
        dateLastActivity: '2026-05-10T00:00:00.000Z',
      },
    ];
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve(lists),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve(cards),
        })
    );
    const tree = await getRepoTree(env, boardUrl);
    expect(tree.truncated).toBe(false);
    const paths = tree.entries.map((e) => e.path);
    expect(paths).toContain('list1');
    expect(paths).toContain('list1/cardA');
    const listEntry = tree.entries.find((e) => e.path === 'list1');
    expect(listEntry?.type).toBe('tree');
    const cardEntry = tree.entries.find((e) => e.path === 'list1/cardA');
    expect(cardEntry?.type).toBe('blob');
    expect(cardEntry?.sha).toBe('2026-05-10T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// writeFile
// ---------------------------------------------------------------------------

describe('writeFile', () => {
  it('PUTs desc when path is a bare cardId', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', fetchMock);
    await writeFile(env, boardUrl, 'card1', '# Updated', 'board', 'ignored');
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/cards\/card1\?/);
    expect(opts.method).toBe('PUT');
    expect(JSON.parse(opts.body as string)).toEqual({ desc: '# Updated' });
  });

  it('POSTs comment text when path ends with /comments', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', fetchMock);
    await writeFile(env, boardUrl, 'card1/comments', 'Nice work!', 'board', 'ignored');
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/cards\/card1\/actions\/comments\?/);
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body as string)).toEqual({ text: 'Nice work!' });
  });

  it('throws SourceApiError for unsupported path containing /', async () => {
    await expect(
      writeFile(env, boardUrl, 'list1/card1/extra', 'x', 'b', 'm')
    ).rejects.toMatchObject({
      name: 'SourceApiError',
    });
  });
});

// ---------------------------------------------------------------------------
// Unsupported operations
// ---------------------------------------------------------------------------

describe('not-applicable operations', () => {
  it('ensureBranch is a no-op', async () => {
    await expect(ensureBranch(env, boardUrl, 'main')).resolves.toBeUndefined();
  });

  it('ensureFork throws 501', async () => {
    await expect(ensureFork(env, boardUrl)).rejects.toMatchObject({ status: 501 });
  });

  it('openPullRequest throws 501', async () => {
    await expect(openPullRequest(env, boardUrl, 'a', 'b', 'title', 'body')).rejects.toMatchObject({
      status: 501,
    });
  });

  it("getDefaultBranch returns 'board'", async () => {
    expect(await getDefaultBranch(env, boardUrl)).toBe('board');
  });
});

// ---------------------------------------------------------------------------
// Aggregate export
// ---------------------------------------------------------------------------

describe('trello aggregate export', () => {
  it('has all 8 adapter methods', () => {
    expect(typeof trello.readFile).toBe('function');
    expect(typeof trello.listFiles).toBe('function');
    expect(typeof trello.getRepoTree).toBe('function');
    expect(typeof trello.writeFile).toBe('function');
    expect(typeof trello.ensureBranch).toBe('function');
    expect(typeof trello.ensureFork).toBe('function');
    expect(typeof trello.openPullRequest).toBe('function');
    expect(typeof trello.getDefaultBranch).toBe('function');
  });
});
