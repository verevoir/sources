// Real-filesystem tests for the symlink-escape fix in src/fs/index.ts.
//
// Verified finding (oversight, probing the real v4 belt): a committed
// LEAF symlink `outer/link.txt -> ../elsewhere/target.txt` let
// `writeFile` write `../elsewhere/target.txt` even though the lexical
// path `outer/link.txt` never left the configured root -- containment
// was lexical only, and the leaf was never `lstat`'d. These tests
// exercise the real adapter against a real temp directory tree, no
// mocks, so a regression has to actually touch the filesystem to be
// missed.
//
// Policy pinned here:
//   - a LEAF symlink pointing outside the root: writes refused, reads
//     refused;
//   - a symlinked DIRECTORY mid-path pointing outside the root: a
//     write beneath it refused;
//   - a symlink pointing INSIDE the root: reads allowed (it reads
//     exactly like the file it points to); writes refused regardless
//     -- a write through ANY symlink is refused, in-root or not, so a
//     link that is safe today can't be repointed outside between a
//     check and the write (TOCTOU);
//   - the pre-existing lexical ".." refusal still holds, unchanged;
//   - a plain file, with no symlink anywhere in its path, is
//     unaffected by any of this.

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mkdtemp,
  mkdir,
  writeFile as fsWriteFile,
  symlink,
  readFile as fsReadFile,
  rm,
  readdir,
} from 'node:fs/promises';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  readFile,
  writeFile,
  isFresh,
  commitFiles,
  listFiles,
  getRepoTree,
} from '../src/fs/index.js';
import type { SourceEnv } from '../src/index.js';

const ENV = {} as unknown as SourceEnv;

