import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { collectProjectIssueResult } from "../src/check/checkProject.js";
import { resolveProjectId, resolveTsBuildInfoPath } from "../src/engines/tsc.js";

describe("Monorepo Incremental TypeScript & Cache Invalidation", () => {
  let tempRoot: string;
  let repoDir: string;
  let stateDir: string;
  let originalStateDir: string | undefined;

  beforeAll(() => {
    const rawTemp = mkdtempSync(join(tmpdir(), "signalint-monorepo-tsc-test-"));
    tempRoot = realpathSync(rawTemp);
    repoDir = join(tempRoot, "repo");
    stateDir = join(tempRoot, "state");
    originalStateDir = process.env.SIGNALINT_STATE_DIR;
    process.env.SIGNALINT_STATE_DIR = stateDir;

    mkdirSync(repoDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });

    // Root workspace files
    writeFileSync(
      join(repoDir, "pnpm-workspace.yaml"),
      "packages:\n  - 'packages/*'\n",
    );
    writeFileSync(
      join(repoDir, "signalint.config.json"),
      JSON.stringify({
        monorepoMode: "auto",
        engines: { tsc: true, biome: false, eslint: false, oxlint: false },
      }),
    );

    // Package B: shared library
    const pkgBDir = join(repoDir, "packages", "lib-b");
    const pkgBSrc = join(pkgBDir, "src");
    mkdirSync(pkgBSrc, { recursive: true });
    writeFileSync(
      join(pkgBDir, "package.json"),
      JSON.stringify({ name: "lib-b", version: "1.0.0" }),
    );
    writeFileSync(
      join(pkgBDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          declaration: true,
          skipLibCheck: true,
        },
        include: ["src/**/*"],
      }),
    );
    writeFileSync(
      join(pkgBSrc, "index.ts"),
      "export const answer = 42;\n",
    );

    // Package A: depends on B
    const pkgADir = join(repoDir, "packages", "app-a");
    const pkgASrc = join(pkgADir, "src");
    mkdirSync(pkgASrc, { recursive: true });
    writeFileSync(
      join(pkgADir, "package.json"),
      JSON.stringify({
        name: "app-a",
        version: "1.0.0",
        dependencies: { "lib-b": "workspace:*" },
      }),
    );
    writeFileSync(
      join(pkgADir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          skipLibCheck: true,
        },
        include: ["src/**/*"],
      }),
    );
    writeFileSync(
      join(pkgASrc, "main.ts"),
      'export const message = "hello";\n',
    );

    // Package C: independent sibling
    const pkgCDir = join(repoDir, "packages", "sibling-c");
    const pkgCSrc = join(pkgCDir, "src");
    mkdirSync(pkgCSrc, { recursive: true });
    writeFileSync(
      join(pkgCDir, "package.json"),
      JSON.stringify({ name: "sibling-c", version: "1.0.0" }),
    );
    writeFileSync(
      join(pkgCDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          skipLibCheck: true,
        },
        include: ["src/**/*"],
      }),
    );
    writeFileSync(
      join(pkgCSrc, "sibling.ts"),
      "export const siblingId = 123;\n",
    );
  });

  afterAll(() => {
    if (originalStateDir !== undefined) {
      process.env.SIGNALINT_STATE_DIR = originalStateDir;
    } else {
      delete process.env.SIGNALINT_STATE_DIR;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("isolates .tsbuildinfo paths per project/package ID", () => {
    const pkgAPath = join(repoDir, "packages", "app-a", "tsconfig.json");
    const pkgBPath = join(repoDir, "packages", "lib-b", "tsconfig.json");

    const idA = resolveProjectId(pkgAPath, repoDir);
    const idB = resolveProjectId(pkgBPath, repoDir);
    expect(idA).not.toEqual(idB);
    expect(idA).toMatch(/^packages-app-a-/);
    expect(idB).toMatch(/^packages-lib-b-/);

    const buildInfoA = resolveTsBuildInfoPath(pkgAPath, repoDir);
    const buildInfoB = resolveTsBuildInfoPath(pkgBPath, repoDir);
    expect(buildInfoA).not.toEqual(buildInfoB);
    expect(buildInfoA).toContain(idA);
    expect(buildInfoB).toContain(idB);
  });

  it("executes topological checks, writes isolated buildinfo, and achieves 100% cache hits on second run", async () => {
    const firstResult = await collectProjectIssueResult(["."], repoDir);
    expect(firstResult.issues).toEqual([]);
    expect(firstResult.cache.misses).toBeGreaterThan(0);

    const pkgAPath = join(repoDir, "packages", "app-a", "tsconfig.json");
    const pkgBPath = join(repoDir, "packages", "lib-b", "tsconfig.json");
    const pkgCPath = join(repoDir, "packages", "sibling-c", "tsconfig.json");

    const buildInfoA = resolveTsBuildInfoPath(pkgAPath, repoDir);
    const buildInfoB = resolveTsBuildInfoPath(pkgBPath, repoDir);
    const buildInfoC = resolveTsBuildInfoPath(pkgCPath, repoDir);

    expect(existsSync(buildInfoA)).toBe(true);
    expect(existsSync(buildInfoB)).toBe(true);
    expect(existsSync(buildInfoC)).toBe(true);

    // Second run with unchanged files achieves 100% cache hits with zero misses
    const secondResult = await collectProjectIssueResult(["."], repoDir);
    expect(secondResult.issues).toEqual([]);
    expect(secondResult.cache.misses).toBe(0);
    expect(secondResult.cache.hits).toBe(firstResult.cache.hits + firstResult.cache.misses);
  });

  it("invalidates dependents when shared dependency changes while keeping sibling cached", async () => {
    // Prime the cache
    await collectProjectIssueResult(["."], repoDir);

    // Modify shared library B
    const libBSrc = join(repoDir, "packages", "lib-b", "src", "index.ts");
    const originalContent = readFileSync(libBSrc, "utf8");
    try {
      writeFileSync(libBSrc, `${originalContent}\nexport const extra = 99;\n`);

      // Run check targeting app-a: app-a depends on lib-b, so it must detect the change in lib-b
      const recheck = await collectProjectIssueResult(["packages/app-a"], repoDir);
      // app-a should miss because dependency lib-b changed
      expect(recheck.cache.misses).toBeGreaterThan(0);

      // Now run check on unrelated sibling-c: sibling-c was not changed and does not depend on lib-b
      const siblingCheck = await collectProjectIssueResult(["packages/sibling-c"], repoDir);
      expect(siblingCheck.cache.misses).toBe(0);
      expect(siblingCheck.cache.hits).toBeGreaterThan(0);
    } finally {
      writeFileSync(libBSrc, originalContent);
    }
  });

  it("falls back to standard single-project check when monorepoMode is off", async () => {
    const offConfig = {
      monorepoMode: "off" as const,
      engines: { tsc: true, biome: false, eslint: false, oxlint: false },
    };
    writeFileSync(join(repoDir, "signalint.config.json"), JSON.stringify(offConfig));
    try {
      const result = await collectProjectIssueResult(["packages/app-a"], repoDir);
      expect(result.issues).toEqual([]);
    } finally {
      writeFileSync(
        join(repoDir, "signalint.config.json"),
        JSON.stringify({
          monorepoMode: "auto",
          engines: { tsc: true, biome: false, eslint: false, oxlint: false },
        }),
      );
    }
  });
});
