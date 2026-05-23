# Changelog

## 0.3.0 — 2026-05-23

- **New: `@verevoir/sources/trello`** — Trello board adapter implementing the SourceAdapter contract. Board > List > Card model: lists are dirs, cards are files. Auth via integration token packed into `SourceEnv.token` as `"<apiKey>:<apiToken>"`. `envFromTrelloProcessEnv()` reads `TRELLO_API_KEY` + `TRELLO_API_TOKEN`. Read operations: `readFile(<cardId>)` returns the card description, `readFile(<cardId>/comments)` renders all comments as markdown. Write operations: `writeFile(<cardId>, ...)` updates the card description; `writeFile(<cardId>/comments, ...)` posts a new comment. No-branch model: `ensureBranch` is a no-op; `ensureFork` and `openPullRequest` throw 501.

## 0.2.0 — 2026-05-23

- **New: `@verevoir/sources/fs`** — local filesystem adapter implementing the SourceAdapter contract. `repoUrl` is interpreted as a directory path. No auth, no API. `readFile` / `listFiles` / `getRepoTree` / `writeFile` work; `ensureFork` / `openPullRequest` throw 501 (not applicable to a local filesystem). Validates the SourceAdapter contract against a second source kind.
- New example: `examples/fs-read-and-tree.ts`.

## 0.1.0 — 2026-05-23

Initial release.

- `@verevoir/sources` — core types, `SourceAdapter` contract, `SourceApiError`, `envFromProcessEnv`.
- `@verevoir/sources/github` — GitHub REST + Git Data adapter. `readFile`, `listFiles`, `getRepoTree`, `writeFile`, `ensureBranch`, `ensureFork`, `openPullRequest`, `getDefaultBranch`. Uses native `fetch`; no SDK peer dependency.
- Extracted from aigency-web's `src/server/repo-api.ts` per ADR 019 (substrate libraries).
