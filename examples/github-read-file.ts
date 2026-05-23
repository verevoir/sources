/**
 * Minimal example: read a file from a public GitHub repo using the
 * GitHub adapter. Prints the first 200 characters of the content.
 *
 * Run:
 *
 *   GITHUB_TOKEN=ghp_... npx tsx examples/github-read-file.ts
 *
 * A token is required even for public repos so rate-limits are
 * scoped per-user. Generate at https://github.com/settings/tokens
 * (fine-grained or classic; read-only contents scope is enough).
 */

import { envFromProcessEnv } from '@verevoir/sources';
import { readFile } from '@verevoir/sources/github';

async function main(): Promise<void> {
  const env = envFromProcessEnv();
  if (!env) {
    console.error('GITHUB_TOKEN not set in environment.');
    process.exit(1);
  }

  const { content, sha } = await readFile(env, 'https://github.com/verevoir/llm', 'README.md');

  console.log(`Read README.md (sha=${sha}):`);
  console.log(content.slice(0, 200) + (content.length > 200 ? '...' : ''));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
