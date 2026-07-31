# Security

## Reporting a vulnerability

Do not publish exploit details in a public issue. Until a private reporting channel
is added, contact the repository owner through GitHub and request a private channel.

## Threat model and tool-argument trust

Signalint treats every MCP tool argument as untrusted. A coding model can be
prompt-injected by repository content, generated text, or another tool response, so
an argument does not become trusted merely because it arrived through an authorized
MCP client.

The server enforces these boundaries before reading a client-selected path or
starting an engine:

- every tool input is parsed by a strict runtime Zod schema; unknown properties,
  wrong container types, non-string path entries, invalid reference unions, and path
  arrays over 512 entries are refused with structured MCP errors;
- absolute, NUL-containing, and leading-dash paths are rejected;
- relative paths are resolved against the canonical project root, checked for
  lexical escape, resolved through filesystem symlinks/junctions, and checked again
  after canonicalization;
- `check_files`, `check_project`, and tsc project-file selection all use the same
  containment module; tsc also re-checks the final `tsconfig.json` selected while
  walking parent directories;
- Oxlint and Biome receive `--` before file arguments. TypeScript 7 does not support
  an end-of-options separator, so tsc receives only the already-contained canonical
  config path and never receives client-supplied source-file flags.

Post-validation, Signalint directly reads only selected files and recognized config
files inside the project root. Its own persistent writes are limited to
`.signalint/` under that root. Engine stdout and stderr are bounded, and all engine
process trees are terminated on timeout, connection cancellation, or server
shutdown.

This containment is not an operating-system sandbox. Signalint and its child
engines run with the permissions of the user who launched the MCP server. A trusted
project configuration can cause an engine to resolve imports, TypeScript `extends`
entries, plugins, or packages using that engine's normal filesystem behavior,
including references outside the project root. Run Signalint only on projects and
engine configurations you are willing to execute with your current user account;
the tool-argument boundary prevents a prompt-injected model from selecting arbitrary
outside paths directly, but it does not reduce the underlying OS account's
permissions.

## Known npm audit advisory

Checked on 2026-07-26 for Signalint 0.1.0:

- Advisory: [GHSA-frvp-7c67-39w9](https://github.com/advisories/GHSA-frvp-7c67-39w9),
  moderate severity.
- Installed dependency path: `signalint-mcp` ->
  `@modelcontextprotocol/sdk@1.29.0` -> `@hono/node-server@1.19.15`.
- Affected component: `@hono/node-server <2.0.5`'s separately exported
  `serveStatic` middleware on Windows. An encoded backslash (`%5C`) in an HTTP URL
  can bypass prefix-mounted middleware and expose a file elsewhere under the
  configured static root. The advisory does not describe directory escape outside
  that root.
- Patched component version: `@hono/node-server@2.0.5`. npm currently reports no
  automatic fix because MCP SDK 1.29.0 declares the dependency as `^1.19.9`.

### Why Signalint's current runtime path does not exercise it

Signalint imports `StdioServerTransport` from
`@modelcontextprotocol/sdk/server/stdio.js` and constructs only that transport in
`src/index.ts`. The installed SDK's stdio module imports Node's `process` object and
the SDK's JSON-line buffer helpers. Its receive path listens to `process.stdin`; its
send path writes serialized MCP messages to `process.stdout`. It creates no HTTP
server, parses no request URL, and serves no filesystem path.

The SDK's HTTP implementation is a separate module,
`@modelcontextprotocol/sdk/server/streamableHttp.js`. That module imports
`getRequestListener` from `@hono/node-server`; Signalint does not import it. The
vulnerable static-file implementation is another separate package export,
`@hono/node-server/serve-static`, and neither Signalint nor the SDK stdio module
imports `serveStatic`.

The exploit therefore lacks all required conditions in the current Signalint
entrypoint: there is no HTTP listener, attacker-controlled URL path, static root, or
`serveStatic` middleware. This conclusion is limited to the current stdio-only
server. It must be reassessed before adding an HTTP transport, static file serving,
or a dashboard server.

Re-run `npm audit` when the MCP SDK updates its Hono dependency range or a compatible
patched release becomes available, and remove this exception once the installed
dependency resolves to `@hono/node-server >=2.0.5`.
