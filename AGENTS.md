# AGENTS.md — Operating rules for Signalint

These are the standards for changing code in this repository. They apply to human
contributors and coding agents alike.

Start with [ARCHITECTURE.md](ARCHITECTURE.md) for how the system fits together,
and [CONTRIBUTING.md](CONTRIBUTING.md) for setup and the pull request process.
You do not need to read the historical build plan to make a correct change.

## Coding standards

- TypeScript strict mode is mandatory. Never use `any` — use `unknown` and narrow,
  or define a proper type.
- Functions should do one thing. If a function exceeds ~40 lines, consider splitting it.
- Every module under `src/adapters/`, `src/cache/`, `src/cluster/`, and `src/memory/`
  must have a corresponding test file under `test/` before it is considered done.
- All public functions and MCP tool handlers need a one-line JSDoc comment stating
  what they do and what they assume about their input.
- Match the response schema defined in `src/schema.ts` exactly. It is versioned
  (`schemaVersion`) and has external consumers. If you believe the schema needs to
  change, propose it — do not silently add or rename fields.
- Engine adapters are the only modules permitted to invoke external processes.
  Everything above them operates on `NormalizedIssue` objects.

## Trust boundaries

Signalint treats every MCP tool argument as untrusted, because the model supplying
it can be prompt-injected by repository content. When changing anything that
handles tool input:

- Validate arguments through the strict schemas in `src/toolArguments.ts`.
- Resolve any client-supplied path through `src/projectPaths.ts`. Do not
  reimplement containment checks locally.
- Never pass client-supplied strings to a shell. Adapters spawn a resolved CLI
  entry point directly.

See [SECURITY.md](SECURITY.md) for the full threat model before changing this area.

## Verification

Run all four checks before opening a pull request:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

A change is done when a test actually passes, not when the code looks correct.

**If your change affects anything under `src/` that compiles to `dist/`, say so
explicitly in your summary:** the maintainer must run `pnpm build` *and*
disconnect/reconnect (or restart) their MCP client for the change to take effect.
A stale running process or an un-rebuilt `dist/` will keep serving old behavior
even after a real fix is committed and pushed. State this plainly every time —
this exact mistake has already cost real debugging time once.

## Dependencies

No new runtime dependency may be added without first checking: (a) does the
standard library or an already-installed package cover this? (b) is the package
actively maintained? If unsure, ask a maintainer before installing.

The dependency set is deliberately small and pinned. `better-sqlite3` is a native
module bound to the Node ABI, so changes near it need testing on every supported
Node line.

## When to stop and ask

Stop and ask a maintainer when:

1. Implementation reality conflicts with a documented design decision — for
   example, an engine's actual output format differs from what the adapter assumes.
2. A change requires a new external dependency.
3. You are about to execute a subprocess, write files outside the project
   directory, or add network access.
4. You cannot find a way to verify a change automatically.
5. You have hit the same failing test three times with different fixes. This is
   exactly the kind of loop Signalint itself is built to catch — summarize what
   you tried instead of guessing again.
6. Anything involves money, publishing to npm or making a repository public, or
   deleting data.

Do not stop and ask for routine implementation choices, or for anything reversible
and low-risk that is clearly within the scope of the change you were asked to make.

## Style for commits, docs, and user-facing copy

- Use `type(scope): message`. Common types: `feat`, `fix`, `test`, `docs`,
  `refactor`, `ci`.
- No hype language ("revolutionary," "blazing fast," "game-changing"). State facts
  and, where possible, numbers.
- No emoji in code, commit messages, or docs unless explicitly requested.
- Prefer showing a real example (input → output) over describing a feature abstractly.
