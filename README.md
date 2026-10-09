# Signalint

[![CI](https://github.com/TranQui004/signalint/actions/workflows/ci.yml/badge.svg)](https://github.com/TranQui004/signalint/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/signalint-mcp.svg)](https://www.npmjs.com/package/signalint-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.12.0-brightgreen.svg)](package.json)

**Signalint** is a reliable, read-only-by-default diagnostic intelligence layer for AI coding agents (Claude Code, Cursor, Codex, VS Code) and CI workflows.

Instead of flooding an agent's context window with thousands of raw compiler lines, Signalint normalizes diagnostics across compilers, linters, and language servers into **bounded, priority-clustered issue summaries**, calculates **verification deltas** against explicit baselines, and detects **oscillating fix loops**.

---

## Key Differentiators

- **13 Complete MCP Tools:** From incremental checks and immutable snapshots to live diagnostic ingestion and transactional fix previews.
- **Verification Deltas:** Exact arithmetic on introduced, resolved, and unchanged diagnostics with semantic identity matching that survives line shifts.
- **Immutable Snapshots:** Isolated in-memory snapshot store eliminates race collisions during concurrent checks.
- **Monorepo-Aware Planning:** Unites package manifests (`pnpm-workspace.yaml`) and TypeScript Project References, ordering checks topologically and isolating incremental `.tsbuildinfo` per package.
- **Multi-Source Provenance:** Distinguishes compiler, linter, and editor/LSP diagnostics across JavaScript, TypeScript, Python (Ruff/Mypy), Rust (Clippy), and Go (GolangCI-Lint).
- **Portable Host Hooks:** Native verify-after-change adapters for Claude Code, Cursor, Codex, and VS Code.
- **Transactional Previews & Atomic Rollback:** In-memory previews never touch disk; apply is atomic and automatically rolls back on failure with drift detection.

---

## Quick Start

### 1. Requirements
- Node.js >= 22.12.0 (utilizes native `node:sqlite`).
- Your project installs its own diagnostic engines (`typescript`, `oxlint`, `eslint`, and/or `@biomejs/biome`). Signalint detects project-local installations and ships no bundled engines.

### 2. Initialize in your repository
```sh
npx signalint init
```
This detects your project's linters/compilers, generates `signalint.config.json`, and configures your installed MCP clients.

### 3. Add to MCP Clients
Add Signalint to your MCP configuration (e.g. `claude_desktop_config.json`, `.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "signalint": {
      "command": "npx",
      "args": ["-y", "signalint-mcp"]
    }
  }
}
```

---

## Complete MCP Tools Catalog

Signalint exposes **13 strictly typed MCP tools** over stdio:

| Tool | Category | Safety Annotation | Description |
|---|---|---|---|
| `ping` | Diagnostics | Read-only (`idempotent`) | Verifies server responsiveness and canonical project root path. |
| `check_project` | Diagnostics | Read-only (`idempotent`) | Full project/workspace scan across all enabled engines. |
| `check_files` | Diagnostics | Read-only (`idempotent`) | Fast incremental check on specific files using content-hash caching. |
| `get_issue_detail` | Diagnostics | Read-only (`idempotent`) | Retrieves full, unomitted issue records for a specific cluster or issue ID. |
| `get_loop_status` | Diagnostics | Read-only (`idempotent`) | Returns oscillating fix signatures and rule churn detected in the session. |
| `get_diagnostic_snapshot` | Snapshots | Read-only (`idempotent`) | Retrieves complete state and metrics for an immutable check snapshot. |
| `compare_diagnostics` | Deltas | Read-only (`idempotent`) | Computes verification delta between a baseline check and a current check. |
| `after_edit_check` | Deltas | Read-only (`idempotent`) | Runs incremental check on edited files and diffs against a baseline check. |
| `ingest_diagnostics` | Live / LSP | Read-only (`openWorld: false`) | Ingests external LSP or compiler diagnostics into Signalint's clustering model. |
| `get_live_diagnostics` | Live / LSP | Read-only (`idempotent`) | Returns active buffered diagnostics with source provenance. |
| `preview_diagnostic_fix` | Transactions | Read-only (`destructive: false`) | Stages proposed code fixes in-memory. **Does not write to disk.** |
| `apply_diagnostic_fix` | Transactions | **Mutating** (`destructive: true`) | Atomically applies fixes with automatic rollback and post-check delta. |
| `discard_diagnostic_fix` | Transactions | Read-only (`idempotent`) | Drops an in-memory fix transaction without touching disk. |

See [docs/mcp-contract.md](docs/mcp-contract.md) for full JSON Schemas and error codes.

---

## CLI Commands

Signalint includes a comprehensive command-line interface:

```sh
# Run a project diagnostic scan:
npx signalint check .
npx signalint check src/ --format github    # GitHub Actions annotations

# View session statistics and cache economics:
npx signalint stats

# Verify local engine availability and configuration:
npx signalint doctor

# Manage host verify-after-change hooks:
npx signalint hooks preview --runtime claude
npx signalint hooks install --runtime cursor --confirm
npx signalint hooks run --runtime claude --payload '<json-event>'
```

---

## Monorepo Support

Signalint natively understands multi-package monorepos:
- Configure `"monorepoMode": "auto"` in `signalint.config.json` to detect `pnpm-workspace.yaml`.
- Builds a topological dependency graph uniting package manifests and TypeScript project references.
- Caches whole-program TypeScript builds in isolated per-package directories (`.signalint/cache/tsc/<project-id>/`).
- Changes to a shared package automatically invalidate dependent packages while keeping independent siblings cached.

See [docs/monorepo.md](docs/monorepo.md) for configuration and architecture.

---

## Verify-After-Change Hooks

Automate post-edit verification without creating infinite agent loops:
- Native adapters for **Claude Code**, **Cursor**, **Codex**, and **VS Code**.
- Emits bounded context into prompt windows and blocks only on unresolved syntax/type errors.

See [docs/hooks.md](docs/hooks.md) for setup instructions.

---

## Documentation Index

- [Architecture & Subsystems](ARCHITECTURE.md)
- [MCP Protocol Contract & Schemas](docs/mcp-contract.md)
- [Host Hook Adapters Guide](docs/hooks.md)
- [Monorepo Planning & Incremental TypeScript](docs/monorepo.md)
- [Known Limitations & Risk Register](docs/known-limitations.md)
- [Wire Reduction Benchmarks](docs/benchmarks.md)
- [Security & Threat Model](SECURITY.md)

---

## License

[MIT](LICENSE) © 2026 Tran Trong Qui
