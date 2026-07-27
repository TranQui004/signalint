# Signalint — Agent-Optimized Code Feedback MCP Server

## Project Plan v2.0

**Purpose of this document:** This is the authoritative build plan for Signalint. It is written to be read and executed by an AI coding agent (Claude Code or similar) working alongside a human developer. Every phase has explicit tasks, file/module targets, and measurable acceptance criteria so the agent can self-verify completion before moving to the next phase. Do not skip phases. Do not start Phase N+1 until Phase N's acceptance criteria pass. **Naming note:** this project was previously called "LoopGuard" internally during planning. That name is already in use by an existing, unrelated, near-identical product (see Section 17) and must not be used anywhere — package name, repo name, config file names, docs, or code comments.

---

## 0. Repository & Local Environment

- **Remote repository:** `https://github.com/TranQui004/signalint.git` (private). Keep it private at least through Phase 6 (Section 13) — flip to public only as a deliberate step at launch, not by default.
- **GitHub CLI (`gh`):** installed and authenticated on the local machine. The agent may use it directly for repo operations (issues, PRs, releases, repo settings) instead of raw `git` + manual GitHub web steps where convenient. Before Phase 0 work begins, the agent should run `gh auth status` to confirm the session is valid, and `gh repo view` to confirm it's pointed at the right repo.
- **Local working folder:** `Signalint/` (currently empty, not yet connected to the remote).
- **Phase 0 must therefore also include**, before any other task: initialize the local folder as a git repo, add the existing GitHub repo as `origin`, make an initial commit (even if just this plan file + `AGENTS.md` + `.gitignore`), and push to confirm the connection works end-to-end. Suggested commands for the agent to run and verify (adapt as needed):
  ```bash
  cd Signalint
  git init
  git remote add origin https://github.com/TranQui004/signalint.git
  git branch -M main
  # add signalint-plan.md, AGENTS.md, .gitignore here first
  git add .
  git commit -m "chore: initial plan and agent rules"
  git push -u origin main
  ```
- Do not assume any files exist in the repo beyond what the agent itself creates — the repo is empty at the start of Phase 0.

## 1. Problem Statement

AI coding agents (Claude Code, Cursor, Windsurf, etc.) rely on lint/typecheck/test tools for feedback during autonomous edit loops. Existing tooling has three unsolved problems when consumed by an *agent* rather than a human:

1. **Token waste** — raw linter/compiler output is verbose, unstructured, and repetitive. Agents burn context re-reading near-identical error blocks every iteration.
2. **No incrementality** — most wrappers re-run the full check on every call, even when only one file changed, wasting time and tokens.
3. **No loop memory** — agents can oscillate between two failing states (fixing error A reintroduces error B, and vice versa) because nothing tracks what was already tried.

Signalint is an MCP server that wraps existing fast, best-in-class engines (Oxlint, Biome, tsgo/tsc, a test runner) and adds an agent-optimized layer on top: compact clustered output, hash-based incremental caching, and session-level attempt memory to detect and break fix loops.

## 2. Goals (v1 scope)

- G1: Provide an MCP server exposing tools that give agents fast, compact, structured diagnostics for a JS/TS project.
- G2: Reduce diagnostic payload size (tokens) by at least 70% vs. raw tool output, via clustering and truncation, without losing actionable information.
- G3: Make repeated checks near-instant via file-hash-based incremental caching (target: <300ms for a re-check touching 1-3 files in a mid-size repo).
- G4: Detect when an agent is oscillating between the same 2+ issue signatures across attempts, and surface an explicit warning.
- G5: Ship as a working, documented, installable MCP server (npm package) that a real user can add to Claude Code / Cursor in under 5 minutes.

## 3. Non-Goals (explicitly out of scope for v1)

