# Changelog

## Unreleased

- **New: `mergePullRequest(env, targetUrl, pull, method?)` on the SourceAdapter contract** — merges an open PR by number or its html_url; `method` selects the strategy (`merge` | `squash` | `rebase`, default a merge commit). GitHub calls `PUT /pulls/{n}/merge` and returns the merged boolean; a refused merge (e.g. 405 not mergeable — conflicts or required checks not green) surfaces as a `SourceApiError`. The fs and Notion adapters throw 501, symmetric with `openPullRequest`. Completes the open→merge PR lifecycle on the contract. (STDIO-565.)

## 0.7.0 — 2026-07-05

- **New: `commitFiles(env, repoUrl, branch, files[], commitMessage)` on the SourceAdapter contract** — commits multiple files as one atomic unit on a branch (creating it if missing), replacing N separate `writeFile` commits. GitHub makes a single commit via the Git Data API (blobs → tree on the branch's base tree → commit parenting the tip → move the ref); the fs adapter writes the files and, when the root is a git repo, checks out the branch and stages + commits — the same branch model GitHub has — surfacing any git failure rather than leaving a silent half-state; Notion degrades to sequential `writeFile`. (STDIO-535.)

## 0.5.0 — 2026-05-26

- **Notion adapter uses the SDK's native Markdown conversion.** `readFile` now reads page bodies via `pages.retrieveMarkdown` and `writeFile` writes via `pages.updateMarkdown` (`replace_content` with `allow_deleting_content`), dropping the ~430-line hand-rolled block↔Markdown converter (`fetchAllBlocks` / `blocksToMarkdown` / `markdownToBlocks` / language-alias map). Same read/write contract, far less surface to maintain, and no more block-shape drift (the class of bug behind the earlier `updateMarkdown` fix). `readFile` treats a 404 on the body endpoint as an empty body (the page itself still resolves). Page-tree navigation (`listFiles` / `getRepoTree` / `resolvePath`) still walks child blocks directly. **Removed:** the internal `markdownToBlocks` export (test-only; no external consumers). (STDIO-42.)

## 0.4.0 — 2026-05-24

- **New: `@verevoir/sources/notion`** — third SourceAdapter implementation, over Notion's API via the official `@notionhq/client` SDK. Models a Notion workspace as a documentation tree: pages are "files", child pages are "subdirectories", file content is the page's blocks rendered to Markdown. `sourceUrl` is a Notion page URL or raw page ID; `path` is a slash-separated traversal through child pages by title (or its kebab-slug).
- Ships a minimal Markdown ↔ Notion-blocks converter covering paragraphs, headings (1-3), bulleted and numbered list items, code blocks (with language alias normalisation), blockquote, divider. Targets aigency-generated content (ADRs, intent docs, tech-stack notes); content created in Notion with rich features (callouts, toggles, tables, etc.) reads with best-effort placeholders and may not round-trip losslessly through a write.
- `isFresh` uses Notion's `last_edited_time` as the version handle — a single `pages.retrieve` call is the cheap probe.
- `ensureBranch` no-op, `ensureFork` / `openPullRequest` throw 501 (no Notion equivalent), `getDefaultBranch` returns `'live'`.
- `@notionhq/client` is an optional peer dependency — consumers who only use `/github` or `/fs` don't pull it.
- 27 new tests (pure-function URL parser + Markdown converter + SDK-mocked adapter integration). 69 total.

## 0.3.1 — 2026-05-24

- Docs: README + llms.txt gain a "Most consumers reach this via MCP" section pointing at `@verevoir/mcp` and the `alwaysLoad: true` Claude Code config. Clarifies that direct in-process use is for advanced cases (writing your own MCP server, composing adapters in libraries).

## 0.3.0 — 2026-05-24

- **Contract: `isFresh(env, repoUrl, path, version, ref?)`** added to `SourceAdapter`. Cache layers ask the source whether a held `version` (the `sha` from a prior `readFile`) is still the live one. Returns `true` when current, `false` when the source has moved (including 404 / file removed). Pairs with the `wrapWithCache` validation TTL in `@verevoir/context`.
- `@verevoir/sources/github`: implements `isFresh` via a Contents API GET + sha compare. v0 wastes the base64 content download; cheaper variants (`If-None-Match`, `Accept: application/vnd.github.object`, tree walks) are noted as future protocol optimisations.
- `@verevoir/sources/fs`: implements `isFresh` via re-read + re-hash + compare. Fast enough on local disk that no stat fast-path is needed at v0.
- **Breaking for third-party adapters** (none today): the new method is required. The two shipped adapters cover it.

## 0.2.0 — 2026-05-23

- **New: `@verevoir/sources/fs`** — local filesystem adapter implementing the SourceAdapter contract. `repoUrl` is interpreted as a directory path. No auth, no API. `readFile` / `listFiles` / `getRepoTree` / `writeFile` work; `ensureFork` / `openPullRequest` throw 501 (not applicable to a local filesystem). Validates the SourceAdapter contract against a second source kind.
- New example: `examples/fs-read-and-tree.ts`.

## 0.1.0 — 2026-05-23

Initial release.

- `@verevoir/sources` — core types, `SourceAdapter` contract, `SourceApiError`, `envFromProcessEnv`.
- `@verevoir/sources/github` — GitHub REST + Git Data adapter. `readFile`, `listFiles`, `getRepoTree`, `writeFile`, `ensureBranch`, `ensureFork`, `openPullRequest`, `getDefaultBranch`. Uses native `fetch`; no SDK peer dependency.
- Extracted from aigency-web's `src/server/repo-api.ts` per ADR 019 (substrate libraries).
