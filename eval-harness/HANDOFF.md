# Signalint — next-session handoff

**Prepared:** 2026-10-09 (Asia/Saigon)  
**Purpose:** Carry project state, verified results, workflow constraints, and the pending merge clarification into the next Arena session. Read this file before using older harness notes.

## 1. Project and working style

- Repository: `TranQui004/signalint` — an MCP server for JavaScript/TypeScript diagnostics.
- User communicates in Vietnamese. Explain findings in Vietnamese; when handing code work to the user's own agent, provide one consolidated, copyable English Markdown prompt.
- The Arena session is for review, analysis, research, measurement, and preserving harness/evidence/context. Do not implement product-source changes locally as a substitute for the user's agent. The user's agent creates delivery branches from current `origin/main`, opens PRs, and merges them through CI.
- The user now handles `signalint-site` directly. Website code, publishing, and configuration are out of scope unless they explicitly ask again.
- No npm publish, version tag, or direct push to `main` for this handoff.

## 2. Current upstream state — source of truth

- `origin/main`: **`1785a0d`** — merge of PR #65, `docs: reconcile security and benchmark evidence`.
- Package version and npm `latest`: **1.1.2**. Latest GitHub Release: **`v1.1.2`**. No follow-up version or release was published for the docs/workflow cleanup.
- No open PRs were listed after #65 merged.
- PRs #62–#65 all merged into `main`; their CI checks passed on Windows, Ubuntu, and macOS:
  - #62 — `3eca84b` — correct README: Signalint ships no diagnostic engines since 1.1.0; projects install their own.
  - #63 — `5ee6b49` — removed `docs/history/`, fixed stale contributor/release docs and risk-register references.
  - #64 — `5450945` — removed stale manual release-dispatch default and added explicit tag/version validation.
  - #65 — `1785a0d` — reconciled the security advisory and benchmark/tokenizer/client claims.
- Current verification: CI green for all three OS jobs; the agent reported local `pnpm lint`, `pnpm typecheck`, `pnpm test` (30 files / 203 tests), and `pnpm build` all passed. I independently ran `pnpm audit --prod` on a clean archive of current `main` using `npx --yes pnpm@11.9.0`; result: **No known vulnerabilities found**.
- No republish is needed. The npm page still stores the old 1.1.2 README with the bundled-engine claim. npm's README page only updates when a new version is published; let the next planned release carry the updated README rather than publishing solely for docs. GitHub `main` is correct.
- PR #63 deleted the planning archive from the current tree but did not rewrite Git history; old commits still contain it. No actual credential was found in the current-tree scan.

## 3. Verified evidence and harness files

Use these current evidence files on the Arena branch:

- `eval-harness/results/verify-1.1.2.md` — release 1.1.2 verification; 3/3 concurrent checks returned full responses and **0** `database is locked` errors.
- `eval-harness/results/verify-pr60.md` — SQLite lock-contention comparison before/after PR #60.
- `eval-harness/results/audit-main-public-readiness-2026-10-09.md` — public-source hygiene review of `main` before PRs #63–#65.
- `eval-harness/prompts/readme-engine-accuracy.md` and `eval-harness/prompts/public-source-hygiene.md` — historical handoff prompts; their tasks have since been completed and merged.
- `eval-harness/README.md` — older round 1–4 harness notes. It contains historical assumptions/results and is not the current release report; use the release-specific files above. Check whether its setup guidance is still suitable before re-running old scripts.

Measurement traps worth retaining:

- Signalint JSON is pretty-printed with spaces after colons; parse it with `JSON.parse`, not whitespace-sensitive grep.
- Diagnostic engines must be installed inside the project under test; otherwise `check` can return `nothing_checked`.
- This sandbox did not have a global `pnpm` executable; `npx --yes pnpm@11.9.0 ...` worked under Node 22.22.3.

## 4. Branch divergence and merge warning — **do not skip**

The user has just asked to prepare handoff docs and then “merge the current branch.” Earlier, the user explicitly required that `arena/63badebc-signalint` never be merged or used as a PR head. The target/scope of the new merge instruction still needs clarification.

The whole Arena branch is **not a safe merge candidate**:

- Common base: **`e9ebfe5c4fd0`**.
- Before this handoff-doc commit, remote `main` was 118 commits and Arena was 121 commits; `main...arena` had **17 main-only / 20 arena-only** commits.
- Arena contains 11 old, unsquashed pre-1.0.0 hardening commits that duplicate work shipped on `main` under different hashes, plus research/harness commits.
- A direct tree comparison already showed **96 changed paths, 3,954 insertions and 3,175 deletions** from `main` to Arena. It would restore the deleted `docs/history` archive, delete current `docs/benchmarks.md` and the PR #64 release validator/tests, and revert many current source/docs/package files. The handoff-doc commit adds more Arena-only files.

Therefore: **do not merge the entire Arena branch into `main`**. No merge has been performed. Ask the user whether they mean (a) leave Arena unmerged and use it only as the next-session handoff, or (b) selectively deliver specific handoff artifacts using a new branch based on current `main`. Do not create that delivery branch yourself unless the user separately authorizes it; this user's standing workflow assigns delivery to their agent.

## 5. Local checkout caution

At handoff preparation, the local working directory was on `arena/63badebc-signalint` at **`e9ebfe5`**, not at the remote Arena tip, with many modified/deleted/untracked source files. The remote refs were newer (`main` `1785a0d`, Arena `aed07de` before this handoff update). This appears to be a stale analysis checkout/overlay, not the current upstream source tree.

- Do not run `git reset --hard`, `git clean`, or a broad checkout in that local tree; it could destroy uncommitted analysis files.
- For current product truth, fetch and inspect `origin/main` or create a clean temporary archive/clone.
- Confirm `git status`, `git rev-parse HEAD`, and `git ls-remote origin refs/heads/main refs/heads/arena/63badebc-signalint` before taking any branch action.

## 6. Next-session checklist

1. Read this file first, then verify current remote tips; do not assume they remain unchanged.
2. Keep `main` as the product source of truth. Do not repeat verification of PRs #62–#65 or releases 1.1.0–1.1.2 unless new evidence warrants it.
3. Ask for clarification about the requested merge before any merge operation; the full Arena branch would regress `main`.
4. Continue the user's intended workflow: investigate the latest Signalint changes, measure/test claims in the sandbox, and hand off a single evidence-backed English prompt when implementation is needed.
5. Keep website work out of scope; the user is handling it.
