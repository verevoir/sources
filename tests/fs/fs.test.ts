import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsPromises } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  readFile,
  listFiles,
  getRepoTree,
  isFresh,
  writeFile,
  ensureBranch,
  ensureFork,
  openPullRequest,
  getDefaultBranch,
  gitDetail,
} from '../../src/fs/index.js';
import { SourceApiError, type SourceEnv } from '../../src/index.js';

const env: SourceEnv = { token: '', forkOrg: '' };

/** sha256 hex prefix, matching shaOf's documented surrogate-sha format --
 * not importing the internal helper, since this tests the externally
 * observable hash a caller of isFresh would compute, not an
 * implementation detail. */
function hashOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 40);
}

let root: string;

beforeEach(async () => {
  root = await fsPromises.mkdtemp(join(tmpdir(), 'fs-adapter-test-'));
});

afterEach(async () => {
  await fsPromises.rm(root, { recursive: true, force: true });
});

describe('readFile', () => {
  it('reads content + returns a content-derived sha', async () => {
    await fsPromises.writeFile(join(root, 'a.txt'), 'hello world\n', 'utf8');
    const result = await readFile(env, root, 'a.txt');
    if (result.kind !== 'found') throw new Error(`expected 'found', got ${result.kind}`);
    expect(result.content).toBe('hello world\n');
    expect(result.sha).toMatch(/^[a-f0-9]{40}$/);
  });

  it('throws SourceApiError with status=404 on missing file', async () => {
    try {
      await readFile(env, root, 'missing.txt');
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SourceApiError);
      expect((err as SourceApiError).status).toBe(404);
    }
  });

  it('refuses paths that escape the root via ..', async () => {
    await expect(readFile(env, root, '../escape.txt')).rejects.toBeInstanceOf(SourceApiError);
  });

  it('refuses absolute paths', async () => {
    await expect(readFile(env, root, '/etc/passwd')).rejects.toBeInstanceOf(SourceApiError);
  });

  it('reads non-ASCII UTF-8 text byte-for-byte unchanged (binary detection does not touch real text)', async () => {
    const text = 'héllo wörld — 日本語\n';
    await fsPromises.writeFile(join(root, 'intl.txt'), text, 'utf8');
    const result = await readFile(env, root, 'intl.txt');
    if (result.kind !== 'found') throw new Error(`expected 'found', got ${result.kind}`);
    expect(result.content).toBe(text);
  });

  it("gives kind 'binary' with mediaType image/png, the right size and identical bytes, for a PNG fixture", async () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52,
    ]);
    await fsPromises.writeFile(join(root, 'pic.png'), png);
    const result = await readFile(env, root, 'pic.png');
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
    await fsPromises.writeFile(join(root, 'blob.dat'), data);
    const result = await readFile(env, root, 'blob.dat');
    if (result.kind !== 'binary') throw new Error(`expected 'binary', got ${result.kind}`);
    expect(result.mediaType).toBe('application/octet-stream');
    expect(result.size).toBe(data.length);
    expect(Buffer.from(result.bytes)).toEqual(data);
  });

  it('strips a UTF-8 BOM and returns the decoded text, not the BOM bytes', async () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello', 'utf8')]);
    await fsPromises.writeFile(join(root, 'bom.txt'), withBom);
    const result = await readFile(env, root, 'bom.txt');
    if (result.kind !== 'found') throw new Error(`expected 'found', got ${result.kind}`);
    expect(result.content).toBe('hello');
  });

  it('decodes UTF-16LE with a BOM as text, even though the bytes are full of NUL', async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello', 'utf16le')]);
    await fsPromises.writeFile(join(root, 'utf16.txt'), utf16);
    const result = await readFile(env, root, 'utf16.txt');
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
    await fsPromises.writeFile(join(root, 'invalid.txt'), invalid);
    const result = await readFile(env, root, 'invalid.txt');
    if (result.kind !== 'binary') throw new Error(`expected 'binary', got ${result.kind}`);
    expect(result.mediaType).toBe('application/octet-stream');
  });

  it('reads ordinary text starting with a WEAK signature prefix ("BM") as text, unchanged', async () => {
    const text = 'BMW notes on the quarterly report.\n';
    await fsPromises.writeFile(join(root, 'weak.txt'), text, 'utf8');
    const result = await readFile(env, root, 'weak.txt');
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
    await fsPromises.writeFile(join(root, 'weak-invalid.dat'), fixture);
    const result = await readFile(env, root, 'weak-invalid.dat');
    if (result.kind !== 'binary') throw new Error(`expected 'binary', got ${result.kind}`);
    expect(result.mediaType).toBe('image/bmp');
  });
});

