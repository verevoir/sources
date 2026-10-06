// @verevoir/sources/fs — local filesystem adapter
//
// Implements the SourceAdapter contract over a local directory root.
// `repoUrl` is interpreted as an absolute filesystem path. A non-empty `ref` is
// REFUSED: this reads a working tree, which is whatever is checked out, so
// there is no version of "read this at main" it can answer — and it used to
// answer anyway, with the working tree, silently. An empty or absent ref means
// "current" and is the normal case. See `refuseRef`.
//
// Designed for the "developer running aigency locally" case (per
// `project_notion_and_fs_sources_candidate_this_week`): point the
// adapter at a working directory, and the same materialisers /
// composers that work against GitHub repos work against the local
// tree with zero changes.
//
// Auth: none. `SourceEnv` is accepted for symmetry with remote
// adapters but every field is ignored. Callers can pass any env;
// `envFromProcessEnv` returns a valid one even with no GITHUB_TOKEN
// when this adapter is the target.
//
// Git-awareness is scoped to `commitFiles`: `writeFile` still writes
// straight to disk (no commit, no branch), but `commitFiles` stages +
// commits on the branch when the root is a git repo (best-effort — the
// files are written first and are not rolled back if the commit fails).
//
// What this is NOT:
//   - Forkable. `ensureFork` and `openPullRequest` throw — they
//     don't have a local-FS equivalent.
//
// SYMLINK CONTAINMENT (security fix). `ensureSafePath` rejects a
// lexical escape (`..`, an absolute path) — but a path can stay
// lexically inside `root` while a symlink SOMEWHERE along it, the
// leaf itself or a directory component partway through, points
// outside it. Verified finding: a committed leaf symlink
// `outer/link.txt -> ../elsewhere/target.txt` let `writeFile` write
// `../elsewhere/target.txt` even though the lexical path
// `outer/link.txt` never left the root — containment was lexical
// only, and the leaf was never `lstat`'d.
//
// Containment is now realpath-based. `ensureSafePath` resolves
// `realpath(root)` once, then walks up from the target's PARENT to
// the nearest existing ancestor and requires THAT ancestor's own real
// path to still be inside the root — catching a symlinked directory
// mid-path for every operation below, not only the ones that happen
// to reach the leaf.
//
// THE LEAF ITSELF is closed differently depending on whether Node's
// fs API lets the operation reach the kernel through an already-open
// file descriptor:
//   - CLOSED AT THE SYSCALL: `writeFile`, `commitFiles`, `readFile`
//     and `isFresh` all open the leaf with `O_NOFOLLOW` set
//     (`writeFileNoFollow` / `readFileNoFollow`, below) — the kernel
//     refuses the open itself (`ELOOP`) if the leaf is a symlink AT
//     OPEN TIME, whether or not it existed a moment earlier when any
//     earlier check ran. This refuses EVERY symlink leaf outright,
//     in-root or not: round 1 already made this the policy for
//     writes (a safe in-root link can be repointed outside between a
//     check and the write); this round gives reads the IDENTICAL
//     policy and mechanism, closing the asymmetry lens-review found
//     on sources#29/#31 (writes closed at the syscall, reads only
//     checked via a racy `lstat`-then-follow). `checkLeafSymlink`'s
//     write-mode branch still runs first, for the common case (a
//     symlink already sitting there) — it gives a clear, named
//     message before the open-level refusal would; it is not what
//     actually closes the race.
//   - CHECK-THEN-USE, NOT CLOSED AT THE SYSCALL: `listFiles`. Node's
//     `fs.promises.readdir` takes a PATH, not an already-open
//     directory handle, so there is no `O_NOFOLLOW`-equivalent way to
//     list a directory's contents without a path-based lookup that
//     could itself follow a symlink planted after the check.
//     `listFiles` still uses `checkLeafSymlink`'s `lstat`+`realpath`
//     check (allowing an in-root prefix, refusing one that resolves
//     outside, or is broken) — a symlinked prefix planted in the
//     window between that check and the `readdir` call would still
//     be followed. This is the SAME class of residual gap as the
//     directory-component one below, at the listed prefix instead of
//     an ancestor; named here rather than left implied.
//
// RESIDUAL GAPS, stated plainly rather than implied — both need a
// CONCURRENT LOCAL ATTACKER on this exact machine, not a remote or
// pre-committed symlink, which is what this fix and the original
// finding are about:
//   - A directory component swapped in further up the path, between
//     `ensureSafePath`'s one-time realpath check and the eventual
//     open/readdir, is not closed by any of this — doing that fully
//     needs `openat`-style walking, which Node's fs API does not
//     expose.
//   - `listFiles`'s own prefix leaf, per the check-then-use paragraph
//     above.
// See CHANGELOG.md for the full account, across all three
// lens-review rounds on sources#29/#31.

