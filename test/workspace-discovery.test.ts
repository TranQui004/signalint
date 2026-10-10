import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  discoverWorkspacePackages,
  parsePnpmWorkspaceYaml,
} from "../src/workspace/discovery.js";

describe("Workspace Discovery", () => {
  let tempRoot: string;

  beforeAll(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "signalint-discovery-test-"));
  });

  afterAll(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  describe("parsePnpmWorkspaceYaml", () => {
    it("parses package globs with comments and mixed quotes", () => {
      const yaml = `
# Workspace configuration
packages:
  - 'packages/*'
  - "apps/*"
  - internal/shared
  # ignore comments
`;
      const globs = parsePnpmWorkspaceYaml(yaml);
      expect(globs).toEqual(["packages/*", "apps/*", "internal/shared"]);
    });

    it("returns undefined when packages section is missing or empty", () => {
      expect(parsePnpmWorkspaceYaml("")).toBeUndefined();
      expect(parsePnpmWorkspaceYaml("some_other_key: true\n")).toBeUndefined();
      expect(parsePnpmWorkspaceYaml("packages:\n# only comments\n")).toBeUndefined();
    });

    it("parses inline flow-style array syntax", () => {
      const yaml = "packages: ['apps/*', 'packages/*', 'shared']\n";
      const globs = parsePnpmWorkspaceYaml(yaml);
      expect(globs).toEqual(["apps/*", "packages/*", "shared"]);
    });
  });

  describe("discoverWorkspacePackages", () => {
    it("falls back cleanly in auto mode when pnpm-workspace.yaml is absent", async () => {
      const emptyDir = mkdtempSync(join(tempRoot, "empty-"));
      const result = await discoverWorkspacePackages(emptyDir, "auto");
      expect(result.packages).toHaveLength(0);
      expect(result.reason).toBe("no_workspace_file");
    });

    it("throws actionable error in strict mode when pnpm-workspace.yaml is absent", async () => {
      const emptyDir = mkdtempSync(join(tempRoot, "empty-strict-"));
      await expect(discoverWorkspacePackages(emptyDir, "strict")).rejects.toThrow(
        /pnpm-workspace\.yaml.*was not found/,
      );
    });

    it("falls back with malformed_workspace_yaml in auto mode", async () => {
      const malformedDir = mkdtempSync(join(tempRoot, "malformed-"));
      writeFileSync(join(malformedDir, "pnpm-workspace.yaml"), "invalid: yaml: contents\n");

      const result = await discoverWorkspacePackages(malformedDir, "auto");
      expect(result.packages).toHaveLength(0);
      expect(result.reason).toBe("malformed_workspace_yaml");
    });

    it("throws in strict mode when pnpm-workspace.yaml is malformed", async () => {
      const malformedDir = mkdtempSync(join(tempRoot, "malformed-strict-"));
      writeFileSync(join(malformedDir, "pnpm-workspace.yaml"), "invalid: yaml\n");

      await expect(discoverWorkspacePackages(malformedDir, "strict")).rejects.toThrow(
        /malformed or defines no packages/,
      );
    });

    it("discovers packages, workspace: dependencies, and tsconfig references", async () => {
      const repoDir = mkdtempSync(join(tempRoot, "monorepo-"));
      writeFileSync(
        join(repoDir, "pnpm-workspace.yaml"),
        "packages:\n  - 'packages/*'\n",
      );

      // Package B (shared library)
      const pkgBDir = join(repoDir, "packages", "pkg-b");
      mkdirSync(pkgBDir, { recursive: true });
      writeFileSync(
        join(pkgBDir, "package.json"),
        JSON.stringify({ name: "@workspace/pkg-b", version: "1.0.0" }),
      );
      writeFileSync(
        join(pkgBDir, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { composite: true } }),
      );

      // Package A (depends on B via workspace: and tsconfig reference)
      const pkgADir = join(repoDir, "packages", "pkg-a");
      mkdirSync(pkgADir, { recursive: true });
      writeFileSync(
        join(pkgADir, "package.json"),
        JSON.stringify({
          name: "@workspace/pkg-a",
          version: "1.0.0",
          dependencies: {
            "@workspace/pkg-b": "workspace:*",
            external: "^1.0.0",
          },
        }),
      );
      writeFileSync(
        join(pkgADir, "tsconfig.json"),
        JSON.stringify({
          references: [{ path: "../pkg-b" }],
        }),
      );

      // Ignored directory without package.json
      const ignoredDir = join(repoDir, "packages", "not-a-pkg");
      mkdirSync(ignoredDir, { recursive: true });

      const result = await discoverWorkspacePackages(repoDir, "auto");
      expect(result.reason).toBeUndefined();
      expect(result.packages).toHaveLength(2);

      const pkgA = result.packages.find((p) => p.name === "@workspace/pkg-a");
      const pkgB = result.packages.find((p) => p.name === "@workspace/pkg-b");

      expect(pkgA).toBeDefined();
      expect(pkgB).toBeDefined();

      expect(pkgA?.dependencies).toEqual(["@workspace/pkg-b"]);
      expect(pkgA?.tsReferences).toEqual(["@workspace/pkg-b"]);
      expect(pkgB?.dependencies).toEqual([]);
      expect(pkgB?.tsReferences).toEqual([]);
    });
  });
});
