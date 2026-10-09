# MCP Protocol Contract & Tool Reference

This document is the authoritative specification for Signalint's Model Context Protocol (MCP) server implementation over stdio.

---

## 1. Protocol Architecture & Transports

- **Transport:** Standard input/output (`stdio`) using `@modelcontextprotocol/sdk`.
- **Protocol Version:** Compliant with MCP specification revision `2024-11-05` / `2026-07-28`.
- **Server Identity:** Advertises `{ name: "signalint", version: "<package.json.version>" }` dynamically derived at runtime via `resolveSignalintVersion()`.
- **Capabilities:** Exposes tools only (`capabilities.tools: {}`). Does not expose generic resources or long-running Tasks.

---

## 2. Payload Modes & Schema Invariants

Signalint supports three wire formatting modes configured via `signalint.config.json` (`mcpPayload`) or `SIGNALINT_MCP_PAYLOAD`:

| Mode | `content[0].text` | `structuredContent` | `outputSchema` Advertised | Wire Overlap | Recommended Use Case |
|---|---|---|---|---|---|
| **`both`** *(default)* | Minified JSON string equal to `JSON.stringify(structuredContent)` | Full typed response object | Yes (`additionalProperties: false`) | High (~2.1×) | Maximum compatibility across any client. |
| **`structured`** | Short single-line human summary string (e.g. `Found 3 issues.`) | Full typed response object | Yes (`additionalProperties: false`) | Low | Modern clients rendering structured UI blocks. |
| **`text`** *(legacy)* | Minified JSON string of response payload | Omitted | Omitted | Lowest (~50% of `both`) | Token-optimized headless agent loops. |

### Schema Strictness
- Every tool parameter input schema (`inputSchema`) is a strict JSON Schema closed with `additionalProperties: false`.
- In `both` and `structured` modes, every tool advertises a corresponding strict `outputSchema` closed with `additionalProperties: false`.

---

## 3. Protocol Errors vs Structured Business Refusals

Signalint strictly differentiates JSON-RPC protocol violations from domain business errors:

1. **Protocol Errors (JSON-RPC code `-32602` / `INVALID_PARAMS`):**
   - Unknown tool invocations (calling an unadvertised tool name).
   - Malformed argument containers (e.g. passing a string, array, or boolean instead of a JSON object).
   - These are thrown directly as protocol-level `McpError` exceptions.

2. **Structured Business Errors (`CallToolResult` with `isError: true`):**
   - Invalid path arguments (path traversal `..`, leading dash `-`, NUL bytes, symlink escapes, paths outside project root).
   - Uninitialized project directory (missing `signalint.config.json` when `SIGNALINT_ALLOW_UNINITIALIZED` is unset).
   - Engine timeouts, engine output limit exceeded, execution failures.
   - Returned as structured machine-readable error responses with status: `"error"`, stable `code`, and human-readable `message`.

3. **Cancellation & Abort:**
   - Client-cancelled requests via `AbortSignal` immediately terminate spawned child process groups (`SIGTERM` -> `SIGKILL`).
   - Does not manufacture synthetic "clean" or "success" results for aborted calls.

---

## 4. MCP Tools Catalog (All 13 Tools)

### A. Core Diagnostics

#### 1. `ping`
- **Purpose:** Verifies server responsiveness and canonical project root path.
- **Annotations:** `readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false`.
- **Input:** `{}`
- **Output:** `{ pong: boolean, projectRoot: string }`

#### 2. `check_project`
- **Purpose:** Executes full lint and typecheck diagnostic scan across project paths (or all workspace packages in monorepos).
- **Annotations:** `readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false`.
- **Input:** `{ paths?: string[] }` (paths default to `["."]`, capped at 512 paths).
- **Output:** Clustered check response `{ schemaVersion, status, totalIssues, clusters, remainingIssues, omittedIssueCount, filteredOutIssueCount, nextStep, checkId, engines }`.

#### 3. `check_files`
- **Purpose:** Runs incremental checks on specific files using content-hash and whole-program fingerprint caching.
- **Annotations:** `readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false`.
- **Input:** `{ files: string[] }` (required array of project-relative file paths).
- **Output:** Clustered check response with per-engine cache metrics (`cache.hits`, `cache.misses`).

