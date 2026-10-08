# Known Limitations & Risk Register

This document tracks current architectural limitations, verified operational boundaries, and the historical risk register for Signalint.

---

## Active Limitations (v1 Scope)

### Monorepo and Multi-Project TypeScript

Signalint assumes a single `tsconfig.json` at the project root for TypeScript whole-program checking (`tsc`). It does not automatically discover and iterate per-package `tsconfig` files in monorepos.

- **Workaround:** Add a root `tsconfig.json` using TypeScript [Project References](https://www.typescriptlang.org/docs/handbook/project-references.html) pointing to package sub-projects.
- **Status:** Documented v1 non-goal. Auto-detection of multi-tsconfig workspaces is slated for v2.

### Read-Only Diagnostic Engine

Signalint exposes strictly read-only tools (`readOnlyHint: true`). It detects and reports fixable diagnostics (e.g., Biome safe fixes or ESLint fix suggestions) but does not modify files on disk. The consuming agent or developer must apply edits.

### Language Scope

Signalint supports JavaScript and TypeScript ecosystems only (ESLint, Oxlint, TypeScript `tsc`, Biome). Scanning Python, Rust, Go, or other languages is out of scope for v1.

### Engine Configuration Discovery

Incremental cache invalidation monitors known root and top-level configuration files defined in `ENGINE_REGISTRY` (e.g. `tsconfig.json`, `.oxlintrc.json`, `biome.json`, `eslint.config.js`). Deeply nested config files or dynamic `extends` chains outside the project root are not parsed dynamically for cache key hashing.

### Whole-Program TypeScript Invalidation in `check_files`

When running `check_files` on a subset of files, whole-program `tsc` results are cached. If an unpassed dependency file changes, Signalint invalidates the whole-program cache by fingerprinting all project TypeScript files (hashing relative paths, file sizes, and modification timestamps).

- **Limitation:** External package type declarations in `node_modules` (unless tsconfig or lockfile changes trigger an engine config hash mismatch) are not tracked by the file-mtime scan to avoid expensive node_modules traversal. Running `check_project` will perform a clean check across the workspace.

### Scope Filtering and Cluster Cap Interaction in `check_files`

When running `check_files` on specific files, whole-program `tsc` executes over the entire project to guarantee cross-file type correctness. However, diagnostics are filtered down to the requested files *before* clustering is applied:

- `totalIssues` strictly counts issues belonging to the requested files.
- Clustering and the 10-cluster cap operate solely on issues within the requested scope.
- Issues discovered in unrequested files are excluded from clustering and surfaced via `filteredOutIssueCount` (and compact `filteredOut`), with `nextStep` pointing the agent to `check_project`.

### MCP Payload Modes and Client Compatibility

Signalint defaults to `mcpPayload: "both"` (carrying both minified JSON in `content[0].text` and the parsed object in `structuredContent`).

- **Wire duplication:** In `"both"` mode, transmitting the response in two parallel MCP channels incurs a 2.1×–2.6× wire framing multiplier over stdio.
- **Client behavior:**
  - Common clients such as Claude Desktop, Claude Code, and Cursor have been manually observed to forward `content[0].text` into the agent's context window.
  - Setting `SIGNALINT_MCP_PAYLOAD=text` (or `"mcpPayload": "text"` in `signalint.config.json`) suppresses the duplicate `structuredContent` channel and omits `outputSchema`, achieving \~46–50% wire reduction without information loss for text-rendering clients.
  - Setting `SIGNALINT_MCP_PAYLOAD=structured` replaces `content[0].text` with a short one-line human summary; clients that only consume `content[0].text` will lose access to individual issue diagnostics.
- **Guidance:** `"both"` remains the default for zero-breaking-change compatibility. See [docs/benchmarks.md](benchmarks.md) for full wire measurements and configuration details.

---

## Risk Register & Resolution Log

The following table tracks architectural and implementation risks identified during early development and their current status across Phases 0–5.

| Risk ID / Topic | Original Risk | Status | Resolution Date & Evidence |
| --- | --- | --- | --- |
| **STATUS-ENGINE-OUTCOME** | Check status reported `passed` even when engine execution encountered errors. | **Closed** | **2026-10-06 (Phase 0):** `runCheck` and clustering logic evaluate engine execution outcomes; if any engine throws an error or fails, check status correctly reports `failed`. Covered by `test/check-project.test.ts`. |
| **CONTAINMENT-ROOT** | Path traversal beyond project root could occur with unnormalized arguments. | **Closed** | **2026-10-06 (Phase 0):** Enforced containment checks in `src/projectPaths.ts` ensuring all target paths resolve strictly within `projectRoot`. Covered by `test/security.test.ts`. |
| **CLIENT-REGISTRY-DOCTOR** | Manual client configuration was error-prone across different agent tools. | **Closed** | **2026-10-06 (Phase 1):** Built `src/clients/` registry supporting Claude Code, Cursor, Codex CLI (TOML emitter), and Windsurf, plus `signalint doctor` CLI environment check. Covered by `test/clients.test.ts` and `test/cli.test.ts`. |
| **PRIORITY-LADDER-SCORE** | Hardcoded or missing priority ladder caused syntax errors to be buried under formatting or style warnings. | **Closed** | **2026-10-06 (Phase 2):** Implemented deterministic priority ladder `[code, type, syntax, import, perf, other, style]`, error vs warning weighting, and file/line distance sorting in `src/cluster/clusterEngine.ts`. Covered by `test/cluster.test.ts`. |
| **BIOME-FIXABILITY** | Biome reported `fixable: false` across all diagnostics. | **Closed** | **2026-10-06 (Phase 2):** Biome adapter inspects diagnostic `advices` matching `/safe fix/i` to surface `fixable: true`. Covered by `test/adapters.test.ts`. |
| **SESSION-CONCURRENCY** | Concurrent check runs or overlapping agent sessions could corrupt `.signalint/` session log. | **Closed** | **2026-10-06 (Phase 2):** Concurrency-safe file access and atomic write handling added to `SessionMemory`. Covered by `test/memory.test.ts`. |
| **ESLINT-FLAT-CONFIG** | Lack of ESLint support forced users to choose between Signalint and custom project rules. | **Closed** | **2026-10-06 (Phase 3, historical resolution):** Added flat-config ESLint engine adapter (`eslint.config.*`) and project-local engine binary resolution before bundled fallbacks (note: since 1.1.0, Signalint stopped shipping engines, while the legacy resolver function still exists and is not reliable for users). Covered by `test/eslint.test.ts` and `test/engine-resolution.test.ts`. |
| **NATIVE-SQLITE-ABI** | `better-sqlite3` required native compilation and broke across differing Node ABIs and architectures. | **Closed** | **2026-10-06 (Phase 4):** Replaced `better-sqlite3` with standard `node:sqlite` (`DatabaseSync`), requiring Node &gt;= 22.12.0 and eliminating native addons entirely. Covered by `test/cache.test.ts`. |
| **DEAD-TIMEOUT-CODE** | Unused `TimeoutResponse` path duplicated error states and caused schema ambiguity. | **Closed** | **2026-10-06 (Phase 4):** Deleted `TimeoutResponse` type and unified all engine timeout failures under `engines.<name>` with `status: error`. Covered by `test/mcp-responses.test.ts`. |
| **BIOME-HARD-DEP** | `@biomejs/biome` added substantial install weight even for projects not using Biome. | **Closed** | **2026-10-06 (Phase 4):** Reclassified `@biomejs/biome` as optional peer dependency (`peerDependenciesMeta.optional = true`). |
| **UTILITY-DUPLICATION** | Duplicate helper functions (`compareIssues`, `isRecord`, `normalizeFile`, `readString`) drifted across modules. | **Closed** | **2026-10-06 (Phase 4):** Consolidated into unified `src/util/index.ts`. Covered by `test/util.test.ts`. |
| **FANOUT-CONCURRENCY** | Up to 512 file reads fanned out concurrently in `checkFiles`, threatening file descriptor exhaustion. | **Closed** | **2026-10-06 (Phase 4):** Bounded file-read concurrency to 32 parallel operations. Covered by `test/check-files.test.ts`. |
| **LONG-MESSAGE-INVARIANT** | Oversized diagnostic messages could bloat cache and violate normalization length constraints. | **Closed** | **2026-10-06 (Phase 4):** Truncated messages at normalization time (`normalizeIssueMessage` in `src/schema.ts`) while keeping cache readers tolerant. Covered by `test/adapters.test.ts`. |
| **SERVER-MONOLITH** | `src/index.ts` was a monolithic file mixing MCP wiring, tool schemas, error handling, and orchestration. | **Closed** | **2026-10-06 (Phase 5):** Modularized server into `src/server/` (`toolSchemas.ts`, `tools.ts`, `errors.ts`, `context.ts`, `handlers/`, `createServer.ts`) leaving `src/index.ts` as a thin entry point. Covered by `test/acceptance-phase5.test.ts`. |
| **SCATTERED-ENGINE-TABLES** | Engine configurations, runners, and package names were duplicated across multiple files. | **Closed** | **2026-10-06 (Phase 5):** Unified single engine registry `src/engines/registry.ts` and relocated adapters to `src/engines/`. Adding a new engine now touches exactly two files. Covered by `test/engines.test.ts`. |
| **MODULE-ORGANIZATION** | `sessionLog.ts`, `stats.ts`, and exclusions were scattered across `src/` root. | **Closed** | **2026-10-06 (Phase 5):** Relocated to `src/memory/sessionLog.ts`, `src/memory/stats.ts`, `src/check/exclusions.ts`, `src/check/checkProject.ts`. |
| **DUPLICATE-EXCLUSIONS** | `filterDefaultExcludedIssues` executed twice (once at provider boundary and once in `runCheck`). | **Closed** | **2026-10-06 (Phase 5):** Eliminated redundant pass in `runCheck`; exclusions applied cleanly at provider boundary. |
| **VITEST-COVERAGE-EXCLUDE** | `src/index.ts` was excluded from Vitest coverage metrics. | **Closed** | **2026-10-06 (Phase 5):** Removed `exclude: ["src/index.ts"]` from `vitest.config.ts`; 100% of `src/` is measured against enforced thresholds. |