- NG1: No custom linting/type-checking engine — Signalint orchestrates existing engines (Oxlint, Biome, tsc/tsgo), it does not reimplement them.
- NG2: No support for languages other than JS/TS in v1 (Python/Rust support is a v2 candidate).
- NG3: No autofix application without explicit agent/user action — Signalint reports and suggests, it does not silently mutate code in v1.
- NG4: No IDE extension in v1.
- NG5: No security/SAST scanning (Semgrep-style) in v1 — pure lint/type/test feedback only.
- NG6: No general-purpose AI-session loop detection or prompt/context compression — that space is already served by existing tools (Section 17). Signalint's loop detection is scoped narrowly to lint/type/test issue signatures only, not general conversation or context management.
- NG7 (discovered during Phase 6 dogfooding, 2026-07): No monorepo/multi-tsconfig awareness in v1. The tsc adapter assumes a single `tsconfig.json` at the project root (Section 9.1) and fails with `TS5058` on npm-workspace-style monorepos with per-package tsconfig files and no root config. Workaround for users: add a root `tsconfig.json` using TypeScript Project References pointing at each package. Proper multi-project support (auto-detecting and iterating per-package tsconfigs) is a v2 candidate, not v1 scope — document this limitation clearly in the README (Phase 5/7) so users aren't surprised by it.

## 4. Target User & Primary Use Case

A developer using an AI coding agent (Claude Code, Cursor, etc.) on a JS/TS repository. The agent calls Signalint's MCP tools after making edits, instead of (or in addition to) shelling out to `eslint`/`tsc` directly, to get faster and more actionable feedback.

## 5. Architecture Overview

```
┌─────────────────────────────────────────────┐
│              MCP Server (index.ts)           │
│  Tools: check_project, check_files,          │
│  get_issue_detail, get_loop_status           │
└───────────────┬───────────────────────────────┘
                │
    ┌───────────┼──────────────┬──────────────┐
    ▼           ▼              ▼              ▼
┌─────────┐ ┌─────────┐  ┌───────────┐  ┌────────────┐
│ Engine   │ │ Cache   │  │ Cluster   │  │ Session    │
│ Adapters │ │ Layer   │  │ Engine    │  │ Memory     │
│(oxlint,  │ │(sha256  │  │(groups by │  │(attempt    │
│ tsc,     │ │ hash →  │  │ root      │  │ log, loop  │
│ biome)   │ │ result) │  │ cause)    │  │ detection) │
└─────────┘ └─────────┘  └───────────┘  └────────────┘
```

**Design principle:** each layer is independently testable and replaceable. Engine adapters are the only layer that shells out to external tools; everything above them works purely on the normalized internal schema (Section 7).

## 6. Tech Stack

- **Language:** TypeScript (Node.js ≥ 20)
- **MCP SDK:** `@modelcontextprotocol/sdk` (official TypeScript SDK)
- **Engines wrapped (v1):** `oxlint` (lint), `tsc`/`tsgo` (types), `biome` (format check, optional)
- **Cache store:** SQLite via `better-sqlite3` (simple, embedded, no external service)
- **Testing:** `vitest`
- **Packaging:** npm package, published as `signalint-mcp`
- **CLI mode:** also expose a thin CLI (`signalint check`) for manual dogfooding without an MCP client

## 7. Core Data Schema (all layers must conform to this)

### 7.1 Normalized Issue

```json
{
  "issueId": "string (stable hash of file+rule+line+message template)",
  "file": "relative/path/to/file.ts",
  "line": 42,
  "col": 5,
  "engine": "oxlint | tsc | biome",
  "rule": "no-unused-vars",
  "severity": "error | warning",
  "message": "short one-line message, max ~120 chars",
  "fixable": true,
  "clusterId": "string, optional — absent until Cluster Engine (Phase 3) assigns it"
}
```

**Field rules (amended during Phase 1, see Section 7.4 for the change log):**

- `fixable`: set to `true` **only** when the engine provides a structured fix (a concrete replacement range/text), never merely because the engine attached help/hint text. Default to `false` when in doubt — this field feeds `suggestedAction` in Section 7.2, and overclaiming fixability there misleads the agent consuming it.
- `clusterId`: **optional** (`clusterId?: string`), not a required field with an empty-string placeholder. Absence means "not yet clustered" (true for all Phase 1/2 output, before the Cluster Engine exists). Do not use `""` as a sentinel — treat presence/absence as the signal, not string content, to avoid ambiguity with a genuinely empty-but-valid value elsewhere in the codebase.

