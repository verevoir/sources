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

  it('rejects an unparseable URL string', () => {
    expect(() => parseConfluenceSpaceUrl('not a url at all')).toThrow(
      /Cannot parse Confluence space URL/
    );
  });
});

describe('confluence adapter — reads', () => {
  it('readFile resolves the page, converts the storage body, and sends Basic auth', async () => {
    const page = { id: '123', version: { number: 4 }, body: { storage: { value: '<p>Hi</p>' } } };
    const calls = stubFetch([['/wiki/api/v2/pages/123?body-format=storage', () => [200, page]]]);
    const res = await confluence.readFile(ENV, SPACE_URL, '123');
    expect(res).toEqual({ kind: 'found', content: 'Hi\n', sha: '4' });
    expect(calls[0].headers.Authorization).toBe(
      `Basic ${Buffer.from(ENV.token, 'utf8').toString('base64')}`
    );
  });

  it('readFile resolves the LAST id of a page-id chain', async () => {
    const page = { id: '456', version: { number: 1 }, body: { storage: { value: '<p>x</p>' } } };
    stubFetch([['/wiki/api/v2/pages/456?body-format=storage', () => [200, page]]]);
    await expect(confluence.readFile(ENV, SPACE_URL, '123/456')).resolves.toMatchObject({
      sha: '1',
    });
  });

  it('readFile rejects the space root — there is no page to read', async () => {
    await expect(confluence.readFile(ENV, SPACE_URL, '')).rejects.toMatchObject({ status: 404 });
  });

  it('treats "." and "/" as the space root too, same as an empty path', async () => {
    await expect(confluence.readFile(ENV, SPACE_URL, '.')).rejects.toMatchObject({
      status: 404,
    });
    await expect(confluence.readFile(ENV, SPACE_URL, '/')).rejects.toMatchObject({
      status: 404,
    });
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

  it('listFiles treats "." and "/" as the space root prefix, same as empty', async () => {
    stubFetch([
      ['/wiki/api/v2/spaces?keys=ENG', () => [200, { results: [{ id: 's1' }] }]],
      [
        '/wiki/api/v2/spaces/s1/pages?limit=100',
        () => [200, { results: [{ id: '1', title: 'Home', version: { number: 2 } }], _links: {} }],
      ],
    ]);
    const viaDot = await confluence.listFiles(ENV, SPACE_URL, '.');
    const viaSlash = await confluence.listFiles(ENV, SPACE_URL, '/');
    const expected = [{ name: 'Home', type: 'dir', path: '1', sha: '2' }];
    expect(viaDot).toEqual(expected);
    expect(viaSlash).toEqual(expected);
  });

  it('listFiles follows cursor pagination via _links.next', async () => {
    const pageA = {
      results: [{ id: '1', title: 'A', version: { number: 1 } }],
      _links: { next: '/wiki/api/v2/spaces/s1/pages?cursor=abc&limit=100' },
    };
    const pageB = { results: [{ id: '2', title: 'B', version: { number: 1 } }], _links: {} };
    const calls = stubFetch([
      ['/wiki/api/v2/spaces?keys=ENG', () => [200, { results: [{ id: 's1' }] }]],
      ['/wiki/api/v2/spaces/s1/pages?limit=100', () => [200, pageA]],
      ['/wiki/api/v2/spaces/s1/pages?cursor=abc', () => [200, pageB]],
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

  it('listFiles builds a child path from the FULL prefix chain, not just the immediate parent', async () => {
    // prefix '100/200', child '300' must come back as '100/200/300' — the
    // '100' ancestor must not be dropped just because only '200' (the last
    // segment) was needed to decide which /children call to make.
    stubFetch([
      [
        '/wiki/api/v2/pages/200/children?limit=100',
        () => [
          200,
          { results: [{ id: '300', title: 'Grandchild', version: { number: 1 } }], _links: {} },
        ],
      ],
    ]);
    const entries = await confluence.listFiles(ENV, SPACE_URL, '100/200');
    expect(entries).toEqual([{ name: 'Grandchild', type: 'dir', path: '100/200/300', sha: '1' }]);
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

  it('isFresh treats "." and "/" as the space root too', async () => {
    expect(await confluence.isFresh(ENV, SPACE_URL, '.', '1')).toBe(false);
    expect(await confluence.isFresh(ENV, SPACE_URL, '/', '1')).toBe(false);
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
    const page = { id: '1', version: { number: 1 }, body: { storage: { value: '<p>ok</p>' } } };
    let n = 0;
    const calls = stubFetch([
      [
        '/wiki/api/v2/pages/1?body-format=storage',
        () => (++n === 1 ? [429, {}, { 'retry-after': '1' }] : [200, page]),
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

describe('confluence adapter — malformed responses raise SourceApiError', () => {
  it('listFiles names the space lookup when its results array is missing', async () => {
    stubFetch([['/wiki/api/v2/spaces?keys=ENG', () => [200, {}]]]);
    await expect(confluence.listFiles(ENV, SPACE_URL, '')).rejects.toThrow(
      /malformed response \(missing results array\)/
    );
  });

  it('listFiles throws a named not-found when the space key resolves to no results', async () => {
    stubFetch([['/wiki/api/v2/spaces?keys=ENG', () => [200, { results: [] }]]]);
    await expect(confluence.listFiles(ENV, SPACE_URL, '')).rejects.toMatchObject({
      message: 'Confluence space not found: ENG',
      status: 404,
    });
  });

  it('readFile names itself when the page response is missing version.number', async () => {
    const malformed = { id: '1', body: { storage: { value: '<p>x</p>' } } };
    stubFetch([['/wiki/api/v2/pages/1?body-format=storage', () => [200, malformed]]]);
    await expect(confluence.readFile(ENV, SPACE_URL, '1')).rejects.toThrow(
      /readFile: malformed page response \(missing version\.number\)/
    );
  });

  it('isFresh names itself when the page response is missing version.number', async () => {
    stubFetch([['/wiki/api/v2/pages/1', () => [200, { id: '1' }]]]);
    await expect(confluence.isFresh(ENV, SPACE_URL, '1', '1')).rejects.toThrow(
      /isFresh: malformed page response \(missing version\.number\)/
    );
  });

  it('listFiles names itself when a child page is missing version.number', async () => {
    stubFetch([
      [
        '/wiki/api/v2/pages/1/children?limit=100',
        () => [200, { results: [{ id: '2', title: 'Child' }], _links: {} }],
      ],
    ]);
    await expect(confluence.listFiles(ENV, SPACE_URL, '1')).rejects.toThrow(
      /listFiles: malformed page response \(missing version\.number\)/
    );
  });

  it('getRepoTree names itself when a page in the tree is missing version.number', async () => {
    stubFetch([
      ['/wiki/api/v2/spaces?keys=ENG', () => [200, { results: [{ id: 's1' }] }]],
      [
        '/wiki/api/v2/spaces/s1/pages?limit=100',
        () => [200, { results: [{ id: '1', title: 'Home' }], _links: {} }],
      ],
    ]);
    await expect(confluence.getRepoTree(ENV, SPACE_URL)).rejects.toThrow(
      /getRepoTree: malformed page response \(missing version\.number\)/
    );
  });
});

describe('confluence adapter — the token never leaves the space’s own origin', () => {
  it('refuses a pagination link to another host instead of following it', async () => {
    const calls = stubFetch([
      ['/wiki/api/v2/spaces?keys=ENG', () => [200, { results: [{ id: 's1' }] }]],
      [
        '/wiki/api/v2/spaces/s1/pages?limit=100',
        () => [
          200,
          {
            results: [{ id: '1', title: 'A', version: { number: 1 } }],
            _links: { next: 'https://exfil.example/steal' },
          },
        ],
      ],
    ]);
    await expect(confluence.listFiles(ENV, SPACE_URL, '')).rejects.toThrow(/cross-origin/);
    expect(calls.map((c) => new URL(c.url).host)).toEqual([
      'adsurg.atlassian.net',
      'adsurg.atlassian.net',
    ]);
  });
});

describe('confluence adapter — timeouts', () => {
  it('reports a timed-out request as a SourceApiError naming the path', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new Error('The operation was aborted due to timeout'), {
          name: 'TimeoutError',
        });
      })
    );
    await expect(confluence.readFile(ENV, SPACE_URL, '1')).rejects.toThrow(/timed out/);
  });

  it('propagates a non-timeout network failure unchanged (not dressed up as a timeout)', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw refused;
      })
    );
    await expect(confluence.readFile(ENV, SPACE_URL, '1')).rejects.toBe(refused);
  });

  it('bounds each request with an abort signal', async () => {
    const calls: RequestInit[] = [];
    const page = { id: '1', version: { number: 1 }, body: { storage: { value: '<p>x</p>' } } };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init: RequestInit) => {
        calls.push(init);
        return Response.json(page);
      })
    );
    await confluence.readFile(ENV, SPACE_URL, '1');
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
  });
});

describe('confluence adapter — rate limiting', () => {
  it('backs off on a negative Retry-After instead of retrying at once', async () => {
    // Date.parse('-5') is the year 2001 — in the past — so the bug this
    // regresses would compute a zero (immediate) wait. The signed-number
    // guard must reject -5 as an invalid delay-seconds value and fall back
    // to exponential backoff (attempt 0 => ~1000ms) instead.
    const page = { id: '1', version: { number: 1 }, body: { storage: { value: '<p>ok</p>' } } };
    let n = 0;
    const calls = stubFetch([
      [
        '/wiki/api/v2/pages/1?body-format=storage',
        () => (++n === 1 ? [429, {}, { 'retry-after': '-5' }] : [200, page]),
      ],
    ]);
    vi.useFakeTimers();
    const p = confluence.readFile(ENV, SPACE_URL, '1');
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toHaveLength(1); // not retried yet — proves it backed off
    await expect(settle(p)).resolves.toMatchObject({ content: 'ok\n' });
    expect(calls).toHaveLength(2);
  });

  it('honours a Retry-After HTTP-date', async () => {
    const page = { id: '1', version: { number: 1 }, body: { storage: { value: '<p>ok</p>' } } };
    let n = 0;
    const calls = stubFetch([
      [
        '/wiki/api/v2/pages/1?body-format=storage',
        () =>
          ++n === 1
            ? [429, {}, { 'retry-after': new Date(Date.now() + 3000).toUTCString() }]
            : [200, page],
      ],
    ]);
    vi.useFakeTimers();
    const p = confluence.readFile(ENV, SPACE_URL, '1');
    await vi.advanceTimersByTimeAsync(1500);
    expect(calls).toHaveLength(1);
    await expect(settle(p)).resolves.toMatchObject({ content: 'ok\n' });
    expect(calls).toHaveLength(2);
  });

  it('clamps a large Retry-After to RATE_LIMIT_MAX_WAIT_MS rather than waiting the full requested delay', async () => {
    // Retry-After: 100 (seconds) asks for a 100,000ms wait; the ceiling caps
    // any one wait at RATE_LIMIT_MAX_WAIT_MS (30,000ms). Advancing only just
    // past the ceiling — nowhere near the full 100s the header asked for —
    // must already be enough to see the retry fire.
    const page = { id: '1', version: { number: 1 }, body: { storage: { value: '<p>ok</p>' } } };
    let n = 0;
    const calls = stubFetch([
      [
        '/wiki/api/v2/pages/1?body-format=storage',
        () => (++n === 1 ? [429, {}, { 'retry-after': '100' }] : [200, page]),
      ],
    ]);
    vi.useFakeTimers();
    const p = confluence.readFile(ENV, SPACE_URL, '1');
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(settle(p)).resolves.toMatchObject({ content: 'ok\n' });
    expect(calls).toHaveLength(2);
  });
});

describe('confluence adapter — page budget, wall-clock half', () => {
  it('treats the wall-clock budget as exhausted, not just the page count', async () => {
    vi.useFakeTimers();
    const calls = stubFetch([
      ['/wiki/api/v2/spaces?keys=ENG', () => [200, { results: [{ id: 's1' }] }]],
      [
        '/wiki/api/v2/spaces/s1/pages?limit=100',
        () => {
          // Push the clock past LIST_BUDGET_MS before the loop re-checks
          // its deadline for the next page — proving the TIME half of the
          // shared PageBudget, not just its page-count half, stops a walk.
          vi.advanceTimersByTime(121_000);
          return [
            200,
            {
              results: [{ id: '1', title: 'A', version: { number: 1 } }],
              _links: { next: '/wiki/api/v2/spaces/s1/pages?cursor=x&limit=100' },
            },
          ];
        },
      ],
      [
        '/wiki/api/v2/spaces/s1/pages?cursor=x',
        () => [200, { results: [{ id: '2', title: 'B', version: { number: 1 } }], _links: {} }],
      ],
    ]);
    const entries = await confluence.listFiles(ENV, SPACE_URL, '');
    expect(entries).toHaveLength(1);
    expect(calls).toHaveLength(2); // spaces + the first page — the cursor page is never fetched
  });
});

describe('confluence adapter — oversized / malformed pagination', () => {
  it('refuses an oversized response (declared via Content-Length) with a named error', async () => {
    stubFetch([
      [
        '/wiki/api/v2/pages/1?body-format=storage',
        () => [200, { id: '1' }, { 'content-length': String(20 * 1024 * 1024 + 1) }],
      ],
    ]);
    await expect(confluence.readFile(ENV, SPACE_URL, '1')).rejects.toThrow(/too large/);
  });

  it('refuses an oversized response via the streaming byte count, not a declared Content-Length', async () => {
    // Mirrors index.ts's own MAX_RESPONSE_BYTES (20 MiB). No content-length
    // header at all, so the declared-Content-Length fast path cannot fire —
    // only the streaming byte-count loop inside readBounded can catch this.
    const CAP_BYTES = 20 * 1024 * 1024;
    const CHUNK = new Uint8Array(1024 * 1024).fill(97);
    const chunkCount = Math.floor(CAP_BYTES / CHUNK.byteLength) + 1; // 1 MiB past the cap
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < chunkCount; i++) controller.enqueue(CHUNK);
        controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(stream, { status: 200 }))
    );
    await expect(confluence.readFile(ENV, SPACE_URL, '1')).rejects.toThrow(/too large/);
  });

  it('names an unparseable pagination link rather than throwing a raw TypeError', async () => {
    stubFetch([
      ['/wiki/api/v2/spaces?keys=ENG', () => [200, { results: [{ id: 's1' }] }]],
      [
        '/wiki/api/v2/spaces/s1/pages?limit=100',
        () => [
          200,
          {
            results: [{ id: '1', title: 'A', version: { number: 1 } }],
            _links: { next: 'http://[::1' },
          },
        ],
      ],
    ]);
    await expect(confluence.listFiles(ENV, SPACE_URL, '')).rejects.toThrow(
      /unparseable pagination link/
    );
  });

  it("refuses an oversized bodyless response through readBounded's res.text() fallback", async () => {
    // A Response with no streaming body at all (res.body === null) falls
    // through to the `!res.body` branch in readBounded, which must enforce
    // the same cap via res.text().length — not just the declared-header or
    // streaming-reader branches exercised by the other two size-cap tests.
    const CAP_BYTES = 20 * 1024 * 1024;
    const bigText = 'a'.repeat(CAP_BYTES + 1);
    const fakeResponse = {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: null,
      text: async () => bigText,
    } as unknown as Response;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse)
    );
    await expect(confluence.readFile(ENV, SPACE_URL, '1')).rejects.toThrow(/too large/);
  });

  it('reads a small bodyless response successfully through the same res.text() fallback', async () => {
    const page = { id: '1', version: { number: 1 }, body: { storage: { value: '<p>ok</p>' } } };
    const fakeResponse = {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: null,
      text: async () => JSON.stringify(page),
    } as unknown as Response;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse)
    );
    await expect(confluence.readFile(ENV, SPACE_URL, '1')).resolves.toMatchObject({
      content: 'ok\n',
    });
  });

  it("falls back to an empty error detail when a 500 response's detail body exceeds the cap", async () => {
    // confCall's non-OK branch reads at most MAX_ERROR_DETAIL_BYTES (65,536)
    // bytes of the body for a truncated error detail, via
    // `readBounded(...).then(...).catch(() => '')` -- any failure reading
    // that detail (oversized here, or a streaming error) is swallowed to an
    // empty string rather than masking the real HTTP status with an
    // unrelated "response too large" error.
    const ERROR_DETAIL_CAP = 65_536;
    const fakeResponse = {
      ok: false,
      status: 500,
      headers: { get: () => null },
      body: null,
      text: async () => 'x'.repeat(ERROR_DETAIL_CAP + 1),
    } as unknown as Response;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse)
    );
    await expect(confluence.readFile(ENV, SPACE_URL, '1')).rejects.toMatchObject({
      status: 500,
      detail: '',
    });
  });
});

