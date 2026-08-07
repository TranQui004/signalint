# Signalint

[![CI](https://github.com/TranQui004/signalint/actions/workflows/ci.yml/badge.svg)](https://github.com/TranQui004/signalint/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/signalint-mcp.svg)](https://www.npmjs.com/package/signalint-mcp)

Signalint is a local MCP server for JavaScript and TypeScript diagnostics. It runs
Oxlint, TypeScript, and optionally Biome; caches unchanged checks; clusters repeated
issues; and warns when the same diagnostic disappears and repeatedly returns.
Loop history is restored from valid `.signalint/session.jsonl` entries when the MCP
server restarts; malformed or crash-truncated lines are skipped.

## Requirements

- Node.js 20.19 or later in the Node 20 line, or Node.js 22.12 or later
- A JavaScript or TypeScript project; TypeScript checks require a `tsconfig.json`
- pnpm 11.9.0 for source development

## Install

Install Signalint in the project it should check:

```sh
npm install --save-dev signalint-mcp
```

Run the setup command from that project root. It detects TypeScript, Oxlint, and
Biome configuration, writes `signalint.config.json`, and offers to update a nearby
Claude Code, Cursor, or Antigravity MCP configuration:

```sh
npx signalint-mcp init
```

If no MCP client can be selected safely, the command prints exact configuration
snippets to copy. TypeScript is enabled only when a root `tsconfig.json` exists;
Biome is enabled when its config exists; Oxlint is the fallback when no configured
linter is detected. To configure Signalint manually, create `signalint.config.json`:

```json
{
  "engines": {
    "oxlint": true,
    "tsc": true,
    "biome": false
  },
  "ignore": ["node_modules/**", "dist/**", ".signalint/**"],
  "timeoutsMs": {
    "oxlint": 30000,
    "tsc": 120000,
    "biome": 30000
  }
}
```

## Claude Code setup

Run this from the checked project. Project scope writes a shareable `.mcp.json`:

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

Create `.cursor/mcp.json` in the checked project:

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

On native Windows use `"command": "cmd"` and
`"args": ["/c", "npx", "--no-install", "signalint-mcp"]`. Open Cursor's MCP
settings, enable `signalint`, and call `ping` followed by `check_project`.

See the [Cursor MCP documentation](https://docs.cursor.com/context/model-context-protocol)
for configuration locations and status controls.

## Setting up with Antigravity

Antigravity uses its own MCP configuration file, typically
`%USERPROFILE%\.gemini\antigravity\mcp_config.json` on Windows. The `init` command
can update this file after confirmation. The equivalent Windows configuration is:

```json
{
  "mcpServers": {
    "signalint": {
      "command": "cmd",
      "args": ["/c", "npx", "--no-install", "signalint-mcp"],
      "cwd": "<absolute-path-to-your-project>"
    }
  }
}
```

On macOS or Linux, use `"command": "npx"` and
`"args": ["--no-install", "signalint-mcp"]`. Restart or reconnect Antigravity
after updating the configuration.

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

`engines.oxlint`, `engines.tsc`, and `engines.biome` are booleans. Defaults are
Oxlint and tsc enabled, Biome disabled. Omitted engine keys retain those defaults.
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
30 seconds for Oxlint, 120 seconds for tsc, and 30 seconds for Biome. A timed-out
engine and its child processes are terminated. In the schema 1.1 check response, that
engine has `{ "status": "error", "message": "tsc did not complete within 120s" }`
under `engines`, while completed engines' diagnostics are preserved.

## Known Limitations

- Signalint supports JavaScript and TypeScript projects only.
- The built-in engines are Oxlint, TypeScript, and Biome; v1 does not support
  arbitrary custom engines.
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

The CLI exits with code 1 when issues are found. To exercise an actual MCP
`check_project` call against the installed package, run:

```sh
node node_modules/signalint-mcp/examples/check-project.mjs .
```

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
- [docs/history/](docs/history/) — original build plan and pre-launch audit trail.

## License

Signalint is available under the [MIT License](LICENSE).
