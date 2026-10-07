# Diagnostic Benchmarks & Payload Measurements

Measured on **2026-10-08** with `signalint-mcp@1.0.0`, `oxlint@1.86.0`, `typescript@7.0.2`, `gpt-tokenizer` (`cl100k_base`), Node.js v22 on Linux x64.

## Benchmark Results

| Fixture | Total Issues | Signalint Minified Payload | Full MCP Envelope | vs Raw CLI Output (`tsc` + `oxlint`) | Issues Hidden / Unreachable |
|---|---:|---:|---:|---:|---:|
| **1 issue, 1 file** | 1 | 377 B (~98 tok) | 910 B (~240 tok) | +90% (fixed envelope) | 0 |
| **12 issues, 1 root cause** | 12 | 445 B (~115 tok) | 1,048 B (~275 tok) | −45% vs raw CLI | 0 |
| **11 issues, 10 distinct rules** | 11 | 1,194 B (~310 tok) | 2,280 B (~590 tok) | −13% vs raw CLI | 0 (was 1 in v1.0.0) |
| **60 issues, 30+ distinct rules** | 60 | 3,099 B (~805 tok) | 5,900 B (~1,540 tok) | −68% vs raw CLI | 0 (was 27 in v1.0.0) |

*(Note: Raw CLI output refers to what an agent pays by running `tsc --pretty false --noEmit` + `oxlint --format agent` directly).*

---

## Methodology & Measurement Details

### 1. Minified Payload vs Full MCP Wire Envelope
There are two distinct payload measurements:
- **Minified Payload:** The raw JSON string of the `CheckResponse` object emitted by `clusterIssues`. Since v1.0.1, the MCP text content (`content[0].text`) is strictly minified JSON.
- **Full MCP Wire Envelope:** What the LLM agent actually pays over stdio. In standard MCP implementations, the JSON-RPC response contains both `content: [{ type: "text", text }]` and `structuredContent: { ... }`. Because the payload is represented in both channels within the JSON-RPC frame, the wire envelope is approximately **1.9× larger** than the raw minified payload.

### 2. 12-Character Issue IDs
In responses, `remainingIssues[].issueId` and `clusters[].sampleIssueIds` emit 12-character hex prefixes instead of full 64-character SHA-256 hashes. If two issue IDs collide on the first 12 characters within a check, Signalint extends prefix length automatically to guarantee distinct identifiers. This shrinks flat issue records from ~90 bytes to ~68 bytes without losing precision. Full 64-character hashes remain preserved in internal storage and database caches.

### 3. Break-Even Guidance
Signalint pays for itself whenever diagnostics share root causes or when total issues exceed roughly 10–15. On tiny result sets (e.g. 1 issue), the envelope adds ~0.35 KB of baseline structure. The headline "80%+ reduction" figure applies to repositories where issues cluster into shared causes (the common scenario for broken imports or type regressions).

---

## Cluster Cap, Overflow Handling, and Retrieval Path

### Upper Bound & Payload Ceiling
To protect LLM context windows, Signalint enforces strict upper bounds:
- **Top 10 Clusters:** Clusters are ranked by priority, issue count, and scope, with at most 10 clusters emitted.
- **Remaining Issues Cap:** Non-clustered issues and demoted overflow clusters are merged into `remainingIssues`, bounded at **100 entries**.
- **Payload Plateau:** Regardless of repository size (whether 400 or 10,000 issues), the response size plateaus at **~21.8 KB minified** (approximately **8,900 tokens** in `cl100k_base`).

### Omitted Issue Retrieval
When issues exceed the remaining cap (e.g., at 400 issues, 200 issues or 50% are omitted from the check summary):
- `omittedIssueCount` (or `omitted` in compact mode) reports the exact count of omitted items.
- `truncated: true` is set.
- All 400 issues are **preserved in session memory and persistent SQLite cache**.
- The response includes a structured `nextStep` naming the exact retrieval tools:
  ```
  Call get_issue_detail to retrieve omitted issues or full details, or check_files on affected paths.
  ```
- **How to retrieve omitted issues:**
  1. `get_issue_detail({ clusterId: "<clusterId>" })`: Retrieves the full array of `NormalizedIssue` records for any cluster, including all individual messages and locations.
  2. `get_issue_detail({ issueId: "<shortId>" })`: Accepts either the 12-character short ID or the full 64-character hash.
  3. `check_files({ files: ["path/to/file.ts"] })`: Re-runs checking scoped down to the files of interest.