### 7.2 Cluster (what the agent sees by default)

```json
{
  "clusterId": "c1",
  "rootCauseSummary": "12 unused imports across 8 files after refactor",
  "ruleIds": ["no-unused-vars"],
  "issueCount": 12,
  "fileCount": 8,
  "priority": 1,
  "suggestedAction": "Remove unused imports; safe to autofix",
  "sampleIssueIds": ["issueId1", "issueId2"]
}
```

### 7.3 Check Response (top-level MCP tool output)

```json
{
  "status": "clean | issues_found",
  "totalIssues": 37,
  "clusters": ["...array of Cluster, sorted by priority ascending — priority 1 (highest urgency) first, max 10 by default..."],
  "truncated": true,
  "loopWarning": null
}
```

### 7.4 Schema Amendment Log

Track every deviation from the original schema here, in order, so anyone reading this plan later understands why the schema doesn't match Section 7's first draft.

- **2026-07 (Phase 1):** `clusterId` changed from required-string to optional-string; `fixable` rule clarified to require structured fix data, not just presence of help text. Trigger: real Oxlint 1.75.0 output didn't match the original assumptions (no `fixable` field at all, and `clusterId` obviously can't exist before Phase 3 runs).
- **2026-07 (Phase 3, pre-implementation):** fixed a genuine contradiction between Section 10 ("priority 1 = highest") and Section 7.3 ("sorted by priority desc"), which would have sorted the least urgent cluster first. Resolved by keeping "1 = highest" and specifying ascending sort explicitly in both sections. Caught by the coding agent before implementation, not after.

## 8. MCP Tools Specification

| Tool | Input | Output | Purpose |
|---|---|---|---|
| `check_project` | `{ paths?: string[] }` | Check Response (7.3) | Full or scoped scan, clustered |
| `check_files` | `{ files: string[] }` | Check Response (7.3) | Incremental check post-edit, uses cache |
| `get_issue_detail` | `{ clusterId or issueId }` | Full Issue list with all fields | Agent drills into a cluster it decided to fix |
| `get_loop_status` | `{}` | `{ looping: bool, signatures: [...] }` | Explicit loop check, also auto-included in check responses |

## 9. Caching Strategy

- Key: `sha256(file content) + engine name + engine config hash`
- Store: SQLite table `cache(key TEXT PRIMARY KEY, result JSON, timestamp INTEGER)`
- Cache invalidation: engine config hash changes (e.g., `.oxlintrc` edited) → invalidate all entries for that engine.

### 9.1 Per-Engine Invocation Strategy (amended Phase 2)

**The original "only re-run engine on changed files" rule does not hold uniformly across engines — it depends on whether the engine's diagnostics are file-local or whole-program.** Trigger for this amendment: real `tsc`/TypeScript 7 output produces `TS5112` when file paths are passed on the command line alongside a `tsconfig.json`, because type information is fundamentally cross-file (a change in file A can produce new diagnostics in file B even though B's own content hash is unchanged). Do not work around this with `--ignoreConfig` — that silently drops `tsconfig.json` settings (paths, strict, target, lib, jsx) and produces diagnostics that don't match the project's real build, which undermines the entire trust premise of this tool.

Split invocation strategy by engine category instead:

- **File-local engines (oxlint, and Biome where used for lint/format rules):** keep the original model — hash each file, only invoke the subprocess for files with a cache miss, one call per changed file (or a single batched call listing only the changed files, if the engine supports batch input).
- **Whole-program engines (tsc):** always invoke with `--project` (never per-file flags), and rely on TypeScript's own `--incremental` mode with a persisted `.tsbuildinfo` file (stored at `.signalint/cache/tsc.tsbuildinfo`) for the compiler's internal speed. Signalint's own file-hash cache is used only to decide **whether to invoke tsc at all** for a given `check_files` call (skip the subprocess entirely if no file relevant to the TS program graph changed since the last check) — not to decide which files tsc analyzes internally. Once invoked, tsc always sees the whole project, as it must to be correct.

This means the Phase 2 acceptance criteria (Section 13) apply differently per engine:

