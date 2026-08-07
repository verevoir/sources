// @verevoir/sources/fs — local filesystem adapter
//
// Implements the SourceAdapter contract over a local directory root.
// `repoUrl` is interpreted as an absolute filesystem path; `ref` is
// accepted-but-ignored at v0 (FS has no branching concept here).
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

import { promises as fsPromises } from 'node:fs';
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

export async function readFile(
  env: SourceEnv,
  root: string,
  path: string,
  ref?: string
): Promise<ReadFileResult> {
  void env;
  void ref;
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
  void ref;
  try {
    const safe = ensureSafePath(root, prefix);
    const items = await fsPromises.readdir(safe, { withFileTypes: true });
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
  void ref;
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
  void ref;
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
    const gitErr = err as { stderr?: string };
    throw new SourceApiError(
      `commitFiles: git staging/commit failed for ${root}@${branch} ` +
        `(left on disk: ${writtenPaths.join(', ')}): ${gitErr?.stderr ?? String(err)}`
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

/** Not applicable to the FS adapter — throws. */
export async function mergePullRequest(
  env: SourceEnv,
  targetUrl: string,
  pull: number | string,
  method?: 'merge' | 'squash' | 'rebase'
): Promise<boolean> {
  void env;
  void pull;
  void method;
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
  mergePullRequest,
  getDefaultBranch,
};
