# Known Limitations & Risk Register

This document tracks active operational boundaries and the authoritative risk register for Signalint.

---

## Active Operational Boundaries

### Localhost Stdio Execution Context
Signalint executes locally over stdio and operates with the OS permissions of the launching user. Path containment enforces project boundary integrity against prompt injection, but Signalint does not replace an OS-level sandbox or VM container.

### External Diagnostic Normalization vs Direct Execution
For JavaScript and TypeScript (`oxlint`, `tsc`, `biome`, `eslint`), Signalint manages subprocess execution and caching directly.
For external languages (Python `ruff`/`mypy`, Rust `cargo clippy`, Go `golangci-lint`), Signalint acts as a normalization, clustering, and ingestion layer (`ingest_diagnostics` or companion adapters); it ingests structured diagnostic streams rather than orchestrating external language build tools directly.

### Atomic Apply & Confirmation Gate
Fix modifications through `apply_diagnostic_fix` are strictly transactional and require explicit `confirm: true`. If a file drifts between preview and apply, the transaction is rejected to prevent silent clobbering.

---

## Risk Register & Resolution Log

The following table tracks architectural and implementation risks identified during development and their verified resolutions across all completed roadmap phases.

| Risk ID / Topic | Original Risk | Status | Resolution Milestone & Evidence |
| --- | --- | --- | --- |
| **STATUS-ENGINE-OUTCOME** | Check status reported `passed` even when engine execution encountered errors. | **Closed** | `runCheck` and clustering logic evaluate engine execution outcomes; if any engine fails, check status reports `error`. Covered by `test/check-project.test.ts`. |
| **CONTAINMENT-ROOT** | Path traversal beyond project root could occur with unnormalized arguments. | **Closed** | Enforced containment checks in `src/projectPaths.ts` and `src/hooks/paths.ts`. Covered by `test/security.test.ts` and `test/hooks-event.test.ts`. |
| **CLIENT-REGISTRY-DOCTOR** | Manual client configuration was error-prone across different agent tools. | **Closed** | Built `src/clients/` registry supporting Claude Code, Cursor, Codex, and Windsurf, plus `signalint doctor`. Covered by `test/clients.test.ts` and `test/doctor.test.ts`. |
| **PRIORITY-LADDER-SCORE** | Syntax errors were buried under style warnings. | **Closed** | Implemented deterministic priority ladder `[code, type, syntax, import, perf, other, style]` in `src/cluster/clusterEngine.ts`. Covered by `test/cluster.test.ts`. |
| **BIOME-FIXABILITY** | Biome reported `fixable: false` across all diagnostics. | **Closed** | Biome adapter inspects `advices` matching `/safe fix/i`. Covered by `test/adapters.test.ts`. |
| **NATIVE-SQLITE-ABI** | Native compilation issues across differing Node ABIs. | **Closed** | Replaced `better-sqlite3` with standard `node:sqlite` (`DatabaseSync`), requiring Node >= 22.12.0. Covered by `test/cache.test.ts`. |
| **VERSION-ALIGNMENT-MCP** | Server reported hardcoded version `0.4.2` while package metadata was `1.1.2`. | **Closed** | **Phase 0 (PR #66):** Dynamically bound `Server.version` to `resolveSignalintVersion()`. Covered by `test/mcp-contract.test.ts`. |
| **STATE-ISOLATION-TESTS** | Parallel tests collided on `.signalint/` caches. | **Closed** | **Phase 0 (PR #66):** Added `SIGNALINT_STATE_DIR` support and isolated test runs via `mkdtempSync`. Covered by `test/state-isolation.test.ts`. |
| **PROTOCOL-ERROR-SHAPE** | Unknown tools returned tool errors with `isError: true` instead of protocol errors. | **Closed** | **Phase 0 (PR #66):** Unknown tools and non-object calls throw JSON-RPC error code `-32602`. Covered by `test/mcp-contract.test.ts`. |
| **CHECK-CONCURRENCY-COLLISION** | Process-global check state caused concurrent checks to overwrite issue details. | **Closed** | **Phase 1 (PR #67):** Introduced immutable `SnapshotStore` keyed by `checkId` with FIFO retention. Covered by `test/snapshots.test.ts`. |
| **VERIFICATION-DELTA-RESILIENCE** | Line shifts from file edits broke issue matching across checks. | **Closed** | **Phase 1 (PR #67):** Two-pass semantic matching algorithm in `computeDiagnosticDelta`. Covered by `test/delta.test.ts`. |
| **PROGRESS-AND-CANCELLATION** | No progress reporting and zombie child processes on abort. | **Closed** | **Phase 1 (PR #67):** Rate-limited monotonic MCP progress tokens and process tree termination. Covered by `test/cancellation-progress.test.ts`. |
| **PORTABLE-HOOK-LIFECYCLE** | Lack of post-edit verification without creating infinite agent loops. | **Closed** | **Phase 2 (PR #70):** Native adapters for Claude Code, Cursor, Codex, and VS Code with bounded payloads. Covered by `test/hooks-adapters.test.ts`. |
| **MONOREPO-TSCONFIG-CEILING** | Single `tsconfig.json` assumption failed in multi-package workspaces. | **Closed** | **Phase 3 (PR #71):** `pnpm-workspace.yaml` discovery, union dependency DAG, and partitioned `.tsbuildinfo` storage. Covered by `test/monorepo-tsc.test.ts`. |
| **LSP-PROVENANCE-NORMALIZATION** | External editor/LSP diagnostics lacked unified clustering. | **Closed** | **Phase 4 (PR #72):** Added `ingest_diagnostics` and `get_live_diagnostics` with source provenance tracking. Covered by `test/live-diagnostics-tool.test.ts`. |
| **TRANSACTIONAL-APPLY-SAFETY** | Unsafe file modifications risking corrupted working trees. | **Closed** | **Phase 5 (PR #73):** In-memory fix previews (`preview_diagnostic_fix`), atomic apply with rollback (`apply_diagnostic_fix`), and drift protection. Covered by `test/transactional-apply.test.ts`. |
