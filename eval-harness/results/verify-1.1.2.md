# Verification: signalint-mcp 1.1.2 (2026-10-08, sandbox, Linux x64)

## Release state
| item | result |
|---|---|
| npm version / dist-tags | 1.1.2 / latest 1.1.2 |
| GitHub Release v1.1.2 | created 2026-10-08T17:15:23Z, commit `0151f35c` |
| Release notes | "Changes since v1.1.1", only the #60 fix, no `chore(release)` entry |
| `v1` floating tag | `0151f35c` |
| package.json / server.json (+ packages[0]) | 1.1.2 / 1.1.2 |
| action.yml `inputs.version` default | 1.1.2 |
| docs/benchmarks.md header | 1.1.2 |
| clean install size | 27 MB |
| CI | Release v1.1.2 success; CI main `0151f35c` success; CI main `a0ce50db` success |
| open PRs | none |
| MCP Registry | not reachable from this sandbox (HTTP 000); verified by the release agent |

## Functional checks on the published package
- PR #58 regression: `npx --yes signalint-mcp@1.1.2 doctor` with stdin held open ->
  exit 0 in <1 s, "MCP payload mode: both". (Pre-fix behaviour: hung forever.)
- Concurrency (PR #60 regression): three simultaneous `signalint check .` in one project
  with real engines (oxlint: ok, tsc: ok, 11 issues):
  - `database is locked`: **0** occurrences
  - 3/3 processes returned a complete response: `schemaVersion: "1.4"`,
    `totalIssues: 11`, 3 clusters + 3 remaining, `issueId` length 12

## Doc bug found while testing (not fixed yet)
`README.md` line ~182 still says Signalint "falls back to its bundled copy (for `oxlint`,
`tsc`, `biome`)" when a project lacks an engine. Since 1.1.0 there is no bundled copy:
engines are optional peer dependencies and the CLI reports `status: "disabled"` with an
install hint. Confirmed empirically — installing signalint-mcp alone leaves both engines
disabled. This line must be corrected before the website copies the text.