- For oxlint: assert the subprocess is invoked once per changed file (or once total with only changed files as input, depending on final adapter design) — the original assertion.
- For tsc: assert the subprocess is invoked **at most once per `check_files` call**, and **not invoked at all** when no file relevant to the TS program changed since the last check. Do not assert "one call per changed file" for tsc — that requirement was based on an incorrect assumption about how type-checking works and should be removed for this engine.

## 10. Clustering Algorithm (v1, heuristic — no ML needed)

1. Group raw issues by `rule` first.
2. Within a rule group, if issue count > 3 and files > 2, treat as one cluster (likely a systemic/mechanical issue).
3. Rule groups with 1-3 issues remain as individual clusters (likely need individual attention).
4. Priority scoring: **lower number = higher urgency** (like P1/P2 in bug tracking, not a 1-5 star rating). `severity=error` + `fixable=false` → priority 1 (highest, surfaced first); mechanical/fixable clusters → priority 3-5 (lower urgency, can batch-fix). Response ordering is always ascending by this number — see Section 7.3.
5. `rootCauseSummary` generated via simple template, not LLM call, to keep v1 fast and dependency-free: `"{issueCount} {rule} issues across {fileCount} files"`.

## 11. Loop Detection (Session Memory) — narrow scope

- Maintain in-memory map (per MCP session, keyed by process lifetime): `issueSignature → [timestamps of appearance]`
- `issueSignature = rule + normalizedMessage` (strip line numbers/variable names)
- If the same signature disappears then reappears ≥2 times within a session → flag `loopWarning` in the next `check_files` response: `{ signature, occurrences, hint: "This issue was fixed and reappeared N times — consider a different approach" }`
- Persist session log to `.signalint/session.jsonl` for post-hoc debugging (not required for detection logic itself).
- **Scope reminder:** this is deliberately narrow — it only tracks lint/type/test issue signatures, not general agent conversation loops. Do not expand this into a general-purpose agent-loop-detection feature; that is a different, already-served problem (Section 17).

## 12. Repository Structure

```
signalint-mcp/
├── src/
│   ├── index.ts                 # MCP server entrypoint, tool registration
│   ├── adapters/
│   │   ├── oxlint.ts
│   │   ├── tsc.ts
│   │   └── biome.ts
│   ├── cache/
│   │   └── sqliteCache.ts
│   ├── cluster/
│   │   └── clusterEngine.ts
│   ├── memory/
│   │   └── sessionMemory.ts
│   ├── schema.ts                 # Section 7 types, shared across all layers
│   ├── dashboard/                # Phase 8 only — do not build before Phase 6 is done
│   │   └── server.ts             # local read-only web view, opt-in
│   └── cli.ts                    # `signalint check` CLI entrypoint
├── test/
│   ├── fixtures/                 # sample broken repos for integration tests
│   ├── adapters.test.ts
│   ├── cluster.test.ts
│   └── memory.test.ts
├── site/                          # Phase 7 only — separate Astro project, see Section 19
├── signalint.config.json         # user-facing config (which engines, ignore paths)
├── AGENTS.md                      # agent operating rules, see Section 18
├── package.json
└── README.md
```

## 13. Build Phases

Each phase must pass its acceptance criteria before proceeding. **Phases 0-6 are the product. Phases 7-8 do not start until Phase 6 is complete and you have real usage data — do not let website/GUI work delay or replace core functionality.**

### Phase 0 — Scaffold (0.5 day)
- Tasks: init npm package, install `@modelcontextprotocol/sdk`, `better-sqlite3`, `vitest`; create minimal MCP server that responds to a `ping` tool.
- Acceptance: server starts, connects successfully to Claude Code / Claude Desktop as a local MCP server, `ping` tool returns `pong`.

### Phase 1 — Engine Adapters (2 days)
- Tasks: implement `adapters/oxlint.ts` and `adapters/tsc.ts`; each takes file path(s), shells out to the tool, parses output into the Normalized Issue schema (7.1).
- Acceptance: unit tests confirm both adapters correctly parse known sample outputs into valid Normalized Issue arrays; `check_project` tool (raw, unclustered) works end-to-end on a real sample repo.

