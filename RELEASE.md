# Release checklist

Signalint is published from CI only. Nothing is published from a developer
machine. A release starts by pushing a tag that matches `v*.*.*` (or triggering manual
dispatch) and whose version matches `package.json`.

## 1. Prepare (through a pull request)

1. Bump `version` in `package.json`.
2. Bump `version` **and** `packages[0].version` in `server.json`. The workflow
   fails the publish job if either disagrees with `package.json`.
3. Move the `## Unreleased` entries in `CHANGELOG.md` into a new
   `## <version> - YYYY-MM-DD` section.
4. Update anything version-specific in `README.md`, `docs/`, and `action.yml`.
5. Open a pull request, wait for CI (Windows, Linux, macOS) and merge to `main`.

## 2. Tag from updated `main`

```sh
git switch main
git pull
git tag vX.Y.Z
git push origin vX.Y.Z
```

## 3. What the workflow does

`.github/workflows/release.yml` then:

1. Runs the gate (`lint`, `typecheck`, `test`, `build`) on Windows, Linux and
   macOS.
2. Fails if the tag version does not match `package.json` `version`.
3. Builds and runs `npm pack --dry-run` so the packed file list is visible in
   the log.
4. Runs `npm publish --provenance --access public` with the `NPM_TOKEN` secret
   (skipped if already published on npm).
5. Verifies `server.json` matches `package.json`, then publishes the listing to
   the official MCP Registry with `mcp-publisher` (GitHub OIDC) with automatic
   retry for npm propagation delay (skipped if already on the MCP Registry).
6. Creates or updates the GitHub Release with title and notes grouped by
   `type(scope):` commit prefixes.

Re-running the workflow or triggering it via workflow dispatch after a partial failure
is safe: published artifacts on npm and MCP Registry are idempotently detected.

## 4. After the release

- Move the `v1` major tag so the GitHub Action can be pinned to a stable ref:

  ```sh
  git tag -f v1 vX.Y.Z
  git push -f origin v1
  ```

- Verify the listings:

  ```sh
  npm view signalint-mcp version
  gh release view vX.Y.Z
  ```

  MCP Registry listing:
  `https://registry.modelcontextprotocol.io/v0.1/servers/io.github.TranQui004%2Fsignalint/versions/latest`

- Smoke-test the published tarball in a clean project:

  ```sh
  npx --yes signalint-mcp@X.Y.Z init
  npx --yes -p signalint-mcp@X.Y.Z signalint check .
  npx --yes -p signalint-mcp@X.Y.Z signalint doctor
  ```

## One-time setup

- Repository secret `NPM_TOKEN`: an npm **automation** token for
  `signalint-mcp`. A classic token with 2FA blocks on the interactive OTP
  prompt.
- `package.json` must keep `mcpName` equal to `name` in `server.json`. The
  registry reads `mcpName` from the published npm metadata and it cannot be
  added to a version after that version is published, so verify it before the
  first publish of a new version.
- `server.json` `description` is limited to 100 characters by the registry
  schema (`2025-12-11`); keep it short.
