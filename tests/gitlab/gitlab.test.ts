import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isGitlabUrl,
  parseGitlabProjectUrl,
  gitlab,
  resetGitlabCaches,
} from '../../src/gitlab/index.js';

type Call = { method: string; url: string; headers: Record<string, string>; body?: unknown };
type Reply = [number, unknown, Record<string, string>?];

/** Stub `fetch` with a route table: each handler matches `METHOD path-prefix`
 * (path relative to the API base, query included; first match wins) and
 * returns [status, body, headers?]. Records every call so tests can assert on
 * the wire shape. */
function stubFetch(routes: [string, (call: Call) => Reply][]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const call: Call = {
        method: init.method ?? 'GET',
        url,
        headers: init.headers as Record<string, string>,
        body: init.body ? JSON.parse(init.body as string) : undefined,
      };
      calls.push(call);
      const rel = url.replace(/^https?:\/\/[^/]+\/api\/v4/, '');
      const route = routes.find(([key]) => {
        const [m, p] = key.split(' ');
        return m === call.method && rel.startsWith(p);
      });
      if (!route) return new Response('no route', { status: 404 });
      const [status, body, headers] = route[1](call);
      return new Response(
        body === undefined || call.method === 'HEAD' ? null : JSON.stringify(body),
        { status, headers }
      );
    })
  );
  return calls;
}

/** Run a promise to completion under fake timers (retry / poll waits). */
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

const env = { token: 'glpat-x', forkOrg: '' };
const REPO = 'https://gitlab.com/group/sub/repo';
const ID = encodeURIComponent('group/sub/repo');
const FORK_ID = encodeURIComponent('forks/team/repo');

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetGitlabCaches();
});

describe('isGitlabUrl', () => {
  it('recognises gitlab.com', () => {
    expect(isGitlabUrl('https://gitlab.com/a/b')).toBe(true);
    expect(isGitlabUrl('https://www.gitlab.com/a/b')).toBe(true);
  });

  it('recognises exactly the hosts listed in GITLAB_HOSTS', () => {
    expect(isGitlabUrl('https://git.client.io/a/b')).toBe(false);
    vi.stubEnv('GITLAB_HOSTS', 'code.example.com, Git.Client.io');
    expect(isGitlabUrl('https://git.client.io/a/b')).toBe(true);
    expect(isGitlabUrl('https://code.example.com/a/b')).toBe(true);
  });

  it('rejects lookalike and unlisted hosts — each would be sent GITLAB_TOKEN', () => {
    expect(isGitlabUrl('https://gitlab.com.evil.io/a/b')).toBe(false);
    expect(isGitlabUrl('https://evilgitlab.com/a/b')).toBe(false);
    expect(isGitlabUrl('https://gitlab.corp.example/a/b')).toBe(false);
    expect(isGitlabUrl('https://github.com/a/b')).toBe(false);
    expect(isGitlabUrl('/abs/path')).toBe(false);
  });

  it('rejects plain http, even for a listed host (the token would travel in cleartext)', () => {
    vi.stubEnv('GITLAB_HOSTS', 'code.example.com');
    expect(isGitlabUrl('http://gitlab.com/a/b')).toBe(false);
    expect(isGitlabUrl('http://code.example.com/a/b')).toBe(false);
  });
});

describe('parseGitlabProjectUrl', () => {
  it('keeps nested groups and strips .git, trailing slash and /-/ UI suffixes', () => {
    expect(parseGitlabProjectUrl('https://gitlab.com/group/sub/repo.git')).toEqual({
      apiBase: 'https://gitlab.com/api/v4',
      projectPath: 'group/sub/repo',
    });
    expect(parseGitlabProjectUrl('https://code.example.com:8443/g/r/-/tree/main/')).toEqual({
      apiBase: 'https://code.example.com:8443/api/v4',
      projectPath: 'g/r',
    });
  });

  it('normalises www.gitlab.com to the gitlab.com API', () => {
    expect(parseGitlabProjectUrl('https://www.gitlab.com/g/r').apiBase).toBe(
      'https://gitlab.com/api/v4'
    );
  });

  it('rejects a string that is not a URL at all, as a SourceApiError', () => {
    expect(() => parseGitlabProjectUrl('gitlab.com/group/repo')).toThrow(
      /Cannot parse GitLab project URL: gitlab\.com\/group\/repo/
    );
  });

  it('rejects a URL without a namespace/project path', () => {
    expect(() => parseGitlabProjectUrl('https://gitlab.com/onlygroup')).toThrow(/namespace/);
  });
});