import { promises as fsPromises, constants as fsConstants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  SourceApiError,
  type SourceEnv,
  type ReadFileResult,
  type DirEntry,
  type RepoTree,
  type TreeEntry,
} from '../index.js';

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  '.venv',
  'venv',
  '__pycache__',
  '.gradle',
  'target',
  '.idea',
  '.vscode',
]);

const execFileAsync = promisify(execFile);

const DEFAULT_TREE_CAP = 5000;

/** Surrogate sha — sha256 prefix of the content. Lets callers that
 * use sha for change-detection (e.g. cache invalidation) behave
 * predictably against FS reads. Not a git blob sha. */
function shaOf(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 40);
}

/** Resolve a relative path under `root`, refusing a LEXICAL escape
 * (`..`, an absolute path) and, separately, an escape through a
 * symlinked directory ANYWHERE in the target's ancestry.
 *
 * `realpath(root)` is resolved once. Then, starting from the
 * target's PARENT (never the target itself — what a symlink AT the
 * leaf means is each verb's own decision; see `checkLeafSymlink`),
 * this walks up to the nearest ancestor that actually exists on
 * disk, and requires THAT ancestor's own real path to still be
 * inside the resolved root. A component that does not exist yet (the
 * normal case for a write about to `mkdir -p` it) is skipped only
 * because there is nothing there yet to BE a symlink — the moment a
 * directory component does exist, its real target is checked, so a
 * symlinked directory mid-path (`dir-link/new-file.txt`) is caught
 * even though `new-file.txt` has never existed.
 *
 * The lexical-escape message is unchanged from before this fix
 * (`Path escapes the root: …`) — existing callers matching on it
 * keep working. The new symlinked-directory message is distinct.
 *
 * Returns the absolute path to operate on and the resolved
 * `realRoot`, which every verb also needs for its own leaf check. */
async function ensureSafePath(
  root: string,
  relativePath: string,
  verb: string
): Promise<{ abs: string; realRoot: string }> {
  const rootAbs = resolve(root);
  const abs = resolve(rootAbs, relativePath);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + '/')) {
    throw new SourceApiError(`Path escapes the root: ${relativePath}`);
  }

  let realRoot: string;
  try {
    realRoot = await fsPromises.realpath(rootAbs);
  } catch {
    // The root itself doesn't exist yet. Nothing to contain against —
    // the caller's own fs call fails with its own, clearer ENOENT.
    return { abs, realRoot: rootAbs };
  }

  let probe = dirname(abs);
  for (let guard = 0; guard < 1024 && probe !== rootAbs; guard++) {
    if (!probe.startsWith(rootAbs + '/')) break;
    let real: string;
    try {
      real = await fsPromises.realpath(probe);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        probe = dirname(probe);
        continue;
      }
      // Every other failure here (EACCES on a permission-restricted
      // ancestor, ELOOP on a symlink loop, ...) is wrapped the same
      // way every other throw in this file is -- a bare fs error
      // reaching a caller through this ancestor walk would be the
      // one path in the whole adapter that doesn't honour the
      // SourceApiError contract. Found by lens-review on sources#29.
      throw new SourceApiError(
        `${verb}: ${relativePath} could not be checked at ${probe} (${code ?? String(err)})`
      );
    }
    if (real !== realRoot && !real.startsWith(realRoot + '/')) {
      throw new SourceApiError(
        `${verb}: ${relativePath} escapes the root via a symlinked directory`
      );
    }
    break;
  }

  return { abs, realRoot };
}