describe('listFiles', () => {
  it('lists files and directories at the given prefix', async () => {
    await fsPromises.writeFile(join(root, 'README.md'), '#', 'utf8');
    await fsPromises.mkdir(join(root, 'src'));
    await fsPromises.writeFile(join(root, 'src', 'index.ts'), '//', 'utf8');

    const top = await listFiles(env, root, '');
    expect(
      top.map((e) => ({ name: e.name, type: e.type })).sort((a, b) => a.name.localeCompare(b.name))
    ).toEqual([
      { name: 'README.md', type: 'file' },
      { name: 'src', type: 'dir' },
    ]);

    const inSrc = await listFiles(env, root, 'src');
    expect(inSrc).toHaveLength(1);
    expect(inSrc[0].path).toBe('src/index.ts');
  });

  it('throws SourceApiError with status=404 on missing prefix', async () => {
    try {
      await listFiles(env, root, 'nope');
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SourceApiError);
      expect((err as SourceApiError).status).toBe(404);
    }
  });
});

describe('getRepoTree', () => {
  it('walks the tree recursively, returning blobs and trees', async () => {
    await fsPromises.writeFile(join(root, 'README.md'), 'A', 'utf8');
    await fsPromises.mkdir(join(root, 'src'));
    await fsPromises.writeFile(join(root, 'src', 'a.ts'), 'a', 'utf8');
    await fsPromises.writeFile(join(root, 'src', 'b.ts'), 'bb', 'utf8');

    const tree = await getRepoTree(env, root);
    const paths = tree.entries.map((e) => e.path).sort();
    expect(paths).toEqual(['README.md', 'src', 'src/a.ts', 'src/b.ts']);

    const readmeEntry = tree.entries.find((e) => e.path === 'README.md');
    expect(readmeEntry?.type).toBe('blob');
    expect(readmeEntry?.size).toBe(1);

    const srcEntry = tree.entries.find((e) => e.path === 'src');
    expect(srcEntry?.type).toBe('tree');

    expect(tree.truncated).toBe(false);
  });

  it('skips ignored directories (node_modules, .git, ...)', async () => {
    await fsPromises.mkdir(join(root, 'node_modules'));
    await fsPromises.writeFile(join(root, 'node_modules', 'pkg.json'), '{}', 'utf8');
    await fsPromises.mkdir(join(root, '.git'));
    await fsPromises.writeFile(join(root, '.git', 'HEAD'), 'ref', 'utf8');
    await fsPromises.writeFile(join(root, 'app.ts'), 'a', 'utf8');

    const tree = await getRepoTree(env, root);
    const paths = tree.entries.map((e) => e.path);
    expect(paths).toContain('app.ts');
    expect(paths.some((p) => p.startsWith('node_modules'))).toBe(false);
    expect(paths.some((p) => p.startsWith('.git'))).toBe(false);
  });
});

