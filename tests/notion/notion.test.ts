import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseNotionPageUrl, slugify } from '../../src/notion/index.js';
import { SourceApiError, type SourceEnv } from '../../src/index.js';

// ---------------------------------------------------------------------------
// Pure-function tests — no SDK needed
// ---------------------------------------------------------------------------

describe('parseNotionPageUrl', () => {
  const DASHED = 'aabbccdd-1122-3344-5566-7788990aabb0';
  const RAW = 'aabbccdd1122334455667788990aabb0';

  it('parses dashed UUIDs as-is (lowercased)', () => {
    expect(parseNotionPageUrl(DASHED)).toEqual({ pageId: DASHED });
    expect(parseNotionPageUrl(DASHED.toUpperCase())).toEqual({ pageId: DASHED });
  });

  it('dashifies 32-hex raw IDs', () => {
    const dashed = 'aabbccdd-1122-3344-5566-77889900aabb0'.slice(0, 36);
    const raw = 'aabbccdd1122334455667788990aabb0';
    expect(parseNotionPageUrl(raw)).toEqual({
      pageId: 'aabbccdd-1122-3344-5566-7788990aabb0',
    });
    void dashed;
  });

  it('extracts page IDs from canonical workspace URLs', () => {
    expect(parseNotionPageUrl('https://www.notion.so/myworkspace/Project-Intent-' + RAW)).toEqual({
      pageId: 'aabbccdd-1122-3344-5566-7788990aabb0',
    });
  });

  it('extracts page IDs from URLs without a workspace segment', () => {
    expect(parseNotionPageUrl(`https://notion.so/${RAW}`)).toEqual({
      pageId: 'aabbccdd-1122-3344-5566-7788990aabb0',
    });
  });

  it('handles query strings and fragments', () => {
    expect(parseNotionPageUrl(`https://www.notion.so/Title-${RAW}?v=12345#some-block`)).toEqual({
      pageId: 'aabbccdd-1122-3344-5566-7788990aabb0',
    });
  });

  it('returns null for unparseable inputs', () => {
    expect(parseNotionPageUrl('https://example.com/not-notion')).toBeNull();
    expect(parseNotionPageUrl('not a notion id')).toBeNull();
    expect(parseNotionPageUrl('')).toBeNull();
  });
});

describe('slugify', () => {
  it('lowercases and replaces non-alphanumeric runs with single dashes', () => {
    expect(slugify('Project Intent')).toBe('project-intent');
    expect(slugify('Hello, World!')).toBe('hello-world');
    expect(slugify('ADR 023: Notion as Substrate')).toBe('adr-023-notion-as-substrate');
  });

  it('trims leading/trailing dashes', () => {
    expect(slugify('!!! Loud !!!')).toBe('loud');
  });

  it('preserves digits', () => {
    expect(slugify('v0 scope 2026-05-24')).toBe('v0-scope-2026-05-24');
  });
});

// ---------------------------------------------------------------------------
// SDK-mocked tests — readFile / isFresh / writeFile
// ---------------------------------------------------------------------------

// Mock the Notion SDK at module level. Tests can swap in fresh
// stub implementations per test via the returned mock helpers.
vi.mock('@notionhq/client', async () => {
  const actual = await vi.importActual<typeof import('@notionhq/client')>('@notionhq/client');
  function MockClient(this: unknown, _options: unknown) {
    // Returning a non-undefined object from a constructor makes
    // `new MockClient(...)` evaluate to that object — letting each
    // test swap in fresh stub method spies via the shared
    // `clientStub` reference.
    return clientStub;
  }
  return {
    ...actual,
    Client: MockClient,
  };
});