### Phase 2 — Caching Layer (1 day)
- Tasks: implement `cache/sqliteCache.ts`; wire into adapters per the per-engine invocation strategy in Section 9.1 (file-local engines like oxlint are re-run only on changed files; tsc is invoked whole-project via `--project` + its own `--incremental`/`.tsbuildinfo`, skipped entirely when nothing TS-relevant changed).
- Acceptance: benchmark test proves a re-check of 2 unchanged files + 1 changed file out of a 50-file fixture repo completes in <300ms. Verify via call-count assertion (not timing alone), with per-engine expectations: oxlint invoked only for the changed file; tsc invoked at most once for the whole call, and not invoked at all when no TS-relevant file changed since the prior check.

### Phase 3 — Clustering & Prioritization (1.5 days)
- Tasks: implement `cluster/clusterEngine.ts` per Section 10; wire into `check_project`/`check_files` response building.
- Acceptance: given a fixture with 40 raw issues, clustered output has ≤10 clusters and the serialized JSON is ≥70% smaller (byte count) than the raw issue list.

### Phase 4 — Loop Detection (1 day)
- Tasks: implement `memory/sessionMemory.ts` per Section 11; wire `get_loop_status` tool and auto-inclusion in check responses.
- Acceptance: integration test simulates an oscillating fix sequence (issue A fixed → issue B appears → B fixed → A reappears, repeated twice) and confirms `loopWarning` is populated by the second oscillation.

### Phase 5 — Config, Docs, Packaging (1 day)
- Tasks: `signalint.config.json` support (enable/disable engines, ignore globs); write README with install/setup instructions for Claude Code and Cursor; publish to npm as `signalint-mcp`.
- Acceptance: a fresh clone of a sample project can install Signalint via documented steps and get a working `check_project` call within 5 minutes, verified by a dry run following only the README.

### Phase 6 — Dogfooding & Public Launch (ongoing)
- Tasks: use Signalint on your own real projects with Claude Code for at least 1 week; collect before/after metrics (token count per check, latency, loop incidents caught); write a launch post with real numbers; post to r/ClaudeAI, r/cursor, Hacker News.
- Acceptance: at least one concrete, measured before/after comparison exists and is published alongside the launch post. **Gate: do not start Phase 7 until this is done.**

### Phase 7 — Marketing/Docs Website (3-5 days, only after Phase 6)
See Section 19 for full specification (pages, design system, tech stack).
- Acceptance: site is live on a free host, docs cover every MCP tool and config option, home page loads with zero layout shift and no banned visual patterns (Section 20).

### Phase 8 — Optional Local Dashboard (2-3 days, stretch, only after Phase 7 or in parallel if traction is already validated)
See Section 21 for full specification.
- Acceptance: `signalint dashboard` opens a local read-only page showing last 20 checks, cache hit rate, and any active loop warnings; same design system as Section 20.

### 13.1 Recommended Model per Phase (Codex CLI, ChatGPT Pro)

**Verified against OpenAI's own docs (learn.chatgpt.com/docs/models and /docs/whats-new) as of July 2026 — the previous version of this table referenced GPT-5.1/5.2/5.3-Codex, which are now deprecated for ChatGPT sign-in. Re-check `learn.chatgpt.com/codex/models` before each phase anyway; this family has been revised roughly every 4-6 weeks.**

**Current model family (GPT-5.6, recommended for ChatGPT-signed-in Codex):**

- **Sol** (`gpt-5.6-sol`) — flagship, strongest for complex/ambiguous coding, deep debugging, and anything needing judgment or polish.
- **Terra** (`gpt-5.6-terra`) — balanced everyday workhorse, roughly GPT-5.5-level quality at lower cost/quota. Good default for routine implementation work.
- **Luna** (`gpt-5.6-luna`) — fastest and cheapest, best for narrow, well-defined, repeatable tasks (boilerplate, extraction, structured transforms) where you already know what "done" looks like.
- **5.3 Codex Spark** (`gpt-5.3-codex-spark`, Pro-only, research preview) — near-instant, text-only, meant for tight iterate-and-check loops (e.g. "fix this failing test, re-run, repeat"), not for the final quality pass.
- Reasoning effort levels (independent of which model you pick): **Low → Medium (default) → High → Extra High → Max → Ultra** (Ultra parallelizes across subagents; Max just gives one model more time). Higher effort = better quality but slower and more quota.
- **Deprecated, do not use:** `gpt-5.2`, `gpt-5.3-codex` — no longer available under ChatGPT sign-in.

