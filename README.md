# Signalint

Signalint is a local MCP server for JavaScript and TypeScript diagnostics. It runs
Oxlint, TypeScript, and optionally Biome; caches unchanged checks; clusters repeated
issues; and warns when the same diagnostic disappears and repeatedly returns.
Loop history is restored from valid `.signalint/session.jsonl` entries when the MCP
server restarts; malformed or crash-truncated lines are skipped.

## Requirements

- Node.js 20.19 or later in the Node 20 line, or Node.js 22.12 or later
- A JavaScript or TypeScript project; TypeScript checks require a `tsconfig.json`

## Install

From the project that Signalint should check:

```sh
npm install --save-dev signalint-mcp
```

Create `signalint.config.json` in that project root, or omit it to use the defaults:

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
`%USERPROFILE%\.gemini\antigravity\mcp_config.json` on Windows. During local
dogfooding, Antigravity did not resolve npm-link-generated `.cmd` shims reliably,
so point it directly at the compiled server entrypoint:

```json
{
  "mcpServers": {
    "signalint": {
      "command": "node",
      "args": ["<absolute-path-to-signalint>/dist/src/index.js"],
      "cwd": "<absolute-path-to-your-project>"
    }
  }
}
```

Run `npm run build` in the Signalint checkout before using that path, then restart
or reconnect Antigravity. After `signalint-mcp` is published to npm, this setup can
use the same `npx --no-install signalint-mcp` pattern documented for Claude Code
and Cursor; direct Node invocation is the current local-checkout instruction.

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

Engine-native configuration remains in `.oxlintrc*`, `tsconfig.json`, and
`biome.json`/`biome.jsonc`. Changing one invalidates that engine's Signalint cache.

`timeoutsMs` sets positive-integer subprocess deadlines in milliseconds. Defaults are
30 seconds for Oxlint, 120 seconds for tsc, and 30 seconds for Biome. A timed-out
engine and its child processes are terminated, and the MCP tool returns a structured
`status: "timeout"` response.

## Known Limitations

Signalint's tsc adapter requires a single `tsconfig.json` at the project root.
Monorepos need a root `tsconfig.json` using TypeScript Project References.

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
and stdio transport. Clean checks with zero raw payload are excluded from the
reduction average, and older checks with missing metrics remain counted without
contributing to the unavailable aggregate.

The CLI exits with code 1 when issues are found. To exercise an actual MCP
`check_project` call against the installed package, run:

```sh
node node_modules/signalint-mcp/examples/check-project.mjs .
```

For a pre-release packed build, replace the registry install with the tarball while
leaving all other steps unchanged:

```sh
npm pack
cd /path/to/clean-sample-project
npm install --save-dev /absolute/path/to/signalint-mcp-0.1.0.tgz
node node_modules/signalint-mcp/examples/check-project.mjs .
```

## Development

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

If a global npm shim cannot find `npm-cli.js`, build directly with `node node_modules/typescript/bin/tsc -p tsconfig.json`.

`npm publish` is intentionally not part of Phase 5. Use `npm pack --dry-run` and a
fresh tarball install until the public launch is explicitly approved.

## Security

See [SECURITY.md](SECURITY.md) for the current npm audit advisory, its evaluated
runtime reachability, and the conditions that require reassessment.