describe('confluence adapter — ref is accepted and ignored, like Notion', () => {
  it('readFile, listFiles, getRepoTree and isFresh all succeed unchanged when a non-empty ref is passed', async () => {
    const page = { id: '1', version: { number: 1 }, body: { storage: { value: '<p>x</p>' } } };
    stubFetch([
      ['/wiki/api/v2/pages/1?body-format=storage', () => [200, page]],
      ['/wiki/api/v2/pages/1', () => [200, { id: '1', version: { number: 1 } }]],
      ['/wiki/api/v2/spaces?keys=ENG', () => [200, { results: [{ id: 's1' }] }]],
      ['/wiki/api/v2/spaces/s1/pages?limit=100', () => [200, { results: [], _links: {} }]],
    ]);
    const ref = 'some-branch-or-version';
    await expect(confluence.readFile(ENV, SPACE_URL, '1', ref)).resolves.toMatchObject({
      kind: 'found',
    });
    await expect(confluence.listFiles(ENV, SPACE_URL, '', ref)).resolves.toEqual([]);
    await expect(confluence.getRepoTree(ENV, SPACE_URL, ref)).resolves.toEqual({
      entries: [],
      truncated: false,
    });
    await expect(confluence.isFresh(ENV, SPACE_URL, '1', '1', ref)).resolves.toBe(true);
  });
});