describe('writeFile', () => {
  it('creates a new file', async () => {
    await writeFile(env, root, 'new.txt', 'hello', 'ignored', 'ignored');
    const content = await fsPromises.readFile(join(root, 'new.txt'), 'utf8');
    expect(content).toBe('hello');
  });

  it('creates parent directories as needed', async () => {
    await writeFile(env, root, 'a/b/c/deep.txt', 'body', 'ignored', 'ignored');
    const content = await fsPromises.readFile(join(root, 'a/b/c/deep.txt'), 'utf8');
    expect(content).toBe('body');
  });

  it('overwrites existing files', async () => {
    await fsPromises.writeFile(join(root, 'x.txt'), 'old', 'utf8');
    await writeFile(env, root, 'x.txt', 'new', 'ignored', 'ignored');
    const content = await fsPromises.readFile(join(root, 'x.txt'), 'utf8');
    expect(content).toBe('new');
  });

  it('refuses to write outside the root', async () => {
    await expect(
      writeFile(env, root, '../escape.txt', 'evil', 'ignored', 'ignored')
    ).rejects.toBeInstanceOf(SourceApiError);
  });
});

describe('isFresh', () => {
  it('returns true when version matches current content sha', async () => {
    await fsPromises.writeFile(join(root, 'a.txt'), 'hello', 'utf8');
    const result = await readFile(env, root, 'a.txt');
    if (result.kind !== 'found') throw new Error(`expected 'found', got ${result.kind}`);
    await expect(isFresh(env, root, 'a.txt', result.sha)).resolves.toBe(true);
  });

  it('returns false when content has changed since the version was recorded', async () => {
    await fsPromises.writeFile(join(root, 'a.txt'), 'old', 'utf8');
    const result = await readFile(env, root, 'a.txt');
    if (result.kind !== 'found') throw new Error(`expected 'found', got ${result.kind}`);
    await fsPromises.writeFile(join(root, 'a.txt'), 'new', 'utf8');
    await expect(isFresh(env, root, 'a.txt', result.sha)).resolves.toBe(false);
  });

  it('returns false when the file no longer exists', async () => {
    await expect(isFresh(env, root, 'missing.txt', 'whatever')).resolves.toBe(false);
  });

  it('refuses paths that escape the root', async () => {
    await expect(isFresh(env, root, '../escape.txt', 'sha')).rejects.toBeInstanceOf(SourceApiError);
  });
});

describe('isFresh — BOM and binary content', () => {
  it('BOM file: true for the recorded sha, false once the content changes', async () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello', 'utf8')]);
    await fsPromises.writeFile(join(root, 'bom2.txt'), withBom);
    const result = await readFile(env, root, 'bom2.txt');
    if (result.kind !== 'found') throw new Error(`expected 'found', got ${result.kind}`);
    await expect(isFresh(env, root, 'bom2.txt', result.sha)).resolves.toBe(true);
    await fsPromises.writeFile(
      join(root, 'bom2.txt'),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('changed', 'utf8')])
    );
    await expect(isFresh(env, root, 'bom2.txt', result.sha)).resolves.toBe(false);
  });

  it('binary file: true for its own hash, false once the bytes change (isFresh hashes raw bytes, not a decoded string)', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await fsPromises.writeFile(join(root, 'pic2.png'), png);
    await expect(isFresh(env, root, 'pic2.png', hashOf(png))).resolves.toBe(true);
    const changed = Buffer.concat([png, Buffer.from([0xff])]);
    await fsPromises.writeFile(join(root, 'pic2.png'), changed);
    await expect(isFresh(env, root, 'pic2.png', hashOf(png))).resolves.toBe(false);
  });
});

describe('not-applicable operations', () => {
  it('ensureBranch is a no-op', async () => {
    await expect(ensureBranch(env, root, 'main')).resolves.toBeUndefined();
  });

  it('ensureFork throws 501', async () => {
    try {
      await ensureFork(env, 'https://github.com/x/y');
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SourceApiError);
      expect((err as SourceApiError).status).toBe(501);
    }
  });

  it('openPullRequest throws 501', async () => {
    try {
      await openPullRequest(env, root, 'a', 'main', 't', 'b');
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SourceApiError);
      expect((err as SourceApiError).status).toBe(501);
    }
  });

  it("getDefaultBranch returns 'local'", async () => {
    expect(await getDefaultBranch(env, root)).toBe('local');
  });
});

