# Monorepo Planning & Incremental TypeScript

Signalint supports multi-package monorepos, uniting package-manager workspace dependency graphs (`pnpm-workspace.yaml`) and TypeScript Project References without risking false cache hits.

---

## 1. Monorepo Configuration

Monorepo planning is controlled via `monorepoMode` in `signalint.config.json` or the `SIGNALINT_MONOREPO_MODE` environment variable:

| Mode | Behavior |
|---|---|
| **`"off"`** *(default)* | Single-project mode. TypeScript inspects the nearest root `tsconfig.json`. Completely backward-compatible with single-package repos. |
| **`"auto"`** | Automatically detects `pnpm-workspace.yaml`. If present and valid, activates topological package planning. If absent or invalid, cleanly falls back to root check. |
| **`"strict"`** | Requires valid workspace configuration. Throws an actionable error if `pnpm-workspace.yaml` is missing or malformed. |

Example `signalint.config.json`:
```json
{
  "monorepoMode": "auto",
  "engines": {
    "oxlint": true,
    "tsc": true,
    "biome": false,
    "eslint": false
  }
}
```

---

## 2. Workspace Graph Resolution

When `monorepoMode` is active:

1. **Package Discovery:**
   - Reads `pnpm-workspace.yaml` to extract package globs (e.g. `packages/*`, `apps/*`, `libs/**`).
   - Discovers packages by matching `package.json` manifests within the resolved globs.
   - Extracts internal `workspace:*` dependencies from `dependencies`, `devDependencies`, and `peerDependencies`.
   - Reads package `tsconfig.json` files and parses TypeScript `references` (`[ { "path": "../shared" } ]`).

2. **Union Dependency Graph:**
   - Constructs a directed acyclic graph (DAG) uniting package-manager dependencies and TypeScript project references.
   - Computes topological execution order using Kahn's algorithm: packages with no dependencies are verified first; dependent packages follow.

3. **Conservative Invalidation & Dependent Closures:**
   - If a shared package (e.g. `packages/ui`) changes, Signalint computes its transitive dependents and schedules all dependent packages (e.g. `apps/web`) for verification.
   - Independent sibling packages (e.g. `apps/docs`) remain 100% cached.

4. **Fail-Safe Fallbacks:**
   - If dependency cycles are detected (`hasCycles: true`), YAML is malformed, or root lockfile/config changes, Signalint falls back conservatively to a full workspace root check (`fallbackReason: "dependency_cycle_detected"`).
   - False cache hits are strictly avoided: over-checking is the intentional safety failure mode.

---

## 3. Isolated Incremental TypeScript Storage

In standard `tsc`, running multiple packages against a single `tsc.tsbuildinfo` causes cache thrashing and state corruption.

Signalint partitions incremental build-info storage per package:
```text
.signalint/cache/tsc/<project-id>/tsc.tsbuildinfo
```
where `<project-id>` is a deterministic slug and cryptographic hash derived from the canonical project root and package relative path (e.g. `packages-lib-b-6bd72152`).

- Build-info directories are created automatically before invoking `--tsBuildInfoFile`.
- Re-checking an unchanged package achieves a 100% cache hit with **zero** spawned `tsc` subprocesses.
