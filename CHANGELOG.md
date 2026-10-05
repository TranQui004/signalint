# Changelog

All notable changes to this project are documented in this file. Entries are
grouped by release and summarize the actual commit history; see `git log` for
full detail.

## Unreleased

- Bumped `schemaVersion` from `"1.2"` to `"1.3"`.
- Added required `projectRoot` (canonical absolute path) to `CheckResponse` and `ping` tool response (`pingOutputSchema`).
- Added optional `code` and `message` fields to `CheckResponse`.
- In `clusterIssues`, top-level `status` now reflects engine outcomes:
  - Enabled engine failure maps to `status: "error"`, `code: "engine_failed"` with the failing engines named.
  - No enabled engine running or zero paths checked maps to `status: "error"`, `code: "nothing_checked"`.
  - `status: "clean"` is only returned when at least one enabled engine reported `ok` and `totalIssues === 0`.
- `createIdleEngineStatuses` now reports `{ status: "disabled", message: "no paths to check" }` for enabled engines when no paths were checked.
- On server creation, write exactly once to stderr: `[signalint] project root: <root>`.
- Require `signalint.config.json` before running `check_project` or `check_files` (returns `code: "project_not_initialized"`, with `SIGNALINT_ALLOW_UNINITIALIZED=1` escape hatch).
- Sanity check JS/TS project markers (reject non-JS projects with `code: "not_a_js_project"`).
- Rewrote `scorePriority()` with a reliable 1–5 priority ladder based on severity, systemic scope across files, file count, and issue count, with `fixable` as a tie-breaker.
- Hardened Biome adapter: tolerantly maps severities (`info` -> warning, `fatal` -> error, unknown string -> error with preserved name) without throwing; suppresses formatter noise by default and drops `category === "format"` diagnostics; detects safe fixes in `advices` matching `/safe fix/i` to set `fixable: true`; accepts `engines.biome` as `boolean | { includeFormatter: boolean }`.
- Replaced positional cluster IDs (`c1`, `c2`) with stable content-derived IDs (`c` + SHA-1 prefix of `sorted(ruleIds)|severity|systemic`).
- Keyed cluster assignment by `issueId` rather than object identity.
- Added additive `checkId` to `CheckResponse` and `checkOutputSchema`; `get_issue_detail` now supports freshness validation via optional `checkId` parameter, returning `status: "stale"` on mismatch.
- Added `pnpm bench` (`scripts/bench.mjs`) measuring payload reduction against real multi-engine output.
- Ensured concurrent tool call safety by serializing `SessionMemory.recordCheck` through an internal promise queue and eliminating the file read-to-write await gap in session logging.
- Added `McpClientSpec` client registry in `src/clients/registry.ts` defining specs for Claude Code, Cursor, Codex CLI, Antigravity, VS Code, Windsurf, and Zed across project and user scopes.
- Client candidate detection now prioritizes project-scoped configurations over user/global configurations.
- Enforced safe `cwd` emission: `init` omits `cwd` when configuring user/global paths and emits a prominent warning with project-scoped configuration snippet alternatives.
- Corrected Antigravity configuration paths: project-scoped `<root>/.agents/mcp_config.json` and user-scoped `~/.gemini/config/mcp_config.json`. Added migration check for legacy `~/.gemini/antigravity/mcp_config.json`.
- Added Codex CLI TOML block emitter (`[mcp_servers.signalint]`) with `startup_timeout_sec = 20` and conditional `cwd`.
- Rewrote MCP client documentation in `README.md`, added Supported Clients table, and added "Multiple projects" section explaining the global config trap.
- Added flat-config ESLint adapter (`src/adapters/eslint.ts`) resolving project-local `eslint` without runtime dependencies and surfacing true fixable diagnostics (`fixable: true`).
- Registered `eslint` across engine selections, CLI flags, cache configs, and MCP schemas.
- Implemented engine resolution (`src/engineResolution.ts`): resolves binaries and package versions from target project `node_modules` first, falling back to bundled copies, and incorporates resolved versions into cache keys.
- Enabled SQLite caching for `check_project`, reusing whole-program tsc results when config hash is unchanged and per-file entries for local linters, reporting real hit/miss stats.
- Added `.signalint/` entry appending to `.gitignore` during `signalint init`, and added detection of flat ESLint and Prettier configurations.
- Reduced default `tsc` timeout from 120,000ms to 60,000ms.

