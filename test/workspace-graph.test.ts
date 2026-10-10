import { describe, expect, it } from "vitest";

import { buildWorkspaceGraph, getTransitiveDependencies } from "../src/workspace/graph.js";
import { findPackageForFile, planWorkspaceChecks } from "../src/workspace/plan.js";
import type { WorkspacePackage } from "../src/workspace/types.js";

describe("Workspace Graph & Planning", () => {
  const pkgBase: WorkspacePackage = {
    name: "pkg-base",
    relativePath: "packages/base",
    absolutePath: "/repo/packages/base",
    manifestPath: "/repo/packages/base/package.json",
    tsconfigPath: "/repo/packages/base/tsconfig.json",
    dependencies: [],
    tsReferences: [],
  };

  const pkgMid: WorkspacePackage = {
    name: "pkg-mid",
    relativePath: "packages/mid",
    absolutePath: "/repo/packages/mid",
    manifestPath: "/repo/packages/mid/package.json",
    tsconfigPath: "/repo/packages/mid/tsconfig.json",
    dependencies: ["pkg-base"],
    tsReferences: [],
  };

  const pkgApp: WorkspacePackage = {
    name: "pkg-app",
    relativePath: "apps/app",
    absolutePath: "/repo/apps/app",
    manifestPath: "/repo/apps/app/package.json",
    tsconfigPath: "/repo/apps/app/tsconfig.json",
    dependencies: ["pkg-mid"],
    tsReferences: [],
  };

  const pkgSibling: WorkspacePackage = {
    name: "pkg-sibling",
    relativePath: "packages/sibling",
    absolutePath: "/repo/packages/sibling",
    manifestPath: "/repo/packages/sibling/package.json",
    tsconfigPath: "/repo/packages/sibling/tsconfig.json",
    dependencies: [],
    tsReferences: [],
  };

  describe("buildWorkspaceGraph", () => {
    it("orders dependencies before dependents topologically", () => {
      const graph = buildWorkspaceGraph("/repo", [pkgApp, pkgMid, pkgBase, pkgSibling]);
      expect(graph.hasCycles).toBe(false);

      const baseIdx = graph.topologicalOrder.indexOf("pkg-base");
      const midIdx = graph.topologicalOrder.indexOf("pkg-mid");
      const appIdx = graph.topologicalOrder.indexOf("pkg-app");

      expect(baseIdx).toBeLessThan(midIdx);
      expect(midIdx).toBeLessThan(appIdx);
      expect(graph.topologicalOrder).toContain("pkg-sibling");
    });

    it("detects dependency cycles and sets hasCycles: true", () => {
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
      expect(graph.topologicalOrder.length).toBeLessThan(2);
    });

    it("computes transitive dependencies correctly", () => {
      const graph = buildWorkspaceGraph("/repo", [pkgApp, pkgMid, pkgBase, pkgSibling]);
      const appDeps = getTransitiveDependencies("pkg-app", graph);
      expect(appDeps.map((p) => p.name)).toEqual(["pkg-base", "pkg-mid"]);

      const siblingDeps = getTransitiveDependencies("pkg-sibling", graph);
      expect(siblingDeps).toEqual([]);
    });
  });

  describe("planWorkspaceChecks", () => {
    const graph = buildWorkspaceGraph("/repo", [pkgApp, pkgMid, pkgBase, pkgSibling]);

    it("falls back to root check when monorepoMode is off", () => {
      const plan = planWorkspaceChecks(graph, { mode: "off" });
      expect(plan.fallbackToRoot).toBe(true);
      expect(plan.fallbackReason).toBe("monorepo_disabled");
      expect(plan.targets).toHaveLength(0);
    });

    it("falls back to root check when graph has cycles", () => {
      const cyclicGraph = buildWorkspaceGraph("/repo", [
        { ...pkgBase, dependencies: ["pkg-app"] },
        { ...pkgApp, dependencies: ["pkg-base"] },
      ]);
      const plan = planWorkspaceChecks(cyclicGraph, { mode: "auto" });
      expect(plan.fallbackToRoot).toBe(true);
      expect(plan.fallbackReason).toBe("dependency_cycle_detected");
    });

    it("plans all packages topologically when targetFiles is empty or root directory", () => {
      const plan = planWorkspaceChecks(graph, { mode: "auto", targetFiles: ["."] });
      expect(plan.fallbackToRoot).toBe(false);
      expect(plan.targets.map((t) => t.name)).toEqual(graph.topologicalOrder);
    });

    it("includes transitive dependents when a dependency is targeted", () => {
      // Modifying pkg-base must plan pkg-base, pkg-mid, and pkg-app, but NOT pkg-sibling
      const plan = planWorkspaceChecks(graph, {
        mode: "auto",
        targetFiles: ["packages/base/src/index.ts"],
      });
      expect(plan.fallbackToRoot).toBe(false);
      const plannedNames = plan.targets.map((t) => t.name);
      expect(plannedNames).toContain("pkg-base");
      expect(plannedNames).toContain("pkg-mid");
      expect(plannedNames).toContain("pkg-app");
      expect(plannedNames).not.toContain("pkg-sibling");

      // Verify topological ordering preserved: base -> mid -> app
      expect(plannedNames.indexOf("pkg-base")).toBeLessThan(plannedNames.indexOf("pkg-mid"));
      expect(plannedNames.indexOf("pkg-mid")).toBeLessThan(plannedNames.indexOf("pkg-app"));
    });

    it("plans only the leaf package when an independent leaf is targeted", () => {
      const plan = planWorkspaceChecks(graph, {
        mode: "auto",
        targetFiles: ["apps/app/src/main.ts"],
      });
      expect(plan.fallbackToRoot).toBe(false);
      expect(plan.targets.map((t) => t.name)).toEqual(["pkg-app"]);
    });

    it("falls back to root check when a root config file changes", () => {
      const plan = planWorkspaceChecks(graph, {
        mode: "auto",
        targetFiles: ["pnpm-lock.yaml"],
      });
      expect(plan.fallbackToRoot).toBe(true);
      expect(plan.fallbackReason).toBe("root_configuration_changed");
    });
  });

  describe("findPackageForFile", () => {
    it("matches the most specific package for a file", () => {
      const pkgRoot: WorkspacePackage = {
        name: "pkg-root",
        relativePath: "packages",
        absolutePath: "/repo/packages",
        manifestPath: "/repo/packages/package.json",
        dependencies: [],
        tsReferences: [],
      };
      const packagesMap = new Map<string, WorkspacePackage>([
        ["pkg-base", pkgBase],
        ["pkg-root", pkgRoot],
      ]);

      const matched = findPackageForFile("packages/base/src/index.ts", packagesMap);
      expect(matched?.name).toBe("pkg-base");
    });
  });
});
