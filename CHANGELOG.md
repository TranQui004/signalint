# Changelog

All notable changes to this project are documented in this file. Entries are
grouped by release and summarize the actual commit history; see `git log` for
full detail.

## 0.2.0

- Added `signalint-mcp init`: detects TypeScript, Oxlint, and Biome
  configuration in the target project, writes `signalint.config.json`, and
  offers to update a nearby Claude Code, Cursor, or Antigravity MCP
  configuration.
- Split current architecture documentation (`ARCHITECTURE.md`) from the
  historical build plan, moving the original planning record to
  `docs/history/` for provenance without treating it as current behavior.
- Linked the live Signalint documentation website from `README.md`.
- Corrected `README.md`'s description of cache and timeout behavior to match
  the implemented `timeoutsMs` config and cache-key versioning.

## 0.1.0

Initial public release.

- MCP server exposing `ping`, `check_project`, `check_files`,
  `get_issue_detail`, and `get_loop_status`.
- Engine adapters for Oxlint and TypeScript (`tsc`), with optional Biome
  support; each engine's diagnostics are normalized to a shared issue schema.
- Per-engine incremental caching: file-local engines (Oxlint, Biome) are
  re-run only on cache misses; the whole-program `tsc` engine is skipped
  entirely when nothing relevant to the TypeScript program changed. The cache
  key includes file content hash, engine config hash, the installed Signalint
  version, and the resolved engine version, so upgrading either invalidates
  stale entries.
- Clustering and prioritization of diagnostics by rule to reduce payload size
  and surface the most urgent issues first.
- Session-scoped loop detection: tracks recurring issue signatures across
  checks and flags a `loopWarning` when the same diagnostic disappears and
  reappears within a session. History is restored from
  `.signalint/session.jsonl` on restart, skipping malformed or
  crash-truncated lines.
- `signalint check` and `signalint stats` CLI commands for use without an MCP
  client, including the Phase 6 measurement summary (payload reduction, cache
  hit rate, latency, loop-warning counts).
- Response schema versioned `1.1`: engine fan-out settles independently per
  engine (`ok | error | disabled`) so one failing engine no longer discards
  diagnostics already produced by another, and each engine subprocess has a
  configurable timeout that terminates the process tree on expiry.
- Security hardening: strict Zod validation of all MCP tool arguments, path
  containment checks resolved against the canonical project root (including
  symlink/junction resolution), and unconditional filtering of
  `node_modules` diagnostics.
- Cross-platform CI matrix (Windows, Linux, macOS) plus a Node 20.19
  compatibility job, and fixes for Windows `npm link` shim and process-tree
  termination issues found during that work.
- Documented the v1 monorepo/multi-`tsconfig` limitation (a single root
  `tsconfig.json` using TypeScript Project References is required; per-package
  config auto-discovery is out of scope for v1).
