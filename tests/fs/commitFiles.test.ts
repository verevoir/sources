import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsPromises } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fs } from '../../src/fs/index.js';

const execFileAsync = promisify(execFile);

describe('fs adapter: commitFiles', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fs-commitfiles-'));
  });

  afterEach(async () => {
    try {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('throws on empty files array', async () => {
    const env = { token: '', forkOrg: '' };
    await expect(fs.commitFiles(env, tempDir, 'main', [], 'test commit')).rejects.toThrow(
      'files array must not be empty'
    );
  });

  it('writes all files to disk in a non-git directory', async () => {
    const env = { token: '', forkOrg: '' };
    const files = [
      { path: 'file1.txt', content: 'content1' },
      { path: 'subdir/file2.txt', content: 'content2' },
      { path: 'a/b/c/file3.txt', content: 'content3' },
    ];

    await fs.commitFiles(env, tempDir, 'main', files, 'test commit');

    const file1 = await fsPromises.readFile(join(tempDir, 'file1.txt'), 'utf8');
    expect(file1).toBe('content1');

    const file2 = await fsPromises.readFile(join(tempDir, 'subdir/file2.txt'), 'utf8');
    expect(file2).toBe('content2');

    const file3 = await fsPromises.readFile(join(tempDir, 'a/b/c/file3.txt'), 'utf8');
    expect(file3).toBe('content3');
  });

  it('creates branch, stages, and commits files in a git repository', async () => {
    const env = { token: '', forkOrg: '' };
    const files = [
      { path: 'file1.txt', content: 'content1' },
      { path: 'file2.txt', content: 'content2' },
    ];

    await execFileAsync('git', ['init', tempDir]);
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir });
    await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir });

    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'Initial commit'], {
      cwd: tempDir,
    });

    await fs.commitFiles(env, tempDir, 'feature-branch', files, 'Add test files');

    const file1 = await fsPromises.readFile(join(tempDir, 'file1.txt'), 'utf8');
    expect(file1).toBe('content1');

    const file2 = await fsPromises.readFile(join(tempDir, 'file2.txt'), 'utf8');
    expect(file2).toBe('content2');

    const { stdout: branchOutput } = await execFileAsync('git', ['branch', '--show-current'], {
      cwd: tempDir,
    });
    expect(branchOutput.trim()).toBe('feature-branch');

    const { stdout: logOutput } = await execFileAsync('git', ['log', '--oneline', '-1'], {
      cwd: tempDir,
    });
    expect(logOutput).toContain('Add test files');
  });

  it('creates the branch if it does not exist', async () => {
    const env = { token: '', forkOrg: '' };
    const files = [{ path: 'test.txt', content: 'test content' }];

    await execFileAsync('git', ['init', tempDir]);
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir });
    await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir });
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'Initial commit'], {
      cwd: tempDir,
    });

    await fs.commitFiles(env, tempDir, 'new-branch', files, 'Create new branch');

    const { stdout: branchOutput } = await execFileAsync('git', ['branch', '--list'], {
      cwd: tempDir,
    });
    expect(branchOutput).toContain('new-branch');
  });

  it('updates existing branch when called again with same branch name', async () => {
    const env = { token: '', forkOrg: '' };

    await execFileAsync('git', ['init', tempDir]);
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir });
    await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir });
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'Initial commit'], {
      cwd: tempDir,
    });

    const files1 = [{ path: 'file1.txt', content: 'version1' }];
    await fs.commitFiles(env, tempDir, 'work-branch', files1, 'First commit');

    const files2 = [{ path: 'file2.txt', content: 'version2' }];
    await fs.commitFiles(env, tempDir, 'work-branch', files2, 'Second commit');

    const { stdout: logOutput } = await execFileAsync('git', ['log', '--oneline'], {
      cwd: tempDir,
    });
    expect(logOutput).toContain('First commit');
    expect(logOutput).toContain('Second commit');
  });

  it('rejects a path that escapes the root (path-traversal guard)', async () => {
    const env = { token: '', forkOrg: '' };
    await expect(
      fs.commitFiles(env, tempDir, 'main', [{ path: '../outside.txt', content: 'x' }], 'msg')
    ).rejects.toThrow();
  });

  it('rejects an unsafe branch name at the boundary, before writing anything', async () => {
    const env = { token: '', forkOrg: '' };
    await execFileAsync('git', ['init', tempDir]);
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir });
    await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir });
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'Initial commit'], {
      cwd: tempDir,
    });
    await expect(
      fs.commitFiles(env, tempDir, 'bad..branch', [{ path: 'x.txt', content: 'hi' }], 'msg')
    ).rejects.toThrow(/unsafe branch/i);
    // rejected before any write — nothing was left on disk
    await expect(fsPromises.readFile(join(tempDir, 'x.txt'), 'utf8')).rejects.toThrow();
  });
});
