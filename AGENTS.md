# AGENTS.md — Operating Rules for Signalint

You are building Signalint, an MCP server described in `signalint-plan.md` in this
repo. That file is the source of truth for architecture, schema, and phase order.
Read it in full before writing any code, and re-read the relevant section before
starting each phase.

## Coding standards

- TypeScript strict mode is mandatory (`"strict": true` in tsconfig). Never use `any`
  — use `unknown` and narrow, or define a proper type.
- Functions should do one thing. If a function exceeds ~40 lines, consider splitting it.
- Every module under `src/adapters/`, `src/cache/`, `src/cluster/`, `src/memory/` must
  have a corresponding test file under `test/` before it is considered done.
- No new runtime dependency may be added without first checking: (a) does the standard
  library or an already-installed package cover this? (b) is the package actively
  maintained (commit within last 6 months)? If unsure, ask the human before installing.
- All public functions and MCP tool handlers need a one-line JSDoc comment stating
  what they do and what they assume about their input.
- Match the data schema in Section 7 of the plan exactly. If you believe the schema
  needs to change, stop and propose the change — do not silently add or rename fields.

## Workflow

- Follow the phase order in Section 13 of the plan. Do not start a phase until the
  previous phase's acceptance criteria are met AND verified by an actually-passing
  test, not just a visual read of the code.
- At the end of each phase, write a short summary (3-5 bullet points) of what was
  built and confirm the acceptance criteria against it explicitly.
- Commit at phase boundaries with a message like `feat(phase-1): engine adapters
  for oxlint and tsc`. Do not squash multiple phases into one commit.
- Phase 7 (website) and Phase 8 (dashboard) must not start until Phase 6 is marked
  complete by the human. If asked to start them early, remind the human of this gate
  and ask for explicit confirmation before proceeding.
- Whenever a change you make affects the compiled MCP server (anything under
  `src/` that gets built to `dist/`), end your report with an explicit reminder:
  the human must run `npm run build` AND disconnect/reconnect (or restart) their
  MCP client for the change to actually take effect — a stale running process or
  un-rebuilt `dist/` will silently keep serving old behavior even after you've
  committed and pushed a real fix. Do not assume this is obvious; state it plainly
  every time, since this exact mistake has already cost real debugging time once.

## When to stop and ask the human (do not guess or proceed silently)

Stop and ask when:
1. A design decision in the plan conflicts with what you're finding during
   implementation (e.g., oxlint's actual output format differs from what Section 7
   assumes).
2. You need to add a new external dependency not already listed in Section 6.
3. You're about to write code that executes a subprocess, writes files outside the
   project directory, or touches anything network-related beyond what's specified.
4. An acceptance criterion in Section 13 is ambiguous or you cannot find a way to
   verify it automatically.
5. You've hit the same failing test 3 times with different fix attempts — this is
   exactly the kind of loop Signalint itself is meant to catch; don't keep guessing,
   summarize what you tried and ask for direction.
6. Anything involving money, publishing to npm/GitHub publicly, or deleting data.

Do NOT stop and ask for:
- Routine implementation choices already covered by the plan (naming a variable,
  choosing between two equivalent ways to write a loop, etc.) — just proceed.
- Anything reversible and low-risk that's clearly within a phase's stated tasks.

## Style for commit messages, docs, and any user-facing copy

- No hype language ("revolutionary," "blazing fast," "game-changing"). State facts
  and, where possible, numbers.
- No emoji in code, commit messages, or docs unless the human explicitly asks.
- Prefer showing a real example (input → output) over describing a feature abstractly.
