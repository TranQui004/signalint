# Signalint

[![CI](https://github.com/TranQui004/signalint/actions/workflows/ci.yml/badge.svg)](https://github.com/TranQui004/signalint/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/signalint-mcp.svg)](https://www.npmjs.com/package/signalint-mcp)
[![M8ven Score](https://m8ven.ai/badge/mcp/tranqui004-signalint-1u4yke)](https://m8ven.ai/mcp/tranqui004-signalint-1u4yke)

Signalint is a local MCP server for JavaScript and TypeScript diagnostics. It runs
Oxlint, TypeScript, and optionally Biome; caches unchanged checks; clusters repeated
issues; and warns when the same diagnostic disappears and repeatedly returns.
Loop history is restored from valid `.signalint/session.jsonl` entries when the MCP
server restarts; malformed or crash-truncated lines are skipped.

**Listed on:**
- [![TranQui004/signalint MCP server](https://glama.ai/mcp/servers/TranQui004/signalint/badges/score.svg)](https://glama.ai/mcp/servers/TranQui004/signalint)
- [mcpservers.org](https://mcpservers.org/servers/tranqui004/signalint)
- [![M8ven Score](https://m8ven.ai/badge/mcp/tranqui004-signalint-1u4yke)](https://m8ven.ai/mcp/tranqui004-signalint-1u4yke)
- Official MCP Registry ([API listing](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.TranQui004%2Fsignalint/versions/latest))

## Diagnostic compression example

When a coding agent requests diagnostics on a project, raw compiler and linter outputs quickly flood the context window with repetitive errors across multiple files. Signalint normalizes issues and clusters them by root cause before returning a bounded, priority-ranked response:

### Raw engine output (7,370 bytes) & normalized diagnostics (52 issues across 11 files · 19,103 bytes)

```json
[
  {
    "issueId": "b2dbbc348dd564e942cc317d434c39d4ac3a1a925d3d53fe23d5d184ce8b820a",
    "file": "src/file01.ts",
    "line": 3,
    "col": 14,
    "engine": "tsc",
    "rule": "TS2322",
    "severity": "error",
    "message": "Type 'string' is not assignable to type 'number'.",
    "fixable": false
  },
  // ... 51 more raw normalized issues
]
```

### Clustered response returned to agent (2 clusters · 655 bytes minified / 954 bytes pretty · 86.4% reduction vs raw, 94.8% vs normalized)

> *Measurement note (2026-10-08, signalint v1.0.0, oxlint v1.86.0, tsc v7.0.2):* This hero example was measured on a fixture where nearly all 52 issues share two systemic root causes — a best case, not an average. See [docs/benchmarks.md](docs/benchmarks.md) for full breakdown across mixed and multi-rule repositories.

```json
{
  "schemaVersion": "1.4",
  "status": "issues_found",
  "projectRoot": "/path/to/project",
  "engines": {
    "oxlint": { "status": "ok" },
    "tsc": { "status": "ok" }
  },
  "totalIssues": 52,
  "clusters": [
    {
      "clusterId": "c4588dda",
      "rootCauseSummary": "21 TS2322 issues across 11 files",
      "ruleIds": ["TS2322"],
      "issueCount": 21,
      "fileCount": 11,
      "priority": 1,
      "suggestedAction": "Review the shared cause of TS2322 across 11 files",
      "sampleIssueIds": [
        "b2dbbc348dd5",
        "86420b99c641"
      ]
    },
    {
      "clusterId": "c8920ad6",
      "rootCauseSummary": "31 no-unused-vars issues across 11 files",
      "ruleIds": ["no-unused-vars"],
      "issueCount": 31,
      "fileCount": 11,
      "priority": 5,
      "suggestedAction": "Review the shared cause of no-unused-vars across 11 files",
      "sampleIssueIds": [
        "62989a92f293",
        "5fd3182b7608"
      ]
    }
  ],
  "remainingIssues": [],
  "omittedIssueCount": 0,
  "truncated": false,
  "checkId": "7e3c2bd2",
  "loopWarning": null,
  "fileRuleChurnWarning": null
}
```

The agent receives a concise summary with priority-ordered clusters and sample issue IDs. When deeper detail is needed for a specific cluster or issue, the agent calls `get_issue_detail` without re-running the whole-project scan.

## When not to use Signalint

Signalint is built specifically to compress diagnostic feedback for coding agents operating inside token-constrained context windows. It may not be the right fit for:

- **Projects already served by a fast IDE + CI loop:** If human developers are working in VS Code or WebStorm with instant inline squiggles and fast CI runs, raw compiler feedback is already immediate.
- **Projects under ~10 diagnostics per check:** On small diagnostic sets, the fixed JSON envelope (~500–850 bytes) is comparable to or larger than raw output. Signalint pays for itself when diagnostics share root causes or exceed ~15 issues.
- **Projects relying on custom ESLint plugin rules:** While Signalint can invoke project-local ESLint, Oxlint is the primary high-speed linter and does not execute arbitrary third-party ESLint plugin rules.
- **Monorepos without a root solution-style `tsconfig.json`:** TypeScript checks resolve from the target project root's `tsconfig.json`. Monorepos with fragmented sub-packages not linked via project references are not yet automatically scanned across package boundaries.
- **Anyone needing autofix or security scanning:** Signalint exposes strictly read-only MCP tools (`readOnlyHint: true`) and produces diagnostic feedback; it does not write fixes to disk or perform SAST / dependency vulnerability scans.

## Requirements

- Node.js 22.12 or later (uses built-in `node:sqlite`)
- A JavaScript or TypeScript project; TypeScript checks require a `tsconfig.json`
- pnpm 11.9.0 for source development

## Install

Install Signalint in the project it should check:

```sh
npm install --save-dev signalint-mcp
```

### Install size & package footprint

Signalint declares `oxlint`, `typescript`, and `@biomejs/biome` as optional peer dependencies (`peerDependenciesMeta.*.optional: true`). When installing Signalint in a repository that already has its own compiler and linter, npm and pnpm do not install duplicate bundled engines by default:

| Package manager | Default `node_modules` install size |
|---|---|
| `npm install --save-dev signalint-mcp` | ~27 MB |
| `pnpm add -D signalint-mcp` | ~27 MB |

**Commands used to measure:**
```sh
npm pack
mkdir test-install && cd test-install
npm init -y
npm install --no-audit --no-fund ../signalint-mcp-<version>.tgz
node -e 'const fs = require("fs"), path = require("path"); function sz(d){let s=0;for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=path.join(d,e.name);s+=e.isDirectory()?sz(f):fs.statSync(f).size;}return s;}console.log((sz("node_modules")/(1024*1024)).toFixed(1)+" MB");'
# Outputs: ~17 MB on Windows / ~27 MB on Linux with native platform bindings
```

If the project does not have `oxlint` or `typescript` installed, run `npx signalint-mcp doctor` to view status and installation hints.

Run the setup command from that project root. It detects TypeScript, Oxlint,
Biome, flat ESLint, and Prettier configuration, writes `signalint.config.json`,
appends `.signalint/` to `.gitignore`, and offers to update a nearby MCP
configuration for Claude Code, Cursor, Codex CLI, Antigravity, VS Code,
Windsurf, or Zed:

```sh
npx signalint-mcp init
```

If no MCP client can be selected safely, the command prints exact configuration
snippets to copy. TypeScript is enabled only when a root `tsconfig.json` exists;
ESLint is enabled when a flat config (`eslint.config.*`) exists; Biome is enabled
when its config exists; Oxlint is the fallback when no other configured linter is detected.
To configure Signalint manually, create `signalint.config.json`:

```json
{
  "engines": {
    "oxlint": true,
    "tsc": true,
    "biome": false,
    "eslint": false
  },
  "ignore": ["node_modules/**", "dist/**", ".signalint/**"],
  "timeoutsMs": {
    "oxlint": 30000,
    "tsc": 60000,
    "biome": 30000,
    "eslint": 30000
  }
}
```

### Engines and resolution

Signalint supports four diagnostic engines:
- **TypeScript (`tsc`)**: Whole-project type checking using `tsconfig.json`. Timeout default is 60s.
- **Oxlint (`oxlint`)**: Ultra-fast file-local linter.
- **Biome (`biome`)**: Fast linter and formatter. Suppresses formatter diagnostics by default and captures safe fix recommendations from advices.
- **ESLint (`eslint`)**: Flat config (`eslint.config.*`) linter. Signalint does not bundle ESLint — it resolves your project's local ESLint installation without extra dependencies and reports true fixable diagnostics (`fixable: true`).

**Resolution order:** For each engine, Signalint checks the target project's `node_modules` first (`require.resolve` / `node_modules/.bin`), ensuring diagnostics match the project's own tool versions. If the project does not have the engine installed, Signalint falls back to its bundled copy (for `oxlint`, `tsc`, `biome`) or marks it disabled with an actionable message (for `eslint`). The resolved engine version is hashed into cache keys to ensure cache invalidation across tool upgrades.

## Supported clients

| Client | Project-scoped (preferred) | User/global (fallback) | Config format / key | Working directory (`cwd`) |
|---|---|---|---|---|
| **Claude Code** | `<root>/.mcp.json` | `~/.claude.json` | JSON (`mcpServers`) | Automatic (Claude sets `cwd` to project root) |
| **Cursor** | `<root>/.cursor/mcp.json` | `~/.cursor/mcp.json` | JSON (`mcpServers`) | Supported (emitted for project scope only) |
| **Codex CLI** | `<root>/.codex/config.toml` | `~/.codex/config.toml` | TOML (`[mcp_servers.<name>]`) | Supported (emitted for project scope only) |
| **Antigravity** | `<root>/.agents/mcp_config.json` | `~/.gemini/config/mcp_config.json` | JSON (`mcpServers`) | Not emitted (runs in active workspace) |
| **VS Code** | `<root>/.vscode/mcp.json` | User settings (`chat.mcp.servers`) | JSON (`servers`) | Not supported |
| **Windsurf** | — | `~/.codeium/windsurf/mcp_config.json` | JSON (`mcpServers`) | Not emitted |
| **Zed** | — | `~/.config/zed/settings.json` | JSON (`context_servers`) | Not supported |

## Claude Code setup

Run this from the checked project. Project scope writes a shareable `<root>/.mcp.json`:

```sh
claude mcp add --scope project signalint -- npx --no-install signalint-mcp
claude mcp get signalint
```

On native Windows, wrap `npx` as required by Claude Code:

```powershell
claude mcp add --scope project signalint -- cmd /c npx --no-install signalint-mcp
claude mcp get signalint
```

Restart Claude Code if it was already open. Ask it to call Signalint's `ping` tool,
then call `check_project` with `{ "paths": ["."] }`.

See the [Claude Code MCP documentation](https://docs.anthropic.com/en/docs/claude-code/mcp)
for scope and troubleshooting details.

## Cursor setup

Create `<root>/.cursor/mcp.json` in the checked project:

```json
{
  "mcpServers": {
    "signalint": {
      "command": "npx",
      "args": ["--no-install", "signalint-mcp"],
      "cwd": "/path/to/project"
    }
  }
}
```

On native Windows, use `"command": "cmd"` and
`"args": ["/c", "npx", "--no-install", "signalint-mcp"]`. Open Cursor's MCP
settings, enable `signalint`, and call `ping` followed by `check_project`.

See the [Cursor MCP documentation](https://docs.cursor.com/context/model-context-protocol)
for configuration locations and status controls.

## Codex CLI setup

The Codex CLI supports both project-scoped and user-scoped TOML configuration.
For project-scoped configuration (trusted projects only), write `<root>/.codex/config.toml`:

```toml
[mcp_servers.signalint]
command = "npx"
args = ["--no-install", "signalint-mcp"]
startup_timeout_sec = 20
cwd = "/path/to/project"
```

On native Windows, use `cmd` with arguments:

```toml
[mcp_servers.signalint]
command = "cmd"
args = ["/c", "npx", "--no-install", "signalint-mcp"]
startup_timeout_sec = 20
cwd = "C:\\path\\to\\project"
```

To configure Codex CLI globally (without pinning a working directory):

```sh
codex mcp add signalint -- npx --no-install signalint-mcp
```

See the [Codex MCP documentation](https://developers.openai.com/codex/mcp)
for configuration options including timeouts, `env`, and tool approvals.

## Antigravity setup

Antigravity supports two verified configuration locations:
- **Project-scoped (preferred):** `<root>/.agents/mcp_config.json`
- **User-scoped (global fallback):** `~/.gemini/config/mcp_config.json`

Project configuration in `<root>/.agents/mcp_config.json`:

```json
{
  "mcpServers": {
    "signalint": {
      "command": "npx",
      "args": ["--no-install", "signalint-mcp"]
    }
  }
}
```

On native Windows, use `"command": "cmd"` and `"args": ["/c", "npx", "--no-install", "signalint-mcp"]`.

> **Migration note:** Earlier versions wrote to `~/.gemini/antigravity/mcp_config.json`. If you have a legacy `signalint` entry in that file, delete it to avoid configuration shadowing. Run `npx signalint-mcp doctor` to check for and report legacy entries.

See [antigravity.google/docs/mcp](https://antigravity.google/docs/mcp) for documentation.

## VS Code setup

Add Signalint to `<root>/.vscode/mcp.json` using the `servers` key:

```json
{
  "servers": {
    "signalint": {
      "command": "npx",
      "args": ["--no-install", "signalint-mcp"]
    }
  }
}
```

## Multiple projects & troubleshooting

### The global configuration trap
When an MCP server is configured in a global user configuration file (`~/.claude.json`, `~/.cursor/mcp.json`, `~/.gemini/config/mcp_config.json`, or `~/.codex/config.toml`) with an absolute `cwd` path, the MCP server will **always** check the hardcoded project directory—regardless of which project or workspace is currently active. This causes silent false-positives or checking the wrong code.

To prevent this:
1. **Prefer project-scoped configuration:** Always keep the MCP config inside the project root (`.mcp.json`, `.cursor/mcp.json`, `.agents/mcp_config.json`, `.vscode/mcp.json`, or `.codex/config.toml`).
2. **Never pin `cwd` in user configs:** Signalint `init` will never emit a `cwd` key when writing to a user-scoped configuration.
3. **Environment variable override:** Set `SIGNALINT_PROJECT_ROOT=/path/to/project` to force Signalint to target a specific project directory when an MCP client does not launch from the project root.
4. **Uninitialized projects:** By default, Signalint requires running `signalint init` so `signalint.config.json` exists. If you need to check an uninitialized project, set `SIGNALINT_ALLOW_UNINITIALIZED=1`.

### Diagnosing configuration with `signalint doctor`

Run `doctor` to inspect your project and detect common configuration issues:

```sh
npx signalint-mcp doctor
```

`doctor` checks:
- Project root resolution and `signalint.config.json` presence.
- JavaScript / TypeScript project markers.
- Diagnostic engine availability (project-local vs. bundled copies) and versions.
- Active MCP client configs, flagging any stale `cwd` entries that point to a different repository.
- Legacy configuration files (such as `~/.gemini/antigravity/mcp_config.json`).

## Windows troubleshooting

Windows `.cmd` shims created by `npm link` can expose a junction path to Node. If
`signalint-mcp` ends with an initialize/EOF error or `signalint stats` exits with
code 0 but prints nothing, bypass the shim with the compiled entrypoint paths:

```powershell
node C:\absolute\path\to\Signalint\dist\src\index.js
node C:\absolute\path\to\Signalint\dist\src\cli.js stats
```

Current builds canonicalize linked paths before deciding whether to start, but direct
Node invocation remains the reliable fallback for older builds or unusual npm setups.

## Configuration

`engines.oxlint`, `engines.tsc`, `engines.biome`, and `engines.eslint` are booleans.
Defaults are Oxlint and tsc enabled; Biome and ESLint disabled. Omitted engine keys
retain those defaults. ESLint is only used when the project has a flat config
(`eslint.config.*`) and installs ESLint itself.
Unknown keys and incorrectly typed values fail with a configuration error.

`ignore` is an array of project-relative globs. Signalint supports `*`, `**`, and
`?`, normalizes Windows separators, and excludes matching requested paths and
diagnostics. Because tsc is a whole-program engine, it still receives the complete
`tsconfig.json` program when invoked; ignored TypeScript paths do not trigger an
incremental `check_files` run and their diagnostics are removed from the response.

Engine-native configuration remains in native files. The v1 cache hash recognizes
root `.oxlintrc`, `.oxlintrc.json`, `oxlint.json`, `tsconfig.json`, `biome.json`,
and `biome.jsonc`. Changing one invalidates the related engine cache. Other valid
sources—including `.oxlintrc.jsonc`, extended configs, and nested package configs—
are not part of v1 cache hashing; clear `.signalint/` after changing one of them.

`timeoutsMs` sets positive-integer subprocess deadlines in milliseconds. Defaults are
30 seconds for Oxlint, 60 seconds for tsc, 30 seconds for Biome, and 30 seconds for
ESLint. A timed-out engine and its child processes are terminated. In the schema 1.3
check response, that engine has `{ "status": "error", "message": "tsc did not complete
within 60s" }` under `engines`, while completed engines' diagnostics are preserved.

## Known Limitations

- Signalint supports JavaScript and TypeScript projects only.
- The bundled engines are Oxlint, TypeScript, and Biome. ESLint is supported only
  when the checked project has a flat config (`eslint.config.*`) and installs
  ESLint itself; v1 does not support arbitrary custom engines.
- Signalint reports whether an issue has a structured fix, but v1 does not apply
  fixes.
- Signalint is not a SAST or security scanner.
- There is no IDE extension yet; integrations use MCP or the command-line client.
- Loop detection is deliberately limited to lint, type, and test issue signatures;
  it does not detect general agent-conversation loops.
- The tsc adapter requires one `tsconfig.json` at the project root. Monorepos must
  provide a solution-style root config using TypeScript Project References;
  Signalint does not auto-discover independent package configs.
- `check_files` treats only the files explicitly passed to that call as relevant to
  TypeScript cache invalidation. If file A changes but is omitted while unchanged file
  B is checked, and B depends on A, Signalint can reuse a stale tsc result. Include
  every changed dependency file or run `check_project`; dependency-graph-based
  invalidation is not implemented in v1.

## MCP tools

- `ping` checks that the local server is connected and returns `pong`.
- `check_project` accepts optional `{ "paths": ["."] }` and returns clustered diagnostics.
- `check_files` accepts `{ "files": ["src/file.ts"] }` and uses incremental caching.
- `get_issue_detail` accepts exactly one `clusterId` or `issueId` from the latest
  successful check and returns its full issues, or a `status: "stale"` response.
- `get_loop_status` returns issue signatures currently flagged as oscillating.

Cache and session artifacts are written under `.signalint/` and should not be committed.

## CLI and package smoke test

Run the same project check without an MCP client:

```sh
npx --no-install signalint check .
```

After MCP checks have accumulated in `.signalint/session.jsonl`, print the Phase 6
measurement summary:

```sh
npx --no-install signalint stats
```

The report includes average normalized-raw-to-clustered JSON payload reduction,
engine-file cache hit rate, average and maximum check latency, and the number of
distinct issue signatures that triggered loop warnings. An engine-file lookup counts
each enabled engine separately, so one changed TypeScript file can miss once for
Oxlint and once for tsc. Latency covers handler work from MCP tool entry through
engine/cache work, clustering, and loop evaluation; it excludes the telemetry append
and stdio transport. Statistics include the active session log and its rotated `.1`
backup, with their retained overlap counted once. Clean checks with zero raw payload are excluded from the
reduction average, and older checks with missing metrics remain counted without
contributing to the unavailable aggregate.

The CLI exits with code 1 when issues are found. Two flags support CI use:
`--format github` prints one GitHub Actions annotation
(`::error file=...,line=...,col=...::message` or `::warning ...`) per issue
instead of JSON, and `--fail-on-priority <N>` exits non-zero only if a
cluster's priority is at or below `N` instead of on any issue found.

To exercise an actual MCP `check_project` call against the installed package,
run:

```sh
node node_modules/signalint-mcp/examples/check-project.mjs .
```

## Priority ladder

Signalint orders diagnostic clusters by priority ascending (1 is most urgent, 5 is least urgent).
The priority ladder evaluates severity, systemic scope across multiple files, rule frequency, and
fix availability:

| Priority | Meaning |
|---|---|
| **1** | Error, systemic (many issues across multiple files) |
| **2** | Error, local, no structured fix known |
| **3** | Error, structured fix available |
| **4** | Warning, local, no structured fix known |
| **5** | Warning, structured fix available or systemic-but-cosmetic |

## Compression benchmark

Measured against realistic multi-engine fixture suites (`pnpm bench`):

| Representation | Size | Notes |
|---|---|---|
| (a) Raw engine output | 7,370 bytes | Compact CLI output (`oxlint --format agent` + `tsc --pretty false`) |
| (b) Signalint normalized | 19,103 bytes | Complete structured JSON diagnostics with per-issue metadata |
| (c) Signalint clustered | 1,477 bytes | High-density agent summary response with root causes and priorities |

- **Reduction vs raw engine output:** 80.0%
- **Reduction vs normalized diagnostics:** 92.3%

## GitHub Actions

`action.yml` at the repository root wraps `signalint check` as a composite
action for CI. It installs Node, installs `signalint-mcp` from npm, and runs
the check with `--format github` so issues appear as inline annotations on
the pull request diff:

```yaml
- uses: TranQui004/signalint@v1
  with:
    fail-on-priority: "3"
```

`@v1` is a moving tag that is re-pointed on every `1.x` release; pin
`@v1.0.0` (or any exact tag) when you need a fixed version.

`fail-on-priority` defaults to `5`, which fails the job on any issue found,
matching `signalint check`'s default behavior without the flag. Lower values
only fail the job when a cluster is at least that urgent: priority 1 is a
systemic error, priority 2 is a local error with no fix, priority 3 is an
error with a structured fix, priority 4 is a local warning, and priority 5
is a fixable or systemic-cosmetic warning (see the Priority ladder table above).

## Development

pnpm 11.9.0 is the canonical package manager for source development. The repository
commits `pnpm-lock.yaml`, declares pnpm in `package.json`, and uses pnpm in CI.

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

If a global npm shim cannot find `npm-cli.js`, build directly with `node node_modules/typescript/bin/tsc -p tsconfig.json`.

Before preparing a release, use `npm pack --dry-run` and verify the packed tarball
in a clean project. Publishing requires explicit release approval.

## Security

See [SECURITY.md](SECURITY.md) for the current npm audit advisory, its evaluated
runtime reachability, and the conditions that require reassessment.

## Documentation

- [Website](https://tranqui004.github.io/signalint-site) — overview, docs, and
  live examples.
- [ARCHITECTURE.md](ARCHITECTURE.md) — how the layers fit together and what each
  module does.
- [CONTRIBUTING.md](CONTRIBUTING.md) — development setup, verification, and pull
  requests.
- [AGENTS.md](AGENTS.md) — coding standards for this repository.
- [SECURITY.md](SECURITY.md) — threat model, trust boundaries, and audit status.
- [CHANGELOG.md](CHANGELOG.md) — notable changes by release.
- [RELEASE.md](RELEASE.md) — release checklist: version bumps, tagging, and
  publish targets.
- [docs/history/](docs/history/) — original build plan and pre-launch audit trail.

## License

Signalint is available under the [MIT License](LICENSE).