describe('gitlab adapter — reads', () => {
  it('readFile decodes base64 content, returns blob_id, and sends the token as a Bearer', async () => {
    const calls = stubFetch([
      [
        `GET /projects/${ID}/repository/files/src%2Fa.ts?ref=dev`,
        () => [
          200,
          { content: Buffer.from('hello').toString('base64'), encoding: 'base64', blob_id: 'b1' },
        ],
      ],
    ]);
    const res = await gitlab.readFile(env, REPO, 'src/a.ts', 'dev');
    expect(res).toEqual({ content: 'hello', sha: 'b1' });
    // Authorization (not PRIVATE-TOKEN): fetch strips it on a cross-origin redirect.
    expect(calls[0].headers.Authorization).toBe('Bearer glpat-x');
    expect(calls[0].headers['PRIVATE-TOKEN']).toBeUndefined();
  });

  it('sends no credential at all when GITLAB_TOKEN is unset', async () => {
    const calls = stubFetch([
      [`GET /projects/${ID}/repository/files/`, () => [200, { content: '', blob_id: 'b' }]],
    ]);
    await gitlab.readFile({ token: '', forkOrg: '' }, REPO, 'x', 'main');
    expect(calls[0].headers.Authorization).toBeUndefined();
  });

  it('readFile resolves the default branch once per project when no ref is given', async () => {
    const calls = stubFetch([
      [`GET /projects/${ID}/repository/files/`, () => [200, { content: '', blob_id: 'b' }]],
      [`GET /projects/${ID}`, () => [200, { default_branch: 'trunk' }]],
    ]);
    await gitlab.readFile(env, REPO, 'x');
    await gitlab.readFile(env, REPO, 'y');
    // 1 project lookup + 2 file reads — the second read reuses the branch.
    expect(calls).toHaveLength(3);
    expect(calls[1].url).toContain('files/x?ref=trunk');
    expect(calls[2].url).toContain('files/y?ref=trunk');
  });

  it('treats an EMPTY ref as the default branch, never sending `ref=`', async () => {
    // '' is the package-wide "current" — the key an unqualified read warms under.
    const calls = stubFetch([
      [`GET /projects/${ID}/repository/files/`, () => [200, { content: '', blob_id: 'b' }]],
      [
        `HEAD /projects/${ID}/repository/files/`,
        () => [200, undefined, { 'x-gitlab-blob-id': 'b' }],
      ],
      [`GET /projects/${ID}/repository/tree`, () => [200, []]],
      [`GET /projects/${ID}`, () => [200, { default_branch: 'trunk' }]],
    ]);
    await gitlab.readFile(env, REPO, 'x', '');
    expect(await gitlab.isFresh(env, REPO, 'x', 'b', '')).toBe(true);
    await gitlab.getRepoTree(env, REPO, '');
    await gitlab.listFiles(env, REPO, '', '');
    for (const c of calls) expect(c.url).not.toMatch(/[?&]ref=(&|$)/);
    expect(calls.filter((c) => c.url.includes('ref=trunk'))).toHaveLength(2);
  });

  it('refuses, before any request, a URL off the host list — even called directly', async () => {
    // A caller that skips isGitlabUrl must still not be able to leak the token.
    const calls = stubFetch([]);
    for (const url of [
      'https://gitlab.com.evil.io/a/b',
      'http://gitlab.com/a/b',
      'https://gitlab.corp.example/a/b',
    ]) {
      await expect(gitlab.readFile(env, url, 'x', 'main')).rejects.toThrow(/GITLAB_HOSTS/);
      await expect(
        gitlab.commitFiles(env, url, 'b', [{ path: 'x', content: '' }], 'm')
      ).rejects.toThrow(/GITLAB_HOSTS/);
    }
    expect(calls).toHaveLength(0);
  });

  it('serves a self-hosted instance listed in GITLAB_HOSTS from its own API base', async () => {
    vi.stubEnv('GITLAB_HOSTS', 'code.example.com');
    const calls = stubFetch([
      [
        `GET /projects/${encodeURIComponent('t/r')}/repository/files/`,
        () => [200, { content: '', blob_id: 'b' }],
      ],
    ]);
    await gitlab.readFile(env, 'https://code.example.com/t/r', 'x', 'main');
    expect(calls[0].url).toMatch(/^https:\/\/code\.example\.com\/api\/v4\//);
  });

  it('re-fetches the default branch once the one-minute memo has expired, not before', async () => {
    let branch = 'trunk';
    const calls = stubFetch([
      [`GET /projects/${ID}/repository/files/`, () => [200, { content: '', blob_id: 'b' }]],
      [`GET /projects/${ID}`, () => [200, { default_branch: branch }]],
    ]);
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const lookups = () => calls.filter((c) => /\/projects\/[^/]+$/.test(new URL(c.url).pathname));
    await gitlab.readFile(env, REPO, 'x');
    branch = 'main'; // renamed upstream
    now.mockReturnValue(1_000_000 + 59_999); // just inside the minute: remembered
    await gitlab.readFile(env, REPO, 'x');
    expect(lookups()).toHaveLength(1);
    now.mockReturnValue(1_000_000 + 60_000); // the minute is up: asked again
    await gitlab.readFile(env, REPO, 'x');
    expect(lookups()).toHaveLength(2);
    expect(calls.at(-1)!.url).toContain('ref=main');
    now.mockReturnValue(1_000_000 + 60_001); // …and the fresh answer is remembered anew
    await gitlab.readFile(env, REPO, 'x');
    expect(lookups()).toHaveLength(2);
  });

  it('names GITLAB_TOKEN when an anonymous request is refused', async () => {
    stubFetch([]);
    await expect(gitlab.readFile({ token: '', forkOrg: '' }, REPO, 'x', 'main')).rejects.toThrow(
      /GITLAB_TOKEN/
    );
  });

  it('does not blame a missing token when one was sent', async () => {
    stubFetch([]);
    await expect(gitlab.readFile(env, REPO, 'x', 'main')).rejects.toThrow(/^not_found$/);
  });

  it('getRepoTree follows keyset pagination and maps entries', async () => {
    const page2 = `https://gitlab.com/api/v4/projects/${ID}/repository/tree?page_token=abc`;
    const calls = stubFetch([
      [
        `GET /projects/${ID}/repository/tree?page_token=abc`,
        () => [200, [{ id: 's2', name: 'b.ts', type: 'blob', path: 'src/b.ts', mode: '100644' }]],
      ],
      [
        `GET /projects/${ID}/repository/tree`,
        () => [
          200,
          [
            { id: 't1', name: 'src', type: 'tree', path: 'src', mode: '040000' },
            { id: 'c1', name: 'sub', type: 'commit', path: 'sub', mode: '160000' },
          ],
          { link: `<${page2}>; rel="next"` },
        ],
      ],
    ]);
    const tree = await gitlab.getRepoTree(env, REPO, 'main');
    expect(tree).toEqual({
      entries: [
        { path: 'src', type: 'tree', sha: 't1' },
        { path: 'src/b.ts', type: 'blob', sha: 's2' },
      ],
      truncated: false,
    });
    expect(calls[0].url).toContain('recursive=true');
    expect(calls[0].url).toContain('pagination=keyset');
  });

  it('stops paging when a Link header carries no rel="next" (the last page)', async () => {
    const prev = `https://gitlab.com/api/v4/projects/${ID}/repository/tree?page_token=back`;
    const calls = stubFetch([
      [
        `GET /projects/${ID}/repository/tree`,
        () => [
          200,
          [{ id: 'x', name: 'f', type: 'blob', path: 'f', mode: '100644' }],
          { link: `<${prev}>; rel="prev", <${prev}>; rel="first"` },
        ],
      ],
    ]);
    const tree = await gitlab.getRepoTree(env, REPO, 'main');
    expect(tree.truncated).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('getRepoTree stops truncated at the page cap rather than paging forever', async () => {
    const self = `https://gitlab.com/api/v4/projects/${ID}/repository/tree?page_token=loop`;
    const calls = stubFetch([
      [
        `GET /projects/${ID}/repository/tree`,
        () => [
          200,
          [{ id: 'x', name: 'f', type: 'blob', path: 'f', mode: '100644' }],
          { link: `<${self}>; rel="next"` },
        ],
      ],
    ]);
    const tree = await gitlab.getRepoTree(env, REPO, 'main');
    expect(tree.truncated).toBe(true);
    expect(calls).toHaveLength(500);
  });

  it('getRepoTree stops truncated when its time budget runs out, before the page cap', async () => {
    // Pages keep coming, but the clock passes the 120s budget after page one.
    const self = `https://gitlab.com/api/v4/projects/${ID}/repository/tree?page_token=loop`;
    const calls = stubFetch([
      [
        `GET /projects/${ID}/repository/tree`,
        () => [
          200,
          [{ id: 'x', name: 'f', type: 'blob', path: 'f', mode: '100644' }],
          { link: `<${self}>; rel="next"` },
        ],
      ],
    ]);
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(0) // deadline = 0 + budget
      .mockReturnValueOnce(0) // page 1: within budget
      .mockReturnValue(10 ** 9); // page 2: past it
    const tree = await gitlab.getRepoTree(env, REPO, 'main');
    expect(tree).toEqual({ entries: [{ path: 'f', type: 'blob', sha: 'x' }], truncated: true });
    expect(calls).toHaveLength(1);
  });

  it('listFiles refuses a directory too large to list in one call rather than returning part of it', async () => {
    const self = `https://gitlab.com/api/v4/projects/${ID}/repository/tree?page_token=loop`;
    stubFetch([
      [
        `GET /projects/${ID}/repository/tree`,
        () => [
          200,
          [{ id: 'x', name: 'f', type: 'blob', path: 'big/f', mode: '100644' }],
          { link: `<${self}>; rel="next"` },
        ],
      ],
    ]);
    await expect(gitlab.listFiles(env, REPO, 'big', 'main')).rejects.toThrow(
      /big has too many entries/
    );
  });

  it('listFiles maps tree/commit/symlink types', async () => {
    stubFetch([
      [
        `GET /projects/${ID}/repository/tree`,
        () => [
          200,
          [
            { id: '1', name: 'd', type: 'tree', path: 'd', mode: '040000' },
            { id: '2', name: 'm', type: 'commit', path: 'm', mode: '160000' },
            { id: '3', name: 'l', type: 'blob', path: 'l', mode: '120000' },
            { id: '4', name: 'f', type: 'blob', path: 'f', mode: '100644' },
          ],
        ],
      ],
    ]);
    const entries = await gitlab.listFiles(env, REPO, '', 'main');
    expect(entries.map((e) => e.type)).toEqual(['dir', 'submodule', 'symlink', 'file']);
  });

  it('listFiles reports a file / missing path as not-a-directory, but lists an empty root', async () => {
    stubFetch([[`GET /projects/${ID}/repository/tree`, () => [200, []]]]);
    await expect(gitlab.listFiles(env, REPO, 'README.md', 'main')).rejects.toThrow(
      /not a directory/
    );
    // '/' is the root, not a path to check.
    await expect(gitlab.listFiles(env, REPO, '/', 'main')).resolves.toEqual([]);
  });

  it('isFresh compares the X-Gitlab-Blob-Id header from a HEAD request', async () => {
    const calls = stubFetch([
      [
        `HEAD /projects/${ID}/repository/files/a`,
        () => [200, undefined, { 'x-gitlab-blob-id': 'v2' }],
      ],
    ]);
    expect(await gitlab.isFresh(env, REPO, 'a', 'v2', 'main')).toBe(true);
    expect(await gitlab.isFresh(env, REPO, 'a', 'v1', 'main')).toBe(false);
    expect(calls[0].method).toBe('HEAD');
  });

  it('isFresh is false when the path no longer resolves', async () => {
    stubFetch([]);
    expect(await gitlab.isFresh(env, REPO, 'gone', 'v1', 'main')).toBe(false);
  });

  it('isFresh surfaces a non-404 failure rather than reading it as "moved"', async () => {
    // Only a 404 means the path is gone; a 500 is an error, not a stale answer.
    stubFetch([[`HEAD /projects/${ID}/repository/files/a`, () => [500, undefined]]]);
    await expect(gitlab.isFresh(env, REPO, 'a', 'v1', 'main')).rejects.toThrow(/500/);
  });
});

describe('gitlab adapter — the token never leaves the repo URL’s origin', () => {
  it('refuses a pagination link to another host instead of following it', async () => {
    const calls = stubFetch([
      [
        `GET /projects/${ID}/repository/tree`,
        () => [200, [], { link: '<https://exfil.example/steal>; rel="next"' }],
      ],
    ]);
    await expect(gitlab.getRepoTree(env, REPO, 'main')).rejects.toThrow(/cross-origin/);
    expect(calls.map((c) => new URL(c.url).host)).toEqual(['gitlab.com']);
  });

  it('refuses a pagination link that downgrades to http', async () => {
    const calls = stubFetch([
      [
        `GET /projects/${ID}/repository/tree`,
        () => [
          200,
          [],
          { link: `<http://gitlab.com/api/v4/projects/${ID}/repository/tree?p=2>; rel="next"` },
        ],
      ],
    ]);
    await expect(gitlab.getRepoTree(env, REPO, 'main')).rejects.toThrow(/cross-origin/);
    expect(calls).toHaveLength(1);
  });
});

describe('gitlab adapter — timeouts', () => {
  it('reports a timed-out request as a SourceApiError naming the path', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new Error('The operation was aborted due to timeout'), {
          name: 'TimeoutError',
        });
      })
    );
    await expect(gitlab.readFile(env, REPO, 'big.bin', 'main')).rejects.toThrow(
      /GET \/projects\/.*big\.bin.*timed out/
    );
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
    await expect(gitlab.readFile(env, REPO, 'a', 'main')).rejects.toBe(refused);
  });

  it('bounds each request with an abort signal', async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init: RequestInit) => {
        calls.push(init);
        return Response.json({ content: '', blob_id: 'b' });
      })
    );
    await gitlab.readFile(env, REPO, 'a', 'main');
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
  });
});