## 0.4.2

- Widened tsc config hash to follow `extends` and `references` chains
  recursively. Previously only `tsconfig.json` at the project root was
  hashed; changes to `tsconfig.base.json` or any referenced project
  tsconfig would not invalidate the whole-program cache. Now all reachable
  config files (bounded to 50 unique paths) are discovered, sorted, and
  hashed together so a branch switch or base config edit forces a fresh
  tsc run. No change to the cache key shape or `engine_state` table schema.
- Added a process-lifetime cache for `tsc --showConfig` inspection results,
  keyed by SHA-256 of the root tsconfig file content. Eliminates the
  redundant `--showConfig` spawn that preceded every `tsc --noEmit` check
  when the config had not changed.

## 0.4.1

- Added MCP tool annotations (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint`) to all five tools via a shared
  `TOOL_ANNOTATIONS` constant. Values: `true`, `false`, `true`, `false`.
  All four hints are set explicitly as booleans so that directory
  validation tools and distribution channels (e.g. OpenAI MCP directory)
  that require every hint to be present and boolean do not reject the tools.
  No behavioral change; no `schemaVersion` change — annotations are
  transport-level `tools/list` metadata, not response shape fields.

## 0.4.0

- Added file-rule churn detection as a second, independent loop warning kind.
  When the same `(file, rule)` pair appears in 3+ separate `check_files` calls
  in a session — even if the exact message or line varies — a distinct
  `fileRuleChurnWarning` is surfaced: `"src/auth.ts has re-triggered TS2345
  across 3 separate checks — the agent may be stuck on this file, not just
  this exact issue"`.
- Added `fileChurning: boolean` and `fileRuleChurns: FileRuleChurnWarning[]` to
  `LoopStatus`. These fields are independent of `looping` and `signatures`
  (exact-signature oscillation), which are unchanged. A pre-existing client
  reading only `looping + signatures` is unaffected.
- Added `fileRuleChurnWarning: FileRuleChurnWarning | null` to `CheckResponse`.
- Bumped `schemaVersion` from `"1.1"` to `"1.2"` to signal the new mandatory
  response field.
- Churn counters reset to 0 when a `(file, rule)` pair is absent from a
  `check_files` result; warnings clear immediately on the next clean check.
- `check_project` calls do not increment or reset churn counters.
- Churn state is persisted to `.signalint/session.jsonl` via a new
  `activeFileRulePairs` field and replayed on startup.
- Updated `outputSchema` declarations for `check_files`, `check_project`, and
  `get_loop_status` to include the new fields.
- Updated `docs/history/build-plan.md` Section 11.1 with counter lifecycle
  table, `fileChurning` separation rationale, and schemaVersion 1.2 justification.

## 0.3.7

- Added explicit `outputSchema` declarations across all five MCP tools (`ping`,
  `check_project`, `check_files`, `get_issue_detail`, `get_loop_status`).
- Added `structuredContent` delivery in `CallToolResult` alongside existing text
  content blocks per MCP SDK 1.30.0 specification.
- Updated `docs/history/build-plan.md` Section 7.4 and Section 8 to record the
  output schema and delivery additions.

## 0.3.6

- Updated `@modelcontextprotocol/sdk` to 1.30.0.
- Updated `oxlint` to 1.78.0 and hardened adapter against non-JSON output prefixes.
- Updated `@biomejs/biome` to 2.5.8.
- Retained `better-sqlite3` at 12.6.2 for verified Node 20.19 compatibility.

## 0.3.5

- Added before/after diagnostic compression example to `README.md` using the
  40-issue acceptance fixture data (86.5% payload reduction).
- Reordered `README.md` top section so the intro paragraph precedes the
  "Listed on" registry block.
- Expanded `package.json`'s `keywords` array to include discovery terms
  (`ai`, `claude`, `cursor`, `codex`, `ai-agent`, `coding-agent`,
  `model-context-protocol`, `linter`, `type-checking`, `diagnostics`,
  `developer-tools`).

## 0.3.4

- Rewrote all 5 MCP tool descriptions in `src/index.ts` for behavioral
  transparency: disclosed read-only guarantees, argument error behavior, stale
  reference responses, and incremental content-hash caching semantics.
- Added `glama.json` maintainer configuration.

## 0.3.3

- Shortened `server.json`'s `description` to satisfy the registry's 100
  character limit (0.3.2's MCP Registry publish step failed validation;
  npm publish of 0.3.2 still succeeded).

## 0.3.2

- Added `server.json` and published Signalint to the official MCP Registry
  (registry.modelcontextprotocol.io), authenticated via GitHub OIDC in CI
  (no stored secret).

## 0.3.1

- Add branding (icon, color) to action.yml for GitHub Marketplace listing.

## 0.3.0

- Added `--format github` to `signalint check`: prints one GitHub Actions
  workflow-command annotation per issue (`::error`/`::warning
  file=...,line=...,col=...::message`) instead of JSON, so issues surface
  inline on a pull request diff.
- Added `--fail-on-priority <N>` to `signalint check`: exits non-zero only
  when a cluster's priority is at or below `N`, reusing the existing
  priority ladder from `src/cluster/clusterEngine.ts`. Omitting the flag
  keeps the previous default of failing on any issue found.
- Added `action.yml`: a composite GitHub Action that installs Node and
  `signalint-mcp`, then runs `signalint check . --format github
  --fail-on-priority <input>`, so Signalint can run in CI/PR workflows
  without an MCP client.

## 0.2.0

- Added `signalint-mcp init`: detects TypeScript, Oxlint, and Biome
  configuration in the target project, writes `signalint.config.json`, and
  offers to update a nearby Claude Code, Cursor, or Antigravity MCP
  configuration.
- Split current architecture documentation (`ARCHITECTURE.md`) from the
  historical build plan, moving the original planning record to
  `docs/history/` for provenance without treating it as current behavior.
- Linked the live Signalint documentation website from `README.md`.
- Corrected `README.md`'s description of cache and timeout behavior to match
  the implemented `timeoutsMs` config and cache-key versioning.

## 0.1.0

Initial public release.

- MCP server exposing `ping`, `check_project`, `check_files`,
  `get_issue_detail`, and `get_loop_status`.
- Engine adapters for Oxlint and TypeScript (`tsc`), with optional Biome
  support; each engine's diagnostics are normalized to a shared issue schema.
- Per-engine incremental caching: file-local engines (Oxlint, Biome) are
  re-run only on cache misses; the whole-program `tsc` engine is skipped
  entirely when nothing relevant to the TypeScript program changed. The cache
  key includes file content hash, engine config hash, the installed Signalint
  version, and the resolved engine version, so upgrading either invalidates
  stale entries.
- Clustering and prioritization of diagnostics by rule to reduce payload size
  and surface the most urgent issues first.
- Session-scoped loop detection: tracks recurring issue signatures across
  checks and flags a `loopWarning` when the same diagnostic disappears and
  reappears within a session. History is restored from
  `.signalint/session.jsonl` on restart, skipping malformed or
  crash-truncated lines.
- `signalint check` and `signalint stats` CLI commands for use without an MCP
  client, including the Phase 6 measurement summary (payload reduction, cache
  hit rate, latency, loop-warning counts).
- Response schema versioned `1.1`: engine fan-out settles independently per
  engine (`ok | error | disabled`) so one failing engine no longer discards
  diagnostics already produced by another, and each engine subprocess has a
  configurable timeout that terminates the process tree on expiry.
- Security hardening: strict Zod validation of all MCP tool arguments, path
  containment checks resolved against the canonical project root (including
  symlink/junction resolution), and unconditional filtering of
  `node_modules` diagnostics.
- Cross-platform CI matrix (Windows, Linux, macOS) plus a Node 20.19
  compatibility job, and fixes for Windows `npm link` shim and process-tree
  termination issues found during that work.
- Documented the v1 monorepo/multi-`tsconfig` limitation (a single root
  `tsconfig.json` using TypeScript Project References is required; per-package
  config auto-discovery is out of scope for v1).
