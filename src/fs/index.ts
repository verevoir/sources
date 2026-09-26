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
// Tree walks respect Git ignore rules. `writeFile` writes straight to disk
// (no commit, no branch), while `commitFiles` stages +
// commits on the branch when the root is a git repo (best-effort — the
// files are written first and are not rolled back if the commit fails).
//
// What this is NOT:
//   - Forkable. `ensureFork` and `openPullRequest` throw — they
//     don't have a local-FS equivalent.

import { promises as fsPromises } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
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

const DEFAULT_TREE_CAP = 25000;

export interface FsTreeOptions {
  /** Maximum returned entries; defaults to 25,000. Must be a positive safe integer. */
  maxEntries?: number;
}

/** Surrogate sha — sha256 prefix of the content. Lets callers that
 * use sha for change-detection (e.g. cache invalidation) behave
 * predictably against FS reads. Not a git blob sha. */
function shaOf(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 40);
}

/** Resolve a relative path under `root`, refusing any path that
 * escapes the root via `..` or absolute paths. Returns the absolute
 * filesystem path the adapter should touch. */
function ensureSafePath(root: string, relativePath: string): string {
  const rootAbs = resolve(root);
  const abs = resolve(rootAbs, relativePath);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + '/')) {
    throw new SourceApiError(`Path escapes the root: ${relativePath}`);
  }
  return abs;
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
    const safe = ensureSafePath(root, path);
    const content = await fsPromises.readFile(safe, 'utf8');
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
    const safe = ensureSafePath(root, prefix);
    const items = await fsPromises.readdir(safe, { withFileTypes: true });
    const ignored = await gitIgnoredPaths(root);
    let scope: IgnoreScope | null = ignored ? { base: '', ignored } : null;
    let rel = '';
    // Check every ancestor before entering a nested repository; otherwise a
    // direct prefix could expose a subtree that the tree walk prunes.
    for (const part of relative(resolve(root), safe).split('/').filter(Boolean)) {
      rel = rel ? `${rel}/${part}` : part;
      if (IGNORED_DIRS.has(part) || isGitIgnored(scope, rel, true)) return [];
      try {
        await fsPromises.lstat(join(root, rel, '.git'));
      } catch {
        continue;
      }
      const nested = await gitIgnoredPaths(join(root, rel));
      if (nested) scope = { base: rel, ignored: nested };
    }
    return items
      .filter(
        (item) =>
          !IGNORED_DIRS.has(item.name) &&
          !isGitIgnored(scope, rel ? `${rel}/${item.name}` : item.name, item.isDirectory())
      )
      .map((item) => ({
        name: item.name,
        type: item.isDirectory()
          ? ('dir' as const)
          : item.isSymbolicLink()
            ? ('symlink' as const)
            : ('file' as const),
        path: prefix ? `${prefix}/${item.name}` : item.name,
        // Listing entries have no content hash; callers can use readFile.
        sha: '',
      }));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new SourceApiError('not_found', 404);
    }
    throw err;
  }
}

/** A git work tree the walk is inside: `base` is its directory relative
 * to the walk root ('' for the root itself) and `ignored` is what git
 * reports as ignored under it, relative to `base` (directories carry a
 * trailing '/'). */
interface IgnoreScope {
  base: string;
  ignored: Set<string>;
}

/** Ask git which paths under `dir` it ignores — nested `.gitignore`s,
 * `.git/info/exclude` and the global excludes file, with git's own
 * semantics rather than a reimplementation. `--directory` collapses a
 * wholly-ignored directory to one `dir/` line, so a large ignored tree
 * (a database bind mount, `node_modules`) costs one entry, not a walk.
 * Returns null when `dir` is not in a work tree or git is unavailable —
 * the walk then falls back to `IGNORED_DIRS` alone. */
async function gitIgnoredPaths(dir: string): Promise<Set<string> | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
      { cwd: dir, maxBuffer: 64 * 1024 * 1024 }
    );
    return new Set(stdout.split('\0').filter(Boolean));
  } catch {
    return null;
  }
}

