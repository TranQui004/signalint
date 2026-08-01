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

## Coding and project rules

Read [AGENTS.md](AGENTS.md) before changing code. It defines the TypeScript,
testing, dependency, schema, and trust-boundary standards used by this repository.

[ARCHITECTURE.md](ARCHITECTURE.md) describes how the layers fit together and what
each module is responsible for. For the historical design rationale and the
pre-launch audit trail, see [docs/history/](docs/history/).
