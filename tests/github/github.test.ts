import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SourceApiError, type SourceEnv } from '../../src/index.js';
import {
  getDefaultBranch,
  readFile,
  listFiles,
  isFresh,
  ensureBranch,
  writeFile,
  ensureFork,
  openPullRequest,
  parseGithubRepoUrl,
} from '../../src/github/index.js';

const env: SourceEnv = { token: 'test-token', forkOrg: 'verevoir' };
const originalFetch = globalThis.fetch;

interface FetchCall {
  url: string;
  init: RequestInit;
}

let calls: FetchCall[] = [];

function scriptFetch(
  scripts: Array<{
    matchPath?: RegExp;
    matchMethod?: string;
    status: number;
    body?: unknown;
    text?: string;
  }>
) {
  let i = 0;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const script = scripts[i++];
    if (!script) {
      throw new Error(`scriptFetch: ran out of scripts at call ${i} for ${url}`);
    }
    if (
      script.matchMethod &&
      (init?.method ?? 'GET').toUpperCase() !== script.matchMethod.toUpperCase()
    ) {
      throw new Error(
        `scriptFetch[${i - 1}]: method ${init?.method} does not match ${script.matchMethod}`
      );
    }
    if (script.matchPath && !script.matchPath.test(url)) {
      throw new Error(`scriptFetch[${i - 1}]: url ${url} does not match ${script.matchPath}`);
    }
    const responseBody = script.text ?? (script.body ? JSON.stringify(script.body) : '');
    return new Response(responseBody, { status: script.status });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('parseGithubRepoUrl', () => {
  it('parses https URLs with .git suffix', () => {
    expect(parseGithubRepoUrl('https://github.com/foo/bar.git')).toEqual({
      owner: 'foo',
      repo: 'bar',
    });
  });
  it('parses ssh URLs', () => {
    expect(parseGithubRepoUrl('git@github.com:foo/bar')).toEqual({
      owner: 'foo',
      repo: 'bar',
    });
  });
  it('parses owner/repo shorthand', () => {
    expect(parseGithubRepoUrl('foo/bar')).toEqual({ owner: 'foo', repo: 'bar' });
  });
  it('returns null for nonsense', () => {
    expect(parseGithubRepoUrl('not a url at all')).toBeNull();
  });
});

describe('getDefaultBranch', () => {
  it('returns the default_branch from the repo metadata', async () => {
    scriptFetch([{ status: 200, body: { default_branch: 'develop' } }]);
    const result = await getDefaultBranch(env, 'https://github.com/foo/bar');
    expect(result).toBe('develop');
    expect(calls[0].url).toBe('https://api.github.com/repos/foo/bar');
    expect(calls[0].init.method).toBe('GET');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-token');
  });

  it("falls back to 'main' when default_branch is missing", async () => {
    scriptFetch([{ status: 200, body: {} }]);
    expect(await getDefaultBranch(env, 'foo/bar')).toBe('main');
  });

  it('throws SourceApiError on 404', async () => {
    scriptFetch([{ status: 404, text: 'not found' }]);
    await expect(getDefaultBranch(env, 'foo/bar')).rejects.toBeInstanceOf(SourceApiError);
  });
});

describe('readFile', () => {
  it('decodes base64 content and returns the sha', async () => {
    scriptFetch([
      {
        status: 200,
        body: {
          type: 'file',
          content: Buffer.from('hello world\n', 'utf8').toString('base64'),
          sha: 'abc123',
        },
      },
    ]);
    const result = await readFile(env, 'foo/bar', 'README.md', 'feature-branch');
    expect(result.content).toBe('hello world\n');
    expect(result.sha).toBe('abc123');
    expect(calls[0].url).toBe(
      'https://api.github.com/repos/foo/bar/contents/README.md?ref=feature-branch'
    );
  });

  it('throws when the path is a directory', async () => {
    scriptFetch([{ status: 200, body: [] }]);
    await expect(readFile(env, 'foo/bar', 'src')).rejects.toBeInstanceOf(SourceApiError);
  });

  it('throws SourceApiError with status=404 on missing file', async () => {
    scriptFetch([{ status: 404, text: 'not found' }]);
    try {
      await readFile(env, 'foo/bar', 'missing.txt');
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SourceApiError);
      expect((err as SourceApiError).status).toBe(404);
    }
  });
});

describe('isFresh', () => {
  it('returns true when current blob sha matches the cached version', async () => {
    scriptFetch([
      {
        status: 200,
        body: {
          type: 'file',
          content: Buffer.from('payload', 'utf8').toString('base64'),
          sha: 'cached-sha',
        },
      },
    ]);
    await expect(isFresh(env, 'foo/bar', 'README.md', 'cached-sha', 'main')).resolves.toBe(true);
  });

  it('returns false when the blob sha has moved', async () => {
    scriptFetch([
      {
        status: 200,
        body: {
          type: 'file',
          content: Buffer.from('payload', 'utf8').toString('base64'),
          sha: 'newer-sha',
        },
      },
    ]);
    await expect(isFresh(env, 'foo/bar', 'README.md', 'older-sha', 'main')).resolves.toBe(false);
  });

  it('returns false when the path no longer resolves (404)', async () => {
    scriptFetch([{ status: 404, text: 'not found' }]);
    await expect(isFresh(env, 'foo/bar', 'gone.md', 'whatever', 'main')).resolves.toBe(false);
  });

  it('propagates non-404 errors', async () => {
    scriptFetch([{ status: 500, text: 'boom' }]);
    await expect(isFresh(env, 'foo/bar', 'README.md', 'sha', 'main')).rejects.toBeInstanceOf(
      SourceApiError
    );
  });
});

