# Changelog

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
