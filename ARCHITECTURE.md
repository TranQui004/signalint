# Signalint architecture

Signalint is a local stdio MCP server that turns diagnostics from existing
JavaScript and TypeScript tools into a compact, versioned response for coding
agents. This document describes the current implementation. See
[`docs/signalint-plan.md`](docs/signalint-plan.md) for design rationale, schema
rules, phase history, and deferred work.

## Layers

```text
                         MCP client
                             |
                 +-----------v-----------+
                 | MCP server             |
                 | src/index.ts           |
                 +-----------+-----------+
                             |
       +---------------+-------------+-------------+
       |               |             |             |
+------v-------+ +-----v------+ +----v------+ +----v----------+
| Engine       | | Cache      | | Cluster   | | Session       |
| adapters     | | layer      | | engine    | | memory        |
| oxlint/tsc/  | | SQLite +   | | rule      | | loop history  |
| biome        | | file hashes| | grouping  | | + metrics     |
+--------------+ +------------+ +-----------+ +---------------+
```

Adapters are the only modules that invoke diagnostic engines. The cache,
clustering, schema, and session layers operate on `NormalizedIssue` objects.

## Source modules

| Module | Responsibility |
|---|---|
| `src/index.ts` | Registers MCP tools, selects configured providers, clusters results, records session state, and serializes tool responses. |
| `src/cli.ts` | Implements `signalint check` and `signalint stats` using the same project and telemetry paths as the server. |
| `src/schema.ts` | Defines and validates normalized issues, clusters, check responses, timeout responses, stale references, and loop status. |
| `src/config.ts` | Loads `signalint.config.json`, validates engine/timeout settings, and applies ignore globs. |
| `src/adapters/oxlint.ts` | Runs Oxlint and normalizes its JSON diagnostics. |
| `src/adapters/tsc.ts` | Resolves the TypeScript project, selects project or build mode, runs the pinned compiler, and parses diagnostics. |
| `src/adapters/biome.ts` | Runs optional Biome checks and normalizes its JSON reporter output. |
| `src/checkFiles.ts` | Coordinates per-file snapshots, engine config hashes, cache decisions, and the different file-local/whole-program strategies. |
| `src/cache/sqliteCache.ts` | Stores per-engine file results and the latest whole-program result in `.signalint/cache.sqlite`. |
| `src/cluster/clusterEngine.ts` | Groups normalized issues by rule, assigns cluster IDs and priority, samples distinct issue IDs, and truncates responses. |
| `src/memory/sessionMemory.ts` | Tracks issue-signature appearances, restores valid JSONL history, adds loop warnings, and appends check metrics. |
| `src/stats.ts` | Aggregates `.signalint/session.jsonl` into payload, cache, latency, and loop-warning statistics. |
| `src/defaultExclusions.ts` | Removes diagnostics whose path contains a `node_modules` segment, independently of user configuration. |
| `src/subprocess.ts` | Runs engine processes with timeouts, abort handling, and Windows/POSIX process-tree termination. |
| `src/abort.ts` | Links MCP cancellation to adapter subprocess cancellation. |
| `src/mainModule.ts` | Detects direct execution through normal paths, symlinks, or Windows junctions. |

## Engine invocation and caching

Oxlint and Biome are file-local. For `check_files`, Signalint hashes each relevant
file, reuses matching SQLite entries, and invokes each engine once with the batch
of cache misses. Results are split back into per-file entries.

TypeScript is whole-program. Signalint uses hashes of the files supplied to
`check_files` only to decide whether tsc needs to run; it never passes those files
as compiler roots. If tsc runs, it sees the complete configured project:

- A normal `tsconfig.json` uses `--project`, `--incremental`, and
  `.signalint/cache/tsc.tsbuildinfo`.
- A root config containing `references` uses `--build <config> --incremental`, so
  solution-style roots with `files: []` traverse their referenced projects.

The current file-cache key is the SHA-256 file-content hash plus engine name and
engine-config hash. Signalint-version and engine-version key components are
documented post-Phase-6 backlog items in Section 9 of the build plan; they are not
implemented yet.

## `check_files` data flow

1. `src/index.ts` validates the MCP arguments and loads project configuration.
2. Ignored request paths are removed, then `src/checkFiles.ts` reads the remaining
   files and computes engine-specific config hashes.
3. File-local cache hits are reused. Oxlint and optional Biome receive only misses;
   tsc is skipped only when all supplied TypeScript-relevant snapshots still match
   the last whole-program result.
4. Any invoked adapter runs through `src/subprocess.ts` and returns normalized
   issues. Cancellation or timeout terminates the engine process tree.
5. Unconditional `node_modules` exclusions and configured ignore globs remove
   diagnostics that should not reach the caller.
6. `src/cluster/clusterEngine.ts` assigns `clusterId` values and builds the
   `schemaVersion: "1.0"` response, ordered by priority and limited to ten clusters
   by default.
7. `SessionMemory` updates diagnostic appearances, adds any loop warning, records
   cache/payload/latency metrics, and appends `.signalint/session.jsonl`.
8. The MCP handler returns the response as JSON text and retains the latest issues
   for `get_issue_detail`.

Timeouts are returned as structured engine timeout responses. Issue references
that no longer exist in the latest successful result return the explicit stale
reference response defined in `src/schema.ts`.