interface ClientStub {
  blocks: {
    children: {
      list: ReturnType<typeof vi.fn>;
    };
  };
  pages: {
    retrieve: ReturnType<typeof vi.fn>;
    retrieveMarkdown: ReturnType<typeof vi.fn>;
    updateMarkdown: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
}

let clientStub: ClientStub;

beforeEach(() => {
  clientStub = {
    blocks: {
      children: { list: vi.fn() },
    },
    pages: {
      retrieve: vi.fn(),
      retrieveMarkdown: vi.fn(),
      updateMarkdown: vi.fn(),
      create: vi.fn(),
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

const ENV: SourceEnv = { token: 'ntn_test_token', forkOrg: '' };
const ROOT_URL = 'https://www.notion.so/myworkspace/Root-aabbccdd1122334455667788990aabb0';
const ROOT_ID = 'aabbccdd-1122-3344-5566-7788990aabb0';

function fullPage(id: string, lastEditedTime: string): unknown {
  return {
    object: 'page',
    id,
    last_edited_time: lastEditedTime,
    created_time: lastEditedTime,
    parent: { type: 'workspace', workspace: true },
    archived: false,
    properties: {},
    url: `https://notion.so/${id}`,
    public_url: null,
    cover: null,
    icon: null,
    created_by: { object: 'user', id: 'u1' },
    last_edited_by: { object: 'user', id: 'u1' },
    in_trash: false,
  };
}

describe('readFile', () => {
  it('returns the page body via retrieveMarkdown + last_edited_time as sha', async () => {
    // Resolve path '': just return the root page. No child lookup needed.
    clientStub.pages.retrieve.mockResolvedValue(fullPage(ROOT_ID, '2026-05-24T12:00:00.000Z'));
    clientStub.pages.retrieveMarkdown.mockResolvedValue({
      markdown: 'Hello world\n\nSecond paragraph\n',
    });

    const { readFile } = await import('../../src/notion/index.js');
    const result = await readFile(ENV, ROOT_URL, '');

    expect(result.sha).toBe('2026-05-24T12:00:00.000Z');
    expect(result.content).toBe('Hello world\n\nSecond paragraph\n');
  });

  it('treats a 404 on the body endpoint as an empty body (page still exists)', async () => {
    clientStub.pages.retrieve.mockResolvedValue(fullPage(ROOT_ID, '2026-05-24T12:00:00.000Z'));
    clientStub.pages.retrieveMarkdown.mockRejectedValue({ code: 'object_not_found', status: 404 });

    const { readFile } = await import('../../src/notion/index.js');
    const result = await readFile(ENV, ROOT_URL, '');

    expect(result.content).toBe('');
    expect(result.sha).toBe('2026-05-24T12:00:00.000Z');
  });

  it('throws SourceApiError(404) when the path does not resolve', async () => {
    // Trying to resolve 'missing-page' under root: list children returns nothing.
    clientStub.blocks.children.list.mockResolvedValue({
      results: [],
      has_more: false,
      next_cursor: null,
    });

    const { readFile } = await import('../../src/notion/index.js');
    await expect(readFile(ENV, ROOT_URL, 'missing-page')).rejects.toMatchObject({
      name: 'SourceApiError',
      status: 404,
    });
  });
});

describe('isFresh', () => {
  it('returns true when the held version matches the current last_edited_time', async () => {
    clientStub.pages.retrieve.mockResolvedValue(fullPage(ROOT_ID, '2026-05-24T12:00:00.000Z'));
    const { isFresh } = await import('../../src/notion/index.js');
    await expect(isFresh(ENV, ROOT_URL, '', '2026-05-24T12:00:00.000Z')).resolves.toBe(true);
  });

  it('returns false when the page has been edited since', async () => {
    clientStub.pages.retrieve.mockResolvedValue(fullPage(ROOT_ID, '2026-05-24T13:00:00.000Z'));
    const { isFresh } = await import('../../src/notion/index.js');
    await expect(isFresh(ENV, ROOT_URL, '', '2026-05-24T12:00:00.000Z')).resolves.toBe(false);
  });

  it('returns false when the page no longer resolves (404)', async () => {
    clientStub.blocks.children.list.mockResolvedValue({
      results: [],
      has_more: false,
      next_cursor: null,
    });
    const { isFresh } = await import('../../src/notion/index.js');
    await expect(isFresh(ENV, ROOT_URL, 'gone-page', 'whatever')).resolves.toBe(false);
  });
});

describe('writeFile', () => {
  it('replaces the page body via updateMarkdown (replace_content)', async () => {
    clientStub.pages.updateMarkdown.mockResolvedValue({});

    const { writeFile } = await import('../../src/notion/index.js');
    await writeFile(ENV, ROOT_URL, '', '# Replaced\n\nNew body.', 'ignored', 'ignored');

    expect(clientStub.pages.updateMarkdown).toHaveBeenCalledTimes(1);
    const call = clientStub.pages.updateMarkdown.mock.calls[0]?.[0] as {
      page_id: string;
      type: string;
      replace_content: { new_str: string; allow_deleting_content: boolean };
    };
    expect(call.type).toBe('replace_content');
    expect(call.replace_content).toEqual({
      new_str: '# Replaced\n\nNew body.',
      allow_deleting_content: true,
    });
  });

  it('upserts: creates the page when the path does not exist, then writes it', async () => {
    // No children under root → the segment doesn't resolve → it's created.
    clientStub.blocks.children.list.mockResolvedValue({
      results: [],
      has_more: false,
      next_cursor: null,
    });
    clientStub.pages.create.mockResolvedValue({ id: 'new-page-id' });
    clientStub.pages.updateMarkdown.mockResolvedValue({});

    const { writeFile } = await import('../../src/notion/index.js');
    await writeFile(ENV, ROOT_URL, 'The Capability Model', '# Model', 'x', 'x');

    // created a child page titled by the segment…
    expect(clientStub.pages.create).toHaveBeenCalledTimes(1);
    const createArg = clientStub.pages.create.mock.calls[0]?.[0] as {
      parent: { page_id: string };
    };
    expect(createArg.parent.page_id).toBe(ROOT_ID);
    // …then wrote the body to the new page, not the root.
    const writeArg = clientStub.pages.updateMarkdown.mock.calls[0]?.[0] as {
      page_id: string;
    };
    expect(writeArg.page_id).toBe('new-page-id');
  });

  it('updates in place when the path already exists (idempotent, no create)', async () => {
    clientStub.blocks.children.list.mockResolvedValue({
      results: [
        {
          object: 'block',
          id: 'existing-id',
          type: 'child_page',
          child_page: { title: 'The Capability Model' },
          last_edited_time: '2026-06-06T00:00:00.000Z',
          has_children: true,
        },
      ],
      has_more: false,
      next_cursor: null,
    });
    clientStub.pages.updateMarkdown.mockResolvedValue({});

    const { writeFile } = await import('../../src/notion/index.js');
    await writeFile(ENV, ROOT_URL, 'the-capability-model', '# Model v2', 'x', 'x');

    expect(clientStub.pages.create).not.toHaveBeenCalled();
    const writeArg = clientStub.pages.updateMarkdown.mock.calls[0]?.[0] as {
      page_id: string;
    };
    expect(writeArg.page_id).toBe('existing-id');
  });
});

describe('not-applicable operations', () => {
  it('ensureBranch is a no-op', async () => {
    const { ensureBranch } = await import('../../src/notion/index.js');
    await expect(ensureBranch(ENV, ROOT_URL, 'main')).resolves.toBeUndefined();
  });

  it('ensureFork throws 501', async () => {
    const { ensureFork } = await import('../../src/notion/index.js');
    await expect(ensureFork(ENV, ROOT_URL)).rejects.toMatchObject({
      name: 'SourceApiError',
      status: 501,
    });
  });

  it('openPullRequest throws 501', async () => {
    const { openPullRequest } = await import('../../src/notion/index.js');
    await expect(openPullRequest(ENV, ROOT_URL, 'h', 'b', 't', 'body')).rejects.toBeInstanceOf(
      SourceApiError
    );
  });

  it("getDefaultBranch returns 'live'", async () => {
    const { getDefaultBranch } = await import('../../src/notion/index.js');
    await expect(getDefaultBranch(ENV, ROOT_URL)).resolves.toBe('live');
  });
});
