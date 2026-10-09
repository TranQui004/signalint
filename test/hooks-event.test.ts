import { symlinkSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import {
  HookPathError,
  isRelevantCodeFile,
  normalizeHookPaths,
  validateHookPath,
} from "../src/hooks/paths.js";
import {
  isHookEventType,
  isHookRuntime,
} from "../src/hooks/event.js";

describe("Hook paths validation and normalization", () => {
  const projectRoot = resolve(".");

  it("rejects traversal segments (..)", () => {
    expect(() => validateHookPath("../outside.ts", projectRoot)).toThrow(HookPathError);
    expect(() => validateHookPath("src/../../outside.ts", projectRoot)).toThrow(
      expect.objectContaining({ code: "directory_traversal" }),
    );
  });

  it("rejects leading dash in path", () => {
    expect(() => validateHookPath("-rf", projectRoot)).toThrow(HookPathError);
    expect(() => validateHookPath("-rf", projectRoot)).toThrow(
      expect.objectContaining({ code: "leading_dash" }),
    );
  });

  it("rejects NUL bytes in path", () => {
    expect(() => validateHookPath("src/\0evil.ts", projectRoot)).toThrow(HookPathError);
    expect(() => validateHookPath("src/\0evil.ts", projectRoot)).toThrow(
      expect.objectContaining({ code: "nul_byte" }),
    );
  });

  it("rejects empty or whitespace-only paths", () => {
    expect(() => validateHookPath("", projectRoot)).toThrow(
      expect.objectContaining({ code: "empty_path" }),
    );
    expect(() => validateHookPath("   ", projectRoot)).toThrow(
      expect.objectContaining({ code: "empty_path" }),
    );
  });

  it("rejects paths outside canonical project root", () => {
    const outside = tmpdir();
    expect(() => validateHookPath(outside, projectRoot)).toThrow(
      expect.objectContaining({ code: "path_outside_project" }),
    );
  });

  it("rejects symlinks escaping project root", () => {
    const testDir = resolve(tmpdir(), `signalint-symlink-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const outsideTarget = resolve(tmpdir(), `signalint-outside-${Date.now()}.ts`);
    writeFileSync(outsideTarget, "export const x = 1;", "utf8");

    const linkPath = join(testDir, "symlink-escape.ts");
    let symlinkCreated = false;
    try {
      symlinkSync(outsideTarget, linkPath, "file");
      symlinkCreated = true;
    } catch {
      // Windows without SeCreateSymbolicLinkPrivilege may disallow creating symlinks
    }

    try {
      if (symlinkCreated) {
        expect(() => validateHookPath(linkPath, testDir)).toThrow(
          expect.objectContaining({ code: "symlink_escape" }),
        );
      }
    } finally {
      rmSync(testDir, { recursive: true, force: true });
      rmSync(outsideTarget, { force: true });
    }
  });

  it("accepts and canonicalizes valid relative project paths", () => {
    const valid = validateHookPath("src/index.ts", projectRoot);
    expect(valid).toBe("src/index.ts");

    const withDotSlash = validateHookPath("./src/cli.ts", projectRoot);
    expect(withDotSlash).toBe("src/cli.ts");
  });

  it("filters code and non-code files via isRelevantCodeFile", () => {
    expect(isRelevantCodeFile("src/index.ts")).toBe(true);
    expect(isRelevantCodeFile("src/components/App.tsx")).toBe(true);
    expect(isRelevantCodeFile("src/lib.js")).toBe(true);
    expect(isRelevantCodeFile("src/index.cjs")).toBe(true);
    expect(isRelevantCodeFile("src/index.mjs")).toBe(true);
    expect(isRelevantCodeFile("config/settings.json")).toBe(true);

    // Non-code files
    expect(isRelevantCodeFile("README.md")).toBe(false);
    expect(isRelevantCodeFile("docs/architecture.txt")).toBe(false);
    expect(isRelevantCodeFile("assets/logo.png")).toBe(false);

    // Excluded directory segments
    expect(isRelevantCodeFile(".git/HEAD")).toBe(false);
    expect(isRelevantCodeFile("node_modules/pkg/index.ts")).toBe(false);
    expect(isRelevantCodeFile("dist/index.js")).toBe(false);
    expect(isRelevantCodeFile(".signalint/cache.db")).toBe(false);
    expect(isRelevantCodeFile(".vscode/settings.json")).toBe(false);

    // Temp and backup files
    expect(isRelevantCodeFile("src/.~index.ts")).toBe(false);
    expect(isRelevantCodeFile("src/index.ts~")).toBe(false);
    expect(isRelevantCodeFile("src/.index.swp")).toBe(false);
    expect(isRelevantCodeFile("src/test.tmp")).toBe(false);
    expect(isRelevantCodeFile("package-lock.json")).toBe(false);
    expect(isRelevantCodeFile("pnpm-lock.yaml")).toBe(false);
  });

  it("normalizes and deduplicates an array of paths", () => {
    const raw = [
      "src/index.ts",
      "./src/index.ts",
      "README.md",
      "node_modules/foo/index.js",
      "src/cli.ts",
    ];
    const normalized = normalizeHookPaths(raw, projectRoot);
    expect(normalized).toEqual(["src/index.ts", "src/cli.ts"]);
  });
});

describe("Hook runtime and event type predicates", () => {
  it("identifies supported hook runtimes", () => {
    expect(isHookRuntime("claude")).toBe(true);
    expect(isHookRuntime("cursor")).toBe(true);
    expect(isHookRuntime("codex")).toBe(true);
    expect(isHookRuntime("vscode")).toBe(true);
    expect(isHookRuntime("vim")).toBe(false);
    expect(isHookRuntime(123)).toBe(false);
    expect(isHookRuntime(null)).toBe(false);
  });

  it("identifies supported hook event types", () => {
    expect(isHookEventType("post_edit")).toBe(true);
    expect(isHookEventType("stop")).toBe(true);
    expect(isHookEventType("pre_edit")).toBe(false);
    expect(isHookEventType(undefined)).toBe(false);
  });
});
