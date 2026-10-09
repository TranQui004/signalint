# eval-harness — evidence harness for Signalint payload claims

> **Current session handoff:** Start with [HANDOFF.md](HANDOFF.md) for current `main`, merged PRs, verified release state, user scope, and branch warnings (2026-10-09). This README's rounds 1–4 setup and results are historical; check the release-specific files under `results/` before reusing any command or number.

Independent measurement harness used to verify (or refute) the numbers Signalint
publishes about itself: payload size, MCP wire cost, install footprint, cache
freshness and loop detection. Everything here is **evidence**, not product code:
it lives on the analysis branch only and is never merged into `main` wholesale.
Downstream delivery happens on a separate branch opened from `main`.

## Why this exists

Signalint's value proposition is "fewer tokens for the same diagnostics". That
claim is only meaningful if it is measured against what an agent would pay by
running the engines itself, and if the number quoted is what actually reaches the
model. Both turned out to be false at various points:

- v1.0.0 silently dropped issues beyond a 10-cluster cap (27 of 60 issues hidden
  in one fixture) — the "80% reduction" was measured on a near-pure systemic
  fixture, a best case.
- The MCP wire envelope is ~2.1–2.6x the payload, because `CallToolResult`
  carries the same object in `content[0].text` and `structuredContent`.
- `--compact` briefly made responses 72% LARGER (fields emitted twice).

Every table below was produced by this harness against a real build.

## Layout

    scripts/setup-projects.mjs   generates the fixtures into projects/
    scripts/measure.mjs          round 1: payload bytes/tokens vs raw engines
    scripts/measure2.mjs         round 2: four raw baselines + scale-app fixture
    scripts/measure3.mjs         round 3: v1.0.0 vs PR #52, invariant checks
    scripts/analyse-pr52.mjs     pretty vs minified, cost of 64-char issue ids
    scripts/mcp-measure.mjs      round 4a: real MCP stdio wire cost
    scripts/cap-test.mjs         round 4b: MAX_REMAINING_ISSUES=100 at 60..400 issues
    scripts/mcp-cache.mjs        round 4c: staleness, check_files scope, loop detection
    scripts/mcp-loop.mjs         round 4d: fix -> reappear loop detection
    scripts/verify-main.mjs      verifies PR #52 + #53 (compact, minify, scope)
    scripts/verify-pr54.mjs      verifies PR #54 (short ids, claimed benchmarks)
    scripts/verify-ids.mjs       short/full issue-id resolution, cluster retrieval
    results/*.json               raw output of every round

## Fixtures (`projects/`, regenerated, not committed)

| fixture | issues | shape |
|---|---:|---|
| `sparse` | 1 | worst case — fixed envelope only |
| `systemic-ts` | 12 | one root cause — best case for clustering |
| `mixed-app` | 11 | 10 distinct rules — realistic small app |
| `scale-app` | 60 | 15 systemic + 15 unique + 15 repeated + 15 distinct |
| `cache-lab` | 2-3 | cross-file types, used for staleness/scope tests |
| `id-lab`, `loop-lab` | 2, 1 | issue-id resolution and loop detection |

## Methodology (keep this identical or the numbers are not comparable)

- **Raw baseline**: `tsc --noEmit --pretty false` + `oxlint --format agent`,
  concatenated — what an agent pays by running the engines itself.
- **Tokens**: `gpt-tokenizer`, `cl100k` encoding.
- **Payload**: `JSON.stringify(response)` (minified) unless the row says "pretty".
- **MCP envelope**: `JSON.stringify(callToolResult)` — the WHOLE JSON-RPC result,
  including `content[0].text` and `structuredContent` when present. This is what
  crosses stdio. A client that only forwards `content[0].text` to the model pays
  roughly `payload x 1.05`; the full frame is ~2.1–2.6x.
- The CLI exits non-zero when issues are found, and Node prints its SQLite
  experimental warning to stderr — always capture with
  `stdio: ["ignore","pipe","ignore"]` and read `error.stdout`.

## Rebuilding from scratch

    npm i -g pnpm@11.9.0            # global installs do not survive the sandbox
    npm install                     # gpt-tokenizer + signalint-mcp@1.0.0 (+ sdk)
    git clone --depth 1 -b <branch> https://github.com/TranQui004/signalint.git builds/<name>
    cd builds/<name> && pnpm install --frozen-lockfile && pnpm run build
    node scripts/setup-projects.mjs

## Headline results (measured, not estimated)

Wire cost actually paid by the agent — full MCP envelope, bytes:

| fixture | issues | v1.0.0 | + PR #52/#53 | + PR #54 | vs v1.0.0 |
|---|---:|---:|---:|---:|---:|
| sparse | 1 | 1,670 | 1,122 | 1,018 | −39% |
| systemic-ts | 12 | 1,862 | 1,396 | 1,188 | −36% |
| mixed-app | 11 | 8,384 | 3,446 | 2,718 | −68% |
| scale-app | 60 | 8,404 (27 hidden) | 9,234 (0 hidden) | 6,842 (0 hidden) | −19% |

Cost model derived from rounds 1–2 (pre-fix): fixed envelope ~850 B,
per-cluster ~400 B, flat issue record ~90 B (~68 B with 12-char ids).
Break-even against raw output is roughly 10–20 issues depending on which raw
baseline you compare against; **below ~15 issues Signalint is larger than raw**.

Verified correct, do not re-investigate: `MAX_REMAINING_ISSUES = 100` and the
`totalIssues === sum(issueCount) + remaining + omitted` invariant (60/150/160/180/400
issues); cache freshness (fix, new error, cross-file change, and same-size edit with
mtime rewound all returned fresh results); loop detection (fires on the 3rd
occurrence = 2 reappearances); `get_issue_detail` for short ids, full ids, and
cluster ids.
