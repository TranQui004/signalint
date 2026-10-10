# Security

## Reporting a vulnerability

Do not publish exploit details in a public issue. Report privately through GitHub's
[Security Advisories](https://github.com/TranQui004/signalint/security/advisories/new)
for this repository (Security tab → "Report a vulnerability"), which is enabled for
this project.

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

## Advisory evaluation (GHSA-frvp-7c67-39w9)

Evaluated 2026-07-26 and re-evaluated 2026-10-06. In the current repository lockfile (`pnpm-lock.yaml`), this advisory is **resolved**.

- Advisory: [GHSA-frvp-7c67-39w9](https://github.com/advisories/GHSA-frvp-7c67-39w9), moderate severity.
- Installed dependency path: `signalint-mcp` -> `@modelcontextprotocol/sdk@1.32.0` -> `@hono/node-server`.
- Affected component: `@hono/node-server <2.0.5`'s separately exported `serveStatic` middleware on Windows. An encoded backslash (`%5C`) in an HTTP URL could bypass prefix-mounted middleware under the configured static root.
- Resolved component version: `pnpm-lock.yaml` resolves `@hono/node-server@2.1.3` (satisfying the patched `>=2.0.5` range).
- Audit verification: `pnpm audit --prod` reports `No known vulnerabilities found` against the committed lockfile.

### Runtime isolation analysis

Even prior to resolution in the lockfile, Signalint's runtime never exercised the vulnerable component:
- Signalint imports only `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js` and constructs only that transport in `src/index.ts`.
- The stdio transport operates strictly on `process.stdin` and `process.stdout`. It creates no HTTP listener, parses no request URL, and serves no filesystem path.
- The SDK's HTTP transport (`@modelcontextprotocol/sdk/server/streamableHttp.js`) and `@hono/node-server/serve-static` are not imported or instantiated anywhere in Signalint.
- The exploit conditions (HTTP listener, attacker-controlled URL path, static root, and `serveStatic` middleware) are absent from Signalint's stdio-only server.

This assessment is specific to the stdio-only transport. Any future addition of an HTTP transport, static file serving, or dashboard interface must re-evaluate dependency attack surfaces before implementation.