describe('gitlab adapter — rate limiting', () => {
  it('retries a 429 after Retry-After (seconds), then succeeds', async () => {
    let n = 0;
    const calls = stubFetch([
      [
        `GET /projects/${ID}/repository/files/a`,
        () =>
          ++n === 1
            ? [429, { message: 'slow down' }, { 'retry-after': '1' }]
            : [200, { content: 'ok', blob_id: 'b' }],
      ],
    ]);
    vi.useFakeTimers();
    const p = gitlab.readFile(env, REPO, 'a', 'main');
    // Not retried before Retry-After (1s) has elapsed…
    await vi.advanceTimersByTimeAsync(900);
    expect(calls).toHaveLength(1);
    // …then retried once it has.
    await expect(settle(p)).resolves.toEqual({ content: 'ok', sha: 'b' });
    expect(calls).toHaveLength(2);
  });

  it('honours a Retry-After HTTP-date', async () => {
    let n = 0;
    const calls = stubFetch([
      [
        `GET /projects/${ID}/repository/files/a`,
        () =>
          ++n === 1
            ? [429, {}, { 'retry-after': new Date(Date.now() + 3000).toUTCString() }]
            : [200, { content: 'ok', blob_id: 'b' }],
      ],
    ]);
    vi.useFakeTimers();
    const p = gitlab.readFile(env, REPO, 'a', 'main');
    await vi.advanceTimersByTimeAsync(1500);
    expect(calls).toHaveLength(1);
    await expect(settle(p)).resolves.toMatchObject({ content: 'ok' });
  });

  it('falls back to backoff when Retry-After is unparseable', async () => {
    let n = 0;
    const calls = stubFetch([
      [
        `GET /projects/${ID}/repository/files/a`,
        () =>
          ++n === 1
            ? [429, {}, { 'retry-after': 'soon-ish' }]
            : [200, { content: 'ok', blob_id: 'b' }],
      ],
    ]);
    vi.useFakeTimers();
    const p = gitlab.readFile(env, REPO, 'a', 'main');
    // First backoff step is 1s (+ jitter): not yet at 900ms…
    await vi.advanceTimersByTimeAsync(900);
    expect(calls).toHaveLength(1);
    await expect(settle(p)).resolves.toMatchObject({ content: 'ok' });
    expect(calls).toHaveLength(2);
  });

  it('gives up with the 429 once retries are exhausted', async () => {
    const calls = stubFetch([[`GET /projects/${ID}/repository/files/a`, () => [429, {}]]]);
    vi.useFakeTimers();
    await expect(settle(gitlab.readFile(env, REPO, 'a', 'main'))).rejects.toThrow(/429/);
    expect(calls).toHaveLength(4);
  });
});

