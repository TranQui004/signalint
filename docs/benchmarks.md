# Diagnostic Benchmarks & Payload Measurements

Measured on 2026-10-07 with `signalint-mcp@1.0.0`, `gpt-tokenizer` (cl100k_base), Linux x64. "Raw" means what an agent would get by running the engines itself.

| Fixture | Issues | Signalint bytes | vs `tsc --pretty false` + `oxlint --format agent` | vs `tsc --pretty false` + `oxlint --format json` | Issues hidden |
|---|---:|---:|---:|---:|---:|
| 1 issue, 1 file | 1 | 853 | +928% | +223% | 0 |
| 12 issues, 1 root cause | 12 | 952 | −6% | −20% | 0 |
| 11 issues, 10 distinct rules | 11 | 4,507 | +228% | +81% | 1 |
| 60 issues, 30+ distinct rules | 60 | 4,520 | −44% | −70% | 27 |

Fixed envelope ≈ 850 bytes; per-cluster cost ≈ 400 bytes; a flat issue record ≈ 90 bytes.

## Break-Even Guidance

> Signalint pays for itself when diagnostics share root causes or when there are more than roughly 15 of them. On very small result sets it adds ~0.8 KB of envelope, so it is larger than raw output there. The published "80% reduction" figure comes from a fixture where nearly all issues share two root causes — treat it as the best case, not the average.

## Optimization Improvements in v1.0.x

In Signalint v1.0.x, payload honesty and envelope footprint were systematically hardened:

1. **Information fidelity:** Single-issue diagnostics are routed into compact flat records (~90 bytes) rather than full cluster envelopes (~400 bytes).
2. **Cap overflow transparency:** Clusters beyond the top 10 cap are preserved in `remainingIssues` rather than silently dropped, and `omittedIssueCount` explicitly signals any bounded overflow with an actionable `nextStep`.
3. **Envelope reduction:** Unused disabled engine entries, redundant `suggestedAction` strings, and sample issue IDs on tiny groups (<= 2 issues) are omitted, reducing small responses from ~853 bytes to under 500 bytes.
4. **Compact mode:** An opt-in compact format (`signalint check --compact` or `SIGNALINT_COMPACT=1`) shortens keys and removes redundant paths for agent pipelines.
