# Verification: signalint-mcp 1.1.1 (2026-10-08, sandbox, Linux x64)

## Release state (independent checks)

| item | result |
|---|---|
| npm `signalint-mcp` version | 1.1.1 |
| npm `dist-tags.latest` | 1.1.1 |
| GitHub Release `v1.1.1` | created 2026-10-08T14:51:03Z, commit `c960553b` |
| Workflow `Release` @ c960553b | success |
| `v1` major tag | points at `c960553b` |
| `package.json` / `server.json` (+ `packages[0].version`) | 1.1.1 / 1.1.1 |
| `action.yml` `inputs.version` default | 1.1.1 |
| clean install size | 27 MB |
| README shipped on npm | 0 occurrences of `npx signalint-mcp doctor`; uses `npx --yes -p signalint-mcp signalint doctor` |
| MCP Registry | NOT verifiable from sandbox (host unreachable, HTTP 000) |

## The hang fix (PR #58) — verified

| invocation (stdin = open pipe, non-TTY) | before 1.1.1 | on 1.1.1 |
|---|---|---|
| `npx --yes signalint-mcp doctor` | hung forever (killed at 20 s), printed only `[signalint] project root:` | **exit 0 in <1 s**, full doctor report |
| `npx --yes -p signalint-mcp signalint doctor` | ok | ok |
| `npx --yes signalint-mcp init` | ok (special-cased) | ok |

## No regression on the MCP client path (PR #58 risk)

Server binary started with non-TTY stdio and no arguments — the path every MCP client uses:

- `tools/list` -> ping, check_project, check_files, get_issue_detail, get_loop_status
- `ping` -> "pong"
- `check_project` -> `schemaVersion: "1.4"`, valid envelope

Conclusion: MCP clients unaffected.

## Known issue left open

CI run 37795855177 on `main` @ `c960553b`: `Test (windows-latest)` failed (1m26s,
"Process completed with exit code 1"); macOS and Ubuntu passed. The SAME tree passed
on the PR branch (run 37794803967) and the `Release` workflow gate at the same commit
passed. Strongly suggests a flaky Windows test, not a 1.1.1 regression — needs a
re-run to confirm.