let tmpRoot: string;
let root: string;
let elsewhere: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'fs-symlink-containment-'));
  root = join(tmpRoot, 'repo');
  elsewhere = join(tmpRoot, 'elsewhere');
  await mkdir(root, { recursive: true });
  await mkdir(elsewhere, { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('fs symlink containment', () => {
  it('the pre-existing lexical ".." refusal still holds, unchanged', async () => {
    const attempt = readFile(ENV, root, '../outside-literal.txt');
    await expect(attempt).rejects.toThrow(/Path escapes the root/);
  });

  it('a leaf symlink pointing OUTSIDE the root: writeFile is refused, and the outside file is unchanged', async () => {
    await fsWriteFile(join(elsewhere, 'target.txt'), 'ORIGINAL');
    await mkdir(join(root, 'outer'), { recursive: true });
    await symlink('../../elsewhere/target.txt', join(root, 'outer', 'link.txt'));

    // Settle the promise first -- a mutant that drops the lstat guard
    // RESOLVES rather than rejects, so asserting `.rejects` alone just
    // fails the assertion. Checking the outside file's content next
    // proves the thing that actually matters: whether the escape
    // itself happened, not merely whether an error was thrown.
    const outcome = await writeFile(ENV, root, 'outer/link.txt', 'PROBE', 'b', 'm').then(
      () => 'resolved',
      (e: unknown) => e
    );

    const outsideNow = await fsReadFile(join(elsewhere, 'target.txt'), 'utf8');
    expect(outsideNow).toBe('ORIGINAL');

    expect(outcome).not.toBe('resolved');
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/symlink/);
  });

  it('a leaf symlink pointing OUTSIDE the root: readFile is also refused', async () => {
    await fsWriteFile(join(elsewhere, 'target.txt'), 'SECRET');
    await mkdir(join(root, 'outer'), { recursive: true });
    await symlink('../../elsewhere/target.txt', join(root, 'outer', 'link.txt'));

    const attempt = readFile(ENV, root, 'outer/link.txt');
    await expect(attempt).rejects.toThrow(/symlink/);
  });

  it('a symlinked DIRECTORY mid-path, pointing outside the root: a write beneath it is refused', async () => {
    await symlink('../elsewhere', join(root, 'dir-link'), 'dir');

    const attempt = writeFile(ENV, root, 'dir-link/new-file.txt', 'PROBE', 'b', 'm');
    await expect(attempt).rejects.toThrow(/symlink/);

    const outsideEntries = await readdir(elsewhere);
    expect(outsideEntries).not.toContain('new-file.txt');
  });

  it('a symlink pointing INSIDE the root is read exactly like the file it points to', async () => {
    await fsWriteFile(join(root, 'in-root-target.txt'), 'INSIDE');
    await symlink('in-root-target.txt', join(root, 'in-link.txt'));

    const result = await readFile(ENV, root, 'in-link.txt');
    expect(result.content).toBe('INSIDE');
  });

  it('a symlink pointing INSIDE the root is STILL refused for a write -- writes through ANY symlink are refused, in-root or not', async () => {
    await fsWriteFile(join(root, 'in-root-target.txt'), 'INSIDE');
    await symlink('in-root-target.txt', join(root, 'in-link.txt'));

    // Same discipline as the outside-root case above: settle the
    // promise first, then check the file's actual content before the
    // rejection reason, so the mutation proves the write itself, not
    // only the thrown message.
    const outcome = await writeFile(ENV, root, 'in-link.txt', 'NEW', 'b', 'm').then(
      () => 'resolved',
      (e: unknown) => e
    );

    const targetNow = await fsReadFile(join(root, 'in-root-target.txt'), 'utf8');
    expect(targetNow).toBe('INSIDE');

    expect(outcome).not.toBe('resolved');
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/symlink/);
  });

  it('listFiles through a symlinked-directory PREFIX refuses, rather than listing the outside', async () => {
    await fsWriteFile(join(elsewhere, 'secret.txt'), 'x');
    await symlink('../elsewhere', join(root, 'dir-link'), 'dir');

    const attempt = listFiles(ENV, root, 'dir-link');
    await expect(attempt).rejects.toThrow(/symlink/);
  });

  it('getRepoTree never lists or follows a symlink -- neither a directory symlink nor a file symlink', async () => {
    await mkdir(join(root, 'sub'), { recursive: true });
    await fsWriteFile(join(root, 'sub', 'real.txt'), 'x');
    await fsWriteFile(join(elsewhere, 'target.txt'), 'y');
    await symlink('../elsewhere', join(root, 'dirlink'), 'dir');
    await symlink('../elsewhere/target.txt', join(root, 'filelink.txt'));

    const tree = await getRepoTree(ENV, root);
    const paths = tree.entries.map((e) => e.path);

    expect(paths).toContain('sub');
    expect(paths).toContain('sub/real.txt');
    expect(paths).not.toContain('dirlink');
    expect(paths).not.toContain('filelink.txt');
    expect(paths.some((p) => p.startsWith('dirlink/'))).toBe(false);
  });

  it('commitFiles refuses a symlink leaf among the requested paths, and the outside file is unchanged', async () => {
    await fsWriteFile(join(elsewhere, 'target.txt'), 'ORIGINAL');
    await mkdir(join(root, 'outer'), { recursive: true });
    await symlink('../../elsewhere/target.txt', join(root, 'outer', 'link.txt'));

    const files = [{ path: 'outer/link.txt', content: 'PROBE' }];
    const attempt = commitFiles(ENV, root, 'b', files, 'm');
    await expect(attempt).rejects.toThrow(/symlink/);

    const outsideNow = await fsReadFile(join(elsewhere, 'target.txt'), 'utf8');
    expect(outsideNow).toBe('ORIGINAL');
  });

  it('a plain file, with no symlink anywhere in its path, is unaffected: readFile, writeFile, isFresh, listFiles, getRepoTree and commitFiles all work normally', async () => {
    await fsWriteFile(join(root, 'normal.txt'), 'hello');

    const read1 = await readFile(ENV, root, 'normal.txt');
    expect(read1.content).toBe('hello');
    expect(await isFresh(ENV, root, 'normal.txt', read1.sha)).toBe(true);

    await writeFile(ENV, root, 'normal.txt', 'updated', 'b', 'm');
    const read2 = await readFile(ENV, root, 'normal.txt');
    expect(read2.content).toBe('updated');

    const listed = await listFiles(ENV, root, '');
    expect(listed.map((e) => e.name)).toContain('normal.txt');

    const tree = await getRepoTree(ENV, root);
    expect(tree.entries.map((e) => e.path)).toContain('normal.txt');

    const files = [{ path: 'another.txt', content: 'x' }];
    await commitFiles(ENV, root, 'b', files, 'm');
    const read3 = await readFile(ENV, root, 'another.txt');
    expect(read3.content).toBe('x');
  });
});
