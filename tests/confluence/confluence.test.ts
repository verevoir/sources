import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseConfluenceSpaceUrl, confluence } from '../../src/confluence/index.js';

type Call = { url: string; headers: Record<string, string> };
type Reply = [number, unknown, Record<string, string>?];

/** Stub `fetch` with a route table: each handler matches a SUBSTRING of the
 * requested URL (first match wins) and returns [status, body, headers?].
 * Records every call so tests can assert on the wire shape. */
function stubFetch(routes: [string, (call: Call) => Reply][]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const call: Call = { url, headers: (init?.headers ?? {}) as Record<string, string> };
      calls.push(call);
      const route = routes.find(([key]) => url.includes(key));
      if (!route) return new Response('no route', { status: 404 });
      const [status, body, headers] = route[1](call);
      return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
    })
  );
  return calls;
}

/** Run a promise to completion under fake timers (429 retry waits). */
async function settle<T>(p: Promise<T>): Promise<T> {
  const settled = p.then(
    (v) => ({ ok: true as const, v }),
    (e: unknown) => ({ ok: false as const, e })
  );
  await vi.runAllTimersAsync();
  const r = await settled;
  if (!r.ok) throw r.e;
  return r.v;
}

const SITE = 'https://adsurg.atlassian.net';
const SPACE_URL = `${SITE}/wiki/spaces/ENG`;
const ENV = { token: 'adam@example.com:tok-secret-123', forkOrg: '' };

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('parseConfluenceSpaceUrl', () => {
  it('parses the site and space key', () => {
    expect(parseConfluenceSpaceUrl(SPACE_URL)).toEqual({ site: SITE, spaceKey: 'ENG' });
  });

  it('ignores a trailing UI path segment', () => {
    expect(parseConfluenceSpaceUrl(`${SPACE_URL}/overview`)).toEqual({
      site: SITE,
      spaceKey: 'ENG',
    });
  });

  it('rejects a host that is not *.atlassian.net — the token would be sent there', () => {
    expect(() => parseConfluenceSpaceUrl('https://evil.example/wiki/spaces/ENG')).toThrow(
      /atlassian\.net/
    );
  });

  it('rejects http, even on a real atlassian.net host', () => {
    expect(() => parseConfluenceSpaceUrl('http://adsurg.atlassian.net/wiki/spaces/ENG')).toThrow(
      /atlassian\.net/
    );
  });

  it('rejects a URL with no space path', () => {
    expect(() => parseConfluenceSpaceUrl(SITE)).toThrow(/Confluence Cloud space URL/);
  });
});

