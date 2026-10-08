# Verification: PR #60 — Windows test flakiness / SQLite lock contention (2026-10-08)

## PR state
- #60 `fix/windows-test-flakiness` -> `main`, 1 commit `17e1da55`, 9 files, +83/-14
- MERGEABLE / CLEAN; CI green: ubuntu 27 s, macos 34 s, windows 1m14 s
- Files: ci.yml, src/cache/sqliteCache.ts, vitest.config.ts, 6 test files

## Source changes confirmed by reading the branch
- `src/cache/sqliteCache.ts`: `PRAGMA busy_timeout = 5000;` on connection creation
- `vitest.config.ts`: `testTimeout: 20_000`
- `.github/workflows/ci.yml`: added `workflow_dispatch:`

## Decisive behavioural test (this is a product fix, not just a test fix)

Setup: fixture `mixed-app`; a holder process takes `BEGIN EXCLUSIVE` on
`.signalint/cache.sqlite` and releases it after 3 s; the CLI runs 300 ms into the hold.

| build | exit | elapsed | "database is locked" | valid CheckResponse returned |
|---|---:|---:|---|---|
| published 1.1.1 (no busy_timeout) | 1 | 59 ms | yes | no |
| PR #60 (busy_timeout = 5000) | 1 | 2,840 ms | no | yes |

Before the fix a concurrent holder makes the CLI die instantly with no output; after the
fix it waits for the lock and returns a complete response. Real-world impact: an MCP
server and a one-off `signalint check` (or two agents) touching the same project used to
break each other.

## Suite (Linux, this sandbox)
- 29 test files / 195 tests pass
- Coverage: statements 84.26, branches 75.56, functions 90.19, lines 84.34 (thresholds 79/70/83/79)

## Notes
- The Windows flake itself: confirmed flaky by the maintainer's re-run of CI run
  37795855177 (passed on retry). Root cause = two vitest workers using the same fixture
  cache DB; parallel-execution dependent, so it cannot be reproduced on Linux directly —
  the lock-contention mechanism above is the underlying cause and is reproduced here.
