# Changelog

## 0.8.1 — 2026-08-25

- **Fixed (github adapter): `getRepoTree` ignored the empty-ref convention the rest of the adapter keeps.** 0.8.0 stated it plainly — "an **empty** ref … still means 'whatever is current' — callers pass `''` so reads, greps and symbol lookups share one cache key" — and `readFile` and `listFiles` implement it with `ref ? … : ''`. `getRepoTree` resolved the same argument with `ref ?? await getDefaultBranch(…)`, and `''` is not nullish, so it survived and the request asked GitHub for `/repos/{o}/{r}/branches/` **with no branch name**. One adapter, two conventions for one argument, and only one of them matched the caller. The malformed request 404s, so every ref-less `grep`, `find_symbol` or tree read through this adapter failed with `not_found` — the same token GitHub returns for a repository that does not exist. A consumer searching a **private repository it could read perfectly well** got `not_found`, concluded it had no access, and stopped looking; the repository was reachable throughout. This is the same shape as the fs-adapter defect 0.8.0 fixed — a wrong answer indistinguishable from a real one — reached through a different argument, in a different adapter, in the same release family. `getRepoTree` had **no test coverage at all**, which is how the two conventions diverged unnoticed; four tests now pin it, and the fix was verified by re-applying the defect and watching exactly one of them go red. **No migration:** the old behaviour was a 404 on every call, so nothing can have depended on it.

## 0.8.0 — 2026-08-14

- **Breaking (fs adapter): a `ref` it cannot honour is now REFUSED rather than ignored.** `readFile`, `listFiles`, `getRepoTree` and `isFresh` each took a `ref` and discarded it (`void ref`), returning the working tree. There is no correct answer to `readFile(…, 'main')` from a directory on disk — but answering the working-tree question instead, silently, made a wrong answer indistinguishable from a real one. A consumer grepped at `main` for a string it knew was in that commit, got nothing back, and concluded the string was absent. All four now throw `SourceApiError` naming the verb and the ref, **before touching the filesystem**, so a ref request against a missing path does not come back `not_found` and teach the caller the wrong fact. An **empty** ref is unchanged and still means "whatever is current" — callers pass `''` so reads, greps and symbol lookups share one cache key, which for a working tree is right. **Migrating:** pass no ref (or `''`) to read the working tree; check the ref out first; or address the repository by its remote URL, where refs mean something. **The Notion adapter still accepts-and-ignores a ref** — the same defect, deliberately not changed in this release so one behavioural break ships at a time.
- **Fixed (fs adapter): `commitFiles` reported git failures with an empty explanation.** The message read `… (left on disk: x.ts):` — a colon with nothing after it. Two things compounded: git writes "nothing to commit" to **stdout**, and only `stderr` was read; and `stderr ?? String(err)` falls back only on null/undefined, so an empty string passed through as though it were the explanation. Every stream is now tried in order and only a non-empty one is believed (`[object Object]` included in what is not believed). A consumer spent a diagnosis on reflog archaeology to recover a sentence git had already written.

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
