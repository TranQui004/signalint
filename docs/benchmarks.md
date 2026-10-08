# Diagnostic Benchmarks & Payload Measurements

Measured on **2026-10-08** with `signalint-mcp@1.1.2`, `oxlint@1.86.0`, `typescript@7.0.2`, `gpt-tokenizer` (`cl100k_base`), Node.js v22.

## Benchmark Results (Default Mode: `"both"`)

| Fixture | Total Issues | Signalint Minified Payload | Full MCP Envelope (`both`) | Wire Ratio | vs Raw CLI Output (`tsc` + `oxlint`) | Issues Hidden / Unreachable |
|---|---:|---:|---:|---:|---:|---:|
| **1 issue, 1 file** | 1 | 424 B (~112 tok) | 984 B (~259 tok) | 2.32x | +90% (fixed envelope) | 0 |
| **12 issues, 1 root cause** | 12 | 508 B (~134 tok) | 1,154 B (~304 tok) | 2.27x | −45% vs raw CLI | 0 |
| **11 issues, 10 distinct rules** | 11 | 1,219 B (~321 tok) | 2,684 B (~706 tok) | 2.20x | −13% vs raw CLI | 0 (was 1 in v1.0.0) |
| **60 issues, 30+ distinct rules** | 60 | 3,124 B (~822 tok) | 6,808 B (~1,792 tok) | 2.18x | −68% vs raw CLI | 0 (was 27 in v1.0.0) |

*(Note: Raw CLI output refers to what an agent pays by running `tsc --pretty false --noEmit` + `oxlint --format agent` directly).*

---

## Configurable MCP Payload Modes & Wire Costs

Signalint supports three configurable MCP payload modes via the `SIGNALINT_MCP_PAYLOAD` environment variable or `mcpPayload` in `signalint.config.json` (precedence: env > config > default `"both"`):

- **`"both"` (Default):** Emits both `content[0].text` (minified JSON) and `structuredContent` (JSON object). Universal compatibility across all MCP clients.
- **`"text"`:** Emits only `content[0].text` (minified JSON); completely omits `structuredContent` and does not advertise `outputSchema`. Cuts wire envelope by **45–46%**.
- **`"structured"`:** Emits full data in `structuredContent`; replaces `content[0].text` with a short, single-line human summary without newlines (e.g., `11 issues found.`).

### Mode Comparison Across Fixtures

| Fixture | Issues | `both` Envelope (Default) | `text` Envelope | `structured` Envelope | `text` Savings vs `both` |
|---|---:|---:|---:|---:|---:|
| **sparse** | 1 | 984 B (2.32x) | 539 B (1.27x) | 498 B (1.17x) | 45.2% |
| **systemic-ts** | 12 | 1,154 B (2.27x) | 625 B (1.23x) | 584 B (1.15x) | 45.8% |
| **mixed-app** | 11 | 2,684 B (2.20x) | 1,444 B (1.18x) | 1,295 B (1.06x) | 46.2% |
| **scale-app** | 60 | 6,808 B (2.18x) | 3,663 B (1.17x) | 3,200 B (1.02x) | 46.2% |

*(These numbers can be reproduced at any time via `node scripts/measure-mcp-payload-mode.mjs`).*

---

## Methodology & Measurement Details

### 1. Honest Wire Cost: Text vs Full JSON-RPC Frame
There are two distinctly different costs across MCP:
- **Text-Only Cost:** A client that extracts `content[0].text` and forwards only that string to the model pays **≈ payload × 1.05** (the minified JSON string plus minimal frame overhead).
- **Full JSON-RPC Frame:** What actually crosses stdio when `structuredContent` is present is **2.1×–2.4× the raw payload** (measured above at 2.18x–2.32x across benchmarks). The payload is duplicated across both channels (`content[0].text` and `structuredContent`). Mode `"text"` eliminates this duplicate channel entirely.

### 2. Real-Client Validation Findings
Before considering changing the default away from `"both"`, real-client behavior was evaluated across Claude Desktop, Claude Code, and Cursor:
- **`"both"` (Default):** Works identically and reliably in all tested MCP clients. No client regressions or information loss.
- **`"text"` Mode:** Clients like Claude Desktop, Claude Code, and Cursor forward `content[0].text` to the model context. In `"text"` mode, the model receives complete diagnostics with zero information loss while the stdio wire footprint drops by ~46–50%.
- **`"structured"` Mode:** When `content[0].text` is only a short human summary, clients that forward only the text channel lose access to the underlying issue list. Therefore, `"structured"` mode requires MCP client host support for structured content and should not be used as the default.
- **Conclusion:** `"both"` remains the default for zero-breaking-change safety. Users and agent setups can set `SIGNALINT_MCP_PAYLOAD=text` to reclaim half the wire payload without losing diagnostic fidelity.

### 3. 12-Character Issue IDs
In responses, `remainingIssues[].issueId` and `clusters[].sampleIssueIds` emit 12-character hex prefixes instead of full 64-character SHA-256 hashes. If two issue IDs collide on the first 12 characters within a check, Signalint extends prefix length automatically to guarantee distinct identifiers. This shrinks flat issue records from ~90 bytes to ~68 bytes without losing precision. Full 64-character hashes remain preserved in internal storage and database caches.

### 4. Break-Even Guidance
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
