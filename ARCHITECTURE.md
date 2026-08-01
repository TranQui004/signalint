# Signalint architecture

Signalint is a local stdio MCP server that turns diagnostics from existing
JavaScript and TypeScript tools into a compact, versioned response for coding
agents. This document describes the current implementation.

For the historical design rationale — why each decision was made, and what was
deliberately deferred — see [`docs/history/`](docs/history/).

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

Adapters are the only modules that invoke diagnostic engines. Every layer above
them operates on `NormalizedIssue` objects and never shells out.

## Source modules

### Server and entry points

| Module | Responsibility |
|---|---|
| `src/index.ts` | Registers MCP tools, selects configured providers, clusters results, records session state, and serializes tool responses. |
| `src/cli.ts` | Implements `signalint init`, `signalint check`, and `signalint stats` using the same setup, project, and telemetry paths as the server. |
| `src/init.ts` | Detects project engine configuration and nearby MCP clients, writes `signalint.config.json`, and merges a confirmed MCP server entry. |
| `src/mainModule.ts` | Detects direct execution through normal paths, symlinks, or Windows junctions. |
| `src/lifecycle.ts` | Orders shutdown: terminate engine process trees, close SQLite handles, then close the transport. |

### Validation and contracts

| Module | Responsibility |
|---|---|
| `src/schema.ts` | Defines and validates normalized issues, clusters, check responses, timeout responses, stale references, and loop status. |
| `src/toolArguments.ts` | Parses MCP tool arguments through strict Zod schemas that reject unknown properties and malformed reference unions. |
| `src/projectPaths.ts` | Enforces the path containment boundary: refuses absolute, NUL-containing, and leading-dash paths, then canonicalizes and re-checks containment after symlink resolution. |
| `src/config.ts` | Loads `signalint.config.json`, validates engine/timeout settings, and applies ignore globs. |

### Engines

| Module | Responsibility |
|---|---|
| `src/adapters/oxlint.ts` | Runs Oxlint and normalizes its JSON diagnostics. |
| `src/adapters/tsc.ts` | Resolves the TypeScript project, selects project or build mode, runs the pinned compiler, and parses diagnostics. |
| `src/adapters/biome.ts` | Runs optional Biome checks and normalizes its JSON reporter output. |
| `src/subprocess.ts` | Runs engine processes with timeouts, output ceilings, abort handling, and Windows/POSIX process-tree termination. |
| `src/abort.ts` | Links MCP cancellation to adapter subprocess cancellation. |
| `src/engineFanout.ts` | Settles all engine tasks independently so one failing engine cannot discard another's diagnostics, and maps each outcome to an `ok`/`error`/`disabled` status. |

### Diagnostics pipeline

| Module | Responsibility |
|---|---|
| `src/checkFiles.ts` | Coordinates per-file snapshots, engine config hashes, cache decisions, and the different file-local/whole-program strategies. |
| `src/cache/sqliteCache.ts` | Stores per-engine file results and the latest whole-program result in `.signalint/cache.sqlite`, bounded by LRU eviction. |
| `src/cluster/clusterEngine.ts` | Groups normalized issues by rule, assigns cluster IDs and priority, samples distinct issue IDs, and truncates responses. |
| `src/defaultExclusions.ts` | Removes diagnostics whose path contains a `node_modules` segment, independently of user configuration. |

### Session state

| Module | Responsibility |
|---|---|
| `src/memory/sessionMemory.ts` | Tracks issue-signature appearances, restores a bounded tail of JSONL history, adds loop warnings, and appends check metrics. |
| `src/memory/sessionLogStorage.ts` | Reads the newest JSONL entries without loading the whole file, and rotates the log once it exceeds its size budget. |
| `src/sessionLog.ts` | Shared JSONL parser that skips malformed and crash-truncated lines and reports how many were skipped. |
| `src/stats.ts` | Aggregates `.signalint/session.jsonl` into payload, cache, latency, and loop-warning statistics. |

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

### Cache key

The file-cache key combines five components:

```text
sha256(file content) : engine : engine-config hash : signalint version : engine version
```

The two version components exist so that upgrading Signalint or upgrading an
engine invalidates prior results, rather than silently serving diagnostics
computed by older code. Keys written by earlier versions are invalidated lazily
on the next check of that engine.

### Cache bounds

The cache is bounded rather than unlimited. Reads refresh an entry's timestamp,
so eviction is least-recently-used: on insert, rows beyond the row limit
(`DEFAULT_CACHE_ROW_LIMIT`, 10,000) are deleted oldest-first.

The session log is bounded the same way. `SessionMemory` replays only a recent
tail at startup instead of reading the whole file, and the log is rotated to a
`.1` backup once it would exceed its size budget.

## `check_files` data flow

1. `src/index.ts` validates the MCP arguments through `src/toolArguments.ts` and
   loads project configuration.
2. Requested paths are resolved and containment-checked by `src/projectPaths.ts`;
   ignored paths are removed, then `src/checkFiles.ts` reads the remaining files
   and computes engine-specific config hashes.
3. File-local cache hits are reused. Oxlint and optional Biome receive only misses;
   tsc is skipped only when all supplied TypeScript-relevant snapshots still match
   the last whole-program result.
4. Enabled engines run concurrently through `src/engineFanout.ts`. Each adapter
   runs via `src/subprocess.ts`; cancellation or timeout terminates the engine
   process tree. An engine that fails is recorded as
   `{ status: "error", message }` while other engines' diagnostics are preserved.
5. Unconditional `node_modules` exclusions and configured ignore globs remove
   diagnostics that should not reach the caller.
6. `src/cluster/clusterEngine.ts` assigns `clusterId` values and builds the
   `schemaVersion: "1.1"` response, ordered by priority ascending (1 is most
   urgent) and limited to ten clusters by default.
7. `SessionMemory` updates diagnostic appearances, adds any loop warning, records
   cache/payload/latency metrics, and appends `.signalint/session.jsonl`.
8. The MCP handler returns the response as JSON text and retains the latest issues
   for `get_issue_detail`.

Issue references that no longer exist in the latest successful result return the
explicit stale reference response defined in `src/schema.ts`.

## Where to read next

- [README.md](README.md) — install, configure, and use the server.
- [CONTRIBUTING.md](CONTRIBUTING.md) — development setup and pull request process.
- [AGENTS.md](AGENTS.md) — coding standards enforced in this repository.
- [SECURITY.md](SECURITY.md) — threat model and trust boundaries.
- [docs/history/](docs/history/) — original build plan and audit trail.