describe('confluence adapter — tree walk truncation', () => {
  it('getRepoTree truncates at DEFAULT_TREE_CAP, reporting truncated: true', async () => {
    const manyPages = Array.from({ length: 5001 }, (_, i) => ({
      id: String(i),
      title: `Page ${i}`,
      version: { number: 1 },
    }));
    stubFetch([
      ['/wiki/api/v2/spaces?keys=ENG', () => [200, { results: [{ id: 's1' }] }]],
      ['/wiki/api/v2/spaces/s1/pages?limit=100', () => [200, { results: manyPages, _links: {} }]],
    ]);
    const tree = await confluence.getRepoTree(ENV, SPACE_URL);
    expect(tree.truncated).toBe(true);
    expect(tree.entries.length).toBe(5000);
  });

  it('treats the page budget as shared across the WHOLE walk, not reset per node', async () => {
    const calls = stubFetch([
      ['/wiki/api/v2/spaces?keys=ENG', () => [200, { results: [{ id: 's1' }] }]],
      [
        '/wiki/api/v2/spaces/s1/pages?limit=100',
        () => [
          200,
          { results: [{ id: '0', title: 'Page 0', version: { number: 1 } }], _links: {} },
        ],
      ],
      [
        '/children',
        (call) => {
          // Every /pages/{n}/children call returns exactly one child, n+1 — a
          // single-child chain deep enough that, if the page budget reset on
          // every node (one confPages call each), the walk would never stop
          // on its own. It must stop because the budget is SHARED.
          const m = call.url.match(/\/pages\/(\d+)\/children/);
          const n = Number(m![1]);
          return [
            200,
            {
              results: [{ id: String(n + 1), title: `Page ${n + 1}`, version: { number: 1 } }],
              _links: {},
            },
          ];
        },
      ],
    ]);
    const tree = await confluence.getRepoTree(ENV, SPACE_URL);
    expect(tree.truncated).toBe(true);
    // Stopped by the shared page budget (MAX_LIST_PAGES), nowhere near
    // DEFAULT_TREE_CAP (5000) — proving the cap that fired is the walk-wide
    // one, not a per-node one re-granted at every level.
    expect(tree.entries.length).toBeGreaterThan(0);
    expect(tree.entries.length).toBeLessThan(600);
    expect(calls.length).toBeGreaterThan(100);
  });
});