describe('confluence adapter — reads', () => {
  it('readFile resolves the page, converts the storage body, and sends Basic auth', async () => {
    const calls = stubFetch([
      [
        '/wiki/api/v2/pages/123?body-format=storage',
        () => [
          200,
          { id: '123', version: { number: 4 }, body: { storage: { value: '<p>Hi</p>' } } },
        ],
      ],
    ]);
    const res = await confluence.readFile(ENV, SPACE_URL, '123');
    expect(res).toEqual({ kind: 'found', content: 'Hi\n', sha: '4' });
    expect(calls[0].headers.Authorization).toBe(
      `Basic ${Buffer.from(ENV.token, 'utf8').toString('base64')}`
    );
  });

  it('readFile resolves the LAST id of a page-id chain', async () => {
    stubFetch([
      [
        '/wiki/api/v2/pages/456?body-format=storage',
        () => [
          200,
          { id: '456', version: { number: 1 }, body: { storage: { value: '<p>x</p>' } } },
        ],
      ],
    ]);
    await expect(confluence.readFile(ENV, SPACE_URL, '123/456')).resolves.toMatchObject({
      sha: '1',
    });
  });

  it('readFile rejects the space root — there is no page to read', async () => {
    await expect(confluence.readFile(ENV, SPACE_URL, '')).rejects.toMatchObject({ status: 404 });
  });

  it('readFile rejects a non-numeric path segment (a title, not an id)', async () => {
    await expect(confluence.readFile(ENV, SPACE_URL, 'overview')).rejects.toThrow(/numeric/);
  });

  it('listFiles resolves the space then lists its root pages', async () => {
    const calls = stubFetch([
      ['/wiki/api/v2/spaces?keys=ENG', () => [200, { results: [{ id: 's1' }] }]],
      [
        '/wiki/api/v2/spaces/s1/pages?limit=100',
        () => [200, { results: [{ id: '1', title: 'Home', version: { number: 2 } }], _links: {} }],
      ],
    ]);
    const entries = await confluence.listFiles(ENV, SPACE_URL, '');
    expect(entries).toEqual([{ name: 'Home', type: 'dir', path: '1', sha: '2' }]);
    expect(calls.some((c) => c.url.includes('/spaces?keys=ENG'))).toBe(true);
  });

  it('listFiles follows cursor pagination via _links.next', async () => {
    const calls = stubFetch([
      ['/wiki/api/v2/spaces?keys=ENG', () => [200, { results: [{ id: 's1' }] }]],
      [
        '/wiki/api/v2/spaces/s1/pages?limit=100',
        () => [
          200,
          {
            results: [{ id: '1', title: 'A', version: { number: 1 } }],
            _links: { next: '/wiki/api/v2/spaces/s1/pages?cursor=abc&limit=100' },
          },
        ],
      ],
      [
        '/wiki/api/v2/spaces/s1/pages?cursor=abc',
        () => [200, { results: [{ id: '2', title: 'B', version: { number: 1 } }], _links: {} }],
      ],
    ]);
    const entries = await confluence.listFiles(ENV, SPACE_URL, '');
    expect(entries.map((e) => e.name)).toEqual(['A', 'B']);
    expect(calls).toHaveLength(3);
  });

  it('listFiles lists the children of the last page id in a chain', async () => {
    stubFetch([
      [
        '/wiki/api/v2/pages/1/children?limit=100',
        () => [200, { results: [{ id: '2', title: 'Child', version: { number: 3 } }], _links: {} }],
      ],
    ]);
    const entries = await confluence.listFiles(ENV, SPACE_URL, '1');
    expect(entries).toEqual([{ name: 'Child', type: 'dir', path: '1/2', sha: '3' }]);
  });

  it('getRepoTree walks the hierarchy breadth-first, marking every page a blob', async () => {
    stubFetch([
      ['/wiki/api/v2/spaces?keys=ENG', () => [200, { results: [{ id: 's1' }] }]],
      [
        '/wiki/api/v2/spaces/s1/pages?limit=100',
        () => [200, { results: [{ id: '1', title: 'Home', version: { number: 1 } }], _links: {} }],
      ],
      [
        '/wiki/api/v2/pages/1/children?limit=100',
        () => [200, { results: [{ id: '2', title: 'Child', version: { number: 1 } }], _links: {} }],
      ],
      ['/wiki/api/v2/pages/2/children?limit=100', () => [200, { results: [], _links: {} }]],
    ]);
    const tree = await confluence.getRepoTree(ENV, SPACE_URL);
    expect(tree).toEqual({
      entries: [
        { path: '1', type: 'blob', sha: '1' },
        { path: '1/2', type: 'blob', sha: '1' },
      ],
      truncated: false,
    });
  });

  it('isFresh compares version.number with a bodyless GET', async () => {
    const calls = stubFetch([
      ['/wiki/api/v2/pages/1', () => [200, { id: '1', version: { number: 5 } }]],
    ]);
    expect(await confluence.isFresh(ENV, SPACE_URL, '1', '5')).toBe(true);
    expect(await confluence.isFresh(ENV, SPACE_URL, '1', '4')).toBe(false);
    expect(calls.every((c) => !c.url.includes('body-format'))).toBe(true);
  });

  it('isFresh is false when the page no longer resolves (404)', async () => {
    stubFetch([['/wiki/api/v2/pages/1', () => [404, {}]]]);
    expect(await confluence.isFresh(ENV, SPACE_URL, '1', '5')).toBe(false);
  });

  it('isFresh surfaces a non-404 failure rather than reading it as stale', async () => {
    stubFetch([['/wiki/api/v2/pages/1', () => [500, {}]]]);
    await expect(confluence.isFresh(ENV, SPACE_URL, '1', '5')).rejects.toThrow(/500/);
  });

  it('isFresh is false for the space root (it has no version of its own)', async () => {
    expect(await confluence.isFresh(ENV, SPACE_URL, '', '1')).toBe(false);
  });

  it("getDefaultBranch returns 'live'", async () => {
    await expect(confluence.getDefaultBranch(ENV, SPACE_URL)).resolves.toBe('live');
  });
});

