# Prompt: public-source hygiene and stale-doc cleanup for Signalint

> Implement the verified findings below on new branches from `main`. The repository is already public. This is a documentation/workflow accuracy cleanup, not a new product release. Keep each PR focused and separate as specified.

## 0. Sync and collect the evidence first

```bash
git fetch origin
git rev-parse --short origin/main
# The latest audited main commit is 3eca84b. If main has moved since this prompt,
# inspect the intervening commits and base every delivery branch on the current origin/main.
git log --oneline 0151f35c..origin/main
```

- `main` moved from **`0151f35c`** (1.1.2 release) to **`3eca84b`** via PR **#62**, `docs(readme): state that engines are project-installed, not bundled since 1.1.0`. PR #62 changes only `README.md`; preserve its correction that Signalint ships no engines.
- The evidence note is `eval-harness/results/audit-main-public-readiness-2026-10-09.md` at arena commit **`7382b9e`**. The arena branch is research-only: **never merge it, never use it as a PR head, and do not branch delivery work from it**.
- Optional: fetch and cherry-pick the research/evidence commits on a separate scratch/evidence branch if you want the committed harness locally. These commits add `eval-harness/` resources; do not include them in a product/docs PR unless explicitly wanted.

```bash
git fetch origin arena/63badebc-signalint
# On a separate scratch branch based on main only:
git switch -c scratch/arena-evidence origin/main
git cherry-pick c5f5e9d 2f1ad13 34890b1 28fcd0f 38c9adf 4b01132 7382b9e
# Or inspect without cherry-picking:
git show origin/arena/63badebc-signalint:eval-harness/results/audit-main-public-readiness-2026-10-09.md
```

If any cherry-pick conflicts, stop and use `git show` to read the evidence. Do not resolve this by merging the arena branch.

## 1. Deliver as three focused PRs

Create each branch from the latest `origin/main`; after a PR is merged, fetch `main` again before creating the next branch. Do not push directly to `main`.

### PR A — `docs: remove obsolete planning archive and align active guidance`

Suggested branch: `docs/public-source-hygiene`.

The maintainer has now explicitly authorized removing the unused `docs/history` archive, reversing the earlier instruction to leave it untouched.

1. Delete `docs/history/build-plan.md` and `docs/history/README.md` (remove the now-empty directory). **Do not rewrite or force-push Git history**; a normal deletion only removes the files from the current tree. No credentials were found in the current tree, and there is no reason to rewrite history.
2. Remove or rewrite active links/references to the removed archive in:
   - `README.md` documentation list;
   - `ARCHITECTURE.md` introductory paragraph and documentation list;
   - `CONTRIBUTING.md` historical-document paragraph;
   - `AGENTS.md` sentence referring to the historical build plan;
   - `docs/known-limitations.md` risk-register introduction, which cites the old build plan.
3. Align active guidance with the current implementation and workflow:
   - `AGENTS.md` currently says `better-sqlite3` is a current native dependency. The project now uses built-in `node:sqlite` (`DatabaseSync`); update this paragraph to match `package.json` and the current cache implementation.
   - `CONTRIBUTING.md` still promises Node 20 support and lists `Test (ubuntu-node-20.19)`. Current `package.json` requires Node `>=22.12.0`; `.github/workflows/ci.yml` currently has exactly three jobs: Windows, Ubuntu, and macOS on Node 22. Remove stale Node 20/job claims. Verify the minimum Node version needed by both the project and pnpm 11.9.0 before stating a contributor prerequisite; distinguish the package runtime minimum from the contributor-tooling minimum if they differ.
   - `RELEASE.md` uses hard-coded `v1.0.0` release/tag examples and `signalint-mcp@1.1.1` smoke-test examples. Replace these with clearly marked placeholders such as `vX.Y.Z` / `signalint-mcp@X.Y.Z`, so the instructions do not age on the next release.
   - Preserve the corrected engine-installation language in `README.md` from PR #62; do not restore any bundled-engine claim.
