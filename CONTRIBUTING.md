# Contributing to Signalint

## Development setup

Install Node.js 20.19 or later in the Node 20 line, or Node.js 22.12 or later,
and pnpm 11.9.0. Then clone the repository and install the locked dependencies:

```sh
git clone https://github.com/TranQui004/signalint.git
cd signalint
pnpm install --frozen-lockfile
```

pnpm is the canonical package manager for this repository. Its version is declared
in `package.json`, the dependency lock is `pnpm-lock.yaml`, and CI uses the same
version.

## Local verification

Run all four project checks before opening a pull request:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test` builds the project before running Vitest. Running the explicit build as
well verifies the same command contributors use when launching the compiled MCP
server locally.

## Branches and pull requests

The `main` branch is protected. Create a focused branch, commit your work there,
push it, and open a pull request against `main`. Keep the branch current with
`main`; required checks run against the merged result.

A pull request can merge only after these GitHub Actions checks pass:

- `Test (windows-latest)`
- `Test (ubuntu-latest)`
- `Test (macos-latest)`
- `Test (ubuntu-node-20.19)`

Direct pushes and force-pushes to `main` are blocked, including for administrators.
Do not bypass or disable the checks to merge a change.

## Commit messages

Use the `type(scope): message` pattern. Keep the subject concise and imperative.
Common types include `feat`, `fix`, `test`, `docs`, `refactor`, and `ci`.

Examples:

```text
fix(tsc): traverse solution-style project references
test(subprocess): cover restricted Windows process cleanup
docs(readme): document pre-release installation
```

## Cutting a release

The full checklist lives in [RELEASE.md](RELEASE.md). In short: releases are
published by the `Release` workflow (`.github/workflows/release.yml`), which is
triggered by pushing a tag matching `v*`. Nothing is published from a developer
machine.

Prerequisite, one time: a repository secret named `NPM_TOKEN` holding an npm
**automation** token for `signalint-mcp`. An automation token skips the
interactive OTP prompt that made manual publishing unreliable.

Steps:

```sh
git switch main
git pull
# bump version in package.json and server.json, move CHANGELOG "Unreleased"
# entries into a versioned section, update docs, then merge through a PR
git commit -am "ci(release): 1.0.0"
# after that PR is merged and main is updated:
git tag v1.0.0
git push origin v1.0.0
```

Remember to bump `version` and `packages[0].version` in `server.json` together
with `package.json`; the workflow rejects a mismatch.

The workflow then:

1. Runs the same three-platform gate as CI (`lint`, `typecheck`, `test`, `build`).
2. Fails if the tag version does not match `package.json` `version`, so a tag can
   never publish a different version than it names.
3. Builds, lists the packed contents, and runs
   `npm publish --provenance --access public` with `NPM_TOKEN`.
4. Verifies `server.json` carries the same version and publishes the listing to
   the official MCP Registry with `mcp-publisher` (GitHub OIDC).
5. Generates release notes by grouping commit subjects since the previous tag by
   their `type(scope):` prefix, and creates the GitHub Release with `gh release
   create`.

Because release notes are generated from commit subjects, a commit that does not
follow `type(scope): message` lands under an "Other" heading rather than being
dropped.

If a release fails after `npm publish` succeeded, do not retag the same version:
npm versions are immutable. Bump to the next patch version and tag again.

## Coding and project rules

Read [AGENTS.md](AGENTS.md) before changing code. It defines the TypeScript,
testing, dependency, schema, and trust-boundary standards used by this repository.

[ARCHITECTURE.md](ARCHITECTURE.md) describes how the layers fit together and what
each module is responsible for. For the historical design rationale and the
pre-launch audit trail, see [docs/history/](docs/history/).