**General rule for this project:** logic-heavy, correctness-sensitive work (parsing, caching, algorithms, loop detection) → **Sol at High or Extra High reasoning**. Routine/well-scoped implementation → **Terra at Medium**. Pure boilerplate/repeatable work → **Luna at Low/Medium**. This balances your Pro quota against quality: don't spend Sol-tier reasoning on tasks Luna handles just as well.

| Phase | Nature of work | Recommended model + effort | Why |
|---|---|---|---|
| 0 — Scaffold | Boilerplate, config files, git setup | `gpt-5.6-luna`, Low | Low ambiguity, low risk, speed and quota matter more than depth |
| 1 — Engine Adapters | Parsing real tool output correctly, edge cases | `gpt-5.6-sol`, High | Wrong parsing silently corrupts every layer above it; correctness-critical |
| 2 — Caching Layer | Hashing/invalidation logic, edge cases | `gpt-5.6-sol`, High | Cache bugs are subtle and easy to miss without careful reasoning |
| 3 — Clustering & Prioritization | Heuristic algorithm design | `gpt-5.6-sol`, Medium-High | Needs genuine design judgment, not just boilerplate |
| 4 — Loop Detection | State machine logic, session memory | `gpt-5.6-sol`, High | Same correctness sensitivity as Phase 2 |
| 5 — Config, Docs, Packaging | Writing docs, README, npm publish steps | `gpt-5.6-terra`, Medium | Mostly writing and following documented steps, not novel logic |
| 6 — Dogfooding & Launch | Using the tool, writing a factual launch post | `gpt-5.6-terra`, Medium | Not a heavy coding task, mostly human-driven |
| 7 — Website | Astro/frontend code, must strictly follow Section 20 design constraints | `gpt-5.6-sol`, Medium-High | Design-constraint adherence (avoiding the banned patterns) benefits from real judgment, not just fast templating |
| 8 — Dashboard | Small local frontend, read-only views | `gpt-5.6-terra`, Medium | Small, well-scoped surface area |

**Quota-saving tip specific to your Pro plan:** for the tight debug loops inside Phases 1, 2, and 4 (write test → run → fix → re-run), consider using **5.3 Codex Spark** for the fast inner iterations, then switch to **Sol at High** for the final implementation you actually commit. This keeps the expensive, high-reasoning calls reserved for the pass that matters, rather than every intermediate attempt. Don't use Spark for the code you're about to commit and mark a phase "done" on — only for throwaway iteration.

If a given Codex surface only exposes one model with adjustable reasoning (rather than the Sol/Terra/Luna picker), keep the model fixed and vary reasoning effort per the table instead (High for Phases 1-4 and 7, Low-Medium for Phases 0, 5, 6, 8).

## 14. Success Metrics (v1)

- ≥70% reduction in diagnostic payload size vs. raw tool output (measured, not estimated)
- <300ms incremental check latency on a mid-size repo (≤500 files) for a 1-3 file change
- At least 1 real loop-breaking event demonstrated in a dogfooding session
- Successful install + first use by at least 5 external users within 30 days of publishing

## 15. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Oxlint/tsc output format changes between versions | Pin versions in `package.json`, add adapter tests against fixture snapshots |
| Clustering heuristic too naive, groups unrelated issues | Start simple (Section 10), treat as tunable; log clustering decisions for later review |
| MCP ecosystem already saturated with lint servers, hard to get attention | Differentiate explicitly on caching + diagnostic-clustering in all marketing copy; lead with measured numbers, not claims |
| Session memory lost on MCP server restart | Acceptable for v1 (in-memory only); document as known limitation |
| Scope creep from website/GUI delaying the actual product | Hard gate: Phase 7/8 cannot start before Phase 6 is complete (enforced in Section 13) |
| Monorepo/multi-tsconfig projects fail with TS5058 (Section 3, NG7) | Documented as explicit v1 non-goal; README must state the root-tsconfig-with-project-references workaround clearly |

