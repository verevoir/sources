/**
 * Minimal example: read a file + walk the tree of a local directory
 * using the FS adapter. Mirrors the GitHub example but with a path
 * argument instead of a repo URL.
 *
 * Run:
 *
 *   npx tsx examples/fs-read-and-tree.ts ./some/local/dir
 *
 * No auth, no API; just `fs` under the hood. The same `SourceAdapter`
 * contract as `@verevoir/sources/github` — code that consumes the
 * contract works against both.
 */

import { resolve } from 'node:path';
import { readFile, getRepoTree } from '@verevoir/sources/fs';

async function main(): Promise<void> {
  const root = resolve(process.argv[2] ?? '.');
  const env = { token: '', forkOrg: '' };

  console.log(`Walking tree of ${root}…`);
  const tree = await getRepoTree(env, root);
  console.log(`  → ${tree.entries.length} entries${tree.truncated ? ' (truncated)' : ''}`);
  const blobs = tree.entries.filter((e) => e.type === 'blob');
  console.log(`  → ${blobs.length} files`);

  const readmeEntry = blobs.find((e) => /^README/i.test(e.path.split('/').pop() ?? ''));
  if (readmeEntry) {
    console.log(`\nReading ${readmeEntry.path}…`);
    const { content, sha } = await readFile(env, root, readmeEntry.path);
    console.log(`  sha (sha256 prefix): ${sha}`);
    console.log(
      `  content (first 200 chars): ${content.slice(0, 200)}${content.length > 200 ? '…' : ''}`
    );
  } else {
    console.log('\nNo README found in this tree.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
