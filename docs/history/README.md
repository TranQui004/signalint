# Project history

This directory holds the original planning and review record for Signalint. It is
kept for provenance and is not maintained as current documentation.

For how the system works today, read [ARCHITECTURE.md](../../ARCHITECTURE.md).

## Contents

- [`build-plan.md`](build-plan.md) — the plan Signalint was built from, including
  the schema specification, per-phase acceptance criteria, a dated amendment log,
  a risk register, and an honest competitive assessment written before launch.

## Why this is kept

The build plan records not just what was decided, but what turned out to be wrong
and was corrected during implementation. Its amendment log (Section 7.4) and risk
register (Section 15) track each change with a date and a trigger.

Two findings are worth surfacing directly, both from a pre-publish security and
correctness review, and both fixed before any public release:

- **Cache keys omitted version components.** File content and engine config could
  be unchanged while Signalint's own code or an engine's version had changed,
  causing a stale cached result to be served by newer code. Fixed by including the
  installed Signalint version and the resolved engine version in the cache key,
  with legacy entries invalidated lazily. Covered by migration tests in
  `test/cache.test.ts`.
- **Engine fan-out discarded successful results.** A `Promise.all` fan-out meant one
  failing engine rejected the whole check, throwing away diagnostics that other
  engines had already produced. Fixed by settling engines independently and
  reporting per-engine `ok`/`error`/`disabled` status, which is why the response
  schema is versioned `1.1`. Covered by `test/engine-fanout.test.ts`.

Both fixes are verifiable in git history alongside the review that prompted them.

## Reading the archive

Treat every statement in `build-plan.md` as a record of intent at the time it was
written, not as a description of current behavior. Where the two disagree, the
code and `ARCHITECTURE.md` are correct.

Two known divergences:

- Section 18 embeds a copy of `AGENTS.md` as it existed during the initial build.
  The live [AGENTS.md](../../AGENTS.md) has since been rewritten and supersedes it.
- Section 13 describes phases 0–8 as a forward-looking sequence. Phases 0–6 are
  complete; phases 7 (website) and 8 (local dashboard) remain unstarted.

Section 21's security gate still applies: the dashboard would introduce an HTTP
listener, which invalidates the stdio-only reasoning in
[SECURITY.md](../../SECURITY.md) and requires a fresh audit-path analysis first.
