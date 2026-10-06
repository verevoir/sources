// Internal O_NOFOLLOW file primitives for the fs adapter. NOT part of the
// package's public surface: package.json `exports` maps `./fs` to
// `./dist/fs/index.js` only, so these are unreachable to consumers. They do no
// root containment themselves; callers in ./index.ts run `ensureSafePath`
// first. Tests import them from this file directly.

import { promises as fsPromises, constants as fsConstants } from 'node:fs';
import { SourceApiError } from '../index.js';

/** Write `content` to `abs` through an `O_NOFOLLOW` open, so the kernel
 * refuses a symlink leaf at open time (`ELOOP`). This is the leaf-race
 * closure for writes described in the module header, including its
 * directory-component residual. Lives in this internal module, NOT the public `./fs` entry point:
 * it does no root containment of its own, so it must only be reached
 * through `writeFile`/`commitFiles` after `ensureSafePath`. */
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

/** Read `abs` through an `O_NOFOLLOW` open: the read-side twin of
 * `writeFileNoFollow` (see the module header). Every symlink leaf is
 * refused, dangling or not. `ENOENT` is rethrown unwrapped so callers'
 * not-found mapping keeps working. Internal for the same reason: no containment of its own. */
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