describe('confluence adapter — auth, not-found, and the token never leaking', () => {
  it('names a clear auth error on 401, without ever including the token', async () => {
    stubFetch([['/wiki/api/v2/pages/1', () => [401, { message: 'Unauthorized' }]]]);
    const err = await confluence.isFresh(ENV, SPACE_URL, '1', 'x').catch((e: Error) => e);
    expect(String(err)).toMatch(/auth failed \(401\)/);
    expect(String(err)).not.toContain(ENV.token);
    expect(String(err)).not.toContain('tok-secret-123');
  });

  it('names a clear auth error on 403 too', async () => {
    stubFetch([['/wiki/api/v2/pages/1?body-format=storage', () => [403, {}]]]);
    await expect(confluence.readFile(ENV, SPACE_URL, '1')).rejects.toThrow(/auth failed \(403\)/);
  });

  it('maps 404 to a plain not_found error', async () => {
    stubFetch([['/wiki/api/v2/pages/1?body-format=storage', () => [404, {}]]]);
    await expect(confluence.readFile(ENV, SPACE_URL, '1')).rejects.toMatchObject({
      message: 'not_found',
      status: 404,
    });
  });

  it('retries a 429 honouring Retry-After, then succeeds', async () => {
    let n = 0;
    const calls = stubFetch([
      [
        '/wiki/api/v2/pages/1?body-format=storage',
        () =>
          ++n === 1
            ? [429, {}, { 'retry-after': '1' }]
            : [
                200,
                { id: '1', version: { number: 1 }, body: { storage: { value: '<p>ok</p>' } } },
              ],
      ],
    ]);
    vi.useFakeTimers();
    const p = confluence.readFile(ENV, SPACE_URL, '1');
    await vi.advanceTimersByTimeAsync(900);
    expect(calls).toHaveLength(1);
    await expect(settle(p)).resolves.toMatchObject({ content: 'ok\n' });
    expect(calls).toHaveLength(2);
  });

  it('gives up once retries are exhausted on a persistent 429', async () => {
    const calls = stubFetch([['/wiki/api/v2/pages/1?body-format=storage', () => [429, {}]]]);
    vi.useFakeTimers();
    await expect(settle(confluence.readFile(ENV, SPACE_URL, '1'))).rejects.toThrow(/429/);
    expect(calls).toHaveLength(4);
  });

  it('never includes the token in a thrown error, even on an unexpected 500', async () => {
    stubFetch([['/wiki/api/v2/pages/1?body-format=storage', () => [500, { message: 'boom' }]]]);
    const err = await confluence.readFile(ENV, SPACE_URL, '1').catch((e: Error) => e);
    expect(String(err)).not.toContain(ENV.token);
    expect(String(err)).not.toContain('tok-secret-123');
  });

  it('rejects a bad token shape before ever calling fetch', async () => {
    const calls = stubFetch([]);
    await expect(
      confluence.readFile({ token: 'no-colon-here', forkOrg: '' }, SPACE_URL, '1')
    ).rejects.toThrow(/email.*api_token/);
    expect(calls).toHaveLength(0);
  });
});
