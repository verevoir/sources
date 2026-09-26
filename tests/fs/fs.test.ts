import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsPromises } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
const execFileAsync = promisify(execFile);

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

  it('hides ignored secrets, directories, and direct ignored prefixes', async () => {
    await execFileAsync('git', ['init', '-q'], { cwd: root });
    await fsPromises.writeFile(join(root, '.gitignore'), '.env.mcp\nprivate/\n');
    await fsPromises.writeFile(join(root, '.env.mcp'), 'test-only');
    await fsPromises.mkdir(join(root, 'private'));
    await fsPromises.writeFile(join(root, 'private', 'secret'), 'test-only');
    await fsPromises.mkdir(join(root, 'node_modules'));
    await fsPromises.writeFile(join(root, 'app.ts'), '');
    expect((await listFiles(env, root, '')).map((e) => e.path).sort()).toEqual([
      '.gitignore',
      'app.ts',
    ]);
    expect(await listFiles(env, root, 'private')).toEqual([]);
    expect(await listFiles(env, join(root, 'private'), '')).toEqual([]);
    expect(await listFiles(env, root, 'private/../private')).toEqual([]);
    expect(await listFiles(env, root, 'node_modules')).toEqual([]);
  });

  it('uses nested worktree rules and preserves tracked files and ignore negation', async () => {
    await execFileAsync('git', ['init', '-q'], { cwd: root });
    const sub = join(root, 'sub');
    await fsPromises.mkdir(sub);
    await execFileAsync('git', ['init', '-q', '--separate-git-dir', join(root, '.git', 'nested')], {
      cwd: sub,
    });
    await fsPromises.writeFile(join(sub, 'tracked.log'), '');
    await execFileAsync('git', ['add', 'tracked.log'], { cwd: sub });
    await fsPromises.writeFile(join(sub, '.gitignore'), '*.log\n!keep.log\n');
    await fsPromises.writeFile(join(sub, 'hidden.log'), '');
    await fsPromises.writeFile(join(sub, 'keep.log'), '');
    expect((await listFiles(env, root, 'sub')).map((e) => e.path).sort()).toEqual([
      'sub/.gitignore',
      'sub/keep.log',
      'sub/tracked.log',
    ]);
  });

  it('keeps non-Git listings available while skipping built-in directories', async () => {
    await fsPromises.writeFile(join(root, '.gitignore'), '*.log\n');
    await fsPromises.writeFile(join(root, 'visible.log'), '');
    await fsPromises.mkdir(join(root, 'node_modules'));
    expect((await listFiles(env, root, '')).map((e) => e.name).sort()).toEqual([
      '.gitignore',
      'visible.log',
    ]);
    await expect(listFiles(env, root, '../escape')).rejects.toThrow('Path escapes');
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

  it('returns more than the old 5,000-entry default cap', async () => {
    await Promise.all(
      Array.from({ length: 5001 }, (_, i) => fsPromises.writeFile(join(root, `file-${i}`), ''))
    );
    const tree = await getRepoTree(env, root);
    expect(tree.entries).toHaveLength(5001);
    expect(tree.truncated).toBe(false);
  });

  it('limits entries with an explicit cap and reports only actual omissions', async () => {
    await fsPromises.mkdir(join(root, 'dir'));
    await fsPromises.writeFile(join(root, 'dir', 'a'), '');
    await fsPromises.mkdir(join(root, 'node_modules'));
    const limited = await getRepoTree(env, root, undefined, { maxEntries: 1 });
    expect(limited.entries.map((e) => e.path)).toEqual(['dir']);
    expect(limited.truncated).toBe(true);
    const exact = await getRepoTree(env, root, undefined, { maxEntries: 2 });
    expect(exact.entries).toHaveLength(2);
    expect(exact.truncated).toBe(false);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid maxEntries %s',
    async (maxEntries) => {
      await expect(getRepoTree(env, root, undefined, { maxEntries })).rejects.toThrow(
        'maxEntries must be a positive safe integer'
      );
    }
  );

  it('keeps sibling repository ignore scopes separate and refreshes each call', async () => {
    for (let i = 0; i < 12; i++) {
      const sub = join(root, `repo-${i}`);
      await fsPromises.mkdir(sub);
      await execFileAsync('git', ['init', '-q'], { cwd: sub });
      await fsPromises.writeFile(join(sub, '.gitignore'), i % 2 ? 'a\n' : 'b\n');
      await fsPromises.writeFile(join(sub, 'a'), '');
      await fsPromises.writeFile(join(sub, 'b'), '');
    }
    const first = await getRepoTree(env, root);
    for (let i = 0; i < 12; i++) {
      const paths = first.entries.map((e) => e.path);
      expect(paths).toContain(`repo-${i}/${i % 2 ? 'b' : 'a'}`);
      expect(paths).not.toContain(`repo-${i}/${i % 2 ? 'a' : 'b'}`);
    }
    await fsPromises.writeFile(join(root, 'repo-0', '.gitignore'), 'a\n');
    const second = (await getRepoTree(env, root)).entries.map((e) => e.path);
    expect(second).toContain('repo-0/b');
    expect(second).not.toContain('repo-0/a');
  });

  describe('honours git ignore rules', () => {
    const git = (cwd: string, ...args: string[]) => execFileAsync('git', args, { cwd });

    it('prunes gitignored directories and files', async () => {
      await git(root, 'init', '-q');
      await fsPromises.writeFile(
        join(root, '.gitignore'),
        '/.dev/pg-data/\n*.log\n.env.mcp\n!keep.log\n',
        'utf8'
      );
      await fsPromises.mkdir(join(root, '.dev', 'pg-data', 'base'), { recursive: true });
      await fsPromises.writeFile(join(root, '.dev', 'pg-data', 'base', '1'), 'x', 'utf8');
      await fsPromises.writeFile(join(root, '.dev', 'init.sh'), '#', 'utf8');
      await fsPromises.writeFile(join(root, 'debug.log'), 'x', 'utf8');
      await fsPromises.writeFile(join(root, '.env.mcp'), 'test-only', 'utf8');
      await fsPromises.writeFile(join(root, 'keep.log'), 'keep', 'utf8');
      await fsPromises.writeFile(join(root, 'app.ts'), 'a', 'utf8');

      const paths = (await getRepoTree(env, root)).entries.map((e) => e.path).sort();
      expect(paths).toEqual(['.dev', '.dev/init.sh', '.gitignore', 'app.ts', 'keep.log']);
    });

    it('does not let an ignored directory exhaust the tree cap', async () => {
      await git(root, 'init', '-q');
      await fsPromises.writeFile(join(root, '.gitignore'), '/aaa-ignored/\n', 'utf8');
      await fsPromises.mkdir(join(root, 'aaa-ignored'));
      await Promise.all(
        Array.from({ length: 5001 }, (_, i) =>
          fsPromises.writeFile(join(root, 'aaa-ignored', `f${i}`), '', 'utf8')
        )
      );
      await fsPromises.writeFile(join(root, 'zzz.ts'), 'z', 'utf8');

      const tree = await getRepoTree(env, root);
      expect(tree.truncated).toBe(false);
      expect(tree.entries.map((e) => e.path)).toContain('zzz.ts');
    });

    it("applies a nested work tree's own ignore rules (submodule-style)", async () => {
      await git(root, 'init', '-q');
      await fsPromises.mkdir(join(root, 'sub', 'out'), { recursive: true });
      await git(
        join(root, 'sub'),
        'init',
        '-q',
        '--separate-git-dir',
        join(root, '.git', 'nested')
      );
      await fsPromises.writeFile(join(root, 'sub', '.gitignore'), 'out/\n', 'utf8');
      await fsPromises.writeFile(join(root, 'sub', 'out', 'bundle.js'), 'b', 'utf8');
      await fsPromises.writeFile(join(root, 'sub', 'index.ts'), 'i', 'utf8');

      const paths = (await getRepoTree(env, root)).entries.map((e) => e.path).sort();
      expect(paths).toEqual(['sub', 'sub/.gitignore', 'sub/index.ts']);
    });

    it('honours ignores when the walk root is inside an ignored directory', async () => {
      await git(root, 'init', '-q');
      await fsPromises.writeFile(join(root, '.gitignore'), 'private/\n');
      await fsPromises.mkdir(join(root, 'private'));
      await fsPromises.writeFile(join(root, 'private', 'secret'), 'test-only');
      expect((await getRepoTree(env, join(root, 'private'))).entries).toEqual([]);
    });

    it('walks everything outside a git work tree', async () => {
      await fsPromises.writeFile(join(root, '.gitignore'), '*.log\n', 'utf8');
      await fsPromises.writeFile(join(root, 'debug.log'), 'x', 'utf8');

      const paths = (await getRepoTree(env, root)).entries.map((e) => e.path).sort();
      expect(paths).toEqual(['.gitignore', 'debug.log']);
    });
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
