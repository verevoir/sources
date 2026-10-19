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
  commitFiles,
  getRepoTree,
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
    if (result.kind !== 'found') throw new Error(`expected 'found', got ${result.kind}`);
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

  it("gives kind 'binary' with mediaType image/png, the right size and identical bytes, for a PNG fixture", async () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52,
    ]);
    scriptFetch([
      {
        status: 200,
        body: { type: 'file', content: png.toString('base64'), sha: 'png-sha' },
      },
    ]);
    const result = await readFile(env, 'foo/bar', 'pic.png');
    if (result.kind !== 'binary') throw new Error(`expected 'binary', got ${result.kind}`);
    expect(result.mediaType).toBe('image/png');
    expect(result.size).toBe(png.length);
    expect(Buffer.from(result.bytes)).toEqual(png);
  });

  it("gives kind 'binary' with mediaType application/octet-stream for a NUL-containing non-image file", async () => {
    const data = Buffer.concat([
      Buffer.from('not an image'),
      Buffer.from([0x00]),
      Buffer.from('more'),
    ]);
    scriptFetch([
      {
        status: 200,
        body: { type: 'file', content: data.toString('base64'), sha: 'blob-sha' },
      },
    ]);
    const result = await readFile(env, 'foo/bar', 'blob.dat');
    if (result.kind !== 'binary') throw new Error(`expected 'binary', got ${result.kind}`);
    expect(result.mediaType).toBe('application/octet-stream');
    expect(result.size).toBe(data.length);
    expect(Buffer.from(result.bytes)).toEqual(data);
  });

  it('strips a UTF-8 BOM and returns the decoded text, not the BOM bytes', async () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello', 'utf8')]);
    scriptFetch([
      {
        status: 200,
        body: { type: 'file', content: withBom.toString('base64'), sha: 'bom-sha' },
      },
    ]);
    const result = await readFile(env, 'foo/bar', 'bom.txt');
    if (result.kind !== 'found') throw new Error(`expected 'found', got ${result.kind}`);
    expect(result.content).toBe('hello');
  });

  it('decodes UTF-16LE with a BOM as text, even though the bytes are full of NUL', async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello', 'utf16le')]);
    scriptFetch([
      {
        status: 200,
        body: { type: 'file', content: utf16.toString('base64'), sha: 'u16-sha' },
      },
    ]);
    const result = await readFile(env, 'foo/bar', 'utf16.txt');
    if (result.kind !== 'found') throw new Error(`expected 'found', got ${result.kind}`);
    expect(result.content).toBe('hello');
  });

  it('gives binary octet-stream for invalid UTF-8 with no recognised signature and no NUL byte', async () => {
    const invalid = Buffer.concat([
      Buffer.from('plain text start, no signature here: '),
      Buffer.from([0xc3, 0x28]),
      Buffer.from(' more text after the bad byte'),
    ]);
    expect(invalid.includes(0x00)).toBe(false);
    scriptFetch([
      {
        status: 200,
        body: { type: 'file', content: invalid.toString('base64'), sha: 'inv-sha' },
      },
    ]);
    const result = await readFile(env, 'foo/bar', 'invalid.dat');
    if (result.kind !== 'binary') throw new Error(`expected 'binary', got ${result.kind}`);
    expect(result.mediaType).toBe('application/octet-stream');
  });

  it('reads ordinary text starting with a WEAK signature prefix ("BM") as text, unchanged', async () => {
    const text = 'BMW notes on the quarterly report.\n';
    scriptFetch([
      {
        status: 200,
        body: {
          type: 'file',
          content: Buffer.from(text, 'utf8').toString('base64'),
          sha: 'weak-sha',
        },
      },
    ]);
    const result = await readFile(env, 'foo/bar', 'weak.txt');
    if (result.kind !== 'found') throw new Error(`expected 'found', got ${result.kind}`);
    expect(result.content).toBe(text);
  });

  it('a WEAK signature match ("BM") whose content also fails the text floor (invalid UTF-8, no NUL) is binary, not text', async () => {
    const fixture = Buffer.concat([
      Buffer.from('BM', 'ascii'),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('padding so this is not a tiny buffer', 'ascii'),
    ]);
    expect(fixture.includes(0x00)).toBe(false);
    scriptFetch([
      {
        status: 200,
        body: { type: 'file', content: fixture.toString('base64'), sha: 'weak-invalid-sha' },
      },
    ]);
    const result = await readFile(env, 'foo/bar', 'weak-invalid.dat');
    if (result.kind !== 'binary') throw new Error(`expected 'binary', got ${result.kind}`);
    expect(result.mediaType).toBe('image/bmp');
  });

  it('reads non-ASCII UTF-8 text byte-for-byte unchanged (binary detection does not touch real text)', async () => {
    const text = 'héllo wörld — 日本語\n';
    scriptFetch([
      {
        status: 200,
        body: {
          type: 'file',
          content: Buffer.from(text, 'utf8').toString('base64'),
          sha: 'intl-sha',
        },
      },
    ]);
    const result = await readFile(env, 'foo/bar', 'intl.md');
    if (result.kind !== 'found') throw new Error(`expected 'found', got ${result.kind}`);
    expect(result.content).toBe(text);
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

describe('isFresh — BOM and binary content behave like any other file', () => {
  it('BOM file: true for the recorded sha, false once GitHub reports it has moved', async () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello', 'utf8')]);
    scriptFetch([
      {
        status: 200,
        body: { type: 'file', content: withBom.toString('base64'), sha: 'bom-sha-1' },
      },
    ]);
    await expect(isFresh(env, 'foo/bar', 'bom.txt', 'bom-sha-1', 'main')).resolves.toBe(true);
    scriptFetch([
      {
        status: 200,
        body: { type: 'file', content: withBom.toString('base64'), sha: 'bom-sha-2' },
      },
    ]);
    await expect(isFresh(env, 'foo/bar', 'bom.txt', 'bom-sha-1', 'main')).resolves.toBe(false);
  });

  it('binary file: true for the recorded sha, false once GitHub reports it has moved', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    scriptFetch([
      {
        status: 200,
        body: { type: 'file', content: png.toString('base64'), sha: 'png-sha-1' },
      },
    ]);
    await expect(isFresh(env, 'foo/bar', 'pic.png', 'png-sha-1', 'main')).resolves.toBe(true);
    scriptFetch([
      {
        status: 200,
        body: { type: 'file', content: png.toString('base64'), sha: 'png-sha-2' },
      },
    ]);
    await expect(isFresh(env, 'foo/bar', 'pic.png', 'png-sha-1', 'main')).resolves.toBe(false);
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

describe('commitFiles (atomic multi-file via the Git Data API)', () => {
  it('throws on an empty files array', async () => {
    await expect(commitFiles(env, 'https://github.com/o/r', 'main', [], 'msg')).rejects.toThrow(
      /must not be empty/
    );
  });

  it('creates blobs, a tree on the base, a commit on the tip, and moves the ref', async () => {
    scriptFetch([
      {
        matchMethod: 'GET',
        matchPath: /git\/refs\/heads\/main$/,
        status: 200,
        body: { object: { sha: 'tip' } },
      },
      {
        matchMethod: 'GET',
        matchPath: /git\/refs\/heads\/main$/,
        status: 200,
        body: { object: { sha: 'tip' } },
      },
      {
        matchMethod: 'GET',
        matchPath: /git\/commits\/tip$/,
        status: 200,
        body: { tree: { sha: 'basetree' } },
      },
      { matchMethod: 'POST', matchPath: /git\/blobs$/, status: 201, body: { sha: 'blobA' } },
      { matchMethod: 'POST', matchPath: /git\/blobs$/, status: 201, body: { sha: 'blobB' } },
      { matchMethod: 'POST', matchPath: /git\/trees$/, status: 201, body: { sha: 'newtree' } },
      { matchMethod: 'POST', matchPath: /git\/commits$/, status: 201, body: { sha: 'newcommit' } },
      { matchMethod: 'PATCH', matchPath: /git\/refs\/heads\/main$/, status: 200, body: {} },
    ]);

    await commitFiles(
      env,
      'https://github.com/o/r',
      'main',
      [
        { path: 'a.txt', content: 'AAA' },
        { path: 'dir/b.txt', content: 'BBB' },
      ],
      'atomic commit'
    );

    const treeCall = calls.find((c) => /git\/trees$/.test(c.url))!;
    const treeBody = JSON.parse(treeCall.init.body as string);
    expect(treeBody.base_tree).toBe('basetree');
    expect(treeBody.tree).toEqual([
      { path: 'a.txt', mode: '100644', type: 'blob', sha: 'blobA' },
      { path: 'dir/b.txt', mode: '100644', type: 'blob', sha: 'blobB' },
    ]);

    const commitCall = calls.find(
      (c) => /git\/commits$/.test(c.url) && (c.init.method ?? '').toUpperCase() === 'POST'
    )!;
    expect(JSON.parse(commitCall.init.body as string)).toMatchObject({
      message: 'atomic commit',
      tree: 'newtree',
      parents: ['tip'],
    });

    const patchCall = calls.find((c) => (c.init.method ?? '').toUpperCase() === 'PATCH')!;
    expect(JSON.parse(patchCall.init.body as string)).toEqual({ sha: 'newcommit' });
  });
});

// getRepoTree had no coverage at all, which is how it came to resolve `ref`
// differently from readFile and listFiles beside it.
describe('getRepoTree resolves the ref the same way its neighbours do', () => {
  const treeBody = {
    tree: [{ path: 'src/a.ts', type: 'blob', size: 10, sha: 'blob1' }],
    truncated: false,
  };
  const branchBody = { commit: { commit: { tree: { sha: 'tree1' } } } };

  it('treats an EMPTY-STRING ref as omitted, and resolves the default branch', async () => {
    // THE ONE THAT COVERS THE FIX. Reverting to `??` fails this test and only
    // this test — the other three pass a truthy ref or none, where `||` and
    // `??` agree. Verified by re-applying the defect and watching it go red.
    scriptFetch([
      { status: 200, body: { default_branch: 'main' } },
      { status: 200, body: branchBody },
      { status: 200, body: treeBody },
    ]);

    const tree = await getRepoTree(env, 'foo/bar', '');

    expect(tree.entries).toHaveLength(1);
    expect(calls[1].url, 'it asked for a branch with no name').toBe(
      'https://api.github.com/repos/foo/bar/branches/main'
    );
  });

  it('treats an omitted ref the same way', async () => {
    scriptFetch([
      { status: 200, body: { default_branch: 'main' } },
      { status: 200, body: branchBody },
      { status: 200, body: treeBody },
    ]);

    await getRepoTree(env, 'foo/bar');

    expect(calls[1].url).toBe('https://api.github.com/repos/foo/bar/branches/main');
  });

  it('uses an explicit ref as given, without asking for the default branch', async () => {
    scriptFetch([
      { status: 200, body: branchBody },
      { status: 200, body: treeBody },
    ]);

    await getRepoTree(env, 'foo/bar', 'feature-branch');

    expect(calls[0].url).toBe('https://api.github.com/repos/foo/bar/branches/feature-branch');
  });

  it('throws rather than returning an empty tree when no tree sha resolves', async () => {
    // NOT coverage of the ref fix — it passes a truthy ref, where `||` and `??`
    // behave identically, so reverting the fix leaves this green. It covers
    // pre-existing behaviour that had no test: an empty entry list and "the
    // branch did not resolve" are different answers, and this pins that the
    // second is raised rather than returned as the first.
    scriptFetch([{ status: 200, body: { commit: {} } }]);

    await expect(getRepoTree(env, 'foo/bar', 'main')).rejects.toBeInstanceOf(SourceApiError);
  });
});

// fetchContentsMeta (the metadata-only GET behind isFresh and writeFile's
// prior-sha lookup) has its own directory/type guards, identical in shape to
// readFile's -- but reached through a different caller here, never readFile.
describe('isFresh — fetchContentsMeta guards (reached through isFresh, not readFile)', () => {
  it('throws, naming the path, when it resolves to a directory -- fetchContentsMeta rejects before isFresh ever compares a sha', async () => {
    scriptFetch([{ status: 200, body: [] }]); // an array body means "this is a directory"
    await expect(isFresh(env, 'foo/bar', 'src', 'whatever', 'main')).rejects.toThrow(
      /src is a directory, not a file/
    );
  });

  it('throws, naming the type, when it resolves to a non-file type (e.g. a submodule)', async () => {
    scriptFetch([{ status: 200, body: { type: 'submodule', sha: 'sub-sha' } }]);
    await expect(isFresh(env, 'foo/bar', 'vendor/lib', 'whatever', 'main')).rejects.toThrow(
      /vendor\/lib is type=submodule, not a file/
    );
  });
});

describe('writeFile — fetchContentsMeta guards (reached through writeFile, not readFile)', () => {
  it('throws, naming the path, when the target resolves to a directory, and never issues the PUT', async () => {
    scriptFetch([
      { status: 200, body: { object: { sha: 'x' } } }, // ensureBranch: branch exists
      { status: 200, body: [] }, // fetchContentsMeta: directory
    ]);
    await expect(
      writeFile(env, 'foo/bar', 'src', 'new content', 'aigency/TP-5', 'msg')
    ).rejects.toThrow(/src is a directory, not a file/);
    expect(calls).toHaveLength(2); // confirms the PUT (a 3rd call) never happened
  });

  it('throws, naming the type, when the target resolves to a non-file type, and never issues the PUT', async () => {
    scriptFetch([
      { status: 200, body: { object: { sha: 'x' } } },
      { status: 200, body: { type: 'submodule', sha: 'sub-sha' } },
    ]);
    await expect(
      writeFile(env, 'foo/bar', 'vendor/lib', 'new content', 'aigency/TP-5', 'msg')
    ).rejects.toThrow(/vendor\/lib is type=submodule, not a file/);
    expect(calls).toHaveLength(2);
  });
});
