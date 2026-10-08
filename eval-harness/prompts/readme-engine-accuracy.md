# Prompt: `docs(readme): correct the "bundled engines" claim — engines are project-installed since 1.1.0`

> Hand this prompt to the coding agent as-is. Docs-only change, one file, no release.

---

## 0. Sync before you start

```bash
git fetch origin
git rev-parse --short origin/main        # must be 0151f35
git checkout -b docs/engine-resolution-accuracy origin/main
```

- Current `main` tip: **`0151f35`** — `chore(release): 1.1.2 (#61)`, parent `a0ce50d` = PR #60.
- **Do not** branch from, merge, or use as a PR head the branch `arena/63badebc-signalint`. It is a research branch that forked from `e9ebfe5` and is 13 commits behind `main`; it is never merged into `main`.
- Optional: pull the evidence files (they only add `eval-harness/`, so they cherry-pick cleanly onto `main`):

```bash
git fetch origin arena/63badebc-signalint
git cherry-pick c5f5e9d 2f1ad13 34890b1 28fcd0f 38c9adf
# or, without touching history:
git show origin/arena/63badebc-signalint:eval-harness/results/verify-1.1.2.md
```

If a cherry-pick conflicts, skip it — this task does not depend on those files.

---

## 1. Why this change

Since **1.1.0**, `typescript`, `oxlint` and `@biomejs/biome` are **optional peer dependencies only** — `optionalDependencies` was removed. Verified at `0151f35`:

- `peerDependencies`: `typescript@7.0.2`, `oxlint@1.86.0`, `@biomejs/biome@2.5.15`
- `peerDependenciesMeta`: all three `{ "optional": true }`
- `optionalDependencies`: `undefined`

README still promises a bundled fallback. Measured in a clean sandbox:

- `npm init -y && npm i signalint-mcp@1.1.2` → `signalint doctor` reports both engines unavailable → `signalint check .` returns `status: "error"`, `code: "nothing_checked"`, `checkId: "da39a3ee"`.
- After `npm i -D typescript@7.0.2 oxlint@1.86.0` **inside the project** → both engines `ok`, `check` returns a normal response.

**Code detail — get the wording right, do not overcorrect into the opposite error:**

`src/engineResolution.ts` → `resolveEngine()` tries project-local first, then `resolveBundledEngine()` when `info.bundledAvailable` is true. `resolveBundledEngine()` resolves from **Signalint's own install location**:

```ts
const localRequire = createRequire(import.meta.url);
const packageJsonPath = localRequire.resolve(`${info.packageName}/package.json`);
```

Because nothing is shipped anymore, that call throws and is swallowed → the engine is disabled. It only succeeds by accident when the package manager hoists a copy next to Signalint.

So the correct statement is: **Signalint bundles no engine; the checked project must install its own; the legacy bundled path is not something users can rely on.** Do **not** write "the bundled fallback was removed from the code" — the function is still there.

---

## 2. Edits — `README.md` only

Line numbers are at `0151f35`.

### a) ~L121 (Install section)

Stale: *"…npm and pnpm do not install duplicate bundled engines by default"* — they no longer install engines at all.

State that since 1.1.0 Signalint ships no engines and the checked project installs its own, for example:

```bash
npm i -D typescript oxlint      # add @biomejs/biome and/or eslint if you use them
```

Keep the existing `peerDependenciesMeta` explanation intact.

### b) ~L182 (Resolution order)

Remove: *"falls back to its bundled copy (for `oxlint`, `tsc`, `biome`) or marks it disabled with an actionable message (for `eslint`)"*.

Correct meaning:

- Project `node_modules` is checked first (`require.resolve` / `node_modules/.bin`), so diagnostics match the project's own tool versions.
- If the project has no such engine, Signalint marks it **disabled** and the output tells you which package to install — true for all four engines, ESLint included.
- The legacy bundled path only resolves a copy when one happens to sit next to Signalint's own installation; users must not rely on it.
- The resolved engine version is still hashed into cache keys.

### c) ~L335 (`doctor` bullet)

*"Diagnostic engine availability (project-local vs. bundled copies) and versions"*
→ *"Diagnostic engine availability (project-local installs only — Signalint ships no engines) and versions"*.

### d) ~L382 (Known Limitations)

*"The bundled engines are Oxlint, TypeScript, and Biome. ESLint is supported only when…"*
→ Signalint **bundles no engine**; TypeScript, Oxlint, Biome and ESLint must be installed in the checked project, and ESLint additionally requires a flat config (`eslint.config.*`); v1 does not support arbitrary custom engines.

### e) ~L105 (Requirements section)

Add one line: the project must install at least one supported engine (`npm i -D typescript oxlint`); otherwise `check` returns `nothing_checked`.

### Scope guard

- Do **not** touch `docs/known-limitations.md` line 67 — dated "Closed" phase entry, historical wording is fine.
- Do **not** touch `CHANGELOG.md`.
- No source changes, no version bump, no tag.

---

## 3. Verification

1. `grep -n "bundled" README.md` — no sentence may promise a shipped/bundled engine copy for `oxlint`, `tsc` or `biome`.
2. Empirical, in a fresh temp dir, confirming the new text matches reality:

```bash
npm init -y && npm i signalint-mcp@1.1.2
npx signalint doctor          # engines reported unavailable with an install hint
npm i -D typescript@7.0.2 oxlint@1.86.0
npx signalint doctor          # both engines ok
```

Optional real check: copy `signalint.config.json`, `tsconfig.json`, `.oxlintrc.json` and `src/` from `eval-harness/projects/mixed-app` (fetch from `origin/arena/63badebc-signalint`), then `npx signalint check .` returns a populated response.

3. `pnpm install --frozen-lockfile && pnpm run build` succeeds; CI green (docs-only — tests are unchanged, but CI must still pass).

---

## 4. Definition of done

- One commit: `docs(readme): state that engines are project-installed, not bundled since 1.1.0`
- **1 file changed** (`README.md`), no version bump, no CHANGELOG entry, no tag.
- PR from `docs/engine-resolution-accuracy` → `main`, CI green, then merge.
