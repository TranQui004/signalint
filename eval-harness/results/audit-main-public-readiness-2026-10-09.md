# Current `main` public-readiness / content hygiene audit

**Audited ref:** `origin/main` at `3eca84b` (`docs(readme): state that engines are project-installed, not bundled since 1.1.0`, PR #62). This is after the previous baseline `0151f35` (release 1.1.2); PR #62 changes only `README.md` (13 additions, 6 deletions).

**Scope:** read-only inspection of a clean archive of the current main tree (178 tracked files, about 18.5k lines), including package metadata, release/CI workflow, active docs, archived planning docs, and broad credential/path scans. No project source was modified. This is an OSS publication/content-hygiene review, **not** a full line-by-line security audit or a scan of the entire Git history.

## Release decision

The 1.1.2 release is still current (`npm view signalint-mcp version dist-tags.latest` → 1.1.2). PR #62 is docs-only; no code, package metadata, `server.json`, tag, or release changed. No npm, MCP Registry, GitHub Release, or GitHub Action republish is needed to close the 1.1.2 work.

The npm registry's stored README for 1.1.2 still contains the pre-PR bundled-engine wording (`npm view signalint-mcp@1.1.2 readme`). npm's official docs say its package-page README is updated only when a new package version is published: https://docs.npmjs.com/about-package-readme-files/. Do not create a release solely for this documentation correction; the next planned release will carry the corrected README. GitHub `main` is already correct.

## High-confidence findings

| Priority | Location | Finding | Suggested action |
|---|---|---|---|
| P1 | `.github/workflows/release.yml:7-12` | Manual `workflow_dispatch` input defaults to `v1.0.0`, but current `package.json` is 1.1.2. Selecting the default fails the workflow's tag/package-version check. | Remove the stale default and require an explicit tag, or implement a safe current-ref fallback; test both tag push and manual-dispatch paths without publishing. |
| P1 | `CONTRIBUTING.md:5-6, 39-44`; `AGENTS.md:65-67` | Contributor guide still promises Node 20 support and lists a fourth Ubuntu/Node-20 CI job. Current package requires Node >=22.12.0 and CI has only Windows/Ubuntu/macOS Node 22 jobs. `AGENTS.md` still calls `better-sqlite3` a current native dependency, while the project migrated to built-in `node:sqlite` in 1.0.0. | Align active contributor/agent docs with `package.json`, lockfile, and workflow. Confirm the minimum Node version needed for pnpm 11.9.0 before stating the contributor minimum. |
| P1 | `SECURITY.md:52-67, 91-93`; `package.json:75-78`; `pnpm-lock.yaml:117, 1282-1285` | Security note says it was evaluated with SDK 1.32.1 and that the advisory exception should be removed when `@hono/node-server >=2.0.5`; current source pins SDK 1.32.0 and lockfile resolves Hono 2.1.3. Its stated removal condition is already met, but the note still reads as active. | Re-check the advisory against the exact lockfile using a supported audit path, then mark resolved/remove the exception or accurately document the current status and tested versions. Do not make a safety claim based only on this static scan. |
| P2 | `docs/benchmarks.md:3, 46-51`; `scripts/measure-mcp-payload-mode.mjs:13-18`; `package.json` / `pnpm-lock.yaml` | Benchmark page says counts used `gpt-tokenizer`/`cl100k_base`, but the script only dynamically imports that package and falls back to a bytes/3.8 estimate. `gpt-tokenizer` is not declared in the project dependencies or lockfile, so a clean checkout cannot reproduce the stated tokenizer output. The real-client compatibility assertions also have no reproducible test/method note in this repo. | Make the tokenizer available reproducibly (or label those values as estimates and document the fallback); substantiate or qualify real-client claims with versions, method, and evidence. Avoid claiming a clean-checkout reproduction until verified. |
| P2 | `RELEASE.md:19-24, 48-60, 65-70`; `CONTRIBUTING.md:75-84` | Release instructions use hard-coded v1.0.0 and smoke-test v1.1.1 examples although current is 1.1.2. These examples will keep aging and can mislead a maintainer. | Use clear placeholders (`vX.Y.Z` / `<version>`) or derive the version from the release PR/tag. |
| Review decision | `docs/history/build-plan.md:15, 21, 459-462`; `docs/history/README.md` | Archived plan says the repository is private, names the former internal codename, contains raw `<cite index=...>` artifacts and private-agent/local setup notes, and includes outdated competitive/roadmap research. It contains no credential detected in this scan and is explicitly retained as an **untouched historical archive**; README/CONTRIBUTING link to it. | The archive was previously explicitly protected from editing. Leave unchanged unless the maintainer now authorizes removal/sanitization. Deleting it from current `main` would not erase the already-public Git history. |

## Public-source checks that passed

- `LICENSE` is MIT; `package.json` declares `MIT`.
- `package.json.files` is an explicit publish allowlist (`dist/src`, `examples`, `glama.json`, `README.md`, `SECURITY.md`, `LICENSE`). The planning archive, `AGENTS.md`, `CONTRIBUTING.md`, and release workflow are not in the npm tarball allowlist.
- Current-tree searches found no private-key signatures, GitHub/npm/cloud-token signatures, `.env`/credential-like file names, email address, or machine-specific home-directory path. Matches for words such as `secret`/`token` were test fixtures or the literal GitHub Actions placeholder `${{ secrets.NPM_TOKEN }}`, not a credential value.
- The repository is already public. This scan covered the current tree only; it did not run Gitleaks/TruffleHog over full history (those tools are unavailable here) and did not complete `npm audit` because npm lockfile generation failed with `Cannot read properties of null (reading 'edgesOut')` in this sandbox.

## Notes for a follow-up handoff

- The next delivery branch must start from current `origin/main` at `3eca84b`, not from the arena branch.
- Preserve the user rule not to edit `docs/history/build-plan.md` unless they explicitly reverse it.
- Keep the README-only #62 fix separate from any release: no new version, tag, or publication is warranted for the GitHub README update itself.