#### 4. `get_issue_detail`
- **Purpose:** Retrieves full, unomitted issue records for a specific cluster ID or issue ID from a prior check.
- **Annotations:** `readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false`.
- **Input:** `{ clusterId?: string, issueId?: string, checkId?: string }` (exactly one of `clusterId` or `issueId` required; `checkId` pins to an immutable snapshot).
- **Output:** Array of `NormalizedIssue` records or `{ status: "stale", message: string }`.

#### 5. `get_loop_status`
- **Purpose:** Returns diagnostic signatures currently oscillating or churning in the agent's session.
- **Annotations:** `readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false`.
- **Input:** `{}`
- **Output:** `{ looping: boolean, signatures: LoopWarning[], fileChurning: boolean, fileRuleChurns: FileRuleChurnWarning[] }`.

---

### B. Snapshots & Verification Deltas

#### 6. `get_diagnostic_snapshot`
- **Purpose:** Retrieves complete metadata, clusters, bounded remaining issues, and engine statuses for an immutable check snapshot.
- **Annotations:** `readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false`.
- **Input:** `{ checkId: string }` (required).
- **Output:** Full diagnostic snapshot or stale reference when expired/unknown.

#### 7. `compare_diagnostics`
- **Purpose:** Calculates a deterministic verification delta between a baseline check and a current check.
- **Annotations:** `readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false`.
- **Input:** `{ baselineCheckId: string, currentCheckId: string }` (both required).
- **Output:** `{ baselineCheckId, currentCheckId, introducedIssues, resolvedIssues, unchangedIssues, errorsIntroduced, errorsResolved, netDelta, nextStep }`.

#### 8. `after_edit_check`
- **Purpose:** Convenience workflow: runs incremental check on modified files and automatically diffs against an optional baseline check.
- **Annotations:** `readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false`.
- **Input:** `{ files: string[], baselineCheckId?: string }`
- **Output:** Check response plus `delta` object if `baselineCheckId` was provided.

---

### C. Live & External Diagnostics

#### 9. `ingest_diagnostics`
- **Purpose:** Ingests external LSP or compiler diagnostics (e.g. from VS Code, Ruff, Clippy, GolangCI-Lint) into Signalint's unified clustering model.
- **Annotations:** `readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false`.
- **Input:** `{ source: string, serverName?: string, diagnostics: Array<{ file: string, range: { start: { line, character }, end: { line, character } }, severity?: number, code?: string|number, message: string }> }`.
- **Output:** `{ snapshotId: string, totalIssues: number, clusters: Cluster[] }`.

#### 10. `get_live_diagnostics`
- **Purpose:** Retrieves active buffered diagnostics merged from internal engines and ingested LSP sources, preserving full source provenance.
- **Annotations:** `readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false`.
- **Input:** `{ files?: string[], severity?: "error" | "warning" }`.
- **Output:** `{ totalIssues: number, issues: NormalizedIssue[], clusters: Cluster[] }`.

---

### D. Transactional Fix Previews & Apply

#### 11. `preview_diagnostic_fix`
- **Purpose:** Stages proposed code modifications in-memory and returns a diff summary. **Does not write to disk.**
- **Annotations:** `readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false`.
- **Input:** `{ patches: Array<{ file: string, originalContent: string, patchedContent: string, description?: string }> }`.
- **Output:** `{ transactionId: string, filesCount: number, summary: string, patchesPreview: Array<{ file, addedLines, removedLines, description? }> }`.

#### 12. `apply_diagnostic_fix`
- **Purpose:** Atomically writes a prepared transaction to disk with automatic rollback on failure and post-apply check.
- **Annotations:** `readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false`.
- **Input:** `{ transactionId: string, confirm: boolean }` (`confirm: true` is strictly required).
- **Output:** `{ transactionId: string, status: "success" | "rolled_back" | "error", filesModified: string[], postCheckId?: string, delta?: unknown, error?: string }`.

#### 13. `discard_diagnostic_fix`
- **Purpose:** Discards a prepared transaction from in-memory storage without touching disk.
- **Annotations:** `readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false`.
- **Input:** `{ transactionId: string }`.
- **Output:** `{ transactionId: string, status: "discarded" }`.

---

## 5. Progress Reporting

When a client provides a `progressToken` in request metadata (`_meta.progressToken`), Signalint transmits rate-limited monotonic progress notifications (`notifications/progress`):
- `0.0`: Check dispatched.
- `0.3`: Linters (Oxlint / Biome / ESLint) complete.
- `0.7`: TypeScript compilation complete.
- `0.9`: Clustering and loop evaluation complete.
- `1.0`: Final response ready.
- Progress emission terminates strictly prior to the final tool result.
