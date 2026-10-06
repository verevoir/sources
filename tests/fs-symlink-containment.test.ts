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
//   - a symlink LEAF pointing INSIDE the root: refused for reads and
//     writes alike (O_NOFOLLOW at the open), so a link that is safe today
//     can't be repointed outside between a check and the use; listFiles
//     alone still lists through an in-root symlinked PREFIX;
//   - the root itself failing to resolve for any reason other than not
//     existing yet fails CLOSED, never skipping containment;
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
  chmod,
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
import { writeFileNoFollow, readFileNoFollow } from '../src/fs/nofollow.js';

import type { SourceEnv } from '../src/index.js';

// Permission-bit tests (EACCES) cannot be exercised as root -- uid 0 bypasses
// DAC checks entirely on the usual CI/dev platforms, so a chmod'd directory
// behaves as if it were never restricted. Skip those specific cases there,
// with the reason stated, rather than let them pass vacuously.
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

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

  it('a symlink pointing INSIDE the root is now ALSO refused for a read -- readFileNoFollow closes the leaf race the same way for reads as for writes, so a symlink leaf is refused whether it points in-root or out (round 3: previously this read was ALLOWED)', async () => {
    await fsWriteFile(join(root, 'in-root-target.txt'), 'INSIDE');
    await symlink('in-root-target.txt', join(root, 'in-link.txt'));

    const attempt = readFile(ENV, root, 'in-link.txt');
    await expect(attempt).rejects.toThrow(/symlink/);

    const targetNow = await fsReadFile(join(root, 'in-root-target.txt'), 'utf8');
    expect(targetNow).toBe('INSIDE');
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

  // --- lens-review round 2 (sources#29): security, correctness, testing, docs ---

  it('SECURITY: writeFileNoFollow refuses to open an existing symlink leaf AT THE SYSCALL, bypassing checkLeafSymlink entirely -- this is the actual TOCTOU closure, not merely the lstat-based message', async () => {
    await fsWriteFile(join(elsewhere, 'target.txt'), 'ORIGINAL');
    await mkdir(join(root, 'outer'), { recursive: true });
    const abs = join(root, 'outer', 'link.txt');
    await symlink('../../elsewhere/target.txt', abs);

    const outcome = await writeFileNoFollow(abs, 'PROBE', 'writeFile', 'outer/link.txt').then(
      () => 'resolved',
      (e: unknown) => e
    );

    const outsideNow = await fsReadFile(join(elsewhere, 'target.txt'), 'utf8');
    expect(outsideNow).toBe('ORIGINAL');

    expect(outcome).not.toBe('resolved');
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/symlink/);
  });

  it("CORRECTNESS: a self-referential symlink LEAF (a loop) is refused as a symlink, not a bare uncaught fs error -- readFileNoFollow's O_NOFOLLOW open reports ELOOP for a loop the same way it does for an ordinary symlink, so the message says 'symlink', matching writeFileNoFollow's own ELOOP wording, not the raw code", async () => {
    const loopPath = join(root, 'loop.txt');
    await symlink('loop.txt', loopPath);

    const attempt = readFile(ENV, root, 'loop.txt');
    await expect(attempt).rejects.toThrow(/loop\.txt/);
    await expect(attempt).rejects.toThrow(/symlink/);
  });

  it('CORRECTNESS: a self-referential symlinked DIRECTORY in the ancestor chain is wrapped in a SourceApiError naming the path, not a bare fs error from the ancestor walk', async () => {
    const loopDir = join(root, 'loopdir');
    await symlink('loopdir', loopDir, 'dir');

    const attempt = writeFile(ENV, root, 'loopdir/file.txt', 'x', 'b', 'm');
    await expect(attempt).rejects.toThrow(/loopdir\/file\.txt/);
    // SECURITY: the error names only the caller's relative path, never the
    // absolute server path of the ancestor it was probing.
    const message = await attempt.then(
      () => '',
      (e: Error) => e.message
    );
    expect(message).not.toContain(tmpRoot);
  });

  it("TESTING: a root that does not exist yet exercises ensureSafePath's own 'root does not exist' branch, and still produces a clear not_found error rather than a crash", async () => {
    const missingRoot = join(tmpRoot, 'does-not-exist-root');

    const attempt = readFile(ENV, missingRoot, 'whatever.txt');
    await expect(attempt).rejects.toThrow('not_found');
  });

  it('TESTING: a symlink whose target does not exist (dangling, not a loop) is refused for reads -- O_NOFOLLOW refuses on the symlink itself, before ever trying to resolve where it points, so a dangling target gets the SAME refusal as any other symlink leaf', async () => {
    const danglingPath = join(root, 'dangling.txt');
    await symlink('does-not-exist-target.txt', danglingPath);

    const attempt = readFile(ENV, root, 'dangling.txt');
    await expect(attempt).rejects.toThrow(/dangling\.txt/);
    await expect(attempt).rejects.toThrow(/symlink/);
  });

  // --- lens-review round 3 (sources#31): security (reads), testing (EACCES branches) ---

  it("SECURITY: readFileNoFollow refuses to open an existing symlink leaf AT THE SYSCALL, the SAME way writeFileNoFollow does for writes -- this is the actual read-side TOCTOU closure, not merely checkLeafSymlink's lstat-based message", async () => {
    await fsWriteFile(join(elsewhere, 'target.txt'), 'SECRET');
    await mkdir(join(root, 'outer'), { recursive: true });
    const abs = join(root, 'outer', 'link.txt');
    await symlink('../../elsewhere/target.txt', abs);

    const outcome = await readFileNoFollow(abs, 'readFile', 'outer/link.txt').then(
      () => 'resolved',
      (e: unknown) => e
    );

    expect(outcome).not.toBe('resolved');
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/symlink/);
  });

  it.skipIf(isRoot)(
    "CORRECTNESS: a non-ENOENT lstat failure (EACCES, via a search-permission-restricted parent) is wrapped in a SourceApiError naming the path and the real code, not a bare fs error -- exercises checkLeafSymlink's own lstat catch, shared by every write and by listFiles (skipped as root: uid 0 bypasses DAC permission checks entirely)",
    async () => {
      await mkdir(join(root, 'locked'), { recursive: true });
      await fsWriteFile(join(root, 'locked', 'file.txt'), 'x');
      await chmod(join(root, 'locked'), 0o000);
      try {
        const attempt = writeFile(ENV, root, 'locked/file.txt', 'PROBE', 'b', 'm');
        await expect(attempt).rejects.toThrow(/locked\/file\.txt/);
        await expect(attempt).rejects.toThrow(/EACCES/);
      } finally {
        await chmod(join(root, 'locked'), 0o755);
      }
    }
  );

  it.skipIf(isRoot)(
    "CORRECTNESS: writeFileNoFollow's generic open-failure fallback (EACCES, via a write-restricted target directory) is wrapped in a SourceApiError naming the path and the real code, not a bare fs error -- the untested sibling of the already-tested ELOOP branch (skipped as root: uid 0 bypasses DAC permission checks entirely)",
    async () => {
      await mkdir(join(root, 'readonly'), { recursive: true });
      await chmod(join(root, 'readonly'), 0o555);
      try {
        const attempt = writeFile(ENV, root, 'readonly/new-file.txt', 'PROBE', 'b', 'm');
        await expect(attempt).rejects.toThrow(/readonly\/new-file\.txt/);
        await expect(attempt).rejects.toThrow(/EACCES/);
      } finally {
        await chmod(join(root, 'readonly'), 0o755);
      }
    }
  );
  it('SECURITY: a ROOT that is itself a symlink loop fails CLOSED in the containment check (ELOOP), rather than silently skipping the ancestor walk', async () => {
    const loopRoot = join(tmpRoot, 'loop-root');
    await symlink('loop-root', loopRoot, 'dir');

    const attempt = writeFile(ENV, loopRoot, 'a.txt', 'PROBE', 'b', 'm');
    const message = await attempt.then(
      () => 'resolved',
      (e: Error) => e.message
    );
    expect(message).toMatch(/a\.txt could not be checked: the root could not be resolved/);
    expect(message).toMatch(/ELOOP/);
    expect(message).not.toContain(tmpRoot);
  });

  it.skipIf(isRoot)(
    'SECURITY: a ROOT that cannot be resolved for EACCES fails CLOSED in the containment check, rather than silently skipping the ancestor walk (skipped as root: uid 0 bypasses DAC permission checks entirely)',
    async () => {
      const lockedParent = join(tmpRoot, 'locked-parent');
      const lockedRoot = join(lockedParent, 'repo');
      await mkdir(lockedRoot, { recursive: true });
      await chmod(lockedParent, 0o000);
      try {
        const attempt = readFile(ENV, lockedRoot, 'a.txt');
        const message = await attempt.then(
          () => 'resolved',
          (e: Error) => e.message
        );
        expect(message).toMatch(/a\.txt could not be checked: the root could not be resolved/);
        expect(message).toMatch(/EACCES/);
        expect(message).not.toContain(tmpRoot);
      } finally {
        await chmod(lockedParent, 0o755);
      }
    }
  );

  it('isFresh refuses a symlink leaf at the open, in-root or pointing outside, the same way readFile does', async () => {
    await fsWriteFile(join(elsewhere, 'secret.txt'), 'SECRET');
    await fsWriteFile(join(root, 'inside.txt'), 'INSIDE');
    await symlink(join(elsewhere, 'secret.txt'), join(root, 'out-link.txt'));
    await symlink(join(root, 'inside.txt'), join(root, 'in-link.txt'));

    await expect(isFresh(ENV, root, 'out-link.txt', 'x')).rejects.toThrow(/symlink/);
    await expect(isFresh(ENV, root, 'in-link.txt', 'x')).rejects.toThrow(/symlink/);
  });

  it('listFiles through an IN-ROOT symlinked prefix lists exactly what the directory it points to holds', async () => {
    await mkdir(join(root, 'realdir'), { recursive: true });
    await fsWriteFile(join(root, 'realdir', 'a.txt'), 'A');
    await symlink(join(root, 'realdir'), join(root, 'dirlink'), 'dir');

    const viaLink = await listFiles(ENV, root, 'dirlink');
    const direct = await listFiles(ENV, root, 'realdir');
    expect(viaLink.map((e) => e.name)).toEqual(['a.txt']);
    expect(viaLink.map((e) => e.name)).toEqual(direct.map((e) => e.name));
  });
  it("the ancestor walk climbs past directories that don't exist yet: a new file under a NEW directory beneath an existing one is written inside the root", async () => {
    await mkdir(join(root, 'existing'), { recursive: true });

    await writeFile(ENV, root, 'existing/new/deeper/file.txt', 'NEW', 'b', 'm');

    expect(await fsReadFile(join(root, 'existing', 'new', 'deeper', 'file.txt'), 'utf8')).toBe(
      'NEW'
    );
  });

  it('the ancestor walk climbs past a not-yet-existing directory to reach a symlinked one above it, and refuses: nothing is created outside', async () => {
    await symlink(elsewhere, join(root, 'dirlink'), 'dir');

    const attempt = writeFile(ENV, root, 'dirlink/new/deep.txt', 'PROBE', 'b', 'm');
    await expect(attempt).rejects.toThrow(/escapes the root via a symlinked directory/);
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it('listFiles through a DANGLING symlinked prefix is refused by name, not listed or crashed on', async () => {
    await symlink(join(root, 'no-such-dir'), join(root, 'dangling'), 'dir');

    await expect(listFiles(ENV, root, 'dangling')).rejects.toThrow(
      /dangling.*broken or unreachable target/
    );
  });
});
