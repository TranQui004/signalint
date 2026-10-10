# Changelog

All notable changes to this project are documented in this file. Entries are
grouped by release and summarize the actual commit history; see `git log` for
full detail.

> **Versioning note:** releases published before `0.4.0` have been retired and are
> no longer listed here. `1.0.0` is the first stable release. Compared with the
> `0.4.x` line it requires Node.js >= 22.12 (built-in `node:sqlite`), bumps the
> response `schemaVersion` from `1.2` to `1.3`, and adds ESLint as a fourth
> diagnostic engine.

## [1.2.0] - 2026-10-10

- **Features:** 13 strictly typed MCP tools, Immutable SnapshotStore (`checkId`), verification delta computation (`compare_diagnostics`, `after_edit_check`), portable verify-after-change hook adapters (Claude Code, Cursor, Codex, VS Code), monorepo workspace planning (`pnpm-workspace.yaml`), incremental TypeScript `.tsbuildinfo` isolation, live LSP diagnostics ingestion (`ingest_diagnostics`, `get_live_diagnostics`), transactional fix previews with atomic rollback (`preview_diagnostic_fix`, `apply_diagnostic_fix`), and external language adapters (Ruff, Mypy, Clippy, GolangCI-Lint).
- **Fixes & Hardening:** JSON-RPC protocol error codes (`-32602`), strict schema validation (`additionalProperties: false`), cross-platform path canonicalization, and parallel SQLite state isolation.

## 1.1.2 - 2026-10-08

### SQLite concurrency and Windows test stability
- **Concurrent access no longer fails.** The SQLite cache now sets `PRAGMA busy_timeout = 5000`, so a second Signalint process touching the same project waits for the lock instead of dying instantly with `database is locked`. Practical effect: an MCP server and a one-off `signalint check .` (or two agents) can now run against the same project at the same time. Measured before/after with a process holding an exclusive lock on `.signalint/cache.sqlite`: previously exit 1 in 59 ms with no output; now waits for the lock (2.8 s in that test) and returns a complete response.
- **Windows CI stability.** Test fixtures that shared one cache database now use ephemeral per-test copies; directory cleanup retries on NTFS `EBUSY`; `testTimeout` raised to 20 s for subprocess integration tests. This removes the `database is locked` flake that intermittently failed `Test (windows-latest)`.
- **CI can be re-run on demand.** `workflow_dispatch:` added to `ci.yml`.

## 1.1.1 - 2026-10-08

### CLI entrypoint dispatch and interactive terminal safety
- Recognised CLI verbs (`init`, `check`, `doctor`, `stats`, `help`, `--help`, `-h`, `--version`, `-v`) directly from the `signalint-mcp` entry point (`dist/src/index.js`), dispatching them to the CLI runner instead of starting the MCP stdio server.
- Fixed indefinite hang when invoking `npx signalint-mcp <command>` from an interactive terminal with stdin held open.
- Emitted actionable guidance to stderr and exited with code 2 when `signalint-mcp` is invoked bare on an interactive TTY console.
- Preserved existing stdio MCP server startup behavior when invoked by MCP clients with non-TTY stdin pipes.
- Corrected documentation in `README.md` and `RELEASE.md` that taught `npx signalint-mcp doctor` to use `npx --yes -p signalint-mcp signalint doctor`.

## 1.1.0 - 2026-10-08

### Response schema and payload efficiency
- Bumped `schemaVersion` to `"1.4"` while maintaining backward compatibility with `"1.3"`.
- Added `remainingIssues`, `omittedIssueCount`, and `nextStep` to `CheckResponse`.
- Eliminated information loss from the 10-cluster cap: groups of 2+ issues remain clustered, while single-issue groups and overflow clusters are routed to flat `remainingIssues` (bounded to 100 entries with `omittedIssueCount` and actionable `nextStep` guidance).
- Emitted 12-character issue IDs in `remainingIssues[].issueId` and `clusters[].sampleIssueIds` with automatic prefix extension on internal hash collisions; full 64-character hashes remain fully resolvable via `get_issue_detail`.
- Minified MCP tool payload text (`content[0].text`), stripping indentation and newlines across all tools.
- Trimmed envelope overhead by omitting empty engine statuses, omitting `sampleIssueIds` on small clusters (<=2 issues), and omitting `suggestedAction` when unfixable.
- Omitted `loopWarning` and `fileRuleChurnWarning` fields when inactive instead of emitting `null`, saving 47 bytes on standard checks.
- Added opt-in compact mode (`signalint check --compact` and `SIGNALINT_COMPACT=1`) with abbreviated keys.