describe('a ref this adapter cannot honour is refused, not ignored', () => {
  // One verb per test. Four exported functions with four signatures are four
  // reasons to fail, and bundled they hide every failure after the first.
  const verbs: [string, (ref: string) => Promise<unknown>][] = [
    ['readFile', (ref) => readFile(env, root, 'a.txt', ref)],
    ['listFiles', (ref) => listFiles(env, root, '', ref)],
    ['getRepoTree', (ref) => getRepoTree(env, root, ref)],
    ['isFresh', (ref) => isFresh(env, root, 'a.txt', 'sha', ref)],
  ];

  it.each(verbs)('%s refuses a named ref', async (_name, call) => {
    // The defect: `void ref` meant a caller asking for `main` got the working
    // tree with no indication it had asked an unanswerable question. A consumer
    // grepped at `main` for a string it knew was in that commit, got nothing,
    // and concluded the string was absent.
    await fsPromises.writeFile(join(root, 'a.txt'), 'on disk', 'utf8');
    await expect(call('main')).rejects.toThrow(/cannot read at ref "main"/);
  });

  it.each(verbs)('%s accepts an empty ref, which is not a request', async (_name, call) => {
    await fsPromises.writeFile(join(root, 'a.txt'), 'on disk', 'utf8');
    await expect(call('')).resolves.toBeDefined();
  });

  it('names the verb and says what to do instead', async () => {
    await expect(readFile(env, root, 'a.txt', 'v1.2.3')).rejects.toThrow(
      /^readFile: cannot read at ref "v1\.2\.3"/
    );
    await expect(readFile(env, root, 'a.txt', 'v1.2.3')).rejects.toThrow(
      /Omit the ref, check the ref out first, or address the repository by its remote URL/
    );
  });

  it('lets an absent or empty ref through, because that is not a request', async () => {
    // Callers pass '' as "whatever is current" so reads, greps and symbol
    // lookups agree on one cache key. For a working tree that is exactly right.
    await fsPromises.writeFile(join(root, 'b.txt'), 'current', 'utf8');

    await expect(readFile(env, root, 'b.txt', '')).resolves.toMatchObject({ content: 'current' });
    await expect(readFile(env, root, 'b.txt')).resolves.toMatchObject({ content: 'current' });
  });

  it('refuses BEFORE touching the filesystem, so a missing file is not the answer', async () => {
    // Otherwise a ref request against a path that happens not to exist reports
    // not_found — the caller learns the file is missing, which is not the fact.
    await expect(readFile(env, root, 'never-existed.txt', 'main')).rejects.toThrow(
      /cannot read at ref/
    );
  });
});

describe('gitDetail — every stream, in order, first non-empty wins', () => {
  // The bug this replaces read one field with an operator that treats empty as
  // present. A fallback chain whose fallbacks are never exercised is how that
  // happened, so each branch gets its own test.
  it('prefers stderr, the stream git uses for most failures', () => {
    expect(gitDetail({ stderr: 'fatal: not a git repository', stdout: 'other' })).toBe(
      'fatal: not a git repository'
    );
  });

  it('falls through an EMPTY stderr to stdout — the case that produced a bare colon', () => {
    expect(gitDetail({ stderr: '   ', stdout: 'nothing to commit, working tree clean' })).toBe(
      'nothing to commit, working tree clean'
    );
  });

  it('falls through to the error message when neither stream said anything', () => {
    expect(gitDetail({ stderr: '', stdout: '', message: 'spawn ENOENT' })).toBe('spawn ENOENT');
  });

  it('never returns empty, even for something that is not an error at all', () => {
    // A caller reading a blank explanation learns nothing and cannot tell that
    // is what happened.
    expect(gitDetail({ stderr: '', stdout: '', message: '' })).toMatch(/said nothing on any/);
    expect(gitDetail(undefined)).toMatch(/undefined|said nothing/);
  });
});
