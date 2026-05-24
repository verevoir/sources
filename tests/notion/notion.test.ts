import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseNotionPageUrl, slugify, markdownToBlocks } from '../../src/notion/index.js';
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

describe('markdownToBlocks — minimal converter', () => {
  it('renders an empty string as no blocks', () => {
    expect(markdownToBlocks('')).toEqual([]);
  });

  it('renders headings 1-3', () => {
    const blocks = markdownToBlocks('# H1\n\n## H2\n\n### H3');
    expect(blocks).toHaveLength(3);
    expect(blocks[0].type).toBe('heading_1');
    expect(blocks[1].type).toBe('heading_2');
    expect(blocks[2].type).toBe('heading_3');
  });

  it('groups consecutive non-block lines into a single paragraph', () => {
    const blocks = markdownToBlocks('Line one\nLine two\nLine three');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('paragraph');
    const richText = (
      blocks[0] as { paragraph: { rich_text: Array<{ text: { content: string } }> } }
    ).paragraph.rich_text;
    expect(richText[0].text.content).toBe('Line one\nLine two\nLine three');
  });

  it('parses fenced code blocks with a language', () => {
    const md = '```ts\nconst x = 1;\n```';
    const blocks = markdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    const code = blocks[0] as {
      type: 'code';
      code: { language: string; rich_text: Array<{ text: { content: string } }> };
    };
    expect(code.type).toBe('code');
    expect(code.code.language).toBe('typescript'); // alias resolved
    expect(code.code.rich_text[0].text.content).toBe('const x = 1;');
  });

  it('parses bulleted and numbered lists as separate list-item blocks', () => {
    const blocks = markdownToBlocks('- One\n- Two\n\n1. First\n2. Second');
    expect(blocks).toHaveLength(4);
    expect(blocks[0].type).toBe('bulleted_list_item');
    expect(blocks[1].type).toBe('bulleted_list_item');
    expect(blocks[2].type).toBe('numbered_list_item');
    expect(blocks[3].type).toBe('numbered_list_item');
  });

  it('parses `---` as a divider', () => {
    const blocks = markdownToBlocks('Above\n\n---\n\nBelow');
    expect(blocks).toHaveLength(3);
    expect(blocks[0].type).toBe('paragraph');
    expect(blocks[1].type).toBe('divider');
    expect(blocks[2].type).toBe('paragraph');
  });

  it('collapses consecutive blockquote lines into one quote block', () => {
    const blocks = markdownToBlocks('> first quoted line\n> second quoted line');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('quote');
    const quote = blocks[0] as { quote: { rich_text: Array<{ text: { content: string } }> } };
    expect(quote.quote.rich_text[0].text.content).toBe('first quoted line\nsecond quoted line');
  });

  it('normalises common code-block language aliases', () => {
    const cases: Array<[string, string]> = [
      ['js', 'javascript'],
      ['ts', 'typescript'],
      ['py', 'python'],
      ['rb', 'ruby'],
      ['sh', 'shell'],
      ['yml', 'yaml'],
      ['', 'plain text'],
      ['nonsense-language', 'plain text'],
    ];
    for (const [input, expected] of cases) {
      const blocks = markdownToBlocks('```' + input + '\nbody\n```');
      const code = blocks[0] as { code: { language: string } };
      expect(code.code.language).toBe(expected);
    }
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
      append: ReturnType<typeof vi.fn>;
    };
    delete: ReturnType<typeof vi.fn>;
  };
  pages: {
    retrieve: ReturnType<typeof vi.fn>;
  };
}

let clientStub: ClientStub;

beforeEach(() => {
  clientStub = {
    blocks: {
      children: { list: vi.fn(), append: vi.fn() },
      delete: vi.fn(),
    },
    pages: { retrieve: vi.fn() },
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

function paragraphBlock(
  id: string,
  text: string,
  lastEditedTime = '2026-05-24T10:00:00.000Z'
): unknown {
  return {
    object: 'block',
    id,
    parent: { type: 'page_id', page_id: ROOT_ID },
    type: 'paragraph',
    paragraph: {
      rich_text: [
        {
          type: 'text',
          text: { content: text, link: null },
          annotations: {
            bold: false,
            italic: false,
            strikethrough: false,
            underline: false,
            code: false,
            color: 'default',
          },
          plain_text: text,
          href: null,
        },
      ],
      color: 'default',
    },
    has_children: false,
    archived: false,
    created_time: lastEditedTime,
    last_edited_time: lastEditedTime,
    created_by: { object: 'user', id: 'u1' },
    last_edited_by: { object: 'user', id: 'u1' },
    in_trash: false,
  };
}

describe('readFile', () => {
  it('returns blocks rendered to Markdown + last_edited_time as sha', async () => {
    // Resolve path '': just return the root page. No child lookup needed.
    clientStub.pages.retrieve.mockResolvedValue(fullPage(ROOT_ID, '2026-05-24T12:00:00.000Z'));
    clientStub.blocks.children.list.mockResolvedValue({
      results: [paragraphBlock('b1', 'Hello world'), paragraphBlock('b2', 'Second paragraph')],
      has_more: false,
      next_cursor: null,
    });

    const { readFile } = await import('../../src/notion/index.js');
    const result = await readFile(ENV, ROOT_URL, '');

    expect(result.sha).toBe('2026-05-24T12:00:00.000Z');
    expect(result.content).toBe('Hello world\n\nSecond paragraph\n');
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
  it('deletes existing children then appends the Markdown-converted blocks', async () => {
    clientStub.blocks.children.list.mockResolvedValue({
      results: [paragraphBlock('old-1', 'old content')],
      has_more: false,
      next_cursor: null,
    });
    clientStub.blocks.delete.mockResolvedValue({});
    clientStub.blocks.children.append.mockResolvedValue({ results: [] });

    const { writeFile } = await import('../../src/notion/index.js');
    await writeFile(ENV, ROOT_URL, '', '# Replaced\n\nNew body.', 'ignored', 'ignored');

    expect(clientStub.blocks.delete).toHaveBeenCalledWith({ block_id: 'old-1' });
    expect(clientStub.blocks.children.append).toHaveBeenCalledTimes(1);
    const appendCall = clientStub.blocks.children.append.mock.calls[0]?.[0] as {
      block_id: string;
      children: Array<{ type: string }>;
    };
    expect(appendCall.children).toHaveLength(2);
    expect(appendCall.children[0].type).toBe('heading_1');
    expect(appendCall.children[1].type).toBe('paragraph');
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