### Scoped file checking
- `check_files` now filters returned diagnostics down to requested files only, surfacing issues in unrequested files via `filteredOutIssueCount` / `filteredOutCount` with a `nextStep` directing agents to `check_project`.
- Robust whole-program `tsc` cache invalidation: fingerprinted project TypeScript sources so `check_files` cache reliably invalidates when unrequested dependencies change.

### Configurable MCP payload mode
- Added configurable MCP payload modes (`SIGNALINT_MCP_PAYLOAD=both|text|structured` and `signalint.config.json` -> `mcpPayload`):
  - `"both"` (default): emits both minified JSON in `content[0].text` and structured JSON in `structuredContent` for universal client compatibility.
  - `"text"`: emits only `content[0].text`, completely suppressing `structuredContent` and schema advertisement for a ~46% wire reduction.
  - `"structured"`: emits full data in `structuredContent` and replaces `content[0].text` with a single-line summary.
- Active payload mode is reported in `signalint doctor`.

### Package footprint and dependencies
- Reclassified `typescript` and `oxlint` as optional `peerDependencies` only (removed from `optionalDependencies`), cutting default install footprint from 74 MB to ~27 MB.
- Gracefully degrades `tsc` and `oxlint` with structured disabled statuses when unresolvable, with missing-linter guidance in `signalint doctor` and `signalint init`.
- Updated GitHub Action (`action.yml`) default version input to `"1.1.0"`.

### CLI, metrics, and documentation
- Added `signalint stats --json` for machine-readable session metrics.
- Added `--compact` flag to `signalint check`.
- Added `docs/benchmarks.md` with single-run like-for-like measurements across all payload modes.
- Added client compatibility guidance and real-world MCP client validation notes (Claude Desktop, Claude Code, Cursor) in `docs/benchmarks.md` and `docs/known-limitations.md`.
- Added "When not to use Signalint" guidance in `README.md`.

## 1.0.0 - 2026-10-06


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
- Removed dead top-level `TimeoutResponse` and `isTimeoutResponse` paths; per-engine timeout errors are reported as structured `status: "error"` in `engines.<name>`.
- Dropped Node 20 support and updated node engine requirement to `>=22.12.0`.
- Migrated cache backend from native `better-sqlite3` to built-in `node:sqlite` (`DatabaseSync`), eliminating native C++ build scripts and external dependencies while preserving cache LRU semantics and public API.
- Moved `@biomejs/biome` to optional peer dependencies (`peerDependenciesMeta.optional = true`); reports `engines.biome = { status: "disabled" }` with an actionable install message when Biome is not present in the project.
- Deduplicated `compareIssues`, `isRecord`, `normalizeFile`, and `readString` into `src/util/index.ts`.
- Sanitized cached issue messages with `normalizeIssueMessage` before validation with `isNormalizedIssue`.
- Bounded file-read fanout in `checkFilesWithStats` to 32 concurrent reads.
- Bumped dependencies: `oxlint` to 1.87.0, `@biomejs/biome` to 2.5.15, `@modelcontextprotocol/sdk` to 1.32.1, `zod` to 4.6.5.
- Modularized server architecture: split `src/index.ts` into dedicated `src/server/` components (`toolSchemas.ts`, `tools.ts`, `errors.ts`, `context.ts`, `createServer.ts`, and tool handlers), leaving `src/index.ts` as a thin entrypoint.
- Consolidated engine configurations into a unified registry `src/engines/registry.ts` and moved engine adapters to `src/engines/` (`oxlint.ts`, `tsc.ts`, `biome.ts`, `eslint.ts`), ensuring adding a new engine touches exactly two files.
- Relocated session log and statistics modules to `src/memory/` and check logic to `src/check/`.
- Removed redundant second pass of `filterDefaultExcludedIssues` inside `runCheck`, preserving exclusion enforcement at the provider boundary.
- Removed dev `signalint.config.json` from `package.json` publication `files`.
- Removed `src/index.ts` exclusion from Vitest coverage configuration while maintaining full coverage thresholds.
- Added `docs/known-limitations.md` documenting active limitations and recording closure of all Phase 0–5 risks with verification evidence.

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