describe('listFiles', () => {
  it('maps the directory entries into a clean shape', async () => {
    scriptFetch([
      {
        status: 200,
        body: [
          { name: 'README.md', type: 'file', path: 'README.md', sha: 'a' },
          { name: 'src', type: 'dir', path: 'src', sha: 'b' },
          { name: 'symlinkto', type: 'symlink', path: 'symlinkto', sha: 'c' },
        ],
      },
    ]);
    const entries = await listFiles(env, 'foo/bar', '', 'main');
    expect(entries).toEqual([
      { name: 'README.md', type: 'file', path: 'README.md', sha: 'a' },
      { name: 'src', type: 'dir', path: 'src', sha: 'b' },
      { name: 'symlinkto', type: 'symlink', path: 'symlinkto', sha: 'c' },
    ]);
  });

  it('throws when the path is a file (single object response)', async () => {
    scriptFetch([
      {
        status: 200,
        body: { type: 'file', name: 'README.md', sha: 'a', content: '' },
      },
    ]);
    await expect(listFiles(env, 'foo/bar', 'README.md')).rejects.toThrow(/not a directory/);
  });
});

describe('ensureBranch', () => {
  it('does nothing when the branch already exists', async () => {
    scriptFetch([{ status: 200, body: { object: { sha: 'abc' } } }]);
    await ensureBranch(env, 'foo/bar', 'aigency/TP-5');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.github.com/repos/foo/bar/git/refs/heads/aigency/TP-5');
  });

  it("creates the branch off the repo's default when missing", async () => {
    scriptFetch([
      { status: 404, text: '' },
      { status: 200, body: { default_branch: 'main' } },
      { status: 200, body: { object: { sha: 'main-sha' } } },
      { status: 201, body: {} },
    ]);
    await ensureBranch(env, 'foo/bar', 'aigency/TP-5');
    expect(calls).toHaveLength(4);
    const post = calls[3];
    expect(post.init.method).toBe('POST');
    expect(post.url).toBe('https://api.github.com/repos/foo/bar/git/refs');
    expect(JSON.parse(post.init.body as string)).toEqual({
      ref: 'refs/heads/aigency/TP-5',
      sha: 'main-sha',
    });
  });
});

describe('writeFile', () => {
  it('updates an existing file with prior sha', async () => {
    scriptFetch([
      { status: 200, body: { object: { sha: 'x' } } },
      {
        status: 200,
        body: {
          type: 'file',
          content: Buffer.from('old', 'utf8').toString('base64'),
          sha: 'prior-sha',
        },
      },
      { status: 200, body: {} },
    ]);
    await writeFile(env, 'foo/bar', 'src/x.ts', 'new content', 'aigency/TP-5', 'Update x.ts');
    const put = calls[2];
    expect(put.init.method).toBe('PUT');
    expect(put.url).toBe('https://api.github.com/repos/foo/bar/contents/src/x.ts');
    const body = JSON.parse(put.init.body as string);
    expect(body.message).toBe('Update x.ts');
    expect(body.branch).toBe('aigency/TP-5');
    expect(body.sha).toBe('prior-sha');
    expect(Buffer.from(body.content, 'base64').toString('utf8')).toBe('new content');
  });

  it('creates a new file when the path does not exist (no prior sha)', async () => {
    scriptFetch([
      { status: 200, body: { object: { sha: 'x' } } },
      { status: 404, text: '' },
      { status: 201, body: {} },
    ]);
    await writeFile(env, 'foo/bar', 'src/new.ts', 'hello', 'aigency/TP-5', 'Create new.ts');
    const put = calls[2];
    const body = JSON.parse(put.init.body as string);
    expect(body.sha).toBeUndefined();
  });
});

describe('ensureFork', () => {
  it('POSTs to /repos/{owner}/{repo}/forks with the org and returns the fork clone_url', async () => {
    scriptFetch([
      {
        status: 202,
        body: { clone_url: 'https://github.com/verevoir/bar.git' },
      },
    ]);
    const url = await ensureFork(env, 'foo/bar');
    expect(url).toBe('https://github.com/verevoir/bar.git');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      organization: 'verevoir',
    });
  });
});

describe('openPullRequest', () => {
  it('POSTs the PR with title/body/head/base and returns html_url', async () => {
    scriptFetch([
      {
        status: 201,
        body: { html_url: 'https://github.com/foo/bar/pull/42' },
      },
    ]);
    const url = await openPullRequest(
      env,
      'foo/bar',
      'verevoir:aigency/TP-5',
      'main',
      'Add x',
      'Body'
    );
    expect(url).toBe('https://github.com/foo/bar/pull/42');
    const body = JSON.parse(calls[0].init.body as string);
    expect(body).toEqual({
      title: 'Add x',
      body: 'Body',
      head: 'verevoir:aigency/TP-5',
      base: 'main',
    });
  });
});