/** `lstat` the target itself — never followed, unlike `stat`/`realpath`
 * — and decide what a symlink there means for `verb`.
 *
 * WRITES (the `write` mode -- `writeFile`/`commitFiles`): when the
 * leaf ALREADY IS a symlink at the moment this runs, refuse outright
 * and say so plainly, no matter where it points. This is the
 * clear-message path, not the actual race closure -- a link planted
 * in the window between THIS lstat and the real write would sail
 * through a check like this one alone (TOCTOU). The actual closure
 * for writes is `writeFileNoFollow`'s O_NOFOLLOW open, below, which
 * the kernel refuses atomically if the leaf is a symlink at open
 * time, whether or not it was one when this lstat ran. This
 * function's write branch exists so the common case -- a stale link
 * already sitting there -- gets a clear, named message instead of a
 * bare ELOOP from the open call.
 *
 * READS (the `read` mode): as of this round, `readFile` and `isFresh`
 * no longer call this function at all -- they close the race the
 * SAME way writes do, via `readFileNoFollow`'s own O_NOFOLLOW open,
 * refusing EVERY symlink leaf outright. `read` mode is now used ONLY
 * by `listFiles`, which has no O_NOFOLLOW-equivalent available (see
 * the module header) and so still needs this check-then-use
 * distinction: a symlink allowed only when ITS OWN realpath resolves
 * inside `realRoot` — an in-root symlink prefix lists exactly like
 * the directory it points to; one pointing outside, or one whose
 * target doesn't exist at all, is refused by name.
 *
 * A target that doesn't exist yet, or exists but isn't a symlink, is
 * a no-op either way — the caller's own fs call handles it next. */
