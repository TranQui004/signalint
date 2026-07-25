# Signalint

Signalint is a local MCP server for JavaScript and TypeScript diagnostics. It runs
Oxlint, TypeScript, and optionally Biome; caches unchanged checks; clusters repeated
issues; and warns when the same diagnostic disappears and repeatedly returns.

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
  "ignore": ["node_modules/**", "dist/**", ".signalint/**"]
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

## MCP tools

- `ping` checks that the local server is connected and returns `pong`.
- `check_project` accepts optional `{ "paths": ["."] }` and returns clustered diagnostics.
- `check_files` accepts `{ "files": ["src/file.ts"] }` and uses incremental caching.
- `get_loop_status` returns issue signatures currently flagged as oscillating.

Cache and session artifacts are written under `.signalint/` and should not be committed.

## CLI and package smoke test

Run the same project check without an MCP client:

```sh
npx --no-install signalint check .
```

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

`npm publish` is intentionally not part of Phase 5. Use `npm pack --dry-run` and a
fresh tarball install until the public launch is explicitly approved.