function isGitIgnored(scope: IgnoreScope | null, childRel: string, isDir: boolean): boolean {
  if (!scope) return false;
  if (scope.ignored.has('./')) return true;
  const key = scope.base ? childRel.slice(scope.base.length + 1) : childRel;
  return scope.ignored.has(isDir ? `${key}/` : key);
}

/** Walk the tree under `root`, skipping `IGNORED_DIRS` by name and
 * anything git ignores. Ignored paths are pruned DURING the walk, so
 * they never count toward `DEFAULT_TREE_CAP` — otherwise a gitignored
 * directory that sorts early (e.g. `.dev/pg-data`) can exhaust the cap
 * and silently drop real source from the tail of the tree. A nested
 * work tree (a submodule, or any directory holding a `.git` entry)
 * starts a fresh scope, since the parent's `git ls-files` does not
 * descend into it. */
export async function getRepoTree(
  env: SourceEnv,
  root: string,
  ref?: string,
  options: FsTreeOptions = {}
): Promise<RepoTree> {
  void env;
  refuseRef(ref, 'getRepoTree');
  const cap = options.maxEntries ?? DEFAULT_TREE_CAP;
  if (!Number.isSafeInteger(cap) || cap < 1) {
    throw new SourceApiError('getRepoTree: maxEntries must be a positive safe integer');
  }
  const entries: TreeEntry[] = [];
  let truncated = false;

  async function scopeFor(rel: string): Promise<IgnoreScope | null> {
    const ignored = await gitIgnoredPaths(rel ? join(root, rel) : root);
    return ignored ? { base: rel, ignored } : null;
  }

  async function walk(rel: string, scope: IgnoreScope | null): Promise<void> {
    const abs = rel ? join(root, rel) : root;
    let items;
    try {
      items = await fsPromises.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    // Resolve sibling repositories concurrently, with at most eight Git
    // processes at once. Keep entry emission sequential for stable cap/order
    // semantics, and never retain ignore results across calls.
    const directories = items
      .filter((item) => {
        const childRel = rel ? `${rel}/${item.name}` : item.name;
        return (
          item.isDirectory() && !IGNORED_DIRS.has(item.name) && !isGitIgnored(scope, childRel, true)
        );
      })
      .slice(0, Math.max(0, cap - entries.length));
    const scopes = new Map<string, IgnoreScope | null>();
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(8, directories.length) }, async () => {
        while (next < directories.length) {
          const item = directories[next++];
          const childRel = rel ? `${rel}/${item.name}` : item.name;
          try {
            await fsPromises.lstat(join(root, childRel, '.git'));
          } catch {
            continue;
          }
          scopes.set(childRel, (await scopeFor(childRel)) ?? scope);
        }
      })
    );
    for (const item of items) {
      if (IGNORED_DIRS.has(item.name)) continue;
      const childRel = rel ? `${rel}/${item.name}` : item.name;
      if (!item.isDirectory() && !item.isFile()) continue;
      if (isGitIgnored(scope, childRel, item.isDirectory())) continue;
      if (entries.length >= cap) {
        truncated = true;
        return;
      }
      if (item.isDirectory()) {
        entries.push({ path: childRel, type: 'tree', sha: '' });
        await walk(childRel, scopes.get(childRel) ?? scope);
        if (truncated) return;
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

  await walk('', await scopeFor(''));
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
    const safe = ensureSafePath(root, path);
    const content = await fsPromises.readFile(safe, 'utf8');
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
  const safe = ensureSafePath(root, path);
  await fsPromises.mkdir(dirname(safe), { recursive: true });
  await fsPromises.writeFile(safe, content, 'utf8');
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
 * root just gets the writes. Throws on empty files or an unsafe branch name. */
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
    const safe = ensureSafePath(root, file.path);
    await fsPromises.mkdir(dirname(safe), { recursive: true });
    await fsPromises.writeFile(safe, file.content, 'utf8');
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