async function checkLeafSymlink(
  abs: string,
  realRoot: string,
  relativePath: string,
  verb: string,
  mode: 'read' | 'write'
): Promise<void> {
  let st;
  try {
    st = await fsPromises.lstat(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return;
    // EACCES, ELOOP (a symlink loop AT this exact path), ... -- wrapped
    // like every other throw in this file. Found by lens-review on
    // sources#29.
    throw new SourceApiError(
      `${verb}: ${relativePath} could not be checked (${code ?? String(err)})`
    );
  }
  if (!st.isSymbolicLink()) return;

  if (mode === 'write') {
    throw new SourceApiError(
      `${verb}: ${relativePath} is a symlink — refusing to write through it`
    );
  }

  let real: string;
  try {
    real = await fsPromises.realpath(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    throw new SourceApiError(
      `${verb}: ${relativePath} is a symlink with a broken or unreachable target (${code ?? String(err)})`
    );
  }
  if (real !== realRoot && !real.startsWith(realRoot + '/')) {
    throw new SourceApiError(`${verb}: ${relativePath} is a symlink pointing outside the root`);
  }
}

/** Open `abs` for writing with `O_NOFOLLOW` set, and write `content`
 * through the resulting handle. The kernel refuses the open itself
 * (`ELOOP`) if the leaf is a symlink AT OPEN TIME — closing the window
 * `checkLeafSymlink`'s `lstat` cannot close on its own: that `lstat`
 * can only report what the leaf was a moment ago, and a symlink
 * planted in the gap between that check and a plain
 * `fsPromises.writeFile` would still be followed. `checkLeafSymlink`
 * stays for the common case (a symlink already sitting there gets a
 * clear, named refusal); this is what actually closes the race for
 * every case, including a brand-new path that didn't exist a moment
 * ago.
 *
 * Exported so a test can call it directly against an already-planted
 * symlink, bypassing `checkLeafSymlink`'s own `lstat` entirely, and
 * prove the open call refuses on its own.
 *
 * REMAINING GAP, stated plainly rather than implied: this closes the
 * race at the LEAF. It does not close a race at a DIRECTORY component
 * further up the path — `ensureSafePath`'s ancestor walk resolves
 * `realpath` once per call, and a directory swapped in after that
 * check but before this open still reaches the eventual syscall by
 * its new, unverified route. Closing that fully needs `openat`-style
 * walking (open each component by file descriptor, never by
 * re-resolved path), which Node's fs API does not expose. This
 * residual gap needs a CONCURRENT LOCAL ATTACKER able to swap a
 * directory on this exact machine between the containment check and
 * the write — not a remote, pre-committed symlink, which is what the
 * leaf fix above and the original finding were about. */
export async function writeFileNoFollow(
  abs: string,
  content: string,
  verb: string,
  relativePath: string
): Promise<void> {
  let handle: Awaited<ReturnType<typeof fsPromises.open>>;
  try {
    handle = await fsPromises.open(
      abs,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ELOOP') {
      throw new SourceApiError(
        `${verb}: ${relativePath} is a symlink — refusing to write through it`
      );
    }
    throw new SourceApiError(
      `${verb}: ${relativePath} could not be opened for writing (${code ?? String(err)})`
    );
  }
  try {
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
}

/** Open `abs` for reading with `O_NOFOLLOW` set, and read the content
 * through the resulting handle. The kernel refuses the open itself
 * (`ELOOP`) if the leaf is a symlink AT OPEN TIME — the SAME closure
 * `writeFileNoFollow` gives writes, now given to reads: EVERY symlink
 * leaf is refused, in-root or not, closing the asymmetry lens-review
 * found on sources#29/#31 (writes closed at the syscall; reads only
 * checked via a racy `lstat`-then-follow). A dangling symlink (one
 * whose target does not exist) gets the SAME refusal as any other
 * symlink leaf -- `O_NOFOLLOW` refuses on the symlink itself, before
 * ever trying to resolve where it points, so there is no separate
 * "broken target" case to distinguish here the way `checkLeafSymlink`
 * once had to.
 *
 * `ENOENT` (the path does not exist at all) is NOT wrapped -- it is
 * rethrown as-is, so `readFile`/`isFresh`'s own existing
 * not-found/false mapping, which matches on the raw error code,
 * keeps working unchanged.
 *
 * Exported so a test can call it directly against an already-planted
 * symlink, the same way `writeFileNoFollow` is. */
export async function readFileNoFollow(
  abs: string,
  verb: string,
  relativePath: string
): Promise<string> {
  let handle: Awaited<ReturnType<typeof fsPromises.open>>;
  try {
    handle = await fsPromises.open(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') throw err;
    if (code === 'ELOOP') {
      throw new SourceApiError(
        `${verb}: ${relativePath} is a symlink — refusing to read through it`
      );
    }
    throw new SourceApiError(
      `${verb}: ${relativePath} could not be opened for reading (${code ?? String(err)})`
    );
  }
  try {
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Refuse a ref this adapter cannot honour.
 *
 * A filesystem adapter reads a working tree, and a working tree is whatever is
 * checked out — so there is no version of `readFile(…, 'main')` this can answer
 * correctly. Until now it answered anyway: `void ref`, four times, and the
 * caller got the working tree with no indication it had asked an unanswerable
 * question.
 *
 * That is not a small imprecision. A consumer grepped at `main` for a string it
 * knew was in that commit, got nothing back, and concluded the string was
 * absent — a discriminating check, run correctly, returning a confident wrong
 * answer in the verbs used for VERIFICATION. Silence is the whole defect: an
 * error here costs a caller one message, and being wrong costs it the
 * conclusion it drew.
 *
 * An EMPTY ref is not a request. Callers pass `''` as "whatever is current" so
 * that reads, greps and symbol lookups agree on one cache key, and for a
 * working tree that is exactly right.
 */
function refuseRef(ref: string | undefined, verb: string): void {
  if (ref === undefined || ref === '') return;
  throw new SourceApiError(
    `${verb}: cannot read at ref ${JSON.stringify(ref)} — this is a working tree on disk, not a ` +
      'git object database. Reading it at a ref would silently answer about whatever is checked ' +
      'out. Omit the ref, check the ref out first, or address the repository by its remote URL.'
  );
}

export async function readFile(
  env: SourceEnv,
  root: string,
  path: string,
  ref?: string
): Promise<ReadFileResult> {
  void env;
  refuseRef(ref, 'readFile');
  try {
    const { abs } = await ensureSafePath(root, path, 'readFile');
    const content = await readFileNoFollow(abs, 'readFile', path);
    return { content, sha: shaOf(content) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new SourceApiError('not_found', 404);
    }
    throw err;
  }
}

export async function listFiles(
  env: SourceEnv,
  root: string,
  prefix: string,
  ref?: string
): Promise<DirEntry[]> {
  void env;
  refuseRef(ref, 'listFiles');
  try {
    const { abs, realRoot } = await ensureSafePath(root, prefix, 'listFiles');
    // The listed directory ITSELF is a leaf for this call — a
    // symlinked prefix is refused unless its own realpath is inside
    // the root, the same policy as a read (see `checkLeafSymlink`):
    // listing THROUGH it would otherwise enumerate whatever is on
    // the other side.
    await checkLeafSymlink(abs, realRoot, prefix, 'listFiles', 'read');
    const items = await fsPromises.readdir(abs, { withFileTypes: true });
    return items.map((item) => ({
      name: item.name,
      type: item.isDirectory()
        ? ('dir' as const)
        : item.isSymbolicLink()
          ? ('symlink' as const)
          : ('file' as const),
      path: prefix ? `${prefix}/${item.name}` : item.name,
      // FS entries don't have a meaningful per-entry sha at the
      // listing level; downstream callers that need one use
      // `readFile` to get the content sha.
      sha: '',
    }));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new SourceApiError('not_found', 404);
    }
    throw err;
  }
}

export async function getRepoTree(env: SourceEnv, root: string, ref?: string): Promise<RepoTree> {
  void env;
  refuseRef(ref, 'getRepoTree');
  const entries: TreeEntry[] = [];
  let truncated = false;

  async function walk(rel: string): Promise<void> {
    if (entries.length >= DEFAULT_TREE_CAP) {
      truncated = true;
      return;
    }
    const abs = rel ? join(root, rel) : root;
    let items;
    try {
      items = await fsPromises.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (entries.length >= DEFAULT_TREE_CAP) {
        truncated = true;
        return;
      }
      if (IGNORED_DIRS.has(item.name)) continue;
      // A symlink is never followed or listed here, directory or
      // file — walking through one could leave the root the same
      // way an unguarded `readFile`/`writeFile` could. This used to
      // be an INCIDENTAL consequence of `isDirectory()`/`isFile()`
      // both being `false` for a symlink `Dirent`; made explicit so
      // it isn't resting on that coincidence, and pinned by a test.
      if (item.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${item.name}` : item.name;
      if (item.isDirectory()) {
        entries.push({ path: childRel, type: 'tree', sha: '' });
        await walk(childRel);
      } else if (item.isFile()) {
        let size: number | undefined;
        try {
          const stat = await fsPromises.stat(join(root, childRel));
          size = stat.size;
        } catch {
          continue;
        }
        entries.push({ path: childRel, type: 'blob', size, sha: '' });
      }
    }
  }

  await walk('');
  return { entries, truncated };
}

/** Returns true when the cached `version` (sha256-prefix of content)
 * still matches the file's current content. Missing file → false.
 *
 * v0 does the simple-correct thing: re-read + re-hash + compare. The
 * cache layer's TTL gate (default 10s) keeps this from running on
 * every `readFile`. A stat-based fast-path (mtime + size) could
 * short-circuit when those match a recorded mtime+size — left as
 * future optimisation once the cache stores stat metadata alongside
 * content. For local disk reads the current implementation is fast
 * enough that the optimisation isn't worth the contract
 * complication. */
export async function isFresh(
  env: SourceEnv,
  root: string,
  path: string,
  version: string,
  ref?: string
): Promise<boolean> {
  void env;
  refuseRef(ref, 'isFresh');
  try {
    const { abs } = await ensureSafePath(root, path, 'isFresh');
    const content = await readFileNoFollow(abs, 'isFresh', path);
    return shaOf(content) === version;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw err;
  }
}

export async function writeFile(
  env: SourceEnv,
  root: string,
  path: string,
  content: string,
  branch: string,
  commitMessage: string
): Promise<void> {
  void env;
  void branch;
  void commitMessage;
  const { abs, realRoot } = await ensureSafePath(root, path, 'writeFile');
  await checkLeafSymlink(abs, realRoot, path, 'writeFile', 'write');
  await fsPromises.mkdir(dirname(abs), { recursive: true });
  await writeFileNoFollow(abs, content, 'writeFile', path);
}

/** Reject a branch name that isn't a safe git ref before it reaches
 * `git checkout -B` — a `-`-prefixed name would be read as an option, and the
 * rest are git ref-name rules (no whitespace or `~^:?*[\`, no `..` / `//` /
 * `@{`, no leading/trailing `/`, no trailing `.`). Validating at the boundary
 * means an unsafe branch is rejected before any file is written. */
function assertSafeBranch(branch: string): void {
  const unsafe =
    branch.length === 0 ||
    branch.startsWith('-') ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.endsWith('.') ||
    branch.includes('..') ||
    branch.includes('//') ||
    branch.includes('@{') ||
    /[\s~^:?*[\\]/.test(branch);
  if (unsafe) {
    throw new SourceApiError(
      `commitFiles: unsafe branch name for fs git: ${JSON.stringify(branch)}`
    );
  }
}

/**
 * What git actually said, from whichever stream it said it on.
 *
 * This read `stderr ?? String(err)` and produced a message ending in a colon
 * with nothing after it, for two compounding reasons. Git writes "nothing to
 * commit" to STDOUT, so the field read was empty; and `??` falls back only on
 * null/undefined, so an empty string passed through as though it were the
 * explanation. A consumer spent a diagnosis on reflog archaeology to recover a
 * sentence git had already written.
 *
 * Every stream, in order, and only a non-empty one is believed.
 *
 * Exported for its own tests. Three of its four branches are unreachable
 * through `commitFiles` — git has to be induced to fail in a specific way to
 * reach each — and a fallback chain whose fallbacks are never exercised is how
 * this bug got here in the first place.
 */
export function gitDetail(err: unknown): string {
  const e = err as { stderr?: string; stdout?: string; message?: string };
  for (const candidate of [e?.stderr, e?.stdout, e?.message, String(err)]) {
    const text = (candidate ?? '').trim();
    // `[object Object]` is what String() gives for the error shapes that reach
    // here, and it is not an explanation — it is the absence of one wearing
    // enough characters to pass a length check. Found by a test asserting the
    // final fallback, which until then was unreachable.
    if (text.length > 0 && text !== '[object Object]') return text;
  }
  return 'git failed and said nothing on any stream';
}

/** Write every file, then — when the root is a git repo — check out `branch`,
 * stage, and commit. Best-effort locally: on a git failure the written files are
 * left on disk (the error names them; see the SourceAdapter contract). A non-git
 * root just gets the writes. Throws on empty files, an unsafe branch name, or
 * ANY listed path that escapes the root or is itself a symlink (see
 * `ensureSafePath`/`checkLeafSymlink` above) — checked per path, inside the same
 * loop that writes, so an escape on file N still leaves files 1..N-1 written
 * (unchanged from this function's pre-existing best-effort contract). */
export async function commitFiles(
  env: SourceEnv,
  root: string,
  branch: string,
  files: { path: string; content: string }[],
  commitMessage: string
): Promise<void> {
  void env;
  if (files.length === 0) {
    throw new SourceApiError('commitFiles: files array must not be empty');
  }

  const gitDirPath = join(root, '.git');
  let isGitRepo = false;
  try {
    await fsPromises.stat(gitDirPath);
    isGitRepo = true;
  } catch {
    isGitRepo = false;
  }

  // Validate the branch before writing anything, so an unsafe ref is rejected
  // with no side effect (no files left on disk).
  if (isGitRepo) {
    assertSafeBranch(branch);
  }

  const writtenPaths: string[] = [];
  for (const file of files) {
    const { abs, realRoot } = await ensureSafePath(root, file.path, 'commitFiles');
    await checkLeafSymlink(abs, realRoot, file.path, 'commitFiles', 'write');
    await fsPromises.mkdir(dirname(abs), { recursive: true });
    await writeFileNoFollow(abs, file.content, 'commitFiles', file.path);
    writtenPaths.push(file.path);
  }

  if (!isGitRepo) {
    return;
  }

  try {
    await execFileAsync('git', ['checkout', '-B', branch], { cwd: root });
    await execFileAsync('git', ['add', '--', ...writtenPaths], { cwd: root });
    await execFileAsync('git', ['commit', '-m', commitMessage], { cwd: root });
  } catch (err) {
    // fs commitFiles is best-effort locally (see the SourceAdapter contract):
    // the files are already on disk, so surface the git failure AND the paths
    // left written, rather than swallowing it into a false success.
    throw new SourceApiError(
      `commitFiles: git staging/commit failed for ${root}@${branch} ` +
        `(left on disk: ${writtenPaths.join(', ')}): ${gitDetail(err)}`
    );
  }
}

/** No-op at v0. FS has no branch concept here. Future: opt-in
 * `git checkout -b` when the root is a git repo. */
export async function ensureBranch(env: SourceEnv, root: string, branch: string): Promise<void> {
  void env;
  void root;
  void branch;
}

/** Not applicable to the FS adapter — throws. */
export async function ensureFork(env: SourceEnv, upstreamUrl: string): Promise<string> {
  void env;
  throw new SourceApiError(`Fork is not supported for the filesystem source: ${upstreamUrl}`, 501);
}

/** Not applicable to the FS adapter — throws. */
export async function openPullRequest(
  env: SourceEnv,
  targetUrl: string,
  head: string,
  base: string,
  title: string,
  body: string
): Promise<string> {
  void env;
  void head;
  void base;
  void title;
  void body;
  throw new SourceApiError(
    `Pull requests are not supported for the filesystem source: ${targetUrl}`,
    501
  );
}

/** Returns a stable sentinel so callers that branch on default-
 * branch-name don't break. Future: read `.git/HEAD` when the root
 * is a git repo. */
export async function getDefaultBranch(env: SourceEnv, root: string): Promise<string> {
  void env;
  void root;
  return 'local';
}

/** Aggregate export — pass `fs` to code that accepts a generic
 * SourceAdapter. */
export const fs = {
  readFile,
  listFiles,
  getRepoTree,
  isFresh,
  writeFile,
  commitFiles,
  ensureBranch,
  ensureFork,
  openPullRequest,
  getDefaultBranch,
};
