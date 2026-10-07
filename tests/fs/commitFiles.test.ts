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
  it('says what git said, even when git said it on stdout (never an empty tail)', async () => {
    // The defect: `stderr ?? String(err)` produced a message ending in a colon
    // with nothing after it. Git writes "nothing to commit" to STDOUT, so the
    // field read was empty — and `??` falls back only on null/undefined, so an
    // empty string passed through as though it were the explanation. A consumer
    // did reflog archaeology to recover a sentence git had already written.
    const env = { token: '', forkOrg: '' };
    await execFileAsync('git', ['init', tempDir]);
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir });
    await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir });
    await fsPromises.writeFile(join(tempDir, 'same.txt'), 'unchanged\n', 'utf8');
    await execFileAsync('git', ['add', '-A'], { cwd: tempDir });
    await execFileAsync('git', ['commit', '-m', 'first'], { cwd: tempDir });

    // Committing identical content: git refuses, and says why on stdout.
    const failure = await fs
      .commitFiles(env, tempDir, 'main', [{ path: 'same.txt', content: 'unchanged\n' }], 'again')
      .then(
        () => new Error('expected a failure'),
        (e: unknown) => e as Error
      );

    expect(failure.message).not.toMatch(/:\s*$/);
    expect(failure.message).toMatch(/nothing to commit/i);
  });

  // --- Oversight's retrospective on 0.10.0/aa06ce6 (0.11.0) ---------------

  it('REGRESSION (a): a later file failing containment leaves NOTHING written, not just the earlier files silently kept', async () => {
    // Before this fix, a two-file batch wrote file 1 to disk and only THEN
    // discovered file 2's path escaped the root — leaving file 1 behind with
    // no mention of it in the error. Validating every path before writing
    // any of them means this batch leaves nothing on disk at all.
    const env = { token: '', forkOrg: '' };
    const files = [
      { path: 'ok1.txt', content: 'one' },
      { path: '../escape.txt', content: 'evil' },
    ];
    await expect(fs.commitFiles(env, tempDir, 'main', files, 'msg')).rejects.toThrow();
    await expect(fsPromises.readFile(join(tempDir, 'ok1.txt'), 'utf8')).rejects.toThrow();
  });

  it('REGRESSION (b): checking out an EXISTING branch never resets it to HEAD (no git checkout -B data loss)', async () => {
    const env = { token: '', forkOrg: '' };
    await execFileAsync('git', ['init', tempDir]);
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir });
    await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir });
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'root'], { cwd: tempDir });

    // Build 'feature-x' with its OWN prior history.
    await execFileAsync('git', ['checkout', '-b', 'feature-x'], { cwd: tempDir });
    await fsPromises.writeFile(join(tempDir, 'prior.txt'), 'prior work', 'utf8');
    await execFileAsync('git', ['add', '-A'], { cwd: tempDir });
    await execFileAsync('git', ['commit', '-m', 'prior commit on feature-x'], { cwd: tempDir });

    // Move the ORIGINAL branch forward independently, so feature-x's
    // merge-base with it is the root commit only — exactly the shape where
    // `-B` would reset feature-x to lose "prior commit on feature-x" entirely.
    const { stdout: rootBranchOut } = await execFileAsync('git', ['branch', '--list'], {
      cwd: tempDir,
    });
    const rootBranch = rootBranchOut
      .split('\n')
      .map((l) => l.replace(/^\*?\s+/, ''))
      .find((l) => l.length > 0 && l !== 'feature-x')!;
    await execFileAsync('git', ['checkout', rootBranch], { cwd: tempDir });
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'original branch moved on'], {
      cwd: tempDir,
    });

    await fs.commitFiles(
      env,
      tempDir,
      'feature-x',
      [{ path: 'new.txt', content: 'added later' }],
      'added later'
    );

    const { stdout } = await execFileAsync('git', ['log', 'feature-x', '--oneline'], {
      cwd: tempDir,
    });
    expect(stdout).toContain('prior commit on feature-x');
    expect(stdout).toContain('added later');
  });

  it('REGRESSION (c): a file already staged for something else is NOT swept into this commit', async () => {
    const env = { token: '', forkOrg: '' };
    await execFileAsync('git', ['init', tempDir]);
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir });
    await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir });
    await fsPromises.writeFile(join(tempDir, 'tracked.txt'), 'v1', 'utf8');
    await execFileAsync('git', ['add', '-A'], { cwd: tempDir });
    await execFileAsync('git', ['commit', '-m', 'root'], { cwd: tempDir });

    // Pre-stage unrelated work the CALLER didn't ask commitFiles to touch.
    await fsPromises.writeFile(join(tempDir, 'tracked.txt'), 'v2 -- pre-staged, not ours', 'utf8');
    await execFileAsync('git', ['add', '-A'], { cwd: tempDir });

    const { stdout: curBranchOut } = await execFileAsync(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd: tempDir }
    );
    const branch = curBranchOut.trim();

    await fs.commitFiles(
      env,
      tempDir,
      branch,
      [{ path: 'new.txt', content: 'ours' }],
      'only new.txt'
    );

    const { stdout: headTracked } = await execFileAsync('git', ['show', 'HEAD:tracked.txt'], {
      cwd: tempDir,
    });
    expect(headTracked).toBe('v1'); // the pre-staged v2 was NOT swept into our commit

    const { stdout: stagedNames } = await execFileAsync(
      'git',
      ['diff', '--cached', '--name-only'],
      { cwd: tempDir }
    );
    expect(stagedNames).toContain('tracked.txt'); // still staged, untouched, waiting for its own commit

    const { stdout: newContent } = await execFileAsync('git', ['show', 'HEAD:new.txt'], {
      cwd: tempDir,
    });
    expect(newContent.trim()).toBe('ours');
  });

  it('runs git with hooks disabled — a repo-local pre-commit hook never fires', async () => {
    const env = { token: '', forkOrg: '' };
    await execFileAsync('git', ['init', tempDir]);
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir });
    await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir });
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'root'], { cwd: tempDir });

    const sentinel = join(tempDir, 'hook-ran.txt');
    await fsPromises.writeFile(
      join(tempDir, '.git', 'hooks', 'pre-commit'),
      `#!/bin/sh\necho ran > "${sentinel}"\nexit 1\n`,
      { mode: 0o755 }
    );

    const { stdout: curBranchOut } = await execFileAsync(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd: tempDir }
    );
    await fs.commitFiles(
      env,
      tempDir,
      curBranchOut.trim(),
      [{ path: 'new.txt', content: 'x' }],
      'msg'
    );

    await expect(fsPromises.readFile(sentinel, 'utf8')).rejects.toThrow();
  });
});