4. Search for remaining **live links** to `docs/history/` or `build-plan.md`. Remove broken navigation links. The dated `CHANGELOG.md` entry that records a historical edit to the plan is release history, not a live documentation link; do not rewrite historical release notes merely to erase that record.
5. Do not touch `server.json`, `action.yml`, package version, changelog release sections, tags, or the website URL as part of this PR.

**PR A verification:**

```bash
git grep -n -E 'docs/history/|build-plan\.md|historical build plan' -- ':!CHANGELOG.md' || true
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Confirm all active Markdown links resolve and inspect the diff to ensure PR #62's README fix remains intact. The changelog exception above is intentional.

### PR B — `fix(release): require an explicit manual-dispatch tag`

Suggested branch, created from the updated `origin/main` after PR A merges: `fix/release-dispatch-tag-input`.

1. In `.github/workflows/release.yml`, remove the stale `workflow_dispatch` default `v1.0.0`. Require an explicit tag/version input (or otherwise fail closed if omitted) and update its example text so it is not fixed to an obsolete release.
2. Keep tag-push releases working: on a tag push, continue resolving the release tag from `github.ref_name`; for manual dispatch, validate the supplied value and ensure it matches `package.json` before any publish step runs.
3. Do not change npm/MCP Registry publish behavior beyond what is required to make the manual input safe and non-stale. Do not dispatch the real workflow, publish, create/move tags, or create a GitHub Release as part of verification.

**PR B verification:** validate the YAML and the tag/version resolution logic for both event types without invoking a publish step; run the repository CI checks. Keep this PR to the release workflow and any narrowly necessary test/helper file.

### PR C — `docs: reconcile security and benchmark evidence`

Suggested branch, created from the latest `origin/main` after earlier merges: `docs/security-benchmark-evidence`.

1. **`SECURITY.md`:** reconcile the advisory note with the exact current lockfile. Current `package.json` pins `@modelcontextprotocol/sdk@1.32.0`; the current `pnpm-lock.yaml` resolves `@hono/node-server@2.1.3`. The existing note says it was evaluated with SDK 1.32.1 and says to remove the exception once Hono is `>=2.0.5`, a condition the current lockfile already satisfies. Re-run a supported audit against the lockfile (`pnpm audit` or equivalent), verify the advisory's affected/patched ranges and runtime path, then mark the note resolved/remove it or document the exact remaining exposure with correct versions. Do not claim safety from this static inspection alone. The sandbox's `npm audit` lockfile generation failed with `Cannot read properties of null (reading 'edgesOut')`; do not treat that failure as a clean audit.
2. **`docs/benchmarks.md` and `scripts/measure-mcp-payload-mode.mjs`:** the doc says the published token counts use `gpt-tokenizer` (`cl100k_base`), but the script imports it optionally and falls back to a `bytes / 3.8` estimate. `gpt-tokenizer` is not declared in `package.json` or `pnpm-lock.yaml`, so a clean checkout does not reproduce the documented tokenizer mode. Resolve this transparently:
   - either add a pinned, maintained, license-compatible **devDependency** and lockfile entry, then prove the script uses it after a clean frozen install; or
   - keep the current dependency set and clearly label token figures as estimates, make the script report which mode it used, and update the docs to match.
3. Review the claims that Claude Desktop, Claude Code, and Cursor were "real-client validated." Keep categorical claims only if the actual client versions, date, method, and evidence can be stated. Otherwise qualify them as manual observations or remove unsupported assertions; do not invent test evidence.
4. Keep benchmark bytes/results and security status aligned with what was actually measured. Do not add a runtime dependency for documentation tooling.

**PR C verification:** run the audit using the committed lockfile; run the benchmark from a clean `pnpm install --frozen-lockfile` + build and confirm the displayed tokenizer mode matches the docs; then run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.

## 2. Rules for all PRs

- Each PR must be based on current `origin/main`, have a focused diff and a clear summary of evidence.
- No direct push to `main`; open the PR from its own delivery branch and merge only through the normal green-CI path.
- No version bump, CHANGELOG entry for this hygiene work, Git tag, npm publish, MCP Registry publish, or GitHub Release.
- Do not edit website content or `signalint-site`; the maintainer is handling that separately.
- Keep the PR #62 README correction and the active 1.1.2 package metadata unchanged.
