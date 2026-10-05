import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { NormalizedIssue } from "../src/schema.js";
import {
  compareIssues,
  isRecord,
  normalizeFile,
  readString,
} from "../src/util/index.js";

describe("Utility functions", () => {
  describe("isRecord", () => {
    it("returns true for plain objects and false for primitives/arrays/null", () => {
      expect(isRecord({})).toBe(true);
      expect(isRecord({ a: 1 })).toBe(true);
      expect(isRecord(Object.create(null))).toBe(true);

      expect(isRecord(null)).toBe(false);
      expect(isRecord(undefined)).toBe(false);
      expect(isRecord([])).toBe(false);
      expect(isRecord([1, 2])).toBe(false);
      expect(isRecord("string")).toBe(false);
      expect(isRecord(123)).toBe(false);
      expect(isRecord(true)).toBe(false);
    });
  });

  describe("compareIssues", () => {
    it("sorts issues deterministically by file, line, col, and engine", () => {
      const issueA: NormalizedIssue = {
        issueId: "1",
        file: "src/a.ts",
        line: 10,
        col: 5,
        engine: "tsc",
        rule: "r1",
        severity: "error",
        message: "m1",
        fixable: false,
      };
      const issueB: NormalizedIssue = {
        ...issueA,
        issueId: "2",
        file: "src/b.ts",
      };
      const issueA2: NormalizedIssue = {
        ...issueA,
        issueId: "3",
        line: 20,
      };
      const issueA3: NormalizedIssue = {
        ...issueA,
        issueId: "4",
        col: 10,
      };
      const issueA4: NormalizedIssue = {
        ...issueA,
        issueId: "5",
        engine: "oxlint",
      };

      expect(compareIssues(issueA, issueB)).toBeLessThan(0);
      expect(compareIssues(issueB, issueA)).toBeGreaterThan(0);
      expect(compareIssues(issueA, issueA2)).toBeLessThan(0);
      expect(compareIssues(issueA, issueA3)).toBeLessThan(0);
      expect(compareIssues(issueA4, issueA)).toBeLessThan(0); // 'oxlint' < 'tsc'
      expect(compareIssues(issueA, issueA)).toBe(0);
    });
  });

  describe("normalizeFile", () => {
    it("converts relative and absolute paths to forward-slash project relative", () => {
      const cwd = resolve("test/fixtures/sample-project");
      const relativePath = "src/broken.ts";
      const absolutePath = resolve(cwd, relativePath);

      expect(normalizeFile(relativePath, cwd)).toBe("src/broken.ts");
      expect(normalizeFile(absolutePath, cwd)).toBe("src/broken.ts");
    });
  });

  describe("readString", () => {
    it("extracts string values or falls back", () => {
      expect(readString({ key: "val" }, "key")).toBe("val");
      expect(readString({ key: 123 }, "key", "fallback")).toBe("fallback");
      expect(readString({}, "missing", "default")).toBe("default");
      expect(readString({}, "missing")).toBe("");
    });
  });
});