describe('gitlab adapter — writes', () => {
  it('commitFiles makes ONE commit with create/update actions by existence', async () => {
    const calls = stubFetch([
      [`GET /projects/${ID}/repository/branches/feat`, () => [200, {}]],
      [
        `HEAD /projects/${ID}/repository/files/exists.ts`,
        () => [200, undefined, { 'x-gitlab-blob-id': 'b' }],
      ],
      [`POST /projects/${ID}/repository/commits`, () => [201, { id: 'c' }]],
    ]);
    await gitlab.commitFiles(
      env,
      REPO,
      'feat',
      [
        { path: 'exists.ts', content: 'a' },
        { path: 'new.ts', content: 'b' },
      ],
      'msg'
    );
    const commits = calls.filter((c) => c.url.endsWith('/repository/commits'));
    expect(commits).toHaveLength(1);
    expect(commits[0].body).toMatchObject({
      branch: 'feat',
      commit_message: 'msg',
      actions: [
        {
          action: 'update',
          file_path: 'exists.ts',
          encoding: 'base64',
          content: Buffer.from('a').toString('base64'),
        },
        { action: 'create', file_path: 'new.ts', encoding: 'base64' },
      ],
    });
  });

  it('commitFiles aborts, committing nothing, when an existence probe fails with a non-404', async () => {
    // A failed probe must not be read as "absent" and turn an update into a create.
    const calls = stubFetch([
      [`GET /projects/${ID}/repository/branches/feat`, () => [200, {}]],
      [`HEAD /projects/${ID}/repository/files/a`, () => [503, undefined]],
      [`POST /projects/${ID}/repository/commits`, () => [201, {}]],
    ]);
    await expect(
      gitlab.commitFiles(env, REPO, 'feat', [{ path: 'a', content: 'x' }], 'm')
    ).rejects.toThrow(/503/);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('commitFiles bounds its concurrent existence probes', async () => {
    let inFlight = 0;
    let peak = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (init.method === 'HEAD') {
          peak = Math.max(peak, ++inFlight);
          await new Promise((r) => setTimeout(r, 1));
          inFlight--;
          return new Response(null, { status: 404 });
        }
        return new Response(JSON.stringify({}), { status: url.includes('/commits') ? 201 : 200 });
      })
    );
    const files = Array.from({ length: 40 }, (_, i) => ({ path: `f${i}`, content: 'x' }));
    await gitlab.commitFiles(env, REPO, 'feat', files, 'm');
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it('commitFiles rejects an empty file list', async () => {
    await expect(gitlab.commitFiles(env, REPO, 'b', [], 'm')).rejects.toThrow(/must not be empty/);
  });

  it('writeFile is a single-file commit on the branch', async () => {
    const calls = stubFetch([
      [`GET /projects/${ID}/repository/branches/feat`, () => [200, {}]],
      [`POST /projects/${ID}/repository/commits`, () => [201, {}]],
    ]);
    await gitlab.writeFile(env, REPO, 'a.md', 'hi', 'feat', 'm');
    const commit = calls.find((c) => c.method === 'POST')!;
    expect(commit.body).toMatchObject({ actions: [{ action: 'create', file_path: 'a.md' }] });
  });

  it('ensureBranch creates a missing branch off the default branch', async () => {
    const calls = stubFetch([
      [`GET /projects/${ID}/repository/branches/`, () => [404, {}]],
      [`GET /projects/${ID}`, () => [200, { default_branch: 'main' }]],
      [`POST /projects/${ID}/repository/branches`, () => [201, {}]],
    ]);
    await gitlab.ensureBranch(env, REPO, 'feat/x');
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toContain('branch=feat%2Fx');
    expect(post.url).toContain('ref=main');
  });

  it('ensureBranch surfaces a non-404 failure instead of trying to create the branch', async () => {
    // A 403 on the lookup is not "absent": creating over it would mask the refusal.
    const calls = stubFetch([[`GET /projects/${ID}/repository/branches/`, () => [403, {}]]]);
    await expect(gitlab.ensureBranch(env, REPO, 'feat')).rejects.toThrow(/403/);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('getDefaultBranch assumes main when GitLab reports none (an empty project)', async () => {
    stubFetch([[`GET /projects/${ID}`, () => [200, {}]]]);
    await expect(gitlab.getDefaultBranch(env, REPO)).resolves.toBe('main');
  });

  it('ensureBranch is a no-op when the branch exists', async () => {
    const calls = stubFetch([[`GET /projects/${ID}/repository/branches/`, () => [200, {}]]]);
    await gitlab.ensureBranch(env, REPO, 'feat');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});

describe('gitlab adapter — forks', () => {
  const forkOf = (ns: string, extra: object = {}) => ({
    id: 9,
    path: 'repo',
    web_url: `https://gitlab.com/${ns}/repo`,
    namespace: { full_path: ns },
    ...extra,
  });

  it('forks into the configured namespace', async () => {
    const calls = stubFetch([
      [`POST /projects/${ID}/fork`, () => [201, forkOf('forks', { import_status: 'finished' })]],
    ]);
    const url = await gitlab.ensureFork({ token: 't', forkOrg: 'forks' }, REPO);
    expect(url).toBe('https://gitlab.com/forks/repo');
    expect(calls[0].body).toEqual({ namespace_path: 'forks' });
  });

  const UPSTREAM = { id: 1, path: 'repo', web_url: REPO };
  const ME_REPO = encodeURIComponent('me/repo');

  it('returns the existing fork on 409 at its expected path (no Owner access needed), and waits for import', async () => {
    let polls = 0;
    const calls = stubFetch([
      [`POST /projects/${ID}/fork`, () => [409, { message: 'already exists' }]],
      [`GET /user`, () => [200, { username: 'me' }]],
      [
        `GET /projects/${ME_REPO}`,
        () => [200, forkOf('me', { import_status: 'started', forked_from_project: { id: 1 } })],
      ],
      [`GET /projects/${ID}`, () => [200, UPSTREAM]],
      [
        `GET /projects/9`,
        () => [200, forkOf('me', { import_status: ++polls > 1 ? 'finished' : 'started' })],
      ],
    ]);
    vi.useFakeTimers();
    await expect(settle(gitlab.ensureFork(env, REPO))).resolves.toBe('https://gitlab.com/me/repo');
    // Found directly — never via an `owned=true` list, which hides forks in a
    // group where the token user is a Maintainer rather than an Owner.
    expect(calls.some((c) => c.url.includes('owned'))).toBe(false);
  });

  it('finds a renamed fork through the upstream’s fork list', async () => {
    const calls = stubFetch([
      [`POST /projects/${ID}/fork`, () => [409, {}]],
      [`GET /user`, () => [200, { username: 'me' }]],
      [`GET /projects/${ME_REPO}`, () => [404, {}]],
      [
        `GET /projects/1/forks`,
        () => [
          200,
          [forkOf('someone-else'), forkOf('me', { web_url: 'https://gitlab.com/me/renamed' })],
        ],
      ],
      [`GET /projects/${ID}`, () => [200, UPSTREAM]],
    ]);
    await expect(gitlab.ensureFork(env, REPO)).resolves.toBe('https://gitlab.com/me/renamed');
    expect(calls.find((c) => c.url.includes('/forks'))!.url).not.toContain('owned');
  });

  it('does NOT adopt a same-named project that is not a fork of the upstream', async () => {
    // The path is taken by an unrelated project, and the upstream's fork list
    // has nothing in `me` — committing there would write to the wrong project.
    stubFetch([
      [`POST /projects/${ID}/fork`, () => [409, { message: 'path has already been taken' }]],
      [`GET /user`, () => [200, { username: 'me' }]],
      [`GET /projects/${ME_REPO}`, () => [200, forkOf('me')]],
      [`GET /projects/1/forks`, () => [200, [forkOf('someone-else')]]],
      [`GET /projects/${ID}`, () => [200, UPSTREAM]],
    ]);
    await expect(gitlab.ensureFork(env, REPO)).rejects.toThrow(/409/);
  });

  it('treats a 400 "has already been taken" like a 409 and adopts the existing fork', async () => {
    // GitLab answers a claimed fork path with 400 + a validation message on some
    // versions, 409 on others; both mean "look for the fork that is there".
    stubFetch([
      [
        `POST /projects/${ID}/fork`,
        () => [
          400,
          { message: { name: ['has already been taken'], path: ['has already been taken'] } },
        ],
      ],
      [`GET /user`, () => [200, { username: 'me' }]],
      [
        `GET /projects/${ME_REPO}`,
        () => [200, forkOf('me', { import_status: 'finished', forked_from_project: { id: 1 } })],
      ],
      [`GET /projects/${ID}`, () => [200, UPSTREAM]],
    ]);
    await expect(gitlab.ensureFork(env, REPO)).resolves.toBe('https://gitlab.com/me/repo');
  });

  it('surfaces a failed fork lookup (non-404) rather than falling through to the fork list', async () => {
    const calls = stubFetch([
      [`POST /projects/${ID}/fork`, () => [409, {}]],
      [`GET /user`, () => [200, { username: 'me' }]],
      [`GET /projects/${ME_REPO}`, () => [500, {}]],
      [`GET /projects/${ID}`, () => [200, UPSTREAM]],
    ]);
    await expect(gitlab.ensureFork(env, REPO)).rejects.toThrow(/500/);
    expect(calls.some((c) => c.url.includes('/forks'))).toBe(false);
  });

  it('surfaces a 400 that is not "already taken" (e.g. forking disabled) unchanged', async () => {
    const calls = stubFetch([
      [`POST /projects/${ID}/fork`, () => [400, { message: 'Forking is disabled' }]],
    ]);
    await expect(gitlab.ensureFork(env, REPO)).rejects.toThrow(/400/);
    expect(calls).toHaveLength(1);
  });

  it('fails when the fork import fails', async () => {
    stubFetch([
      [`POST /projects/${ID}/fork`, () => [201, forkOf('me', { import_status: 'failed' })]],
    ]);
    await expect(gitlab.ensureFork(env, REPO)).rejects.toThrow(/import failed/);
  });

  it('gives up when the fork import never finishes', async () => {
    stubFetch([
      [`POST /projects/${ID}/fork`, () => [201, forkOf('me', { import_status: 'started' })]],
      [`GET /projects/9`, () => [200, forkOf('me', { import_status: 'started' })]],
    ]);
    vi.useFakeTimers();
    await expect(settle(gitlab.ensureFork(env, REPO))).rejects.toThrow(/still 'started'/);
  });
});

describe('gitlab adapter — merge requests', () => {
  it('opens a cross-project MR from the fork to the target', async () => {
    const calls = stubFetch([
      [`GET /projects/${ID}`, () => [200, { id: 42 }]],
      [
        `POST /projects/${FORK_ID}/merge_requests`,
        () => [201, { web_url: 'https://gitlab.com/group/sub/repo/-/merge_requests/3' }],
      ],
    ]);
    const url = await gitlab.openPullRequest(env, REPO, 'forks/team/repo:feat', 'main', 'T', 'B');
    expect(url).toContain('/merge_requests/3');
    expect(calls[1].body).toEqual({
      source_branch: 'feat',
      target_branch: 'main',
      target_project_id: 42,
      title: 'T',
      description: 'B',
    });
  });

  it('opens a same-project MR when head is a bare branch', async () => {
    const calls = stubFetch([
      [`GET /projects/${ID}`, () => [200, { id: 42 }]],
      [
        `POST /projects/${ID}/merge_requests`,
        () => [201, { web_url: 'https://gitlab.com/group/sub/repo/-/merge_requests/4' }],
      ],
    ]);
    await expect(gitlab.openPullRequest(env, REPO, 'feat', 'main', 'T', 'B')).resolves.toBe(
      'https://gitlab.com/group/sub/repo/-/merge_requests/4'
    );
    // Created on the target itself — no fork path, no second project lookup.
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      `GET /api/v4/projects/${ID}`,
      `POST /api/v4/projects/${ID}/merge_requests`,
    ]);
    expect(calls[1].body).toMatchObject({ source_branch: 'feat', target_project_id: 42 });
  });

  it('fails loudly when GitLab reports success but returns no MR URL', async () => {
    stubFetch([
      [`GET /projects/${ID}`, () => [200, { id: 42 }]],
      [`POST /projects/${ID}/merge_requests`, () => [201, { iid: 4 }]],
    ]);
    await expect(gitlab.openPullRequest(env, REPO, 'feat', 'main', 'T', 'B')).rejects.toThrow(
      /missing web_url/
    );
  });

  it('returns the already-open MR on 409 for a same-project MR', async () => {
    const calls = stubFetch([
      [
        `GET /projects/${ID}/merge_requests`,
        () => [200, [{ web_url: 'https://gitlab.com/mr/1', source_project_id: 42 }]],
      ],
      [`GET /projects/${ID}`, () => [200, { id: 42 }]],
      [`POST /projects/${ID}/merge_requests`, () => [409, { message: ['exists'] }]],
    ]);
    await expect(gitlab.openPullRequest(env, REPO, 'feat', 'main', 'T', 'B')).resolves.toBe(
      'https://gitlab.com/mr/1'
    );
    const list = calls.find((c) => c.url.includes('/merge_requests?'))!;
    expect(list.url).toContain('source_branch=feat');
    expect(list.url).toContain('state=opened');
  });

  it('returns the already-open fork MR on 409, listed on the TARGET and matched on the fork', async () => {
    // MRs belong to their target project: listing on the fork finds nothing.
    stubFetch([
      [
        `GET /projects/${ID}/merge_requests`,
        () => [
          200,
          [
            { web_url: 'https://gitlab.com/mr/other-fork', source_project_id: 7 },
            { web_url: 'https://gitlab.com/mr/ours', source_project_id: 9 },
          ],
        ],
      ],
      [`GET /projects/${FORK_ID}/merge_requests`, () => [200, []]],
      [`GET /projects/${FORK_ID}`, () => [200, { id: 9 }]],
      [`GET /projects/${ID}`, () => [200, { id: 42 }]],
      [`POST /projects/${FORK_ID}/merge_requests`, () => [409, { message: ['exists'] }]],
    ]);
    await expect(
      gitlab.openPullRequest(env, REPO, 'forks/team/repo:feat', 'main', 'T', 'B')
    ).resolves.toBe('https://gitlab.com/mr/ours');
  });

  it('rethrows the 409 when no matching open MR is found', async () => {
    stubFetch([
      [
        `GET /projects/${ID}/merge_requests`,
        () => [200, [{ web_url: 'https://gitlab.com/mr/x', source_project_id: 7 }]],
      ],
      [`GET /projects/${ID}`, () => [200, { id: 42 }]],
      [`POST /projects/${ID}/merge_requests`, () => [409, {}]],
    ]);
    await expect(gitlab.openPullRequest(env, REPO, 'feat', 'main', 'T', 'B')).rejects.toThrow(
      /409/
    );
  });
});
