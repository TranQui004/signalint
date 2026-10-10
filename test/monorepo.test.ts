import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  discoverWorkspacePackages,
  globPatternToRegExp,
  isLocalWorkspaceMatch,
  isPathExcluded,
  parsePnpmWorkspaceYaml,
} from "../src/workspace/discovery.js";
import { buildWorkspaceGraph, getTransitiveDependencies } from "../src/workspace/graph.js";
import { hasSolutionStyleTsconfig, planWorkspaceChecks } from "../src/workspace/plan.js";
import { canonicalizePath } from "../src/projectPaths.js";
import type { WorkspacePackage } from "../src/workspace/types.js";

describe("Monorepo Workspace Discovery & Graph Hardening", () => {
  let tempRoot: string;
  let originalStateDir: string | undefined;

  beforeAll(() => {
    tempRoot = canonicalizePath(mkdtempSync(join(tmpdir(), "signalint-monorepo-harden-")));
    originalStateDir = process.env.SIGNALINT_STATE_DIR;
    process.env.SIGNALINT_STATE_DIR = canonicalizePath(join(tempRoot, "state"));
    mkdirSync(process.env.SIGNALINT_STATE_DIR, { recursive: true });
  });

  afterAll(() => {
    if (originalStateDir !== undefined) {
      process.env.SIGNALINT_STATE_DIR = originalStateDir;
    } else {
      delete process.env.SIGNALINT_STATE_DIR;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  describe("YAML Parsing & Flow-Style", () => {
    it("parses inline arrays and YAML flow style", () => {
      const content = `
# Workspace packages definition
packages: ['packages/*', 'apps/*', "tools/*"]
`;
      const globs = parsePnpmWorkspaceYaml(content);
      expect(globs).toEqual(["packages/*", "apps/*", "tools/*"]);
    });

    it("handles multiline comments and mixed flow styles gracefully", () => {
      const content = `
# Header comments
# Line 2
packages:
  - "packages/*" # inline comment
  - 'apps/web'
  # middle comment
  - tools/builder
`;
      const globs = parsePnpmWorkspaceYaml(content);
      expect(globs).toEqual(["packages/*", "apps/web", "tools/builder"]);
    });

    it("returns undefined for empty, malformed, or non-array packages", () => {
      expect(parsePnpmWorkspaceYaml("")).toBeUndefined();
      expect(parsePnpmWorkspaceYaml("packages: {}\n")).toBeUndefined();
      expect(parsePnpmWorkspaceYaml("packages: 'invalid-string'\n")).toBeUndefined();
      expect(parsePnpmWorkspaceYaml("invalid: [1, 2, 3]\n")).toBeUndefined();
      expect(parsePnpmWorkspaceYaml("packages: [!!invalid]\n")).toBeUndefined();
    });
  });

  describe("Glob Patterns & Negation Exclusions (!)", () => {
    it("converts glob patterns to regex correctly", () => {
      const rx1 = globPatternToRegExp("packages/*");
      expect(rx1.test("packages/lib-a")).toBe(true);
      expect(rx1.test("packages/lib-a/nested")).toBe(false);

      const rx2 = globPatternToRegExp("packages/deprecated-*");
      expect(rx2.test("packages/deprecated-old")).toBe(true);
      expect(rx2.test("packages/active-pkg")).toBe(false);

      const rx3 = globPatternToRegExp("**/legacy/**");
      expect(rx3.test("packages/legacy/old-app")).toBe(true);
      expect(rx3.test("legacy")).toBe(true);
      expect(rx3.test("packages/lib-a")).toBe(false);
    });

    it("detects excluded paths and parent paths accurately", () => {
      const exclusions = ["packages/fixtures*", "**/test/**", "legacy/**"];
      expect(isPathExcluded("packages/fixtures-test", exclusions)).toBe(true);
      expect(isPathExcluded("packages/test/unit", exclusions)).toBe(true);
      expect(isPathExcluded("legacy/old-app", exclusions)).toBe(true);
      expect(isPathExcluded("packages/lib-a", exclusions)).toBe(false);
    });

    it("discovers packages while filtering out negated patterns and invalid directories", async () => {
      const repoDir = canonicalizePath(mkdtempSync(join(tempRoot, "exclusion-repo-")));
      writeFileSync(
        join(repoDir, "pnpm-workspace.yaml"),
        `packages:
  - 'packages/*'
  - '!packages/fixtures*'
  - '!**/legacy/**'
`,
      );

      // 1. Valid package: packages/lib-core
      const coreDir = join(repoDir, "packages", "lib-core");
      mkdirSync(coreDir, { recursive: true });
      writeFileSync(join(coreDir, "package.json"), JSON.stringify({ name: "@mono/core", version: "1.0.0" }));

      // 2. Excluded package: packages/fixtures-sample (matches !packages/fixtures*)
      const fixtureDir = join(repoDir, "packages", "fixtures-sample");
      mkdirSync(fixtureDir, { recursive: true });
      writeFileSync(join(fixtureDir, "package.json"), JSON.stringify({ name: "@mono/fixture", version: "1.0.0" }));

      // 3. Excluded package: packages/legacy/old-app (matches !**/legacy/**)
      const legacyDir = join(repoDir, "packages", "legacy", "old-app");
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(join(legacyDir, "package.json"), JSON.stringify({ name: "@mono/old-app", version: "1.0.0" }));

      // 4. Directory without package.json (should be excluded)
      const emptyDir = join(repoDir, "packages", "not-a-package");
      mkdirSync(emptyDir, { recursive: true });

      const result = await discoverWorkspacePackages(repoDir, "auto");
      expect(result.reason).toBeUndefined();
      expect(result.packages).toHaveLength(1);
      expect(result.packages[0]?.name).toBe("@mono/core");

      const graph = buildWorkspaceGraph(repoDir, result.packages);
      const plan = planWorkspaceChecks(graph, { mode: "auto" });
      expect(plan.targets.map((t) => t.name)).toEqual(["@mono/core"]);
    });
  });

  describe("Workspace Protocol vs Registry Package Resolution", () => {
    it("accurately matches workspace specifiers and compatible local versions", () => {
      expect(isLocalWorkspaceMatch("workspace:*", "1.0.0")).toBe(true);
      expect(isLocalWorkspaceMatch("workspace:^", "1.0.0")).toBe(true);
      expect(isLocalWorkspaceMatch("workspace:~", "1.0.0")).toBe(true);
      expect(isLocalWorkspaceMatch("workspace:../pkg", "1.0.0")).toBe(true);
      expect(isLocalWorkspaceMatch("*", "1.0.0")).toBe(true);
      expect(isLocalWorkspaceMatch("1.0.0", "1.0.0")).toBe(true);
      expect(isLocalWorkspaceMatch("^1.0.0", "1.2.0")).toBe(true);
      expect(isLocalWorkspaceMatch("~1.2.0", "1.2.3")).toBe(true);

      // Incompatible versions
      expect(isLocalWorkspaceMatch("^2.0.0", "1.0.0")).toBe(false);
      expect(isLocalWorkspaceMatch("~1.3.0", "1.2.0")).toBe(false);
      expect(isLocalWorkspaceMatch("^1.0.0", undefined)).toBe(false);
    });

    it("ignores external registry packages during dependency graph construction", async () => {
      const repoDir = canonicalizePath(mkdtempSync(join(tempRoot, "registry-deps-repo-")));
      writeFileSync(join(repoDir, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");

      // Package B: shared base
      const pkgBDir = join(repoDir, "packages", "pkg-b");
      mkdirSync(pkgBDir, { recursive: true });
      writeFileSync(join(pkgBDir, "package.json"), JSON.stringify({ name: "pkg-b", version: "1.0.0" }));

      // Package C: shared utility
      const pkgCDir = join(repoDir, "packages", "pkg-c");
      mkdirSync(pkgCDir, { recursive: true });
      writeFileSync(join(pkgCDir, "package.json"), JSON.stringify({ name: "pkg-c", version: "1.0.0" }));

      // Package D: incompatible version requirement
      const pkgDDir = join(repoDir, "packages", "pkg-d");
      mkdirSync(pkgDDir, { recursive: true });
      writeFileSync(join(pkgDDir, "package.json"), JSON.stringify({ name: "pkg-d", version: "1.0.0" }));

      // Package A: depends on B (workspace:*), C (^1.0.0), D (^9.0.0 incompatible), and external registry deps
      const pkgADir = join(repoDir, "packages", "pkg-a");
      mkdirSync(pkgADir, { recursive: true });
      writeFileSync(
        join(pkgADir, "package.json"),
        JSON.stringify({
          name: "pkg-a",
          version: "1.0.0",
          dependencies: {
            "pkg-b": "workspace:*",
            "pkg-c": "^1.0.0",
            "pkg-d": "^9.0.0", // Incompatible version -> should NOT create workspace edge
            react: "^19.0.0",
            typescript: "^5.5.0",
            "@types/node": "^22.0.0",
          },
        }),
      );

      const discovery = await discoverWorkspacePackages(repoDir, "auto");
      expect(discovery.packages).toHaveLength(4);

      const pkgA = discovery.packages.find((p) => p.name === "pkg-a");
      expect(pkgA).toBeDefined();
      expect(pkgA?.dependencies).toContain("pkg-b");
      expect(pkgA?.dependencies).toContain("pkg-c");
      expect(pkgA?.dependencies).not.toContain("pkg-d");
      expect(pkgA?.dependencies).not.toContain("react");
      expect(pkgA?.dependencies).not.toContain("typescript");
      expect(pkgA?.dependencies).not.toContain("@types/node");

      const graph = buildWorkspaceGraph(repoDir, discovery.packages);
      expect(graph.hasCycles).toBe(false);

      const aIndex = graph.topologicalOrder.indexOf("pkg-a");
      const bIndex = graph.topologicalOrder.indexOf("pkg-b");
      const cIndex = graph.topologicalOrder.indexOf("pkg-c");

      expect(bIndex).toBeLessThan(aIndex);
      expect(cIndex).toBeLessThan(aIndex);
    });
  });

  describe("Circular Dependency Handling", () => {
    it("handles circular dependencies deterministically without hanging", () => {
      const cyclicA: WorkspacePackage = {
        name: "pkg-a",
        relativePath: "packages/a",
        absolutePath: "/repo/packages/a",
        manifestPath: "/repo/packages/a/package.json",
        dependencies: ["pkg-b"],
        tsReferences: [],
      };
      const cyclicB: WorkspacePackage = {
        name: "pkg-b",
        relativePath: "packages/b",
        absolutePath: "/repo/packages/b",
        manifestPath: "/repo/packages/b/package.json",
        dependencies: ["pkg-a"],
        tsReferences: [],
      };

      const graph = buildWorkspaceGraph("/repo", [cyclicA, cyclicB]);
      expect(graph.hasCycles).toBe(true);
      expect(graph.cycleNodes).toEqual(["pkg-a", "pkg-b"]);

      // getTransitiveDependencies terminates safely with visited set
      const depsA = getTransitiveDependencies("pkg-a", graph);
      expect(depsA.map((d) => d.name)).toEqual(["pkg-b"]);

      // planWorkspaceChecks in auto mode returns fallback without throwing or looping
      const autoPlan = planWorkspaceChecks(graph, { mode: "auto" });
      expect(autoPlan.fallbackToRoot).toBe(true);
      expect(autoPlan.fallbackReason).toBe("dependency_cycle_detected");

      // planWorkspaceChecks in strict mode throws actionable error with cycle nodes
      expect(() => planWorkspaceChecks(graph, { mode: "strict" })).toThrow(
        /dependency cycle detected between workspace packages.*pkg-a.*pkg-b/,
      );
    });
  });

  describe("Cross-Platform Path Reference Resolution", () => {
    it("resolves nested relative tsconfig project references canonicalizing paths", async () => {
      const repoDir = canonicalizePath(mkdtempSync(join(tempRoot, "ts-refs-repo-")));
      writeFileSync(join(repoDir, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");

      // Package B
      const pkgBDir = join(repoDir, "packages", "pkg-b");
      mkdirSync(pkgBDir, { recursive: true });
      writeFileSync(join(pkgBDir, "package.json"), JSON.stringify({ name: "pkg-b", version: "1.0.0" }));
      writeFileSync(
        join(pkgBDir, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { composite: true } }),
      );

      // Package A referencing B via relative path and trailing tsconfig.json
      const pkgADir = join(repoDir, "packages", "pkg-a");
      mkdirSync(pkgADir, { recursive: true });
      writeFileSync(join(pkgADir, "package.json"), JSON.stringify({ name: "pkg-a", version: "1.0.0" }));
      writeFileSync(
        join(pkgADir, "tsconfig.json"),
        JSON.stringify({
          references: [
            { path: "../pkg-b" },
            { path: "../pkg-b/tsconfig.json" },
          ],
        }),
      );

      // Root solution tsconfig referencing both
      writeFileSync(
        join(repoDir, "tsconfig.json"),
        JSON.stringify({
          files: [],
          references: [
            { path: "./packages/pkg-a" },
            { path: "packages/pkg-b/tsconfig.json" },
          ],
        }),
      );

      const discovery = await discoverWorkspacePackages(repoDir, "auto");
      expect(discovery.packages).toHaveLength(2);

      const pkgA = discovery.packages.find((p) => p.name === "pkg-a");
      expect(pkgA?.tsReferences).toEqual(["pkg-b"]);

      const isSolution = await hasSolutionStyleTsconfig(repoDir, discovery.packages);
      expect(isSolution).toBe(true);
    });
  });
});
