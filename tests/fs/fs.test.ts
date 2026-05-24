import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsPromises } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
} from '../../src/fs/index.js';
import { SourceApiError, type SourceEnv } from '../../src/index.js';

const env: SourceEnv = { token: '', forkOrg: '' };

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
    const { sha } = await readFile(env, root, 'a.txt');
    await expect(isFresh(env, root, 'a.txt', sha)).resolves.toBe(true);
  });

  it('returns false when content has changed since the version was recorded', async () => {
    await fsPromises.writeFile(join(root, 'a.txt'), 'old', 'utf8');
    const { sha: oldSha } = await readFile(env, root, 'a.txt');
    await fsPromises.writeFile(join(root, 'a.txt'), 'new', 'utf8');
    await expect(isFresh(env, root, 'a.txt', oldSha)).resolves.toBe(false);
  });

  it('returns false when the file no longer exists', async () => {
    await expect(isFresh(env, root, 'missing.txt', 'whatever')).resolves.toBe(false);
  });

  it('refuses paths that escape the root', async () => {
    await expect(isFresh(env, root, '../escape.txt', 'sha')).rejects.toBeInstanceOf(SourceApiError);
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
