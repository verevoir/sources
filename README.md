# @verevoir/sources

Source-adapter primitive: a contract over remote file sources (read, list, tree, write, branch, fork, PR open) with implementations as subpath imports.

## Purpose

Lets a downstream project read and write files in remote repositories without coupling to a specific source-host SDK. Pick the source via a subpath import; unused implementations don't enter your bundle.

Built for LLM-driven workflows that need API-based code access (no on-disk clones, no resident language servers). The companion package [`@verevoir/context`](https://github.com/verevoir/context) layers an in-process cache + symbol index on top of these reads.

## Subpaths

- `@verevoir/sources` — core types, the `SourceAdapter` contract, the `SourceApiError` class, and the `envFromProcessEnv` helper. No source dependency.
- `@verevoir/sources/github` — GitHub REST + Git Data adapter. Uses native `fetch`, no SDK dependency.
- `@verevoir/sources/fs` — local filesystem adapter. `repoUrl` is a local directory path. No auth, no API. Reads/lists/walks/writes; fork + PR throw 501 (not applicable to a local filesystem).
- `@verevoir/sources/trello` — Trello board adapter. `repoUrl` is a board URL (`https://trello.com/b/<boardId>`). Lists are dirs; cards are files. Auth via integration-token packed into `SourceEnv.token` as `"<apiKey>:<apiToken>"`.

Future adapters land alongside (`@verevoir/sources/gitlab`, `@verevoir/sources/bitbucket`, `@verevoir/sources/s3`, `@verevoir/sources/notion`) under the same contract.

## Install

```bash
npm install @verevoir/sources
```

No mandatory peer dependencies — the GitHub adapter uses native `fetch`.

## Canonical usage — GitHub

```ts
import { envFromProcessEnv } from '@verevoir/sources';
import { readFile, writeFile, openPullRequest } from '@verevoir/sources/github';

const env = envFromProcessEnv();
if (!env) throw new Error('GITHUB_TOKEN not set');

// Read a file from the default branch.
const { content, sha } = await readFile(env, 'https://github.com/acme/charts', 'README.md');

// Write a file on a feature branch (branch is created if missing).
await writeFile(
  env,
  'https://github.com/acme/charts',
  'docs/notes.md',
  '# Notes\n\nBody.\n',
  'feature/notes',
  'Add notes'
);

// Open a PR from the feature branch to main.
const prUrl = await openPullRequest(
  env,
  'https://github.com/acme/charts',
  'feature/notes',
  'main',
  'Add docs/notes.md',
  'Body of the PR.'
);
```

## Canonical usage — Local filesystem

Same contract; no auth required. `repoUrl` is interpreted as a directory path.

```ts
import { readFile, listFiles, getRepoTree, writeFile } from '@verevoir/sources/fs';

const env = { token: '', forkOrg: '' }; // FS adapter ignores both

// Walk the working tree (skipping node_modules, .git, dist, etc.).
const tree = await getRepoTree(env, '/path/to/project');
console.log(`${tree.entries.filter((e) => e.type === 'blob').length} files`);

// Read + write the same way as GitHub.
const readme = await readFile(env, '/path/to/project', 'README.md');
await writeFile(
  env,
  '/path/to/project',
  'docs/notes.md',
  '# Notes\n',
  'ignored', // FS adapter ignores branch
  'ignored' // FS adapter ignores commit message
);
```

`ensureFork` and `openPullRequest` throw 501 on the FS adapter — there's no local-FS equivalent. The customer manages git operations themselves.

## Canonical usage — Trello

Board > List > Card. Lists are dirs; cards are files. Auth uses an integration token (API key + API token) packed together.

```ts
import { envFromTrelloProcessEnv } from '@verevoir/sources/trello';
import { readFile, writeFile, listFiles } from '@verevoir/sources/trello';

// Set TRELLO_API_KEY + TRELLO_API_TOKEN in your environment.
const env = envFromTrelloProcessEnv();
if (!env) throw new Error('TRELLO_API_KEY or TRELLO_API_TOKEN not set');

const boardUrl = 'https://trello.com/b/abc123/my-board';

// Read a card's description (already markdown).
const { content, sha } = await readFile(env, boardUrl, '<cardId>');

// Read all comments on a card, rendered as markdown blocks.
const { content: comments } = await readFile(env, boardUrl, '<cardId>/comments');

// Update a card's description.
await writeFile(env, boardUrl, '<cardId>', '# Updated\n\nNew body.', 'board', '');

// Post a new comment on a card.
await writeFile(env, boardUrl, '<cardId>/comments', 'LGTM!', 'board', '');

// List all lists on the board ('' prefix → lists as DirEntry[]).
const lists = await listFiles(env, boardUrl, '');

// List cards in a specific list (<listId> prefix → cards as DirEntry[]).
const cards = await listFiles(env, boardUrl, lists[0].path);
```

**Path conventions:**

- `<cardId>` — the card's description. `readFile` returns `.desc`; `writeFile` updates it.
- `<cardId>/comments` — the card's comment thread. `readFile` renders all comments as markdown; `writeFile` posts a new comment (does not replace existing ones).
- `''` as `listFiles` prefix — returns the board's lists.
- `<listId>` as `listFiles` prefix — returns cards in that list.

`ensureBranch` is a no-op. `ensureFork` and `openPullRequest` throw 501.

## Fork-pivot pattern

When a `writeFile` to an upstream repo returns 403 (no write access), the caller can fork the upstream, write to the fork, and open a PR back:

```ts
import { ensureFork, writeFile, openPullRequest, SourceApiError } from '@verevoir/sources/github';

try {
  await writeFile(env, upstreamUrl, path, content, branch, message);
} catch (err) {
  if (err instanceof SourceApiError && err.status === 403) {
    const forkUrl = await ensureFork(env, upstreamUrl);
    await writeFile(env, forkUrl, path, content, branch, message);
    await openPullRequest(env, upstreamUrl, `${env.forkOrg}:${branch}`, 'main', 'Title', 'Body');
  } else {
    throw err;
  }
}
```

## The contract

Every subpath exposes the same set of functions (or a strict subset for read-only sources):

```ts
readFile(env, repoUrl, path, ref?)         → Promise<{ content, sha }>
listFiles(env, repoUrl, prefix, ref?)      → Promise<DirEntry[]>
getRepoTree(env, repoUrl, ref?)            → Promise<RepoTree>
writeFile(env, repoUrl, path, content, branch, message) → Promise<void>
ensureBranch(env, repoUrl, branch)         → Promise<void>
ensureFork(env, upstreamUrl)               → Promise<string>
openPullRequest(env, target, head, base, title, body) → Promise<string>
getDefaultBranch(env, repoUrl)             → Promise<string>
```

The `SourceAdapter` interface in `@verevoir/sources` captures this exactly. An aggregate export (e.g. `github`) is also available per subpath so generic callers can pass an adapter around as a single value.

## Errors

`SourceApiError` is thrown on transport / API failures. `status` carries the HTTP status when present; `detail` carries the truncated response body for non-404 errors. 404 is the conventional "ref / path doesn't exist" signal — callers fall back to default-branch reads or other recovery on that status.

## What this is NOT

- Not an Octokit replacement. Functions cover read + write + branch + fork + PR open; everything else (issues, releases, etc.) stays on the source's own SDK.
- Not a sync engine. Each call is independent; no local working tree, no shadow state.
- Not a language-aware index. Symbol extraction + content cache live in [`@verevoir/context`](https://github.com/verevoir/context) on top.

## See also

- [`@verevoir/context`](https://github.com/verevoir/context) — in-process content + symbol cache for LLM context windows.
- [`@verevoir/llm`](https://github.com/verevoir/llm) — provider-agnostic LLM call surface.

## License

Apache-2.0.