## 16. Instructions for the Coding Agent (see also Section 18, AGENTS.md)

- Work phase by phase, in order. Do not begin implementation of a later phase before the current phase's acceptance criteria are verifiably met (write and run the test, don't just assert it mentally).
- All new code must conform to the schema in Section 7 — do not introduce ad-hoc fields without updating this document first.
- Every adapter, cache function, and cluster function must have a corresponding test in `test/`.
- If a design decision in this document turns out to be wrong during implementation, stop and flag it explicitly rather than silently deviating — update this document with the change and reasoning before continuing.

## 17. Competitive Landscape & Differentiation (honest assessment)

Research as of July 2026 found the following adjacent/overlapping projects. Read this before writing any marketing copy — do not claim uniqueness that isn't true.

- **"LoopGuard"** (existing, unrelated to this project) — a free VS Code extension + MCP integration that <cite index="23-1">detects repeat-fix loops in AI coding sessions and shrinks prompts/context before they reach the model, with MCP integration for Claude Code, Cursor, Codex CLI, Windsurf, and GitHub Copilot.</cite> This is why the project was renamed to Signalint — same name, overlapping loop-detection concept, already shipped and free.
- **LoopSense MCP** — <cite index="27-1">an open-source MCP server that gives agents visibility into CI results, deployments, test outcomes, and file system changes after the agent takes an action.</cite> Different focus (CI/deploy feedback, not lint/type diagnostics), but adjacent "close the feedback loop for agents" positioning.
- **Several existing MCP servers already wrap ESLint/TypeScript/Biome/Prettier** for agent consumption, including at least one that <cite index="13-1">integrates Biome, ESLint, and Playwright into a single MCP server for code quality tooling,</cite> and another that <cite index="13-1">exposes real-time VS Code diagnostics (TypeScript, ESLint, Prettier) via multiple tools including a workspace health score.</cite> These are direct competitors for the "lint via MCP" surface.
- One commentator building in this exact space noted bluntly that <cite index="11-1">the MCP ecosystem has hundreds of new servers built every week but "zero quality tooling."</cite> Read as: the surface-level idea (wrap a linter in MCP) is commoditized and low-effort to copy; the defensible part is execution quality, not the idea itself.

**What remains genuinely differentiated for Signalint, honestly stated:**
1. The specific combination of hash-based incremental caching + root-cause clustering *for lint/type/test diagnostics specifically* (not general context/conversation) — not observed in any single existing project during this research.
2. Narrow, disciplined scope (Section 3, NG6) — competitors doing "general agent loop detection" are solving a broader, fuzzier problem; Signalint solves one measurable thing well.
3. Measured, published before/after numbers (Section 14) as the core marketing asset, rather than feature claims — most competitors found during research lead with feature lists, not benchmarks.

**What this means practically:** do not market this as "the first" or "the only" tool that does X. Market it as measurably faster/leaner at one specific job, with numbers to prove it.

---

## 18. Agent System Prompt (save as `AGENTS.md` in repo root)

Copy the block below verbatim into `AGENTS.md` at the project root before starting Phase 0. This governs how the coding agent should behave for the rest of the project.

```markdown
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
```

---

## 19. Website Specification (Phase 7)

**Tech stack:** Astro (static site generator, near-zero JS by default, first-class Markdown/MDX for docs via content collections). Hosted free on Cloudflare Pages (preferred) or GitHub Pages.

**Pages required:**

1. **Home** — hero section with a concrete, factual value statement (not generic SaaS copy), a bento-grid section where each cell demonstrates one real capability with an actual example (before/after diagnostic payload, actual latency number), an install code block (`npx signalint-mcp init` or equivalent), and links to Docs / GitHub.
2. **Docs** (sidebar-navigated, multi-page):
   - Getting Started / Installation
   - Configuration Reference (every `signalint.config.json` field, documented)
   - MCP Tools Reference (each tool from Section 8: input schema, output schema, one real example)
   - Architecture / How It Works (reuse the diagram from Section 5)
   - FAQ
   - Troubleshooting
