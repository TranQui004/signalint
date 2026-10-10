# Signalint Architecture

Signalint is a reliable, read-only-by-default diagnostic intelligence layer for AI coding agents and CI workflows. It normalizes compiler, linter, and language server diagnostics into an actionable, bounded, clustered format.

---

## 1. System Layers

```text
                           AI Coding Agent / Client Host
                 (Claude Code, Cursor, Codex, VS Code, CI Actions)
                                      |
                         +------------v------------+
                         |     Transport Layer     |
                         |  Stdio MCP / CLI Hooks  |
                         +------------+------------+
                                      |
         +----------------------------+----------------------------+
         |                                                         |
+--------v--------+                                       +--------v--------+
| Workspace Layer |                                       | Hooks Subsystem |
| pnpm-workspace  |                                       | Host Adapters   |
| DAG & Plan      |                                       | & Policy Engine |
+--------+--------+                                       +-----------------+
         |
+--------v------------------------------------------------------------------+
| Diagnostics Normalization, Provenance & Clustering                        |
| - Engines: Oxlint, tsc, Biome, ESLint                                     |
| - External Adapters: Python (Ruff/Mypy), Rust (Clippy), Go (GolangCI-Lint) |
| - Source Provenance Tracking & Diagnostic Burst Buffer                    |
| - Deterministic Priority Ladder & Semantic Cluster Engine                 |
+--------+------------------------------------------------------------------+
         |
+--------v------------------------------------------------------------------+
| Storage, Verification & Transactions                                      |
| - SnapshotStore: Immutable Check Snapshots (FIFO / TTL)                  |
| - VerificationDelta: Line-Shift Resilient Diffing Engine                  |
| - SqliteCache: Partitioned Content-Hash Cache (node:sqlite)               |
| - SessionMemory: Session Metrics & Churn/Loop Tracking                   |
| - TransactionManager: In-Memory Previews & Atomic Rollback Apply          |
+---------------------------------------------------------------------------+
```

---

## 2. Core Subsystems

### A. Server & Protocol Layer (`src/server/`)
- **`createServer.ts`**: Configures the MCP server, binds runtime version dynamically (`resolveSignalintVersion()`), and registers JSON-RPC request handlers.
- **`toolSchemas.ts` & `tools.ts`**: Declares all 13 active tools. Strictly closes every object schema with `additionalProperties: false` in `both` and `structured` modes.
- **`errors.ts`**: Separates protocol errors (JSON-RPC code `-32602`) from structured business tool errors (`isError: true`).

### B. Workspace & Monorepo Planning (`src/workspace/`)
- **`discovery.ts`**: Parses `pnpm-workspace.yaml`, extracts package manifests, workspace dependencies (`workspace:*`), and TypeScript project references.
- **`graph.ts`**: Constructs a union directed acyclic graph (DAG) uniting package manifests and TypeScript references, resolving topological execution order with Kahn's algorithm.
- **`plan.ts`**: Plans package verification closures, calculating transitive dependents so changes to shared libraries trigger automatic verification of dependent applications while keeping independent siblings cached.

### C. Diagnostic Engine & LSP Normalization (`src/diagnostics/` & `src/engines/`)
- **`provenance.ts`**: Tags every diagnostic with source provenance (`compiler`, `linter`, `lsp`, `editor`) and originating server identity.
- **`normalize.ts`**: Normalizes 0-based LSP coordinates into Signalint 1-based coordinates and canonicalizes `file://` URIs across POSIX and Windows.
- **`buffer.ts`**: Diagnostic buffer that deduplicates burst events during active editor sessions and enforces bounded capacity (10,000 issues).
- **External Adapters (`src/diagnostics/adapters/`)**: Normalizes diagnostic output from Ruff/Mypy (Python), Clippy (Rust), and GolangCI-Lint (Go).

### D. Snapshots, Deltas & Loop History
- **`SnapshotStore` (`src/diagnostics/snapshots.ts`)**: Stores immutable diagnostic snapshots keyed by `checkId`. Eliminates process-global check state collisions with bounded capacity (50 items) and TTL expiration (30 minutes).
- **`computeDiagnosticDelta` (`src/diagnostics/delta.ts`)**: Deterministic diffing engine employing a two-pass matching algorithm (exact issue ID + semantic identity) to remain resilient against line shifts caused by code edits.
- **`SessionMemory` (`src/memory/sessionMemory.ts`)**: Records check history in `.signalint/session.jsonl` to detect oscillating fixes (looping signatures) and rule churn across an agent's session.

### E. In-Memory Transactional Previews & Safe Apply (`src/transactions/`)
- **`manager.ts`**:
  - `prepareTransaction`: Stages file modifications entirely in memory without writing to disk.
  - `applyTransaction`: Atomic apply requiring explicit `confirm: true`. Verifies content drift before touching disk, writes files atomically, automatically rolls back all changes if any write fails, and triggers post-apply verification check.

### F. Host Hook Adapters (`src/hooks/`)
- **Adapters**: Native mapping for Claude Code (`PostToolUse`, `Stop`), Cursor (`afterFileEdit`, `stop`), Codex, and VS Code.
- **`paths.ts`**: Path validation defending against directory traversal, leading dashes, NUL bytes, and symlink escapes across POSIX and Windows short names (8.3).
- **`policy.ts`**: Implements post-edit incremental verification and final stop verification, guaranteeing that engine execution failures are never reported as clean.
