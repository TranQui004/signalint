# Security

## Reporting a vulnerability

Do not publish exploit details in a public issue. Until a private reporting channel
is added, contact the repository owner through GitHub and request a private channel.

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
