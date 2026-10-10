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

`.github/workflows/release.yml` executes in strict sequential order:

1. **Gate job:** Runs checks (`lint`, `typecheck`, `test`, `build`, and tarball smoke tests) on Windows, Linux, and macOS.
2. **Verify release metadata:** (`node scripts/verify-release-metadata.mjs`) validates `package.json`, `server.json`, `server.json.packages[0]`, `action.yml`, and release tag consistency **strictly before** any publication.
3. **Build project:** Compiles TypeScript sources (`pnpm build`).
4. **Pack release tarball:** Generates npm package tarball (`npm pack --json`) and inspects unpacked contents (`dist/src/index.js`, permissions, manifest identity).
5. **Smoke test verified tarball:** Executes end-to-end smoke verification (`node scripts/smoke-tarball.mjs <tarball>`) against the generated artifact.
6. **Generate release notes:** Extracts commit messages grouped by `type(scope):`.
7. **Check publication status:** Checks whether version is already published on npm.
8. **Publish to npm:** Runs `npm publish "${tarball}" --provenance --access public` using repository secret `NPM_TOKEN` (skipped if already published).
9. **Publish to MCP Registry:** Publishes listing to the official MCP Registry via `mcp-publisher` (GitHub OIDC) with automatic retry for npm propagation delay (skipped if already on the MCP Registry).
10. **Create GitHub Release:** Creates GitHub Release with generated release notes.

> All deterministic metadata and artifact checks run before `npm publish`. Steps after `npm publish` are strictly limited to external registry publication and GitHub Release creation.

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