3. **Changelog** — plain reverse-chronological list, sourced from GitHub releases.
4. **Open Source / GitHub page** — license (MIT recommended), contributing guide, link to repo. No separate pricing page needed; state "free and open source" as a single line in the footer/home page instead of a dedicated page.

## 20. Design System — "quiet, functional minimalism" (applies to both website and dashboard)

**Hard constraints — do not use, under any circumstance:**
Gradient backgrounds, gradient buttons, glow effects, neon effects, glassmorphism, floating blobs, random abstract decorative shapes, excessive box-shadows, overly rounded cards (border-radius beyond ~6-8px), generic SaaS hero layouts (giant centered headline + gradient blob + "Get Started" pill button), artificial futuristic styling, auto-generated stock UI patterns.

**Positive direction (Notion-inspired, but not a Notion clone):**

- **Color:** near-white warm background (e.g. `#FAFAF8`, not pure `#FFFFFF`), near-black text (e.g. `#1A1A1A`, not pure `#000000`). Exactly **one** muted accent color for links/active states/primary actions (e.g. a desaturated blue or ochre — pick one and use it consistently, never as a gradient). No dark-mode-by-default; if dark mode is added later, it must follow the same "no pure black, no neon accent" rule.
- **Typography:** one clean system/humanist sans for body and headings (e.g. Inter or system-ui stack), one monospace for code/data/config examples (e.g. JetBrains Mono or ui-monospace). Hierarchy is built with size and weight, not color or effects.
- **Cards and separation:** use 1px solid borders (e.g. `rgba(0,0,0,0.08)`) instead of box-shadow to separate content blocks. Avoid drop shadows entirely except a single, very subtle shadow reserved for actual overlays (dropdowns, modals) — never on static cards.
- **Radius:** small and consistent, 4-6px across all elements. No pill-shaped buttons, no large blobby corners.
- **Layout:** content-first, generous whitespace, left-aligned text (avoid centered walls of text). The bento grid on the home page must contain real content (a real code snippet, a real number, a real diagram) in every cell — not decorative icons or placeholder text.
- **Icons:** simple line-style, functional only (used to aid scanning, e.g. next to a nav item), never as decorative hero graphics.
- **Imagery:** use real screenshots, real diagrams, or real data visualizations only. No stock illustrations, no abstract 3D renders, no AI-generated hero art.
- **Motion:** minimal. Simple opacity/position transitions on interaction (e.g. hover state, accordion open) are fine; no scroll-triggered parallax, no floating/pulsing elements.

## 21. Optional Local Dashboard Specification (Phase 8, stretch)

A read-only local web page, served by the MCP server itself on an opt-in local port (e.g. `signalint dashboard` starts a server on `localhost:4848` and opens the browser). Same design system as Section 20, but data-dense rather than marketing-oriented (tables and lists, not a hero section).

**Views:**
- **Recent checks** — table of the last 20 `check_project`/`check_files` calls: timestamp, files touched, issue count, cache hit rate for that call.
- **Active clusters** — current unresolved clusters from the last check, same data as the MCP tool response, rendered as a simple list.
- **Loop warnings** — timeline of any loop warnings raised in the current session, with the issue signature and occurrence count.

No write actions in v1 — this is a debugging/visibility companion for the human, not a control panel. Do not add authentication/remote access in v1; it binds to localhost only.

**Security gate before starting this phase:** `SECURITY.md` (written during Phase 5) documents that the project's current npm audit exception (`GHSA-frvp-7c67-39w9`, a moderate advisory in `@hono/node-server`'s `serveStatic` path) only holds because Signalint runs stdio-only, with no HTTP listener and no static file serving. This dashboard is exactly the kind of change that invalidates that reasoning — it introduces a local HTTP server. Before implementing Phase 8, re-run the audit-path analysis from `SECURITY.md` against whatever HTTP mechanism the dashboard actually uses (the MCP SDK's `streamableHttp.js`, a separate lightweight server, etc.) and update `SECURITY.md` accordingly. Do not assume the earlier "stdio-only, not affected" conclusion still applies.
